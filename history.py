"""
Daily net worth history.

One record per local calendar date, kept in the database (see store.py). Every date is valued at that day's closing prices, so a date the server
missed (laptop closed or asleep) is filled in later with the number it would
have had. A date stays provisional, and is re-valued on every pass, until noon
the next day, by which time every market has closed for it.

Holdings only change through the dashboard, which needs this server, so a
missed date carries the holdings of the record before it.
"""
import bisect
import datetime
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

LIST_KEYS = ("us", "in", "bcash", "bank", "hand", "pf", "other")
PRICED = ("us", "in", "other")
# code, Yahoo symbol, history fx key, settings fallback field. Rates match index.html.
EXTRA_FX = (
    ("THB", "USDTHB=X", "USDTHB", "thbManual"),
    ("AED", "USDAED=X", "USDAED", "aedManual"),
)
FX_FALLBACK = {"USDINR=X": 85.0, "USDTHB=X": 33.0, "USDAED=X": 3.67}  # the dashboard's defaults
SETTLE_HOURS = 36  # from the start of a date: noon the next day
GIVE_UP_DAYS = 7  # a date still missing prices after this keeps its best guess
MAX_BACKFILL_DAYS = 400
LOOKBACK_DAYS = 10  # so a weekend or holiday still finds the previous close
PASS_EVERY = 15 * 60
RETRY_EVERY = 2 * 60
CHECK_EVERY = 60
SETTLE_AFTER_SAVE = 3  # seconds to let a burst of saves finish before a pass
FETCH_DEADLINE = 60
FETCH_WORKERS = 4
SPLIT_WINDOW_DAYS = 45  # a split older than this is not offered to the user


def yahoo_symbol(kind, h):
    s = str(h.get("symbol") or "").strip().upper()
    if not s:
        return ""
    if kind == "in" and not s.endswith((".NS", ".BO")):
        return s + (".BO" if h.get("exchange") == "BSE" else ".NS")
    return s


def _num(v):
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


def _day(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).date().isoformat()


# Yahoo's session change matches the previous daily close for these. For
# currencies and crypto it is a different window, so it must not fill a bar.
_SESSION_KINDS = {"EQUITY", "ETF", "MUTUALFUND", "INDEX"}


def _session_previous_close(meta, price):
    """Previous session's close, from the chart meta rather than the bars.

    The daily bar for that session is often empty, while regularMarketPrice
    still describes the session after it. previousClose is missing on this
    endpoint; the full-day change is that session's move.
    """
    prev = meta.get("previousClose")
    if isinstance(prev, (int, float)) and not isinstance(prev, bool):
        return float(prev)
    anchor = meta.get("fulldayPrice")
    if not isinstance(anchor, (int, float)) or isinstance(anchor, bool):
        anchor = price
    change = meta.get("fulldayChange")
    if (
        isinstance(anchor, (int, float)) and not isinstance(anchor, bool)
        and isinstance(change, (int, float)) and not isinstance(change, bool)
    ):
        return float(anchor) - float(change)
    return None


def daily_closes(result):
    """(series, gaps). series is [(exchange-local date, close)] sorted by date.
    gaps is the set of dates Yahoo sent a bar for but no close, and that this
    function could not fill. The latest price stands in for the current
    session, whose bar Yahoo often leaves empty. The session before that is
    often empty too; for an equity its close is the chart's session change.
    """
    meta = result.get("meta") or {}
    offset = meta.get("gmtoffset") or 0
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    by_day = {}
    null_days = set()
    for ts, close in zip(result.get("timestamp") or [], quote.get("close") or []):
        if ts is None:
            continue
        day = _day(ts + offset)
        if close is None:
            if day not in by_day:
                null_days.add(day)
        else:
            by_day[day] = float(close)
            null_days.discard(day)
    price, at = meta.get("regularMarketPrice"), meta.get("regularMarketTime")
    current = None
    if price is not None and at:
        current = _day(at + offset)
        by_day[current] = float(price)
        null_days.discard(current)
    kind = (meta.get("instrumentType") or "").upper()
    prev_close = _session_previous_close(meta, price)
    if prev_close is not None and current is not None and kind in _SESSION_KINDS:
        earlier = sorted(d for d in null_days if d < current)
        if earlier and not any(earlier[-1] < d < current for d in by_day):
            by_day[earlier[-1]] = prev_close
            null_days.discard(earlier[-1])
    null_days.difference_update(by_day)
    return sorted(by_day.items()), null_days


def close_on(series, day, gaps=None):
    """Latest close on or before day. A date in gaps had a bar with no close,
    so an older close must not stand in for it."""
    if gaps and day in gaps:
        return None
    if not series:
        return None
    i = bisect.bisect_right(series, (day, float("inf")))
    return series[i - 1][1] if i else None


def close_after(series, day):
    if not series:
        return None
    i = bisect.bisect_right(series, (day, float("inf")))
    return series[i][1] if i < len(series) else None


def split_events(result):
    """[(exchange-local date, ratio)] for the stock splits in a chart result.
    A 10-for-1 split has ratio 10; a 1-for-10 reverse split 0.1."""
    meta = result.get("meta") or {}
    offset = meta.get("gmtoffset") or 0
    out = []
    for ev in ((result.get("events") or {}).get("splits") or {}).values():
        try:
            ratio = float(ev["numerator"]) / float(ev["denominator"])
            out.append((_day(int(ev["date"]) + offset), ratio))
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            continue
    return sorted(out)


def strip_holdings(portfolio):
    """The parts of the portfolio a snapshot needs to be re-valued later."""
    out = {}
    for kind in LIST_KEYS:
        out[kind] = [{k: v for k, v in h.items() if k != "log"} for h in portfolio.get(kind) or [] if isinstance(h, dict)]
    return out


def symbols_for(holdings):
    syms = {"USDINR=X"}
    for kind in PRICED:
        for h in holdings.get(kind) or []:
            s = yahoo_symbol(kind, h)
            if s:
                syms.add(s)
    curs = {h.get("currency") for k in ("bcash", "bank", "hand", "other") for h in holdings.get(k) or []}
    for code, sym, _key, _manual in EXTRA_FX:
        if code in curs:
            syms.add(sym)
    return syms


def _prices(rec):
    return {i["sym"]: i["price"] for i in (rec or {}).get("items") or [] if i.get("sym") and i.get("price") is not None}


def split_factor(splits, sym, day, h, first_seen):
    """Closes are adjusted for splits, but a record keeps the quantity held on
    its day. For a date before a split the old quantity is multiplied up, unless
    the holding already carries the split (the user applied it) or was added
    after the split."""
    f = 1.0
    done = set(h.get("splits") or [])
    seen = first_seen.get(h.get("id"))
    for date, ratio in splits.get(sym, ()):
        if date > day and date not in done and (seen is None or seen < date):
            f *= ratio
    return f


def value_day(day, holdings, settings, closes, prev, own=None, gaps=None, splits=None, first_seen=None):
    """Value one date the way the dashboard does, using closes for that date.
    A symbol with no close falls back to this date's earlier record (own), then
    the previous date's record, then its next known close, then the fallback
    price, then cost, and is listed in missing."""
    prev_prices = {**_prices(prev), **_prices(own)}
    prev_fx = {**((prev or {}).get("fx") or {}), **((own or {}).get("fx") or {})}
    missing = set()

    def price_of(sym, manual):
        c = close_on(closes.get(sym), day, (gaps or {}).get(sym))
        if c is not None:
            return c
        missing.add(sym)
        if sym in prev_prices:
            return prev_prices[sym]
        c = close_after(closes.get(sym), day)
        if c is not None:
            return c
        return _num(manual) if manual not in (None, "") else None

    def rate(sym, key, manual):
        r = price_of(sym, None)
        if r is None:
            r = prev_fx.get(key) or (_num(manual) or None) or FX_FALLBACK[sym]
        return r

    held = symbols_for(holdings)
    usdinr = rate("USDINR=X", "USDINR", settings.get("fxManual"))
    extra_rates = {}
    for code, sym, key, manual in EXTRA_FX:
        if sym in held:
            extra_rates[code] = (key, rate(sym, key, settings.get(manual)))

    def to_inr(v, cur):
        if cur == "USD":
            return v * usdinr
        hit = extra_rates.get(cur)
        if hit:
            return v / hit[1] * usdinr
        return v  # INR, and anything unknown, as the dashboard treats it

    items, cats = [], {k: 0.0 for k in LIST_KEYS}
    for kind in LIST_KEYS:
        for h in holdings.get(kind) or []:
            sym = yahoo_symbol(kind, h) if kind in PRICED else ""
            qty, price = _num(h.get("qty")), None
            if sym and splits:
                qty *= split_factor(splits, sym, day, h, first_seen or {})
            if kind in ("us", "in"):
                cur = "USD" if kind == "us" else "INR"
                price = price_of(sym, h.get("manualPrice")) if sym else None
                value = qty * (price if price is not None else _num(h.get("avg")))
            elif kind == "other":
                cur = h.get("currency") or "INR"
                price = price_of(sym, h.get("price")) if sym else None
                value = qty * price if price is not None else _num(h.get("value"))
            else:
                cur = "INR" if kind == "pf" else (h.get("currency") or "INR")
                value = _num(h.get("balance"))
            inr = to_inr(value, cur)
            cats[kind] += inr
            item = {"k": kind, "id": h.get("id"), "cur": cur, "value": round(value, 4), "inr": round(inr, 2)}
            if sym:
                item.update(sym=sym, qty=qty, price=price)
            items.append(item)

    fx = {"USDINR": usdinr}
    for _code, (key, r) in extra_rates.items():
        fx[key] = r
    return {
        "date": day,
        "net": round(sum(cats.values()), 2),
        "cats": {k: round(v, 2) for k, v in cats.items()},
        "fx": fx,
        "missing": sorted(missing),
        "items": items,
        "holdings": holdings,
    }


def attribute(records, start=None, end=None):
    """Split the change in net worth between two dates into what the markets did
    and what the owner did. records are history records in date order.

    Per item, from one day to the next:
      price   the old quantity at the new price
      fx      the old quantity at the new price, valued at the new exchange rate
      flow    quantity bought, sold, deposited or withdrawn, at the new price
    A balance (bank, PF, cash) has no price: its change is a flow, so interest
    shows up as money added. Everything is in rupees, as stored."""
    recs = [r for r in records if (not start or r["date"] >= start) and (not end or r["date"] <= end)]
    out = {"from": None, "to": None, "start": 0.0, "end": 0.0, "price": 0.0, "fx": 0.0, "flows": 0.0, "byCat": {}, "days": 0}
    if len(recs) < 2:
        if recs:
            out.update({"from": recs[0]["date"], "to": recs[0]["date"], "start": recs[0]["net"], "end": recs[0]["net"]})
        return out
    out.update({"from": recs[0]["date"], "to": recs[-1]["date"], "start": recs[0]["net"], "end": recs[-1]["net"], "days": len(recs) - 1})
    by_cat = {}

    def add(kind, field, v):
        out[field] += v
        by_cat.setdefault(kind, {"price": 0.0, "fx": 0.0, "flows": 0.0})[field] += v

    def parts(it):
        value, inr = _num(it.get("value")), _num(it.get("inr"))
        fx = inr / value if value else 0.0
        qty = _num(it.get("qty"))
        if it.get("sym") and qty:
            return qty, value / qty, fx, True
        return 1.0, value, fx, False

    for a, b in zip(recs, recs[1:]):
        before = {i.get("id"): i for i in a.get("items") or []}
        after = {i.get("id"): i for i in b.get("items") or []}
        for ident in set(before) | set(after):
            i0, i1 = before.get(ident), after.get(ident)
            kind = (i1 or i0).get("k")
            if i0 is None:
                add(kind, "flows", _num(i1.get("inr")))
            elif i1 is None:
                add(kind, "flows", -_num(i0.get("inr")))
            else:
                q0, p0, f0, priced0 = parts(i0)
                q1, p1, f1, priced1 = parts(i1)
                if priced0 != priced1:
                    add(kind, "flows", _num(i1.get("inr")) - _num(i0.get("inr")))
                    continue
                if f0 == 0 or f1 == 0:
                    f0 = f0 or f1
                    f1 = f1 or f0
                if priced0:
                    add(kind, "price", q0 * (p1 - p0) * f0)
                    add(kind, "fx", q0 * p1 * (f1 - f0))
                    add(kind, "flows", (q1 - q0) * p1 * f1)
                else:  # a balance: only the exchange rate is the market's doing
                    add(kind, "fx", p0 * (f1 - f0))
                    add(kind, "flows", (p1 - p0) * f1)
    out["byCat"] = {k: {f: round(v, 2) for f, v in d.items()} for k, d in by_cat.items()}
    for f in ("price", "fx", "flows"):
        out[f] = round(out[f], 2)
    return out


class History:
    def __init__(self, store, load_portfolio, fetch_chart, log):
        self.store = store
        self.load_portfolio = load_portfolio  # () -> portfolio dict or None
        self.fetch_chart = fetch_chart  # (sym, query, deadline) -> (result, None) | (None, (kind, msg))
        self.log = log
        self._lock = threading.Lock()
        self._kick = threading.Event()
        self._last_missing = None
        self._last_errors = None
        self.last_pass = {"at": None, "ok": None, "error": None}

    # ---------- storage ----------
    def read(self):
        return self.store.history_all()

    def summary(self):
        with self._lock:
            records = self.read()
        keys = ("date", "net", "cats", "fx", "final", "filled")
        return [dict({k: r.get(k) for k in keys}, missing=len(r.get("missing") or [])) for r in records]

    def attribution(self, start=None, end=None):
        with self._lock:
            records = self.read()
        return attribute(records, start, end)

    def health(self):
        """Days worth a second look: valued with an estimated price, or filled in
        after the server missed them. Plus when the last pass ran."""
        with self._lock:
            records = self.read()
        estimated = [{"date": r["date"], "missing": r.get("missing") or [], "final": bool(r.get("final"))}
                     for r in records if r.get("missing")]
        filled = [r["date"] for r in records if r.get("filled")]
        return {"days": len(records), "estimated": estimated, "filled": filled, "lastPass": self.last_pass,
                "splits": self.store.splits_list("pending")}

    def rebuild(self, start, end=None, current_holdings=False):
        """Value the days from start (to end) again from closing prices. With
        current_holdings the days are valued with today's holdings, which
        repairs history after a wrong quantity was entered."""
        datetime.date.fromisoformat(start)
        end = end or datetime.date.today().isoformat()
        datetime.date.fromisoformat(end)
        portfolio = self.load_portfolio()
        today_s = datetime.date.today().isoformat()
        with self._lock:
            records = [r for r in self.read() if start <= r["date"] <= end and r["date"] < today_s]
            for r in records:
                r["final"] = False
                if current_holdings and portfolio is not None:
                    r["holdings"] = strip_holdings(portfolio)
            self.store.history_put(records)
        self.log(f"history: rebuilding {len(records)} day(s) from {start}" + (" with current holdings" if current_holdings else ""))
        self.run_pass()
        return len(records)

    # ---------- prices ----------
    def _fetch(self, symbols, start):
        p1 = int(datetime.datetime.combine(start, datetime.time.min).timestamp())
        p2 = int(time.time()) + 86400
        query = f"interval=1d&period1={p1}&period2={p2}&events=split"
        deadline = time.monotonic() + FETCH_DEADLINE
        symbols = sorted(symbols)
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
            results = list(pool.map(lambda s: self.fetch_chart(s, query, deadline), symbols))
        closes, gaps, errors, splits = {}, {}, {}, {}
        for sym, (result, err) in zip(symbols, results):
            if result is not None:
                closes[sym], gaps[sym] = daily_closes(result)
                found = split_events(result)
                if found:
                    splits[sym] = found
            else:
                errors[sym] = err
        return closes, gaps, errors, splits

    def _note_splits(self, found, holdings_today, first_seen, today):
        """Offer a split to the user once, for a holding that existed before it."""
        for sym, events in found.items():
            held = [h for kind in PRICED for h in holdings_today.get(kind) or [] if yahoo_symbol(kind, h) == sym]
            for date, ratio in events:
                age = (today - datetime.date.fromisoformat(date)).days
                if age > SPLIT_WINDOW_DAYS or ratio == 1:
                    continue
                if not any(date not in (h.get("splits") or []) and first_seen.get(h.get("id"), "9999") < date for h in held):
                    continue
                if self.store.splits_note(sym, date, ratio):
                    self.log(f"history: {sym} split {ratio:g}-for-1 on {date}; waiting for you to apply it")

    # ---------- one pass ----------
    def run_pass(self, now=None):
        """Bring every open date up to date. Returns True when some price was
        missing, so the caller retries sooner."""
        portfolio = self.load_portfolio()
        if portfolio is None:
            return False
        now = now or time.time()
        today = datetime.datetime.fromtimestamp(now).date()
        today_s = today.isoformat()
        settings = portfolio.get("settings") or {}

        with self._lock:
            records = {r["date"]: r for r in self.read()}
            last = max(records) if records else None
            open_days = [d for d, r in records.items() if not r.get("final") and d < today_s]
            gap = []
            if last and last < today_s:
                d = max(datetime.date.fromisoformat(last) + datetime.timedelta(days=1),
                        today - datetime.timedelta(days=MAX_BACKFILL_DAYS))
                while d < today:
                    gap.append(d.isoformat())
                    d += datetime.timedelta(days=1)
            todo = set(open_days) | set(gap) | {today_s}

            # holdings per date: today's are current, a stored date keeps its own,
            # a missed date carries the record before it
            holdings, prev = {}, None
            for d in sorted(set(records) | todo):
                if d == today_s:
                    holdings[d] = strip_holdings(portfolio)
                elif d in records:
                    holdings[d] = records[d].get("holdings") or (prev and holdings.get(prev)) or {}
                else:
                    holdings[d] = holdings.get(prev) or {}
                prev = d

            first_seen = {}
            for d in sorted(holdings):
                for kind in LIST_KEYS:
                    for h in holdings[d].get(kind) or []:
                        first_seen.setdefault(h.get("id"), d)

            symbols = set().union(*(symbols_for(holdings[d]) for d in todo))
            start = datetime.date.fromisoformat(min(todo)) - datetime.timedelta(days=LOOKBACK_DAYS)
            closes, gaps, errors, found = self._fetch(symbols, start)
            self._note_splits(found, holdings[today_s], first_seen, today)
            split_map = {}
            for s in self.store.splits_list():
                if s["status"] != "dismissed":
                    split_map.setdefault(s["sym"], []).append((s["date"], s["ratio"]))

            new_days, finalized, prev_rec = [], [], None
            for d in sorted(set(records) | todo):
                if d not in todo:
                    prev_rec = records[d]
                    continue
                rec = value_day(d, holdings[d], settings, closes, prev_rec, records.get(d), gaps, split_map, first_seen)
                existed = d in records
                rec["filled"] = records[d].get("filled", False) if existed else d != today_s
                start_of_day = datetime.datetime.combine(datetime.date.fromisoformat(d), datetime.time.min).timestamp()
                settled = now >= start_of_day + SETTLE_HOURS * 3600
                stale = (today - datetime.date.fromisoformat(d)).days > GIVE_UP_DAYS
                rec["final"] = settled and (not rec["missing"] or stale)
                rec["at"] = int(now)
                if not existed:
                    new_days.append(d)
                if rec["final"]:
                    finalized.append(d)
                records[d] = rec
                prev_rec = rec

            self.store.history_put([records[d] for d in sorted(todo) if d in records])

        self._report(new_days, finalized, today_s, records, errors, len(symbols))
        return any(records[d]["missing"] for d in todo if d in records)

    def _report(self, new_days, finalized, today_s, records, errors, n_symbols):
        filled = [d for d in new_days if d != today_s]
        if filled:
            span = filled[0] if len(filled) == 1 else f"{filled[0]} to {filled[-1]}"
            self.log(f"history: filled {len(filled)} missed day(s), {span}")
        if today_s in new_days:
            self.log(f"history: started {today_s}")
        if finalized:
            self.log(f"history: settled {', '.join(finalized)}")
        err_kinds = Counter(e[0] for e in errors.values())
        if errors and err_kinds != self._last_errors:
            sym, (kind, msg) = next(iter(sorted(errors.items())))
            kinds = ", ".join(f"{k} {n}" for k, n in err_kinds.most_common())
            self.log(f"history: price fetch failed for {len(errors)}/{n_symbols} symbol(s) ({kinds}); e.g. {sym}: {msg}")
        elif not errors and self._last_errors:
            self.log("history: price fetch recovered")
        self._last_errors = err_kinds if errors else None
        missing = sorted({s for r in records.values() if not r.get("final") for s in r.get("missing") or []})
        if missing != self._last_missing and not errors:
            if missing:
                self.log(f"history: no close yet for {', '.join(missing[:10])}{' …' if len(missing) > 10 else ''}; using last known")
        self._last_missing = missing

    # ---------- background loop ----------
    def kick(self):
        """Holdings changed: refresh today's record soon."""
        self._kick.set()

    def start(self):
        threading.Thread(target=self._loop, name="history", daemon=True).start()

    def _loop(self):
        last_pass, last_day, retry_soon = 0.0, None, False
        last_seen = time.time()
        while True:
            kicked = self._kick.wait(0 if last_day is None else CHECK_EVERY)
            if kicked:
                time.sleep(SETTLE_AFTER_SAVE)
                self._kick.clear()
            now = time.time()
            if now - last_seen > 3 * CHECK_EVERY:
                self.log(f"resumed after {(now - last_seen) / 60:.0f} min without running (sleep or pause)")
            last_seen = now
            today = datetime.date.today()
            wait = RETRY_EVERY if retry_soon else PASS_EVERY
            if not (kicked or today != last_day or now - last_pass >= wait):
                continue
            try:
                retry_soon = self.run_pass(now)
                self.last_pass = {"at": int(time.time()), "ok": True, "error": None}
            except Exception as exc:  # keep the loop alive; the next pass tries again
                self.log(f"history: pass failed: {type(exc).__name__}: {exc}")
                self.last_pass = {"at": int(time.time()), "ok": False, "error": f"{type(exc).__name__}: {exc}"}
                retry_soon = True
            last_pass, last_day = time.time(), today
            last_seen = time.time()
