"""Tests of the client against a stand-in for the network. No requests leave the process."""

import base64
import json
import time
import unittest
from urllib.parse import parse_qs, urlsplit

import edgekv
from edgekv import EdgeKV, EdgeKVError


def b64(text):
    return base64.b64encode(text.encode()).decode()


def failure(status, code, message="no"):
    return (status, {}, json.dumps({"error": {"code": code, "message": message}}).encode())


def ok(body, status=200):
    return (status, {}, json.dumps(body).encode())


def client(answers, retries=0, control_url=None, tokens=None):
    """A client whose requests are answered from a list, in order, and recorded."""
    seen = []

    def transport(method, url, headers, body, timeout):
        seen.append({"method": method, "url": urlsplit(url), "headers": headers, "body": body, "timeout": timeout})
        if not answers:
            raise AssertionError("the test did not expect this request")
        answer = answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    api_key = None if tokens else "ekv_test_key"
    kv = EdgeKV(api_key, "https://api.test/", control_url, tokens=tokens, retries=retries, transport=transport)
    return kv, seen


class ErrorCode:
    """assertRaises, plus a check of the error's code."""

    def __init__(self, test, code, status=None):
        self.test, self.code, self.status = test, code, status

    def __enter__(self):
        return self

    def __exit__(self, kind, error, traceback):
        self.test.assertIsInstance(error, EdgeKVError, f"expected {self.code}, got {error!r}")
        self.test.assertEqual(error.code, self.code)
        if self.status is not None:
            self.test.assertEqual(error.status, self.status)
        self.error = error
        return True


class ClientTests(unittest.TestCase):
    def setUp(self):
        # Retries wait between attempts; the tests do not need to.
        self._sleep = edgekv.time.sleep
        edgekv.time.sleep = lambda seconds: None

    def tearDown(self):
        edgekv.time.sleep = self._sleep

    def fails(self, code, status=None):
        return ErrorCode(self, code, status)

    def test_every_request_carries_the_key_and_goes_to_the_database_by_name(self):
        kv, seen = client([ok({"lsn": 3})])
        self.assertEqual(kv.database("orders").put("a", "one"), 3)
        self.assertEqual(seen[0]["method"], "PUT")
        self.assertEqual(seen[0]["url"].geturl(), "https://api.test/v1/db/orders/kv/a")
        self.assertEqual(seen[0]["headers"]["Authorization"], "Bearer ekv_test_key")
        self.assertEqual(seen[0]["body"], b"one")

    def test_keys_are_escaped_in_the_path_with_their_slashes_kept(self):
        kv, seen = client([(200, {}, b"\x01")])
        kv.database("orders").get("users/42/display name?")
        self.assertEqual(seen[0]["url"].path, "/v1/db/orders/kv/users/42/display%20name%3F")
        with self.fails("BAD_REQUEST"):
            kv.database("orders").get("")

    def test_get_returns_bytes_text_or_json_and_none_for_a_key_that_is_not_there(self):
        stored = b'{"n":1}'
        kv, _ = client(
            [(200, {}, stored)] * 3 + [failure(404, "KEY_NOT_FOUND"), failure(404, "KEY_NOT_FOUND")]
        )
        db = kv.database("orders")
        self.assertEqual(db.get("k"), stored)
        self.assertEqual(db.get_text("k"), '{"n":1}')
        self.assertEqual(db.get_json("k"), {"n": 1})
        self.assertIsNone(db.get("absent"))
        self.assertIsNone(db.get_json("absent"))

    def test_a_missing_database_is_an_error_not_a_missing_key(self):
        kv, _ = client([failure(404, "NOT_FOUND", "database not found")])
        with self.fails("NOT_FOUND", 404) as caught:
            kv.database("nope").get("k")
        self.assertEqual(caught.error.message, "database not found")

    def test_commit_sends_keys_and_values_base64_encoded_and_bytes_unchanged(self):
        kv, seen = client([ok({"lsn": 9})])
        lsn = kv.database("orders").commit(
            [
                {"op": "put", "key": "a", "value": "one"},
                {"op": "put", "key": b"\x00\xff", "value": b"\x01\x02\x03"},
                {"op": "delete", "key": "b"},
            ]
        )
        self.assertEqual(lsn, 9)
        self.assertEqual(seen[0]["url"].path, "/v1/db/orders/commit")
        self.assertEqual(
            json.loads(seen[0]["body"]),
            {
                "ops": [
                    {"op": "put", "key": b64("a"), "value": b64("one")},
                    {"op": "put", "key": "AP8=", "value": "AQID"},
                    {"op": "delete", "key": b64("b")},
                ]
            },
        )
        with self.fails("BAD_REQUEST"):
            kv.database("orders").commit([])
        with self.fails("BAD_REQUEST"):
            kv.database("orders").commit([{"op": "upsert", "key": "a"}])

    def test_scan_walks_every_page_and_decodes_what_it_returns(self):
        kv, seen = client(
            [
                ok(
                    {
                        "items": [
                            {"key": b64("user/1"), "value": b64("ann")},
                            {"key": b64("user/2"), "value": b64("bo")},
                        ],
                        "next_page_token": "dG9rZW4=",
                    }
                ),
                ok({"items": [{"key": b64("user/3"), "value": b64("cy")}], "next_page_token": None}),
            ]
        )
        found = [(entry.key, entry.value) for entry in kv.database("orders").scan(prefix="user/", page_size=2)]
        self.assertEqual(found, [("user/1", b"ann"), ("user/2", b"bo"), ("user/3", b"cy")])
        self.assertEqual(parse_qs(seen[0]["url"].query), {"prefix": ["user/"], "limit": ["2"]})
        self.assertEqual(parse_qs(seen[1]["url"].query)["page_token"], ["dG9rZW4="])

    def test_wait_for_change_long_polls_the_head_and_caps_the_wait_at_30_seconds(self):
        kv, seen = client([ok({"generation": 0, "lsn": 8}), ok({"generation": 0, "lsn": 7})])
        self.assertEqual(kv.database("orders").wait_for_change(7, 0.5), edgekv.Head(0, 8))
        self.assertEqual(parse_qs(seen[0]["url"].query), {"wait_after": ["7"], "timeout_ms": ["500"]})
        kv.database("orders").wait_for_change(7, 999)
        self.assertEqual(parse_qs(seen[1]["url"].query)["timeout_ms"], ["30000"])
        # The request is given longer than the wait it asks for.
        self.assertEqual(seen[1]["timeout"], 40.0)

    def test_a_request_the_service_did_not_carry_out_is_tried_again(self):
        kv, seen = client([failure(429, "RATE_LIMITED"), failure(409, "LEASE_HELD"), ok({"lsn": 4})], retries=3)
        self.assertEqual(kv.database("orders").put("a", "x"), 4)
        self.assertEqual(len(seen), 3)

    def test_retries_stop_at_the_limit_and_report_the_last_failure(self):
        kv, seen = client([failure(429, "RATE_LIMITED"), failure(429, "RATE_LIMITED")], retries=1)
        with self.fails("RATE_LIMITED", 429):
            kv.database("orders").put("a", "x")
        self.assertEqual(len(seen), 2)

    def test_failures_that_trying_again_cannot_fix_are_reported_at_once(self):
        for status, code in [
            (401, "UNAUTHENTICATED"),
            (403, "FORBIDDEN"),
            (403, "STORAGE_QUOTA_EXCEEDED"),
            (403, "ACCOUNT_SUSPENDED"),
            (413, "VALUE_TOO_LARGE"),
        ]:
            kv, seen = client([failure(status, code)], retries=3)
            with self.fails(code):
                kv.database("orders").put("a", "x")
            self.assertEqual(len(seen), 1, code)

    def test_a_failure_to_connect_is_retried_and_a_timeout_is_not(self):
        kv, _ = client([OSError("connection refused"), ok({"lsn": 1})], retries=2)
        self.assertEqual(kv.database("orders").put("a", "x"), 1)

        # A timeout is not retried, because the write may have happened.
        kv, seen = client([TimeoutError("timed out"), ok({"lsn": 1})], retries=2)
        with self.fails("TIMEOUT", 0):
            kv.database("orders").put("a", "x")
        self.assertEqual(len(seen), 1)

    def test_an_answer_that_is_not_from_the_service_still_becomes_an_error(self):
        kv, _ = client([(502, {}, b"<html>bad gateway</html>")])
        with self.fails("SERVICE_ERROR", 502):
            kv.database("orders").get("k")
        # The code is also sent as a header, for answers with no readable body.
        kv, _ = client([(503, {"x-edgekv-error": "UNAVAILABLE"}, b"")])
        with self.fails("UNAVAILABLE"):
            kv.database("orders").get("k")

    def test_databases_are_managed_at_the_control_url(self):
        raw = {
            "id": "d1",
            "region": "us-west-2",
            "status": "active",
            "status_reason": None,
            "created_at": "2026-10-12T00:00:00Z",
            "spec": {"name": "orders"},
        }
        kv, seen = client(
            [
                ok({"items": [{"region": "us-west-2"}]}),
                ok(raw, 201),
                ok({"items": [raw], "next_page_token": "next"}),
                ok({"items": [], "next_page_token": None}),
                ok({**raw, "usage": {"stored_bytes": 1234}}),
                ok({"items": [{"hour": "2026-10-12T01:00:00Z", "stored_bytes": 5, "ops_written": 2, "bytes_served": 0}]}),
                ok({"id": "d1", "status": "deleting"}, 202),
            ],
            control_url="https://cp.test",
        )
        self.assertEqual(kv.regions(), ["us-west-2"])
        created = kv.databases.create("orders", "us-west-2")
        self.assertEqual(
            created, edgekv.DatabaseInfo("d1", "orders", "us-west-2", "active", None, "2026-10-12T00:00:00Z")
        )
        self.assertEqual(json.loads(seen[1]["body"]), {"name": "orders", "region": "us-west-2"})

        self.assertEqual([database.name for database in kv.databases.list()], ["orders"])
        self.assertEqual(parse_qs(seen[3]["url"].query)["page_token"], ["next"])

        self.assertEqual(kv.databases.get("d1").stored_bytes, 1234)
        self.assertEqual(kv.databases.usage("d1"), [edgekv.UsageHour("2026-10-12T01:00:00Z", 5, 2, 0)])
        kv.databases.delete("d1")
        self.assertEqual((seen[6]["method"], seen[6]["url"].geturl()), ("DELETE", "https://cp.test/v1/databases/d1"))
        for request in seen:
            self.assertEqual(request["url"].netloc, "cp.test")

    def test_mistakes_in_the_options_are_caught_before_any_request(self):
        with self.fails("BAD_REQUEST"):
            EdgeKV("not-a-key", "https://api.test")
        with self.fails("BAD_REQUEST"):
            EdgeKV("ekv_k", "")
        kv, seen = client([])
        with self.fails("BAD_REQUEST"):
            kv.regions()
        with self.fails("BAD_REQUEST"):
            kv.databases.create("x1", "us-west-2")
        with self.assertRaises(TypeError):
            kv.database("orders").put("k", 42)
        self.assertEqual(seen, [])

    def test_a_write_can_require_the_version_it_read_or_that_the_key_has_no_value(self):
        kv, seen = client([ok({"lsn": 5, "version": "v2"}), ok({"lsn": 6}), ok({"lsn": 7}), ok({"lsn": 8}), ok({"lsn": 9})])
        db = kv.database("shop")
        self.assertEqual(db.put("stock/1", "9", if_version="v1"), 5)
        self.assertEqual(seen[0]["headers"]["If-Match"], "v1")
        db.put("stock/2", "1", if_absent=True)
        self.assertEqual(seen[1]["headers"]["If-None-Match"], "*")
        db.delete("stock/2", if_version="v1")
        self.assertEqual((seen[2]["method"], seen[2]["headers"]["If-Match"]), ("DELETE", "v1"))
        db.put("stock/3", "x")
        self.assertNotIn("If-Match", seen[3]["headers"])
        self.assertNotIn("If-None-Match", seen[3]["headers"])
        db.commit(
            [{"op": "put", "key": "a", "value": "1"}, {"op": "delete", "key": "b"}],
            conditions=[{"key": "a", "version": "v2"}, {"key": b"b", "version": None}],
        )
        self.assertEqual(
            json.loads(seen[4]["body"])["conditions"], [{"key": b64("a"), "version": "v2"}, {"key": b64("b"), "version": None}]
        )
        with self.fails("BAD_REQUEST"):
            db.put("k", "v", if_version="v1", if_absent=True)
        self.assertEqual(len(seen), 5)

    def test_get_versioned_returns_the_version_sent_with_the_value(self):
        kv, _ = client([(200, {"x-edgekv-version": "v7"}, b"10"), failure(404, "KEY_NOT_FOUND")])
        self.assertEqual(kv.database("shop").get_versioned("stock/1"), edgekv.Versioned(b"10", "v7"))
        self.assertIsNone(kv.database("shop").get_versioned("stock/2"))

    def test_a_failed_condition_names_its_key_and_is_not_retried(self):
        answer = (412, {}, json.dumps({"error": {"code": "CONDITION_FAILED", "message": "changed", "key": b64("stock/1")}}).encode())
        kv, seen = client([answer], retries=3)
        with self.fails("CONDITION_FAILED", 412) as failed:
            kv.database("shop").put("stock/1", "9", if_version="v1")
        self.assertEqual(failed.error.key, b"stock/1")
        self.assertEqual(len(seen), 1)

    def test_update_reads_again_when_someone_else_wrote_first(self):
        kv, seen = client(
            [
                (200, {"x-edgekv-version": "v1"}, b"10"),
                failure(412, "CONDITION_FAILED"),
                (200, {"x-edgekv-version": "v2"}, b"12"),
                ok({"lsn": 3}),
            ]
        )
        values = []

        def decrement(current):
            values.append(current)
            return str(int(current) - 1)

        self.assertEqual(kv.database("shop").update("stock/1", decrement), 3)
        self.assertEqual(values, [b"10", b"12"])
        self.assertEqual((seen[1]["headers"]["If-Match"], seen[3]["headers"]["If-Match"]), ("v1", "v2"))
        self.assertEqual(seen[3]["body"], b"11")

    def test_update_creates_only_if_absent_deletes_on_none_and_skips_none_on_nothing(self):
        kv, seen = client(
            [
                failure(404, "KEY_NOT_FOUND"),
                ok({"lsn": 1}),
                (200, {"x-edgekv-version": "v1"}, b"1"),
                ok({"lsn": 2}),
                failure(404, "KEY_NOT_FOUND"),
            ]
        )
        db = kv.database("shop")
        self.assertEqual(db.update("counter", lambda current: "1" if current is None else None), 1)
        self.assertEqual(seen[1]["headers"]["If-None-Match"], "*")
        self.assertEqual(db.update("counter", lambda current: None), 2)
        self.assertEqual((seen[3]["method"], seen[3]["headers"]["If-Match"]), ("DELETE", "v1"))
        self.assertIsNone(db.update("counter", lambda current: None))
        self.assertEqual(len(seen), 5)

    def test_update_gives_up_when_the_key_keeps_changing(self):
        answers = []
        for i in range(edgekv.UPDATE_ATTEMPTS):
            answers += [(200, {"x-edgekv-version": f"v{i}"}, b"x"), failure(412, "CONDITION_FAILED")]
        kv, seen = client(answers)
        with self.fails("CONDITION_FAILED"):
            kv.database("shop").update("hot", lambda current: "y")
        self.assertEqual(len(seen), edgekv.UPDATE_ATTEMPTS * 2)

    def test_with_tokens_each_database_gets_its_own_token_fetched_once(self):
        issued = {}

        def tokens(database):
            self.assertNotIn(database, issued)
            issued[database] = jwt(3600, database)
            return issued[database]

        kv, seen = client([ok({"lsn": 1}), ok({"lsn": 2}), ok({"lsn": 3})], tokens=tokens)
        kv.database("notes-1").put("a", "1")
        kv.database("notes-1").put("b", "2")
        kv.database("notes-2").put("a", "1")
        self.assertEqual(list(issued), ["notes-1", "notes-2"])
        self.assertEqual(seen[1]["headers"]["Authorization"], f"Bearer {issued['notes-1']}")
        self.assertEqual(seen[2]["headers"]["Authorization"], f"Bearer {issued['notes-2']}")

    def test_a_refused_token_is_replaced_and_the_request_tried_once_more(self):
        issued = []

        def tokens(database):
            issued.append(jwt(3600, f"t{len(issued)}"))
            return issued[-1]

        kv, seen = client(
            [failure(401, "TOKEN_EXPIRED"), ok({"lsn": 1}), failure(401, "UNAUTHENTICATED"), failure(401, "UNAUTHENTICATED")],
            tokens=tokens,
        )
        db = kv.database("notes")
        self.assertEqual(db.put("a", "1"), 1)
        self.assertEqual(seen[0]["headers"]["Authorization"], f"Bearer {issued[0]}")
        self.assertEqual(seen[1]["headers"]["Authorization"], f"Bearer {issued[1]}")
        with self.fails("UNAUTHENTICATED"):
            db.put("b", "2")
        self.assertEqual(len(seen), 4)

    def test_a_token_past_its_renewal_time_is_replaced_before_use(self):
        issued = []

        def tokens(database):
            issued.append(jwt(-1 if not issued else 3600, f"t{len(issued)}"))
            return issued[-1]

        kv, seen = client([ok({"lsn": 1}), ok({"lsn": 2})], tokens=tokens)
        kv.database("notes").put("a", "1")
        kv.database("notes").put("b", "2")
        self.assertEqual(len(issued), 2)
        self.assertEqual(seen[1]["headers"]["Authorization"], f"Bearer {issued[1]}")

    def test_a_failing_token_source_is_unavailable(self):
        def tokens(database):
            raise RuntimeError("backend down")

        kv, seen = client([], tokens=tokens)
        with self.fails("UNAVAILABLE") as failed:
            kv.database("notes").get("a")
        self.assertIn("backend down", failed.error.message)
        self.assertEqual(seen, [])

    def test_refresh_time_is_a_minute_early_or_halfway_and_never_without_exp(self):
        now = 1_000_000_000.0

        def at(exp):
            return "x." + base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=") + ".y"

        self.assertEqual(edgekv._refresh_at(at(now + 3600), now), now + 3540)
        self.assertEqual(edgekv._refresh_at(at(now + 60), now), now + 30)
        self.assertEqual(edgekv._refresh_at("ekv_not_a_jwt", now), float("inf"))

    def test_create_token_asks_for_a_token_for_one_database(self):
        kv, seen = client([ok({"token": "eyJ.x.y", "scope": "write", "expires_at": "2026-10-15T13:00:00Z"}, 201)])
        token = kv.database("notes-user-1").create_token(scope="write", ttl_seconds=600, subject="user-1")
        self.assertEqual(token, edgekv.Token("eyJ.x.y", "write", "2026-10-15T13:00:00Z"))
        self.assertEqual(seen[0]["url"].path, "/v1/db/notes-user-1/tokens")
        self.assertEqual(json.loads(seen[0]["body"]), {"scope": "write", "ttl_seconds": 600, "subject": "user-1"})

    def test_an_api_key_or_tokens_never_both_and_tokens_cannot_manage_databases(self):
        with self.fails("BAD_REQUEST"):
            EdgeKV(url="https://api.test")
        with self.fails("BAD_REQUEST"):
            EdgeKV("ekv_k", "https://api.test", tokens=lambda database: "t")
        kv, seen = client([], control_url="https://cp.test", tokens=lambda database: "t")
        with self.fails("BAD_REQUEST") as failed:
            kv.regions()
        self.assertIn("API key", failed.error.message)
        self.assertEqual(seen, [])


def jwt(seconds, token_id="a"):
    """A token that expires ``seconds`` from now, in the shape the service mints (only ``exp`` is read)."""

    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'HS256'})}.{part({'exp': int(time.time()) + seconds, 'jti': token_id})}.sig"


try:
    import cryptography  # noqa: F401

    HAVE_CRYPTOGRAPHY = True
except ImportError:
    HAVE_CRYPTOGRAPHY = False

KEY = bytes(range(32))
OTHER_KEY = bytes([9]) * 32

#: The format shared with the valkvedge library and the TypeScript client: the
#: same vector is checked in each of them.
VECTOR = {
    "database": "agent-memory",
    "key": b"facts/name",
    "value": b"Ada Lovelace",
    "nonce": bytes(range(0xA0, 0xAC)),
    "sealed": bytes.fromhex("a0a1a2a3a4a5a6a7a8a9aaab4dcf197f0189b4c8cc6e9071b3f75750df0d5894317f0dd9e2ece8f5"),
}


@unittest.skipUnless(HAVE_CRYPTOGRAPHY, 'needs pip install "valkv-edgekv[encryption]"')
class EncryptionTests(unittest.TestCase):
    def fails(self, code, status=None):
        return ErrorCode(self, code, status)

    def test_values_are_sealed_in_the_library_format_bound_to_their_database_and_key(self):
        from edgekv._crypto import ValueCipher

        cipher = ValueCipher(KEY, VECTOR["database"])
        sealed = cipher.seal(VECTOR["key"], VECTOR["value"], VECTOR["nonce"])
        self.assertEqual(sealed, VECTOR["sealed"])
        self.assertEqual(len(sealed), len(VECTOR["value"]) + edgekv.ENCRYPTION_OVERHEAD)
        self.assertEqual(cipher.open(VECTOR["key"], sealed), VECTOR["value"])

        self.assertIsNone(cipher.open(b"facts/other", sealed), "moved to another key")
        self.assertIsNone(ValueCipher(KEY, "other-db").open(VECTOR["key"], sealed), "moved to another database")
        self.assertIsNone(ValueCipher(OTHER_KEY, VECTOR["database"]).open(VECTOR["key"], sealed), "another key")
        self.assertIsNone(cipher.open(VECTOR["key"], sealed[:-1] + bytes([sealed[-1] ^ 1])), "tampered")
        self.assertIsNone(cipher.open(VECTOR["key"], b"short"), "too short to be sealed")
        self.assertNotEqual(cipher.seal(b"k", b"v"), cipher.seal(b"k", b"v"))

    def test_an_encryption_key_is_32_bytes_or_64_hexadecimal_characters(self):
        kv, _ = client([])
        self.assertTrue(kv.database("a", encryption_key=KEY.hex()).encrypted)
        self.assertTrue(kv.database("a", encryption_key=KEY.hex().upper()).encrypted)
        self.assertFalse(kv.database("a").encrypted)
        for wrong in (bytes(16), "abc", KEY.hex()[2:], KEY.hex()[2:] + "zz"):
            with self.fails("BAD_REQUEST"):
                kv.database("a", encryption_key=wrong)

    def test_with_a_key_put_sends_ciphertext_and_get_returns_the_value(self):
        kv, seen = client([ok({"lsn": 1})])
        kv.database(VECTOR["database"], encryption_key=KEY).put("facts/name", "Ada Lovelace")
        sent = seen[0]["body"]
        self.assertEqual(len(sent), len(VECTOR["value"]) + edgekv.ENCRYPTION_OVERHEAD)
        self.assertNotIn(VECTOR["value"], sent)

        reader, _ = client([(200, {}, sent), (200, {}, VECTOR["sealed"])])
        same = reader.database(VECTOR["database"], encryption_key=KEY.hex())
        self.assertEqual(same.get_text("facts/name"), "Ada Lovelace")
        self.assertEqual(same.get_text("facts/name"), "Ada Lovelace", "a value sealed by another client opens")

    def test_the_wrong_key_or_a_value_that_was_not_encrypted_fails_with_invalid_encryption_key(self):
        kv, _ = client([(200, {}, VECTOR["sealed"]), (200, {}, b"plain text"), (200, {}, VECTOR["sealed"])])
        with self.fails("INVALID_ENCRYPTION_KEY") as failed:
            kv.database(VECTOR["database"], encryption_key=OTHER_KEY).get("facts/name")
        self.assertEqual(failed.error.key, b"facts/name")
        with self.fails("INVALID_ENCRYPTION_KEY"):
            kv.database(VECTOR["database"], encryption_key=KEY).get("facts/name")
        # Without a key, the stored bytes come back as they are.
        self.assertEqual(kv.database(VECTOR["database"]).get("facts/name"), VECTOR["sealed"])

    def test_with_a_key_commits_seal_each_value_under_its_own_key_and_scans_open_them(self):
        kv, seen = client([ok({"lsn": 2})])
        kv.database("memory", encryption_key=KEY).commit(
            [
                {"op": "put", "key": "facts/a", "value": "one"},
                {"op": "put", "key": "facts/b", "value": "two"},
                {"op": "delete", "key": "facts/c"},
            ]
        )
        ops = json.loads(seen[0]["body"])["ops"]
        self.assertEqual(ops[2], {"op": "delete", "key": b64("facts/c")})
        items = [
            {"key": ops[0]["key"], "value": ops[0]["value"], "version": "v1"},
            {"key": ops[1]["key"], "value": ops[1]["value"], "version": "v2"},
        ]
        moved = [{**items[0], "key": b64("facts/b")}]
        reader, _ = client([ok({"items": items, "next_page_token": None}), ok({"items": moved, "next_page_token": None})])
        db = reader.database("memory", encryption_key=KEY)
        self.assertEqual(
            [(e.key, e.value, e.version) for e in db.scan(prefix="facts/")],
            [("facts/a", b"one", "v1"), ("facts/b", b"two", "v2")],
        )
        with self.fails("INVALID_ENCRYPTION_KEY"):
            db.scan_page()

    def test_update_reads_decrypts_and_writes_back_sealed_under_the_version_it_read(self):
        from edgekv._crypto import ValueCipher

        cipher = ValueCipher(KEY, "counters")
        kv, seen = client([(200, {"x-edgekv-version": "v7"}, cipher.seal(b"hits", b"41")), ok({"lsn": 8})])
        kv.database("counters", encryption_key=KEY).update("hits", lambda current: str(int(current) + 1))
        self.assertEqual(seen[1]["headers"]["If-Match"], "v7")
        self.assertEqual(cipher.open(b"hits", seen[1]["body"]), b"42")


class WithoutCryptographyTests(unittest.TestCase):
    @unittest.skipIf(HAVE_CRYPTOGRAPHY, "cryptography is installed")
    def test_a_key_without_the_cryptography_package_says_what_to_install(self):
        kv, _ = client([])
        with self.assertRaises(EdgeKVError) as raised:
            kv.database("a", encryption_key=KEY)
        self.assertEqual(raised.exception.code, "BAD_REQUEST")
        self.assertIn("valkv-edgekv[encryption]", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
