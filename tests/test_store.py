import json
import os
import sqlite3
import unittest

from helpers import KEY, sample_portfolio, tmpdir

import crypto
from store import RevConflict, Store, StoreError, open_default, validate_portfolio, verify_db


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tmpdir()
        self.dir = self._tmp.name
        self.db = os.path.join(self.dir, "folio.db")
        self.store = Store(self.db)

    def tearDown(self):
        self.store.close()
        self._tmp.cleanup()

    def test_first_save_then_read(self):
        self.assertEqual(self.store.read_portfolio(), (None, 0))
        rev = self.store.write_portfolio(sample_portfolio(), 0)
        pf, got = self.store.read_portfolio()
        self.assertEqual((rev, got), (1, 1))
        self.assertEqual(pf["us"][0]["symbol"], "AAPL")

    def test_stale_revision_is_refused_and_nothing_changes(self):
        self.store.write_portfolio(sample_portfolio(), 0)
        changed = sample_portfolio()
        changed["us"] = []
        with self.assertRaises(RevConflict) as ctx:
            self.store.write_portfolio(changed, 0)
        self.assertEqual(ctx.exception.rev, 1)
        self.assertEqual(len(self.store.read_portfolio()[0]["us"]), 1)

    def test_invalid_portfolio_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_portfolio({"us": []})
        with self.assertRaises(ValueError):
            validate_portfolio({"settings": {}, "us": "nope"})

    def test_versions_are_kept_and_trimmed(self):
        rev = 0
        for n in range(35):
            pf = sample_portfolio()
            pf["bank"][0]["balance"] = n
            rev = self.store.write_portfolio(pf, rev)
        versions = self.store.versions()
        self.assertEqual(len(versions), 30)
        self.assertEqual(versions[0]["rev"], 35)
        self.assertEqual(self.store.read_version(35)["bank"][0]["balance"], 34)
        self.assertIsNone(self.store.read_version(1))

    def test_daily_backup_holds_the_state_before_the_first_write(self):
        self.store.write_portfolio(sample_portfolio(), 0)          # creates today's backup (empty database)
        names = [n for n in os.listdir(self.store.backup_dir) if n.startswith("folio-2")]
        self.assertEqual(len(names), 1, names)
        later = sample_portfolio()
        later["bank"][0]["balance"] = 1
        self.store.write_portfolio(later, 1)                       # same day: backup is not replaced
        self.assertEqual(len([n for n in os.listdir(self.store.backup_dir) if n.startswith("folio-2")]), 1)

    def test_backup_verifies_and_restores_round_trip(self):
        rev = self.store.write_portfolio(sample_portfolio(), 0)
        self.store.history_put([{"date": "2026-10-01", "net": 100.0, "final": True, "items": []}])
        backup = os.path.join(self.dir, "copy.db")
        self.store.backup_to(backup)
        report = verify_db(backup)
        self.assertTrue(report["ok"], report)
        self.assertEqual((report["holdings"], report["history_days"]), (5, 1))
        # change everything, then restore
        broken = sample_portfolio()
        broken["us"], broken["bank"] = [], []
        self.store.write_portfolio(broken, rev)
        self.store.history_put([{"date": "2026-10-02", "net": 5.0, "final": False}])
        result = self.store.restore_from(backup)
        pf, new_rev = self.store.read_portfolio()
        self.assertEqual(len(pf["us"]), 1)
        self.assertEqual([r["date"] for r in self.store.history_all()], ["2026-10-01"])
        self.assertGreater(new_rev, 2, "the revision moves forward so open browsers reload")
        self.assertTrue(os.path.exists(result["kept"]))
        self.assertTrue(verify_db(result["kept"])["ok"], "what was there before the restore is kept")

    def test_verify_rejects_a_damaged_file(self):
        self.store.write_portfolio(sample_portfolio(), 0)
        backup = os.path.join(self.dir, "copy.db")
        self.store.backup_to(backup)
        with open(backup, "r+b") as f:
            f.seek(0)
            f.write(b"not a database at all")
        self.assertFalse(verify_db(backup)["ok"])
        junk = os.path.join(self.dir, "junk.db")
        sqlite3.connect(junk).execute("CREATE TABLE x (a)").connection.commit()
        self.assertFalse(verify_db(junk)["ok"])

    def test_restore_refuses_a_bad_backup_and_changes_nothing(self):
        self.store.write_portfolio(sample_portfolio(), 0)
        junk = os.path.join(self.dir, "junk.db")
        with open(junk, "wb") as f:
            f.write(b"x" * 100)
        with self.assertRaises(StoreError):
            self.store.restore_from(junk)
        self.assertEqual(self.store.read_portfolio()[1], 1)

    def test_encryption_round_trip(self):
        self.store.write_portfolio(sample_portfolio(), 0)
        self.store.history_put([{"date": "2026-10-01", "net": 123456.0, "final": True}])
        self.store.set_encryption(True, KEY)
        raw = sqlite3.connect(self.db).execute("SELECT body FROM portfolio").fetchone()[0]
        self.assertTrue(bytes(raw).startswith(crypto.MAGIC))
        self.assertNotIn(b"AAPL", bytes(raw))
        self.assertEqual(self.store.read_portfolio()[0]["us"][0]["symbol"], "AAPL")
        self.assertEqual(self.store.history_all()[0]["net"], 123456.0)
        # a new save while encrypted stays encrypted
        pf, rev = self.store.read_portfolio()
        pf["bank"][0]["balance"] = 7
        self.store.write_portfolio(pf, rev)
        for table in ("portfolio", "portfolio_versions", "history"):
            for (body,) in sqlite3.connect(self.db).execute(f"SELECT body FROM {table}"):
                self.assertTrue(bytes(body).startswith(crypto.MAGIC), table)
        on_disk = b""
        for suffix in ("", "-wal"):
            if os.path.exists(self.db + suffix):
                with open(self.db + suffix, "rb") as f:
                    on_disk += f.read()
        self.assertNotIn(b"AAPL", on_disk, "no readable copy of the old rows is left in the file")
        self.assertNotIn(b"123456", on_disk)
        self.store.set_encryption(False)
        raw = sqlite3.connect(self.db).execute("SELECT body FROM portfolio").fetchone()[0]
        self.assertEqual(json.loads(bytes(raw))["bank"][0]["balance"], 7)

    def test_encrypted_data_needs_the_key(self):
        self.store.write_portfolio(sample_portfolio(), 0)
        self.store.set_encryption(True, KEY)
        self.store.close()
        os.environ.pop("FOLIO_KEY", None)
        with self.assertRaises(StoreError):
            Store(self.db, key=None) if crypto.keychain_get() is None else self.skipTest("this machine has a folio key in the Keychain")
        wrong = Store(self.db, key=bytes(32))
        with self.assertRaises(crypto.CryptoError):
            wrong.read_portfolio()
        right = Store(self.db, key=KEY)
        self.assertEqual(right.read_portfolio()[1], 1)

    def test_legacy_files_are_imported_once_and_left_alone(self):
        data = os.path.join(self.dir, "data.json")
        hist = os.path.join(self.dir, "history.jsonl")
        with open(data, "w") as f:
            json.dump({"rev": 41, "portfolio": sample_portfolio()}, f)
        with open(hist, "w") as f:
            f.write(json.dumps({"date": "2026-10-01", "net": 1.0}) + "\n\nnot json\n" + json.dumps({"date": "2026-10-02", "net": 2.0}) + "\n")
        fresh = os.path.join(self.dir, "new.db")
        logs = []
        os.environ["DATA_FILE"], os.environ["HISTORY_FILE"] = data, hist
        try:
            st = open_default(fresh, logs.append)
        finally:
            del os.environ["DATA_FILE"], os.environ["HISTORY_FILE"]
        self.assertEqual(st.read_portfolio()[1], 41)
        self.assertEqual(len(st.history_all()), 2)
        self.assertTrue(os.path.exists(data) and os.path.exists(hist))
        self.assertEqual(len(logs), 2)
        pf, rev = st.read_portfolio()
        pf["bank"][0]["balance"] = 5
        st.write_portfolio(pf, rev)
        again = open_default(fresh)                                # a second start must not import over the new data
        self.assertEqual(again.read_portfolio()[0]["bank"][0]["balance"], 5)

    def test_restore_from_an_old_json_backup(self):
        rev = self.store.write_portfolio(sample_portfolio(), 0)
        old = os.path.join(self.dir, "data-2026-10-01.json")
        pf = sample_portfolio()
        pf["bank"][0]["balance"] = 42
        with open(old, "w") as f:
            json.dump(pf, f)
        self.store.restore_json(old)
        self.assertEqual(self.store.read_portfolio()[0]["bank"][0]["balance"], 42)

    def test_splits_are_noted_once_and_can_be_resolved(self):
        self.assertTrue(self.store.splits_note("NVDA", "2026-06-10", 10.0))
        self.assertFalse(self.store.splits_note("NVDA", "2026-06-10", 10.0))
        self.assertEqual(len(self.store.splits_list("pending")), 1)
        self.assertTrue(self.store.splits_set("NVDA", "2026-06-10", "applied"))
        self.assertEqual(self.store.splits_list("pending"), [])

    def test_last_good_quotes_are_kept(self):
        self.store.quotes_put({"AAPL": {"price": 1.5, "prev": 1.4}})
        got = self.store.quotes_get({"AAPL"})["AAPL"]
        self.assertEqual(got["price"], 1.5)
        self.assertIn("fetchedAt", got)


class CryptoTests(unittest.TestCase):
    def test_round_trip_and_tamper_detection(self):
        blob = crypto.encrypt(KEY, b"net worth 7,103,585")
        self.assertEqual(crypto.decrypt(KEY, blob), b"net worth 7,103,585")
        self.assertNotEqual(blob, crypto.encrypt(KEY, b"net worth 7,103,585"), "a fresh IV each time")
        tampered = bytearray(blob)
        tampered[20] ^= 1
        with self.assertRaises(crypto.CryptoError):
            crypto.decrypt(KEY, bytes(tampered))
        with self.assertRaises(crypto.CryptoError):
            crypto.decrypt(bytes(32), blob)


if __name__ == "__main__":
    unittest.main()
