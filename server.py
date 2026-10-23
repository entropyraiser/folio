#!/usr/bin/env python3
"""
Net worth tracker: server.

Serves the dashboard (web/), fetches live quotes (Yahoo Finance, with
fallbacks), stores your holdings and a daily net worth record in folio.db next
to this file, and keeps backups of it.
No third-party packages needed. Python 3.8+.

Run:   python3 server.py
Open:  http://localhost:8787

Maintenance (backup, restore, verify, encrypt, rebuild history): python3 folio.py --help

Options (environment variables):
  PORT=8787        port to listen on
  HOST=127.0.0.1   interface to bind (keep the default unless you know why)
  DB_FILE=...      the database (default: folio.db next to server.py)
  DATA_FILE=...    older data.json to import on first start (default: data.json next to DB_FILE)
  HISTORY_FILE=... older history.jsonl to import on first start
  LOG_DIR=...      where server.log is written (default: logs/ next to server.py)
"""
import datetime
import ipaddress
import json
import logging
import mimetypes
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from urllib.parse import parse_qs, urlparse

import history as history_mod
import quotes as quotes_mod
from history import History
from quotes import Quotes
from store import DAILY_BACKUP_RE, RevConflict, StoreError, open_default, validate_portfolio, verify_db

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))

SYMBOL_RE = re.compile(r"^[A-Za-z0-9.^=&_\-]{1,24}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_SYMBOLS = 100

DB_FILE = os.environ.get("DB_FILE", os.path.join(HERE, "folio.db"))
_data_dir = os.path.dirname(os.path.abspath(DB_FILE))
DATA_FILE = os.environ.get("DATA_FILE", os.path.join(_data_dir, "data.json"))
HISTORY_FILE = os.environ.get("HISTORY_FILE", os.path.join(_data_dir, "history.jsonl"))
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(HERE, "logs"))
LOG_FILE = os.path.join(LOG_DIR, "server.log")
MAX_BODY = 5 * 1024 * 1024
MAX_RESTORE = 256 * 1024 * 1024   # a whole database file

_log = logging.getLogger("folio")
STORE = None
QUOTES = None
HISTORY = None


def setup_logging():
    """server.log in LOG_DIR, rotated at 1 MB. Also the terminal when run by hand;
    under launchd stderr is logs/launchd.log, which then only gets crashes."""
    _log.setLevel(logging.INFO)
    _log.propagate = False
    fmt = logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%dT%H:%M:%S")
    handlers = []
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        handlers.append(RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=3, encoding="utf-8"))
    except OSError as exc:
        print(f"Could not write {LOG_FILE} ({exc}); logging to the terminal only.", file=sys.stderr)
    if sys.stderr.isatty() or not handlers:
        handlers.append(logging.StreamHandler(sys.stderr))
    for h in handlers:
        h.setFormatter(fmt)
        _log.addHandler(h)


def log_line(msg):
    _log.info(msg)


def read_stored():
    """(portfolio, rev). portfolio is None before the first save."""
    return STORE.read_portfolio()


def write_data(obj, expected_rev):
    return STORE.write_portfolio(obj, expected_rev)


STATIC_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8",
                ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Folio/2.0"

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _peer_is_loopback(self):
        ip = self.client_address[0]
        if ip.startswith("::ffff:"):
            ip = ip[7:]
        try:
            return ipaddress.ip_address(ip).is_loopback
        except ValueError:
            return False

    def _local_only_ok(self):
        """Holdings are private: the connection itself must be from this
        machine, and the page must be one this server served (blocks other
        websites and DNS-rebinding tricks). A widened HOST cannot spoof this
        with a Host header."""
        if not self._peer_is_loopback():
            return False
        hosts = {f"localhost:{PORT}", f"127.0.0.1:{PORT}", f"[::1]:{PORT}", f"{HOST}:{PORT}"}
        if self.headers.get("Host", "") not in hosts:
            return False
        origin = self.headers.get("Origin")
        return not origin or origin in {f"http://{h}" for h in hosts}

    def _if_match(self):
        raw = self.headers.get("If-Match", "").strip().strip('"')
        if not raw.isdigit():
            return None
        return int(raw)

    def _send(self, code, body, ctype, cors=True):
        self.send_response(code)
        if cors:
            self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if ctype.startswith("text/html"):  # everything the page loads comes from this server
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, payload, cors=True):
        self._send(code, json.dumps(payload).encode(), "application/json; charset=utf-8", cors)

    def _private(self):
        """True when the caller may see private data; otherwise answers 403."""
        if self._local_only_ok():
            return True
        self._json(403, {"error": "forbidden"}, cors=False)
        return False

    def _body_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._json(413, {"error": "body missing or too large"}, cors=False)
            return None
        try:
            return json.loads(self.rfile.read(length))
        except ValueError as exc:
            self._json(400, {"error": f"invalid JSON: {exc}"}, cors=False)
            return None

    def do_OPTIONS(self):
        self.send_response(204)
        if urlparse(self.path).path in ("/api/quotes", "/api/search", "/api/health"):
            self._cors()  # public market data only; holdings and history never get CORS headers
        self.end_headers()

    # ---------- writes ----------
    def do_PUT(self):
        if urlparse(self.path).path != "/api/data":
            return self._json(404, {"error": "not found"})
        if not self._private():
            return
        expected = self._if_match()
        if expected is None:
            return self._json(428, {"error": "If-Match revision required"}, cors=False)
        obj = self._body_json()
        if obj is None:
            return
        try:
            validate_portfolio(obj)
            rev = write_data(obj, expected)
        except ValueError as exc:
            return self._json(400, {"error": f"invalid data: {exc}"}, cors=False)
        except RevConflict as exc:
            return self._json(409, {"error": "conflict", "rev": exc.rev}, cors=False)
        except (OSError, StoreError) as exc:
            return self._json(500, {"error": f"could not write data: {exc}"}, cors=False)
        if HISTORY:
            HISTORY.kick()
        self._json(200, {"ok": True, "rev": rev}, cors=False)

    def _restore(self, dry):
        """Take an uploaded backup database. dry=True only reports what is in it."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_RESTORE:
            return self._json(413, {"error": "backup file missing or too large"}, cors=False)
        blob = self.rfile.read(length)
        if not blob.startswith(b"SQLite format 3\x00"):
            return self._json(400, {"error": "That is not a backup file from this tracker."}, cors=False)
        os.makedirs(STORE.backup_dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix="upload-", suffix=".db", dir=STORE.backup_dir)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(blob)
            report = verify_db(tmp, STORE._key_given)
            summary = {k: report[k] for k in ("ok", "problems", "holdings", "history_days", "encrypted")}
            if not report["ok"] or dry:
                return self._json(200 if report["ok"] else 400, summary, cors=False)
            try:
                res = STORE.restore_from(tmp)
            except (StoreError, OSError) as exc:
                return self._json(500, {"error": f"could not restore: {exc}"}, cors=False)
            log_line(f"restored from an uploaded backup ({summary['holdings']} holdings, {summary['history_days']} days); previous state kept as {res['kept']}")
            if HISTORY:
                HISTORY.kick()
            self._json(200, {**summary, "restored": True, "kept": os.path.basename(res["kept"])}, cors=False)
        finally:
            for extra in ("", "-wal", "-shm", "-journal"):
                try:
                    os.remove(tmp + extra)
                except FileNotFoundError:
                    pass

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/restore":
            if not self._private():
                return
            return self._restore("dry" in parse_qs(parsed.query))
        if path not in ("/api/history/rebuild", "/api/splits"):
            return self._json(404, {"error": "not found"})
        if not self._private():
            return
        body = self._body_json()
        if body is None:
            return
        if not isinstance(body, dict):
            return self._json(400, {"error": "expected an object"}, cors=False)
        if path == "/api/splits":
            status = body.get("status")
            if status not in ("applied", "dismissed") or not SYMBOL_RE.match(str(body.get("sym", ""))) \
                    or not DATE_RE.match(str(body.get("date", ""))):
                return self._json(400, {"error": "need sym, date and status applied|dismissed"}, cors=False)
            ok = STORE.splits_set(body["sym"], body["date"], status)
            return self._json(200 if ok else 404, {"ok": ok}, cors=False)
        start = str(body.get("from", ""))
        if not DATE_RE.match(start):
            return self._json(400, {"error": "need from as YYYY-MM-DD"}, cors=False)
        end = body.get("to")
        if end is not None and not DATE_RE.match(str(end)):
            return self._json(400, {"error": "to must be YYYY-MM-DD"}, cors=False)
        try:
            n = HISTORY.rebuild(start, end, bool(body.get("currentHoldings")))
        except ValueError as exc:
            return self._json(400, {"error": str(exc)}, cors=False)
        self._json(200, {"ok": True, "days": n}, cors=False)

    # ---------- reads ----------
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        query = parse_qs(url.query)

        if path == "/api/health":
            return self._json(200, {"ok": True})

        if path == "/api/data":
            if not self._private():
                return
            try:
                data, rev = read_stored()
            except (ValueError, OSError, StoreError) as exc:
                return self._json(500, {"error": f"could not read data: {exc}"}, cors=False)
            return self._json(200, {"exists": data is not None, "data": data, "rev": rev}, cors=False)

        if path == "/api/backup":
            if not self._private():
                return
            os.makedirs(STORE.backup_dir, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix="export-", suffix=".db", dir=STORE.backup_dir)
            os.close(fd)
            try:
                STORE.backup_to(tmp)
                with open(tmp, "rb") as f:
                    blob = f.read()
            except (OSError, StoreError) as exc:
                return self._json(500, {"error": f"could not make a backup: {exc}"}, cors=False)
            finally:
                for extra in ("", "-wal", "-shm", "-journal", ".tmp"):
                    try:
                        os.remove(tmp + extra)
                    except FileNotFoundError:
                        pass
            name = f"folio-backup-{datetime.date.today().isoformat()}.db"
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.send_header("Content-Length", str(len(blob)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(blob)
            return

        if path == "/api/history":
            if not self._private():
                return
            return self._json(200, {"days": HISTORY.summary() if HISTORY else []}, cors=False)

        if path == "/api/attribution":
            if not self._private():
                return
            start, end = query.get("from", [""])[0], query.get("to", [""])[0]
            if (start and not DATE_RE.match(start)) or (end and not DATE_RE.match(end)):
                return self._json(400, {"error": "from and to must be YYYY-MM-DD"}, cors=False)
            return self._json(200, HISTORY.attribution(start or None, end or None), cors=False)

        if path == "/api/history/health":
            if not self._private():
                return
            return self._json(200, HISTORY.health(), cors=False)

        if path == "/api/status":
            if not self._private():
                return
            return self._json(200, storage_status(), cors=False)

        if path == "/api/splits":
            if not self._private():
                return
            return self._json(200, {"splits": STORE.splits_list("pending")}, cors=False)

        if path == "/api/search":
            return self._json(200, {"results": QUOTES.search(query.get("q", [""])[0])})

        if path == "/api/quotes":
            symbols = []
            for s in query.get("symbols", [""])[0].split(","):
                s = s.strip()
                if s and SYMBOL_RE.match(s) and s not in symbols:
                    symbols.append(s)
            symbols = symbols[:MAX_SYMBOLS]
            if not symbols:
                return self._json(400, {"error": "Pass ?symbols=AAPL,RELIANCE.NS,USDINR=X"})
            return self._json(200, {"quotes": QUOTES.fetch_many(symbols), "fetchedAt": int(time.time())})

        return self._static(path)

    def _static(self, path):
        if path in ("/", "/index.html"):
            path = "/index.html"
        rel = os.path.normpath(path.lstrip("/"))
        full = os.path.realpath(os.path.join(WEB, rel))
        if not full.startswith(os.path.realpath(WEB) + os.sep) or not os.path.isfile(full):
            return self._json(404, {"error": "not found"})
        ext = os.path.splitext(full)[1].lower()
        ctype = STATIC_TYPES.get(ext)
        if not ctype:
            return self._json(404, {"error": "not found"})
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)


def storage_status():
    backups = []
    try:
        backups = sorted(n for n in os.listdir(STORE.backup_dir) if DAILY_BACKUP_RE.match(n))
    except OSError:
        pass
    try:
        size = os.path.getsize(STORE.path)
    except OSError:
        size = 0
    return {"encrypted": STORE.encrypted(), "database": STORE.path, "bytes": size,
            "lastBackup": backups[-1] if backups else None, "backups": len(backups),
            "versions": len(STORE.versions()), "migrated": STORE.meta("imported_legacy") == "1"}


def _portfolio_or_none():
    try:
        return read_stored()[0]
    except (ValueError, OSError, StoreError) as exc:
        log_line(f"history: could not read the portfolio: {exc}")
        return None


def _alpha_key_from_file():
    """A key saved in alpha_vantage_api_key.txt next to server.py (or ALPHA_VANTAGE_KEY) works without pasting it into Settings."""
    key = os.environ.get("ALPHA_VANTAGE_KEY", "").strip()
    if key:
        return key
    try:
        with open(os.path.join(HERE, "alpha_vantage_api_key.txt"), "r", encoding="utf-8") as f:
            return f.read().strip().splitlines()[0].strip() if f.readable() else ""
    except (OSError, IndexError):
        return ""


def _settings():
    pf = _portfolio_or_none()
    settings = dict((pf or {}).get("settings") or {})
    if not str(settings.get("alphaKey") or "").strip():
        settings["alphaKey"] = _alpha_key_from_file()
    return settings


def _warm_loop():
    """Keep the last good prices recent, so a page load after a quiet stretch
    (or while Yahoo is down) still has numbers to show."""
    while True:
        time.sleep(quotes_mod.WARM_EVERY)
        try:
            pf = _portfolio_or_none()
            if pf is None:
                continue
            syms = sorted(history_mod.symbols_for(history_mod.strip_holdings(pf)))[:MAX_SYMBOLS]
            QUOTES.fetch_many(syms)
        except Exception as exc:
            log_line(f"quotes: warm-up failed: {type(exc).__name__}: {exc}")


def _check_latest_backup():
    """Open the newest daily backup the way a restore would, and say so in the log."""
    try:
        names = sorted(n for n in os.listdir(STORE.backup_dir) if DAILY_BACKUP_RE.match(n))
    except OSError:
        return
    if not names:
        return
    report = verify_db(os.path.join(STORE.backup_dir, names[-1]))
    if report["ok"]:
        log_line(f"backup check: {names[-1]} opens and decrypts ({report['holdings']} holdings, {report['history_days']} history days)")
    else:
        log_line(f"backup check: PROBLEM with {names[-1]}: {'; '.join(report['problems'])}")


def open_store():
    return open_default(DB_FILE, log=log_line)


if __name__ == "__main__":
    setup_logging()
    try:
        STORE = open_store()
    except StoreError as exc:
        log_line(f"Cannot start: {exc}")
        sys.exit(1)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    log_line(f"Folio running at http://localhost:{PORT} (pid {os.getpid()}, Python {sys.version.split()[0]})")
    log_line(f"Database: {STORE.path}{' (encrypted)' if STORE.encrypted() else ''}  Log: {LOG_FILE}")
    QUOTES = Quotes(STORE, _settings, log_line)
    HISTORY = History(STORE, _portfolio_or_none, quotes_mod.yahoo_chart, log_line)
    HISTORY.start()
    threading.Thread(target=_warm_loop, name="warm", daemon=True).start()
    threading.Thread(target=_check_latest_backup, name="backup-check", daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log_line("Stopped.")
