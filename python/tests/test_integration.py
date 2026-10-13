"""Tests of the client against a running service. They create a database, use it and delete it.

    EDGEKV_URL          the data API, e.g. https://api.example.com
    EDGEKV_CONTROL_URL  where databases are managed, e.g. https://cp.example.com
    EDGEKV_API_KEY      a key that may manage databases
"""

import os
import threading
import time
import unittest

from edgekv import EdgeKV, EdgeKVError


def env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required for the integration tests")
    return value


def eventually(code, attempt, seconds=30):
    """Retries while `attempt` raises `code`, for things the service applies within seconds."""
    deadline = time.monotonic() + seconds
    while True:
        try:
            return attempt()
        except EdgeKVError as error:
            if error.code != code or time.monotonic() > deadline:
                raise
            time.sleep(0.5)


class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.kv = EdgeKV(env("EDGEKV_API_KEY"), env("EDGEKV_URL"), env("EDGEKV_CONTROL_URL"))
        cls.name = f"sdk-py-{int(time.time() * 1000)}"
        regions = cls.kv.regions()
        assert regions, "the service offers at least one region"
        cls.info = cls.kv.databases.create(cls.name, regions[0])
        assert cls.info.name == cls.name and cls.info.status == "active"
        cls.db = cls.kv.database(cls.name)
        # A new database is usable on the data API a moment after it is created.
        eventually("NOT_FOUND", lambda: cls.db.put("warm-up", "x"))
        cls.db.delete("warm-up")

    @classmethod
    def tearDownClass(cls):
        try:
            cls.kv.databases.delete(cls.info.id)
        except EdgeKVError:
            pass

    def assertFails(self, code, call, status=None):
        with self.assertRaises(EdgeKVError) as caught:
            call()
        self.assertEqual(caught.exception.code, code)
        if status is not None:
            self.assertEqual(caught.exception.status, status)

    def test_the_new_database_is_listed_and_can_be_read_back(self):
        self.assertIn(self.name, [database.name for database in self.kv.databases.list()])
        read = self.kv.databases.get(self.info.id)
        self.assertEqual(read.id, self.info.id)
        self.assertIsInstance(read.stored_bytes, int)
        self.assertIsInstance(self.kv.databases.usage(self.info.id), list)

    def test_a_name_that_is_taken_or_not_valid_is_refused_with_its_own_code(self):
        region = self.info.region
        self.assertFails("NAME_CONFLICT", lambda: self.kv.databases.create(self.name, region))
        self.assertFails("INVALID_NAME", lambda: self.kv.databases.create("Not Valid", region))
        self.assertFails("REGION_UNAVAILABLE", lambda: self.kv.databases.create("fine-name", "nowhere-1"))

    def test_put_get_and_delete_as_bytes_text_and_json(self):
        db = self.db
        first = db.put("greeting", "hello")
        self.assertGreater(first, 0)
        self.assertEqual(db.get_text("greeting"), "hello")

        blob = bytes([0, 1, 2, 254, 255])
        second = db.put("blob", blob)
        self.assertGreater(second, first, "later writes have higher positions")
        self.assertEqual(db.get("blob"), blob)

        db.put_json("settings", {"theme": "dark", "sizes": [1, 2]})
        self.assertEqual(db.get_json("settings"), {"theme": "dark", "sizes": [1, 2]})

        db.delete("greeting")
        self.assertIsNone(db.get("greeting"))
        db.delete("never-existed")  # deleting what is not there is fine

    def test_keys_with_slashes_spaces_and_non_ascii_characters_round_trip(self):
        for key in ["users/42/name", "with space", "query?and#hash", "naïve/日本語", "percent%20literal"]:
            self.db.put(key, f"value of {key}")
            self.assertEqual(self.db.get_text(key), f"value of {key}", key)

    def test_a_commit_applies_together_and_reaches_keys_that_are_not_text(self):
        db = self.db
        binary_key = bytes([0xFF, 0x00, 0x01])
        db.put("batch/old", "to be removed")
        db.commit(
            [
                {"op": "put", "key": "batch/a", "value": "1"},
                {"op": "put", "key": "batch/b", "value": "2"},
                {"op": "delete", "key": "batch/old"},
                {"op": "put", "key": binary_key, "value": "binary key"},
            ]
        )
        self.assertEqual(db.get_text("batch/a"), "1")
        self.assertEqual(db.get_text("batch/b"), "2")
        self.assertIsNone(db.get("batch/old"))
        # The binary key is there too: it comes back from a scan with its bytes.
        self.assertEqual([entry.value for entry in db.scan() if entry.key_bytes == binary_key], [b"binary key"])

    def test_scan_returns_a_prefix_in_key_order_across_pages(self):
        db = self.db
        db.commit([{"op": "put", "key": f"scan/{i:02d}", "value": f"v{i}"} for i in range(25)])
        db.put("scanother/x", "outside the prefix")

        keys = [entry.key for entry in db.scan(prefix="scan/", page_size=10)]
        self.assertEqual(len(keys), 25)
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(keys[0], "scan/00")

        page = db.scan_page(prefix="scan/", page_size=10)
        self.assertEqual(len(page.items), 10)
        self.assertIsInstance(page.next_page_token, str)
        self.assertEqual(page.items[3].value, b"v3")
        self.assertFails("BAD_REQUEST", lambda: db.scan_page(page_size=1000))

    def test_wait_for_change_returns_on_a_write_and_on_its_timeout_otherwise(self):
        db = self.db
        lsn = db.head().lsn
        started = time.monotonic()
        idle = db.wait_for_change(lsn, 0.6)
        self.assertEqual(idle.lsn, lsn)
        self.assertGreaterEqual(time.monotonic() - started, 0.5, "it waited")

        woke = []
        waiter = threading.Thread(target=lambda: woke.append(db.wait_for_change(lsn, 20)))
        waiter.start()
        time.sleep(0.3)
        written = db.put("wake", "up")
        waiter.join(timeout=25)
        self.assertFalse(waiter.is_alive(), "woken by the write, not by the timeout")
        self.assertEqual(woke[0].lsn, written)

    def test_a_database_that_does_not_exist_and_a_wrong_key_are_told_apart(self):
        self.assertFails("NOT_FOUND", lambda: self.kv.database("no-such-database").get("k"), 404)
        stranger = EdgeKV("ekv_this-key-was-never-issued-000000", env("EDGEKV_URL"), env("EDGEKV_CONTROL_URL"))
        self.assertFails("UNAUTHENTICATED", lambda: stranger.database(self.name).get("k"), 401)
        self.assertFails("UNAUTHENTICATED", stranger.regions)

    def test_a_deleted_database_stops_being_served(self):
        doomed = self.kv.databases.create(f"{self.name}-gone", self.info.region)
        gone = self.kv.database(doomed.name)
        eventually("NOT_FOUND", lambda: gone.put("k", "v"))
        self.kv.databases.delete(doomed.id)
        deadline = time.monotonic() + 30
        while True:
            try:
                gone.get("k")
                result = "served"
            except EdgeKVError as error:
                result = error.code
            if result == "NOT_FOUND":
                break
            self.assertLess(time.monotonic(), deadline, f"still {result} 30 s after the delete")
            time.sleep(0.5)


if __name__ == "__main__":
    unittest.main()
