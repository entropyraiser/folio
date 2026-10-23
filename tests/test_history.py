import datetime
import os
import time
import unittest

from helpers import sample_portfolio, tmpdir

os.environ["TZ"] = "UTC"
time.tzset()

import history
from history import History, attribute, daily_closes, split_events, split_factor, value_day
from store import Store


def ts(day, hour=12):
    return int(datetime.datetime.strptime(f"{day} {hour}", "%Y-%m-%d %H").replace(tzinfo=datetime.timezone.utc).timestamp())


def chart(closes, split=None, price=None):
    """A Yahoo-shaped chart result. closes is {date: close}; the last one doubles as the live price."""
    days = sorted(closes)
    result = {
        "meta": {"gmtoffset": 0, "regularMarketPrice": price if price is not None else closes[days[-1]],
                 "regularMarketTime": ts(days[-1]), "instrumentType": "EQUITY"},
        "timestamp": [ts(d) for d in days],
        "indicators": {"quote": [{"close": [closes[d] for d in days]}]},
    }
    if split:
        date, num, den = split
        result["events"] = {"splits": {str(ts(date)): {"date": ts(date), "numerator": num, "denominator": den}}}
    return result


class Fake:
    """fetch_chart stand-in: symbol -> chart result, or an error."""
    def __init__(self, charts):
        self.charts = charts
        self.calls = 0

    def __call__(self, sym, query, deadline):
        self.calls += 1
        if sym in self.charts:
            return self.charts[sym], None
        return None, ("symbol", "no data")


def item(k, ident, value, inr, **extra):
    return {"k": k, "id": ident, "cur": "USD" if k in ("us", "bcash") else "INR", "value": value, "inr": inr, **extra}


class AttributionTests(unittest.TestCase):
    def rec(self, date, items):
        return {"date": date, "net": sum(i["inr"] for i in items), "items": items}

    def test_parts_add_up_to_the_change(self):
        a = self.rec("2026-10-01", [
            item("us", "u1", 1000, 80000, sym="AAPL", qty=10, price=100),
            item("bcash", "c1", 500, 40000),
            item("bank", "b1", 100000, 100000)])
        b = self.rec("2026-10-02", [
            item("us", "u1", 1320, 105600, sym="AAPL", qty=12, price=110),       # +10% price, bought 2 more, rate 80 -> 80
            item("bcash", "c1", 500, 41000),                                       # rate moved 80 -> 82
            item("bank", "b1", 101000, 101000),                                    # 1000 deposited
            item("hand", "h1", 2000, 2000)])                                       # a new item
        out = attribute([a, b])
        self.assertEqual(out["days"], 1)
        self.assertAlmostEqual(out["price"], 10 * 10 * 80)                         # old quantity at the new price
        self.assertAlmostEqual(out["fx"], 500 * 2)                                 # only the cash feels the rate
        self.assertAlmostEqual(out["flows"], 2 * 110 * 80 + 1000 + 2000)
        self.assertAlmostEqual(out["price"] + out["fx"] + out["flows"], b["net"] - a["net"], places=1)

    def test_interest_on_a_balance_is_money_added_not_market(self):
        a = self.rec("2026-10-01", [item("pf", "p1", 500000, 500000)])
        b = self.rec("2026-10-02", [item("pf", "p1", 503000, 503000)])
        out = attribute([a, b])
        self.assertEqual((out["price"], out["fx"], out["flows"]), (0, 0, 3000))

    def test_removed_items_and_ranges(self):
        recs = [self.rec("2026-10-01", [item("us", "u1", 100, 8000, sym="X", qty=1, price=100)]),
                self.rec("2026-10-02", [item("us", "u1", 100, 8000, sym="X", qty=1, price=100)]),
                self.rec("2026-10-03", [])]
        self.assertEqual(attribute(recs)["flows"], -8000)
        self.assertEqual(attribute(recs, start="2026-10-03")["days"], 0)
        self.assertEqual(attribute(recs, start="2026-10-02")["from"], "2026-10-02")
        self.assertEqual(attribute([])["days"], 0)

    def test_a_chain_of_days_reconciles(self):
        recs = []
        for n, (qty_, price_) in enumerate([(10, 100), (10, 105), (15, 104), (15, 110)]):
            recs.append(self.rec(f"2026-10-0{n + 1}", [item("us", "u1", qty_ * price_, qty_ * price_ * 80, sym="A", qty=qty_, price=price_),
                                                       item("bank", "b1", 1000 + n * 10, 1000 + n * 10)]))
        out = attribute(recs)
        self.assertAlmostEqual(out["price"] + out["fx"] + out["flows"], recs[-1]["net"] - recs[0]["net"], places=1)


class SplitTests(unittest.TestCase):
    def test_events_are_read_from_a_chart(self):
        found = split_events(chart({"2026-10-01": 20.0, "2026-10-02": 21.0}, split=("2026-10-02", 10, 1)))
        self.assertEqual(found, [("2026-10-02", 10.0)])
        reverse = split_events(chart({"2026-10-01": 20.0}, split=("2026-10-01", 1, 10)))
        self.assertAlmostEqual(reverse[0][1], 0.1)
        self.assertEqual(split_events({"meta": {}}), [])

    def test_factor_only_for_older_days_and_unapplied_holdings(self):
        splits = {"NVDA": [("2026-10-02", 10.0)]}
        held = {"id": "u1"}
        seen = {"u1": "2026-09-01"}
        self.assertEqual(split_factor(splits, "NVDA", "2026-10-01", held, seen), 10.0)
        self.assertEqual(split_factor(splits, "NVDA", "2026-10-02", held, seen), 1.0, "from the split day on, prices match the units")
        self.assertEqual(split_factor(splits, "NVDA", "2026-10-01", {"id": "u1", "splits": ["2026-10-02"]}, seen), 1.0, "applied by the user")
        self.assertEqual(split_factor(splits, "NVDA", "2026-10-01", {"id": "new"}, {"new": "2026-10-05"}), 1.0, "bought after the split")


class PassTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tmpdir()
        self.store = Store(os.path.join(self._tmp.name, "folio.db"))
        self.logs = []
        self.pf = {"settings": {"base": "INR"}, "us": [{"id": "u1", "broker": "IBKR", "symbol": "NVDA", "qty": 10, "avg": 100.0}],
                   "in": [], "bcash": [], "bank": [{"id": "b1", "bank": "X", "currency": "INR", "balance": 1000}], "hand": [], "pf": [], "other": []}

    def tearDown(self):
        self.store.close()
        self._tmp.cleanup()

    def history(self, charts):
        return History(self.store, lambda: self.pf, Fake(charts), self.logs.append)

    def fx(self, *days):
        return chart({d: 80.0 for d in days})

    def test_a_pass_values_today_and_fills_missed_days(self):
        days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]
        h = self.history({"NVDA": chart(dict(zip(days, [100.0, 110.0, 120.0, 130.0]))), "USDINR=X": self.fx(*days)})
        h.run_pass(now=ts("2026-09-28"))
        h.run_pass(now=ts("2026-10-01"))                    # the laptop was off for two days
        recs = {r["date"]: r for r in self.store.history_all()}
        self.assertEqual(sorted(recs), days)
        self.assertAlmostEqual(recs["2026-09-29"]["net"], 10 * 110 * 80 + 1000)
        self.assertTrue(recs["2026-09-29"]["filled"])
        self.assertFalse(recs["2026-10-01"]["final"], "today is provisional")
        self.assertTrue(recs["2026-09-28"]["final"])

    def test_a_split_is_offered_once_and_history_stays_continuous(self):
        d = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]
        usd = self.fx(*d)
        before = {"2026-09-30": 1000.0, "2026-10-01": 1000.0}
        h = self.history({"NVDA": chart(before), "USDINR=X": usd})
        h.run_pass(now=ts("2026-10-01"))
        self.assertEqual(self.store.splits_list(), [])
        # NVDA splits 10-for-1 on the 2nd; the feed now serves split-adjusted closes
        adjusted = {"2026-09-30": 100.0, "2026-10-01": 100.0, "2026-10-02": 101.0, "2026-10-03": 102.0}
        h.fetch_chart = Fake({"NVDA": chart(adjusted, split=("2026-10-02", 10, 1)), "USDINR=X": usd})
        h.run_pass(now=ts("2026-10-03"))
        pending = self.store.splits_list("pending")
        self.assertEqual([(s["sym"], s["date"], s["ratio"]) for s in pending], [("NVDA", "2026-10-02", 10.0)])
        recs = {r["date"]: r for r in self.store.history_all()}
        self.assertAlmostEqual(recs["2026-10-01"]["net"], 10 * 1000 * 80 + 1000, delta=1, msg="the day before the split keeps its value")
        h.run_pass(now=ts("2026-10-03"))
        self.assertEqual(len(self.store.splits_list("pending")), 1, "not offered twice")
        # the user applies it in the app
        self.pf["us"][0].update(qty=100, avg=10.0, splits=["2026-10-02"])
        self.store.splits_set("NVDA", "2026-10-02", "applied")
        h.run_pass(now=ts("2026-10-03"))
        recs = {r["date"]: r for r in self.store.history_all()}
        self.assertAlmostEqual(recs["2026-10-03"]["net"], 100 * 102 * 80 + 1000, delta=1)
        self.assertAlmostEqual(recs["2026-10-01"]["net"], 10 * 1000 * 80 + 1000, delta=1)

    def test_a_holding_added_after_the_split_is_not_offered_it(self):
        d = ["2026-10-02", "2026-10-03"]
        h = self.history({"NVDA": chart({"2026-10-02": 100.0, "2026-10-03": 102.0}, split=("2026-10-02", 10, 1)), "USDINR=X": self.fx(*d)})
        h.run_pass(now=ts("2026-10-03"))
        self.assertEqual(self.store.splits_list(), [])

    def test_rebuild_revalues_settled_days_with_chosen_holdings(self):
        days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-02"]
        charts = {"NVDA": chart(dict(zip(days, [100.0, 110.0, 120.0, 130.0]))), "USDINR=X": self.fx(*days)}
        h = self.history(charts)
        h.run_pass(now=ts("2026-09-28"))
        h.run_pass(now=ts("2026-10-02"))
        self.assertTrue(all(r["final"] for r in self.store.history_all() if r["date"] < "2026-10-02"))
        self.pf["us"][0]["qty"] = 20                          # a quantity entered wrongly, now fixed
        today = datetime.date.today().isoformat()
        h.rebuild("2026-09-29", "2026-09-30", current_holdings=True)
        recs = {r["date"]: r for r in self.store.history_all()}
        self.assertAlmostEqual(recs["2026-09-29"]["net"], 20 * 110 * 80 + 1000)
        self.assertAlmostEqual(recs["2026-09-28"]["net"], 10 * 100 * 80 + 1000, msg="days outside the range are untouched")
        self.assertIsNotNone(today)

    def test_health_lists_estimated_days(self):
        h = self.history({"USDINR=X": self.fx("2026-10-01")})            # no NVDA data at all
        h.run_pass(now=ts("2026-10-01"))
        info = h.health()
        self.assertEqual(info["estimated"][0]["missing"], ["NVDA"])
        self.assertEqual(info["splits"], [])


if __name__ == "__main__":
    unittest.main()
