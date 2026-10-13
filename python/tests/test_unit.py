"""Tests of the client against a stand-in for the network. No requests leave the process."""

import base64
import json
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


def client(answers, retries=0, control_url=None):
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

    kv = EdgeKV("ekv_test_key", "https://api.test/", control_url, retries=retries, transport=transport)
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


if __name__ == "__main__":
    unittest.main()
