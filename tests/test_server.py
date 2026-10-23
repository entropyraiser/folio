import http.client
import json
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock

from helpers import sample_portfolio, tmpdir

import history as history_mod
import quotes as quotes_mod
import server
from history import History
from quotes import Quotes
from store import Store


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tmpdir()
        server.STORE = Store(os.path.join(cls._tmp.name, "folio.db"))
        server.QUOTES = Quotes(server.STORE, lambda: {}, lambda m: None)
        server.HISTORY = History(server.STORE, lambda: server.STORE.read_portfolio()[0], lambda *a: (None, ("network", "off")), lambda m: None)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        server.PORT = cls.port
        server.HOST = "127.0.0.1"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.STORE.close()
        cls._tmp.cleanup()

    def req(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"localhost:{self.port}", **(headers or {})}
        data = json.dumps(body) if body is not None else None
        if data:
            h.setdefault("Content-Type", "application/json")
        conn.request(method, path, data, h)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        try:
            return resp.status, json.loads(raw), resp
        except ValueError:
            return resp.status, raw, resp

    # ---- holdings: the privacy rules ----
    def test_private_routes_refuse_foreign_hosts_and_origins(self):
        for path in ("/api/data", "/api/history", "/api/attribution", "/api/history/health", "/api/status", "/api/splits"):
            self.assertEqual(self.req("GET", path)[0], 200, path)
            self.assertEqual(self.req("GET", path, headers={"Host": "evil.example"})[0], 403, path + " with a rebound host")
            self.assertEqual(self.req("GET", path, headers={"Origin": "http://evil.example"})[0], 403, path + " from another site")
            self.assertEqual(self.req("GET", path, headers={"Host": f"localhost:{self.port + 1}"})[0], 403, path + " with the wrong port")
        status, _, resp = self.req("GET", "/api/data")
        self.assertIsNone(resp.getheader("Access-Control-Allow-Origin"), "no CORS on holdings")

    def test_private_writes_refuse_foreign_hosts_and_origins(self):
        body = sample_portfolio()
        self.assertEqual(self.req("PUT", "/api/data", body, {"If-Match": "0", "Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.req("PUT", "/api/data", body, {"If-Match": "0", "Host": "evil.example"})[0], 403)
        self.assertEqual(self.req("POST", "/api/history/rebuild", {"from": "2026-01-01"}, {"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.req("POST", "/api/splits", {"sym": "A", "date": "2026-01-01", "status": "applied"}, {"Host": "evil.example"})[0], 403)

    def test_peers_that_are_not_loopback_are_refused(self):
        with mock.patch.object(server.Handler, "_peer_is_loopback", return_value=False):
            self.assertEqual(self.req("GET", "/api/data")[0], 403)

    def test_preflight_gives_cors_only_for_public_routes(self):
        _, _, resp = self.req("OPTIONS", "/api/quotes")
        self.assertEqual(resp.getheader("Access-Control-Allow-Origin"), "*")
        _, _, resp = self.req("OPTIONS", "/api/data")
        self.assertIsNone(resp.getheader("Access-Control-Allow-Origin"))

    # ---- saving ----
    def test_save_needs_a_revision_and_conflicts_are_reported(self):
        self.assertEqual(self.req("PUT", "/api/data", sample_portfolio())[0], 428)
        status, body, _ = self.req("PUT", "/api/data", sample_portfolio(), {"If-Match": "0"})
        self.assertEqual((status, body["rev"]), (200, 1))
        status, body, _ = self.req("PUT", "/api/data", sample_portfolio(), {"If-Match": "0"})
        self.assertEqual((status, body["rev"]), (409, 1))
        self.assertEqual(self.req("PUT", "/api/data", {"us": []}, {"If-Match": "1"})[0], 400)
        status, body, _ = self.req("GET", "/api/data")
        self.assertEqual(body["rev"], 1)
        self.assertEqual(body["data"]["us"][0]["symbol"], "AAPL")

    def test_splits_endpoint_validates(self):
        server.STORE.splits_note("NVDA", "2026-06-10", 10.0)
        self.assertEqual(self.req("POST", "/api/splits", {"sym": "NVDA", "date": "2026-06-10", "status": "nope"})[0], 400)
        self.assertEqual(self.req("POST", "/api/splits", {"sym": "bad sym!", "date": "2026-06-10", "status": "applied"})[0], 400)
        self.assertEqual(self.req("POST", "/api/splits", {"sym": "NVDA", "date": "2026-06-10", "status": "dismissed"})[0], 200)
        self.assertEqual(self.req("GET", "/api/splits")[1]["splits"], [])

    def test_rebuild_validates_dates(self):
        self.assertEqual(self.req("POST", "/api/history/rebuild", {"from": "yesterday"})[0], 400)
        self.assertEqual(self.req("POST", "/api/history/rebuild", {"from": "2026-01-01", "to": "x"})[0], 400)

    def test_attribution_validates_dates(self):
        self.assertEqual(self.req("GET", "/api/attribution?from=junk")[0], 400)

    # ---- static files ----
    def test_dashboard_files_are_served_and_nothing_else(self):
        status, body, resp = self.req("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<script src=\"js/app.js\">", body)
        self.assertEqual(resp.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(self.req("GET", "/js/app.js")[0], 200)
        self.assertEqual(self.req("GET", "/style.css")[0], 200)
        for path in ("/../server.py", "/..%2fserver.py", "/%2e%2e/server.py", "/js/../../store.py", "/folio.db", "/data.json", "/js/", "/nope.js"):
            self.assertEqual(self.req("GET", path)[0], 404, path)

    def test_quote_symbols_are_checked(self):
        self.assertEqual(self.req("GET", "/api/quotes?symbols=")[0], 400)
        self.assertEqual(self.req("GET", "/api/quotes?symbols=a%20b;rm")[0], 400)


if __name__ == "__main__":
    unittest.main()
