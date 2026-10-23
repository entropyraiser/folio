"""
Storage: one SQLite file (folio.db) holds the portfolio, its saved versions, the
daily net worth history, the last good quotes and any pending stock splits.

SQLite makes every save atomic, lets the server and the command line tool work
on the same file, and replaces the old data.json and history.jsonl pair.
Portfolio and history rows can be encrypted (see crypto.py); quotes and splits
hold only public market data and stay readable.

The old files are read once, on first start, and left where they are.
"""
import datetime
import json
import os
import re
import sqlite3
import threading
import time

import crypto

SCHEMA_VERSION = 1
LIST_KEYS = ("us", "in", "bcash", "bank", "hand", "pf", "other")
KEEP_BACKUPS = 30
KEEP_VERSIONS = 30
DAILY_BACKUP_RE = re.compile(r"^folio-\d{4}-\d{2}-\d{2}\.db$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS portfolio (
  id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, body BLOB NOT NULL, saved_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS portfolio_versions (
  rev INTEGER PRIMARY KEY, saved_at INTEGER NOT NULL, body BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS history (
  date TEXT PRIMARY KEY, final INTEGER NOT NULL, body BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS quotes (
  sym TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS splits (
  sym TEXT NOT NULL, date TEXT NOT NULL, ratio REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY (sym, date));
"""


class RevConflict(Exception):
    def __init__(self, rev):
        super().__init__(f"portfolio is at revision {rev}")
        self.rev = rev


class StoreError(Exception):
    pass


def validate_portfolio(obj):
    if not isinstance(obj, dict):
        raise ValueError("expected a JSON object")
    if not isinstance(obj.get("settings"), dict):
        raise ValueError("expected a settings object")
    for key in LIST_KEYS:
        if key in obj and not isinstance(obj[key], list):
            raise ValueError(f"expected {key} to be a list")


def unwrap_legacy(stored):
    """(portfolio, rev) from a data.json body. Older files are the portfolio itself, at rev 1."""
    if isinstance(stored, dict) and isinstance(stored.get("rev"), int) and isinstance(stored.get("portfolio"), dict):
        return stored["portfolio"], stored["rev"]
    return stored, 1


class Store:
    def __init__(self, path, backup_dir=None, key=None, log=None):
        self.path = os.path.abspath(path)
        self.backup_dir = backup_dir or os.path.join(os.path.dirname(self.path), "data-backups")
        self._key_given = key
        self._log = log or (lambda msg: None)
        self._local = threading.local()
        self._write_lock = threading.RLock()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with self._write_lock:
            db = self._db()
            db.executescript(SCHEMA)
            if self.meta("schema") is None:
                self.set_meta("schema", str(SCHEMA_VERSION))
        if self.encrypted() and self._key() is None:
            raise StoreError(
                "The data is encrypted but its key was not found in the Keychain. "
                "Unlock the login keychain, or restore the key, and start again.")

    # ---------- connection ----------
    def _db(self):
        db = getattr(self._local, "db", None)
        if db is None:
            db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA foreign_keys=ON")
            self._local.db = db
        return db

    def close(self):
        db = getattr(self._local, "db", None)
        if db is not None:
            db.close()
            self._local.db = None

    # ---------- meta ----------
    def meta(self, k, default=None):
        row = self._db().execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return row[0] if row else default

    def set_meta(self, k, v):
        self._db().execute("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))

    # ---------- encryption ----------
    def encrypted(self):
        return self.meta("encrypted") == "1"

    def _key(self):
        return self._key_given or crypto.keychain_get()

    def _pack(self, obj):
        raw = json.dumps(obj, separators=(",", ":")).encode()
        if self.encrypted():
            key = self._key()
            if key is None:
                raise StoreError("encryption key unavailable")
            return crypto.encrypt(key, raw)
        return raw

    def _unpack(self, blob):
        blob = bytes(blob)
        if blob.startswith(crypto.MAGIC):
            key = self._key()
            if key is None:
                raise StoreError("encryption key unavailable")
            blob = crypto.decrypt(key, blob)
        return json.loads(blob)

    def set_encryption(self, on, key=None):
        """Re-write every encrypted-or-not row. All inside one transaction."""
        with self._write_lock:
            if on:
                key = key or self._key_given or crypto.keychain_get() or crypto.keychain_create()
                self._key_given = key
            elif not self._key():
                raise StoreError("encryption key unavailable")
            db = self._db()
            db.execute("PRAGMA secure_delete=ON")  # freed pages that held readable rows are wiped, not left behind
            db.execute("BEGIN IMMEDIATE")
            try:
                rows = {
                    "portfolio": db.execute("SELECT id, body FROM portfolio").fetchall(),
                    "portfolio_versions": db.execute("SELECT rev, body FROM portfolio_versions").fetchall(),
                    "history": db.execute("SELECT date, body FROM history").fetchall(),
                }
                plain = {t: [(k, self._unpack(b)) for k, b in r] for t, r in rows.items()}
                db.execute("INSERT INTO meta (k, v) VALUES ('encrypted', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                           ("1" if on else "0",))
                keycol = {"portfolio": "id", "portfolio_versions": "rev", "history": "date"}
                for table, items in plain.items():
                    for k, obj in items:
                        db.execute(f"UPDATE {table} SET body=? WHERE {keycol[table]}=?", (self._pack(obj), k))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            db.execute("VACUUM")  # rewrite the file so no old readable copy stays in it
            if not on:
                self._key_given = None

    # ---------- backups ----------
    def _daily_backup(self):
        """First write of the day: keep a consistent copy of the database as it
        was before that write."""
        os.makedirs(self.backup_dir, exist_ok=True)
        dest = os.path.join(self.backup_dir, f"folio-{datetime.date.today().isoformat()}.db")
        if os.path.exists(dest):
            return
        self.backup_to(dest)
        names = sorted(n for n in os.listdir(self.backup_dir) if DAILY_BACKUP_RE.match(n))
        for old in names[:-KEEP_BACKUPS]:
            try:
                os.remove(os.path.join(self.backup_dir, old))
            except OSError:
                pass

    def backup_to(self, dest):
        tmp = dest + ".tmp"
        if os.path.exists(tmp):
            os.remove(tmp)
        out = sqlite3.connect(tmp)
        try:
            self._db().backup(out)
            out.execute("PRAGMA journal_mode=DELETE")
        finally:
            out.close()
        for extra in ("-wal", "-shm"):  # the copy is one self-contained file
            try:
                os.remove(tmp + extra)
            except FileNotFoundError:
                pass
        os.replace(tmp, dest)

    def export_to(self, dest, secrets=None):
        """A backup for moving machines: the database plus small secrets that live
        outside it (such as the price-source key), packed like the rest of the data."""
        self.backup_to(dest)
        secrets = {k: v for k, v in (secrets or {}).items() if v}
        if secrets:
            out = sqlite3.connect(dest)
            try:
                out.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('secrets', ?)", (self._pack(secrets),))
                out.commit()
            finally:
                out.close()

    def take_secrets(self):
        """Read the secrets that came in with a restored backup, and remove them from the database."""
        db = self._db()
        row = db.execute("SELECT v FROM meta WHERE k='secrets'").fetchone()
        if not row:
            return {}
        db.execute("DELETE FROM meta WHERE k='secrets'")
        try:
            got = self._unpack(row[0])
        except (ValueError, StoreError, crypto.CryptoError):
            return {}
        return got if isinstance(got, dict) else {}

    # ---------- portfolio ----------
    def read_portfolio(self):
        """(portfolio, rev); (None, 0) before the first save."""
        row = self._db().execute("SELECT rev, body FROM portfolio WHERE id=1").fetchone()
        if not row:
            return None, 0
        return self._unpack(row[1]), row[0]

    def write_portfolio(self, obj, expected_rev):
        """Replace the portfolio only when expected_rev is the revision stored
        now. Returns the new revision; raises RevConflict when another save
        landed first."""
        validate_portfolio(obj)
        with self._write_lock:
            self._daily_backup()
            db = self._db()
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT rev FROM portfolio WHERE id=1").fetchone()
                rev = row[0] if row else 0
                if expected_rev != rev:
                    raise RevConflict(rev)
                body, now = self._pack(obj), int(time.time())
                db.execute(
                    "INSERT INTO portfolio (id, rev, body, saved_at) VALUES (1, ?, ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET rev=excluded.rev, body=excluded.body, saved_at=excluded.saved_at",
                    (rev + 1, body, now))
                db.execute("INSERT OR REPLACE INTO portfolio_versions (rev, saved_at, body) VALUES (?, ?, ?)", (rev + 1, now, body))
                db.execute("DELETE FROM portfolio_versions WHERE rev <= ?", (rev + 1 - KEEP_VERSIONS,))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        return rev + 1

    def versions(self):
        rows = self._db().execute("SELECT rev, saved_at FROM portfolio_versions ORDER BY rev DESC").fetchall()
        return [{"rev": r, "savedAt": t} for r, t in rows]

    def read_version(self, rev):
        row = self._db().execute("SELECT body FROM portfolio_versions WHERE rev=?", (rev,)).fetchone()
        return self._unpack(row[0]) if row else None

    # ---------- history ----------
    def history_all(self):
        rows = self._db().execute("SELECT body FROM history ORDER BY date").fetchall()
        return [self._unpack(b) for (b,) in rows]

    def history_put(self, records):
        if not records:
            return
        with self._write_lock:
            self._daily_backup()
            db = self._db()
            db.execute("BEGIN IMMEDIATE")
            try:
                for rec in records:
                    db.execute(
                        "INSERT INTO history (date, final, body) VALUES (?, ?, ?) "
                        "ON CONFLICT(date) DO UPDATE SET final=excluded.final, body=excluded.body",
                        (rec["date"], 1 if rec.get("final") else 0, self._pack(rec)))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    # ---------- quotes ----------
    def quotes_get(self, symbols=None):
        rows = self._db().execute("SELECT sym, body, fetched_at FROM quotes").fetchall()
        out = {}
        for sym, body, at in rows:
            if symbols is None or sym in symbols:
                out[sym] = {**json.loads(body), "fetchedAt": at}
        return out

    def quotes_put(self, items):
        if not items:
            return
        now = int(time.time())
        with self._write_lock:
            db = self._db()
            db.execute("BEGIN IMMEDIATE")
            try:
                for sym, q in items.items():
                    db.execute(
                        "INSERT INTO quotes (sym, body, fetched_at) VALUES (?, ?, ?) "
                        "ON CONFLICT(sym) DO UPDATE SET body=excluded.body, fetched_at=excluded.fetched_at",
                        (sym, json.dumps(q, separators=(",", ":")), now))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    # ---------- splits ----------
    def splits_note(self, sym, date, ratio):
        """Record a split once. Returns True when it is new."""
        with self._write_lock:
            cur = self._db().execute(
                "INSERT OR IGNORE INTO splits (sym, date, ratio, status) VALUES (?, ?, ?, 'pending')", (sym, date, ratio))
            return cur.rowcount > 0

    def splits_list(self, status=None):
        q = "SELECT sym, date, ratio, status FROM splits" + (" WHERE status=?" if status else "") + " ORDER BY date"
        rows = self._db().execute(q, (status,) if status else ()).fetchall()
        return [{"sym": s, "date": d, "ratio": r, "status": st} for s, d, r, st in rows]

    def splits_set(self, sym, date, status):
        with self._write_lock:
            cur = self._db().execute("UPDATE splits SET status=? WHERE sym=? AND date=?", (status, sym, date))
            return cur.rowcount > 0

    # ---------- legacy import ----------
    def import_legacy(self, data_file, history_file):
        """Bring in data.json and history.jsonl on the first start. Leaves them untouched."""
        done = []
        if self.meta("imported_legacy") == "1":
            return done
        portfolio, rev = self.read_portfolio()
        if portfolio is None and data_file and os.path.exists(data_file):
            with open(data_file, "r", encoding="utf-8") as f:
                stored = json.load(f)
            pf, rev = unwrap_legacy(stored)
            validate_portfolio(pf)
            with self._write_lock:
                db = self._db()
                db.execute("BEGIN IMMEDIATE")
                try:
                    body, now = self._pack(pf), int(time.time())
                    db.execute("INSERT INTO portfolio (id, rev, body, saved_at) VALUES (1, ?, ?, ?)", (rev, body, now))
                    db.execute("INSERT OR REPLACE INTO portfolio_versions (rev, saved_at, body) VALUES (?, ?, ?)", (rev, now, body))
                    db.execute("COMMIT")
                except BaseException:
                    db.execute("ROLLBACK")
                    raise
            done.append(f"portfolio (rev {rev}) from {data_file}")
        if not self.history_all() and history_file and os.path.exists(history_file):
            recs = []
            with open(history_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(rec, dict) and isinstance(rec.get("date"), str):
                        recs.append(rec)
            self.history_put(recs)
            done.append(f"{len(recs)} history day(s) from {history_file}")
        self.set_meta("imported_legacy", "1")
        if done:  # a backup that has everything just imported (the daily one was taken before the first write)
            os.makedirs(self.backup_dir, exist_ok=True)
            self.backup_to(os.path.join(self.backup_dir, f"folio-imported-{datetime.datetime.now():%Y%m%dT%H%M%S}.db"))
        return done

    # ---------- restore ----------
    def restore_from(self, src_path):
        """Replace everything with the contents of a backup database. The
        current state is kept first, and the revision moves forward so any open
        browser reloads instead of overwriting the restored data."""
        report = verify_db(src_path, self._key_given)
        if not report["ok"]:
            raise StoreError("backup failed verification: " + "; ".join(report["problems"]))
        with self._write_lock:
            os.makedirs(self.backup_dir, exist_ok=True)
            stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
            keep = os.path.join(self.backup_dir, f"folio-before-restore-{stamp}.db")
            self.backup_to(keep)
            _, current_rev = self.read_portfolio()
            src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
            try:
                src.backup(self._db())
            finally:
                src.close()
            portfolio, rev = self.read_portfolio()
            if portfolio is not None and rev <= current_rev:
                db = self._db()
                db.execute("UPDATE portfolio SET rev=? WHERE id=1", (current_rev + 1,))
        return {"kept": keep, "report": report}

    def restore_json(self, json_path):
        """Restore the portfolio from a legacy data.json style backup."""
        with open(json_path, "r", encoding="utf-8") as f:
            pf, _ = unwrap_legacy(json.load(f))
        validate_portfolio(pf)
        _, rev = self.read_portfolio()
        return self.write_portfolio(pf, rev)


def verify_db(path, key=None):
    """Open a database read-only and check that it is whole and readable."""
    report = {"path": path, "ok": False, "problems": [], "rev": None, "history_days": 0, "holdings": 0, "encrypted": False}
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        report["problems"].append(f"cannot open: {exc}")
        return report
    try:
        try:
            check = db.execute("PRAGMA integrity_check").fetchall()
        except sqlite3.Error as exc:
            report["problems"].append(f"not a database: {exc}")
            return report
        if check != [("ok",)]:
            report["problems"].append("integrity check: " + "; ".join(str(r[0]) for r in check[:3]))
            return report
        names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for need in ("meta", "portfolio", "history"):
            if need not in names:
                report["problems"].append(f"missing table {need}")
        if report["problems"]:
            return report
        enc = db.execute("SELECT v FROM meta WHERE k='encrypted'").fetchone()
        report["encrypted"] = bool(enc and enc[0] == "1")

        def unpack(blob):
            blob = bytes(blob)
            if blob.startswith(crypto.MAGIC):
                k = key or crypto.keychain_get()
                if k is None:
                    raise StoreError("encryption key unavailable")
                blob = crypto.decrypt(k, blob)
            return json.loads(blob)

        try:
            row = db.execute("SELECT rev, body FROM portfolio WHERE id=1").fetchone()
            if row:
                report["rev"] = row[0]
                pf = unpack(row[1])
                validate_portfolio(pf)
                report["holdings"] = sum(len(pf.get(k) or []) for k in LIST_KEYS)
            days = 0
            for (body,) in db.execute("SELECT body FROM history"):
                rec = unpack(body)
                if not isinstance(rec, dict) or "date" not in rec:
                    raise ValueError("history row without a date")
                days += 1
            report["history_days"] = days
        except (ValueError, StoreError, crypto.CryptoError) as exc:
            report["problems"].append(f"unreadable rows: {exc}")
            return report
        report["ok"] = True
        return report
    finally:
        db.close()


def open_default(db_file, log=None, key=None):
    """Open the database, importing an older data.json and history.jsonl that
    sit beside it the first time."""
    log = log or (lambda msg: None)
    store = Store(db_file, log=log, key=key)
    folder = os.path.dirname(os.path.abspath(db_file))
    data = os.environ.get("DATA_FILE", os.path.join(folder, "data.json"))
    hist = os.environ.get("HISTORY_FILE", os.path.join(folder, "history.jsonl"))
    for line in store.import_legacy(data, hist):
        log(f"imported {line}; the old file was left in place")
    return store
