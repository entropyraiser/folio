import os
import unittest
from unittest import mock

from helpers import tmpdir

import quotes
from store import Store


def good(price=10.0, source="yahoo"):
    return {"price": price, "prev": price - 1, "currency": "USD", "name": "X", "exchange": "NMS", "time": 1, "source": source}


class QuoteSourceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tmpdir()
        self.store = Store(os.path.join(self._tmp.name, "folio.db"))
        self.settings = {}
        self.logs = []
        self.q = quotes.Quotes(self.store, lambda: self.settings, self.logs.append)
        quotes._cache.clear()
        for name in ("from_chart", "from_spark", "from_alpha"):
            p = mock.patch.object(quotes, name)
            setattr(self, name, p.start())
            self.addCleanup(p.stop)

    def tearDown(self):
        self.store.close()
        self._tmp.cleanup()

    def fetch(self, sym="AAPL"):
        return self.q.fetch_symbol(sym, 1e12)

    def test_main_source_wins(self):
        self.from_chart.return_value = (good(), None)
        out = self.fetch()
        self.assertEqual(out["source"], "yahoo")
        self.from_spark.assert_not_called()

    def test_unknown_symbol_gets_no_fallback_and_no_stale_copy(self):
        self.store.quotes_put({"ZZZ": good()})
        self.from_chart.return_value = (None, ("symbol", "No data found"))
        out = self.fetch("ZZZ")
        self.assertEqual(out["kind"], "symbol")
        self.from_spark.assert_not_called()
        self.from_alpha.assert_not_called()

    def test_spark_is_next_when_the_chart_endpoint_fails(self):
        self.from_chart.return_value = (None, ("http", "HTTP 429"))
        self.from_spark.return_value = (good(source="yahoo-spark"), None)
        self.assertEqual(self.fetch()["source"], "yahoo-spark")

    def test_alpha_vantage_only_with_a_key(self):
        self.from_chart.return_value = (None, ("network", "down"))
        self.from_spark.return_value = (None, ("network", "down"))
        self.from_alpha.return_value = (good(source="alphavantage"), None)
        quotes._cache.clear()
        self.assertEqual(self.fetch().get("kind"), "network")      # no key: not asked
        self.from_alpha.assert_not_called()
        self.settings["alphaKey"] = "KEY"
        quotes._cache.clear()
        self.assertEqual(self.fetch()["source"], "alphavantage")
        self.assertEqual(self.from_alpha.call_args[0][:2], ("AAPL", "KEY"))

    def test_last_good_copy_is_marked_stale(self):
        self.from_chart.return_value = (good(12.5), None)
        self.q.fetch_many(["AAPL"])
        quotes._cache.clear()
        self.from_chart.return_value = (None, ("timeout", "slow"))
        self.from_spark.return_value = (None, ("timeout", "slow"))
        out = self.q.fetch_many(["AAPL"])["AAPL"]
        self.assertTrue(out["stale"])
        self.assertEqual((out["price"], out["source"]), (12.5, "cache"))
        self.assertIn("asOf", out)

    def test_stale_copies_are_not_saved_over_good_ones(self):
        self.from_chart.return_value = (good(12.5), None)
        self.q.fetch_many(["AAPL"])
        quotes._cache.clear()
        self.from_chart.return_value = (None, ("timeout", "slow"))
        self.from_spark.return_value = (None, ("timeout", "slow"))
        self.q.fetch_many(["AAPL"])
        saved = self.store.quotes_get({"AAPL"})["AAPL"]
        self.assertNotIn("stale", saved)
        self.assertEqual(saved["price"], 12.5)

    def test_nothing_at_all_is_an_error(self):
        self.from_chart.return_value = (None, ("network", "down"))
        self.from_spark.return_value = (None, ("network", "down"))
        self.assertEqual(self.fetch("NEW")["kind"], "network")


class MappingTests(unittest.TestCase):
    def test_alpha_symbols(self):
        self.assertEqual(quotes.alpha_params("USDINR=X"), {"function": "CURRENCY_EXCHANGE_RATE", "from_currency": "USD", "to_currency": "INR"})
        self.assertEqual(quotes.alpha_params("RELIANCE.NS")["symbol"], "RELIANCE.BSE")
        self.assertEqual(quotes.alpha_params("BTC-USD")["from_currency"], "BTC")
        self.assertEqual(quotes.alpha_params("AAPL"), {"function": "GLOBAL_QUOTE", "symbol": "AAPL"})
        self.assertIsNone(quotes.alpha_params("^NSEI"))

    def test_previous_close_prefers_the_session_change(self):
        meta = {"fulldayPrice": 100.0, "fulldayChange": -3.0}
        self.assertEqual(quotes.previous_close(meta, [1, 2], 100.0), 103.0)
        self.assertEqual(quotes.previous_close({}, [90.0, 95.0], 100.0), 90.0)
        self.assertEqual(quotes.previous_close({"previousClose": 98.5}, [], 100.0), 98.5)

    def test_alpha_rate_limit_note_is_a_failure_and_pauses_calls(self):
        with mock.patch.object(quotes, "_alpha_request", return_value={"Note": "25 requests per day"}) as req:
            quotes._alpha_state.update(day=None, calls=0, blocked_until=0.0)
            out, err = quotes.from_alpha("AAPL", "K")
            self.assertIsNone(out)
            self.assertEqual(err[0], "http")
            quotes._alpha_state["next_at"] = 0.0
            quotes.from_alpha("AAPL", "K")
            self.assertEqual(req.call_count, 1, "blocked for the next hour")
        quotes._alpha_state.update(day=None, calls=0, blocked_until=0.0)

    def test_alpha_quote_is_parsed(self):
        data = {"Global Quote": {"05. price": "101.50", "08. previous close": "100.00"}}
        with mock.patch.object(quotes, "_alpha_request", return_value=data):
            quotes._alpha_state.update(day=None, calls=0, blocked_until=0.0)
            out, err = quotes.from_alpha("AAPL", "K")
        self.assertEqual((out["price"], out["prev"], out["source"]), (101.5, 100.0, "alphavantage"))
        quotes._alpha_state.update(day=None, calls=0, blocked_until=0.0)


if __name__ == "__main__":
    unittest.main()
