"""
Live quotes.

Yahoo Finance's chart endpoint is the main source. When it fails for a reason
that is not "no such symbol", the lighter spark endpoint is tried, then Alpha
Vantage if a key is saved in Settings. When every source fails, the last good
quote kept in the database is returned and marked stale, so the dashboard can
say "last known" instead of guessing.
"""
import json
import socket
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
CACHE_TTL = 20  # seconds; stops rapid refreshes from hammering the sources
ERROR_TTL = 15  # seconds; a failed symbol is not fetched again on every refresh
ALPHA_TTL = 15 * 60  # the free Alpha Vantage tier allows 25 calls a day
SEARCH_TTL = 10 * 60
QUOTE_DEADLINE = 16  # seconds for the whole batch; the page stops waiting at 20
HOST_TIMEOUT = 4  # a healthy answer takes well under a second
HOST_COOLDOWN = 30  # seconds a host that timed out or was unreachable is skipped
SLOW_BATCH = 5  # seconds; a batch slower than this is logged even when it succeeds
WARM_EVERY = 5 * 60
SEARCH_TYPES = {"EQUITY", "ETF", "MUTUALFUND", "CRYPTOCURRENCY", "INDEX", "CURRENCY"}

_cache = {}
_cache_lock = threading.Lock()
_host_down_until = {}
_host_lock = threading.Lock()
_batch_lock = threading.Lock()
_batch_state = {"failing": False, "symbol_errors": {}}
_alpha_lock = threading.Lock()
_alpha_state = {"day": None, "calls": 0, "blocked_until": 0.0}


def _cache_get(sym):
    with _cache_lock:
        hit = _cache.get(sym)
        if hit and time.monotonic() - hit[0] < hit[2]:
            return hit[1]
    return None


def _cache_put(sym, payload, ttl):
    with _cache_lock:
        _cache[sym] = (time.monotonic(), payload, ttl)


def _host_ok(host):
    with _host_lock:
        return time.monotonic() >= _host_down_until.get(host, 0)


def _host_failed(host):
    """Skip this host for a while, so one that hangs (for example just after
    the Mac wakes, before the network is back) cannot use up a whole batch."""
    with _host_lock:
        _host_down_until[host] = time.monotonic() + HOST_COOLDOWN


def _short(exc):
    return str(exc).split("\n", 1)[0][:200]


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _chart_error(exc):
    try:
        return ((json.loads(exc.read()).get("chart") or {}).get("error") or {}).get("description") or ""
    except Exception:
        return ""


def _yahoo_get(path, deadline, describe=None):
    """GET a Yahoo path from the first healthy host. Returns (json, None) or
    (None, (kind, message)); see yahoo_chart for the kinds."""
    err = None
    for host in YAHOO_HOSTS:
        if not _host_ok(host):
            continue
        remaining = deadline - time.monotonic()
        if remaining < 0.5:
            return None, err or ("deadline", "not tried before the batch deadline")
        try:
            req = Request(f"https://{host}{path}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urlopen(req, timeout=min(HOST_TIMEOUT, remaining)) as resp:
                return json.load(resp), None
        except HTTPError as exc:
            desc = (describe or _chart_error)(exc)
            if exc.code == 404:
                return None, ("symbol", desc or "symbol not found")
            err = ("http", f"HTTP {exc.code} from {host}" + (f": {desc}" if desc else ""))
        except URLError as exc:
            _host_failed(host)
            if isinstance(exc.reason, socket.timeout):
                err = ("timeout", f"{host} did not answer in {HOST_TIMEOUT}s")
            else:
                err = ("network", f"{host}: {_short(exc.reason)}")
        except socket.timeout:
            _host_failed(host)
            err = ("timeout", f"{host} stopped answering mid-response")
        except ValueError as exc:
            err = ("http", f"{host}: unreadable response ({_short(exc)})")
        except OSError as exc:
            _host_failed(host)
            err = ("network", f"{host}: {_short(exc)}")
    return None, err or ("offline", f"every Yahoo host failed in the last {HOST_COOLDOWN}s")


def yahoo_chart(sym, query, deadline):
    """Fetch one chart from the first healthy Yahoo host that answers.
    Returns (result, None) or (None, (kind, message)), where kind is:
      symbol    Yahoo has no data for this symbol; retrying will not help
      http      Yahoo answered with an error status (rate limit, outage)
      timeout   a host did not answer within HOST_TIMEOUT
      network   a host could not be reached (DNS, refused, reset)
      offline   every host failed within HOST_COOLDOWN, so none was tried
      deadline  the batch ran out of time before this symbol was tried"""
    data, err = _yahoo_get(f"/v8/finance/chart/{quote(sym)}?{query}", deadline)
    if err:
        return None, err
    chart = data.get("chart") or {}
    result = (chart.get("result") or [None])[0]
    if not result:
        return None, ("symbol", (chart.get("error") or {}).get("description") or "symbol not found")
    return result, None


def previous_close(meta, closes, price):
    """Close of the previous session, the baseline for the Today column.

    Yahoo's daily bars often include an empty session (yesterday's open,
    high, low and close are all null) and still put today's live price on
    the latest bar. Dropping those nulls makes the second-to-last close two
    sessions back, so a stock that fell today can show a gain. The chart
    meta's full-day change is that session's move. chartPreviousClose is the
    close before the requested window, not yesterday, so it is only a last
    resort when the window itself has no bars.
    """
    prev = meta.get("previousClose")
    if _is_num(prev):
        return prev
    anchor = meta.get("fulldayPrice")
    change = meta.get("fulldayChange")
    if not _is_num(anchor):
        anchor = price
    if _is_num(anchor) and _is_num(change):
        return anchor - change
    if len(closes) >= 2:
        return closes[-2]
    chart_prev = meta.get("chartPreviousClose")
    return chart_prev if _is_num(chart_prev) else None


# ---------- sources ----------
def from_chart(sym, deadline):
    result, err = yahoo_chart(sym, "interval=1d&range=5d", deadline)
    if err is None:
        meta = result.get("meta", {})
        price = meta.get("regularMarketPrice")
        if price is None:
            err = ("symbol", "no price in response")
    if err:
        return None, err
    quotes = (result.get("indicators", {}).get("quote") or [{}])[0]
    closes = [c for c in (quotes.get("close") or []) if c is not None]
    return {
        "price": price,
        "prev": previous_close(meta, closes, price),
        "currency": meta.get("currency"),
        "name": meta.get("shortName") or meta.get("longName"),
        "exchange": meta.get("exchangeName"),
        "time": meta.get("regularMarketTime"),
        "source": "yahoo",
    }, None


def from_spark(sym, deadline):
    data, err = _yahoo_get(f"/v8/finance/spark?symbols={quote(sym)}&range=5d&interval=1d", deadline, describe=lambda e: "")
    if err:
        return None, err
    row = (data or {}).get(sym)
    if not isinstance(row, dict):
        return None, ("symbol", "no data from spark")
    closes = [c for c in (row.get("close") or []) if _is_num(c)]
    price = row.get("fulldayPrice")
    if not _is_num(price):
        price = closes[-1] if closes else None
    if price is None:
        return None, ("symbol", "no price from spark")
    times = [t for t in (row.get("timestamp") or []) if t]
    return {
        "price": price,
        "prev": previous_close(row, closes, price),
        "currency": None,
        "name": None,
        "exchange": None,
        "time": times[-1] if times else None,
        "source": "yahoo-spark",
    }, None


def _alpha_request(params):
    url = "https://www.alphavantage.co/query?" + urlencode(params)
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=HOST_TIMEOUT + 3) as resp:
        return json.load(resp)


def alpha_params(sym):
    """Alpha Vantage query for a Yahoo symbol, or None when it has no equivalent."""
    if sym.endswith("=X") and len(sym) == 8:
        return {"function": "CURRENCY_EXCHANGE_RATE", "from_currency": sym[:3], "to_currency": sym[3:6]}
    if sym.endswith(".NS"):
        return {"function": "GLOBAL_QUOTE", "symbol": sym[:-3] + ".BSE"}  # NSE is not covered
    if sym.endswith(".BO"):
        return {"function": "GLOBAL_QUOTE", "symbol": sym[:-3] + ".BSE"}
    if "-" in sym and sym.rsplit("-", 1)[1] in ("USD", "EUR", "INR"):
        base, quote_cur = sym.rsplit("-", 1)
        return {"function": "CURRENCY_EXCHANGE_RATE", "from_currency": base, "to_currency": quote_cur}
    if sym.startswith("^"):
        return None
    return {"function": "GLOBAL_QUOTE", "symbol": sym}


def from_alpha(sym, key, deadline=None):
    params = alpha_params(sym)
    if not key or not params:
        return None, ("symbol", "no Alpha Vantage key or equivalent symbol")
    today = time.strftime("%Y-%m-%d")
    with _alpha_lock:  # one call at a time: a free key allows one request a second and 25 a day
        if _alpha_state["day"] != today:
            _alpha_state.update(day=today, calls=0, blocked_until=0.0)
        if _alpha_state["calls"] >= 24 or time.monotonic() < _alpha_state["blocked_until"]:
            return None, ("http", "Alpha Vantage daily limit reached")
        wait = max(0.0, _alpha_state.get("next_at", 0.0) - time.monotonic())
        if deadline is not None and time.monotonic() + wait + 1 > deadline:
            return None, ("deadline", "not tried before the batch deadline")
        if wait:
            time.sleep(wait)
        _alpha_state["next_at"] = time.monotonic() + 1.3
        _alpha_state["calls"] += 1
        try:
            data = _alpha_request({**params, "apikey": key})
        except (URLError, OSError, ValueError) as exc:
            return None, ("network", f"Alpha Vantage: {_short(exc)}")
        note = data.get("Note") or data.get("Information")
        if note:
            if "per second" not in str(note).lower():
                _alpha_state["blocked_until"] = time.monotonic() + 3600
            return None, ("http", "Alpha Vantage: " + str(note)[:120])
    try:
        if params["function"] == "CURRENCY_EXCHANGE_RATE":
            r = data["Realtime Currency Exchange Rate"]
            return {"price": float(r["5. Exchange Rate"]), "prev": None, "currency": params["to_currency"],
                    "name": None, "exchange": None, "time": int(time.time()), "source": "alphavantage"}, None
        g = data["Global Quote"]
        return {"price": float(g["05. price"]), "prev": float(g["08. previous close"]) if g.get("08. previous close") else None,
                "currency": None, "name": None, "exchange": None, "time": int(time.time()), "source": "alphavantage"}, None
    except (KeyError, ValueError, TypeError):
        return None, ("symbol", "Alpha Vantage had no quote")


class Quotes:
    def __init__(self, store, get_settings, log):
        self.store = store
        self.get_settings = get_settings  # () -> portfolio settings dict
        self.log = log

    def fetch_symbol(self, sym, deadline):
        hit = _cache_get(sym)
        if hit is not None:
            return hit
        out, err = from_chart(sym, deadline)
        if out is None and err[0] != "symbol":
            out, _ = from_spark(sym, deadline)
        if out is None and err[0] not in ("symbol", "deadline"):
            key = (self.get_settings() or {}).get("alphaKey")
            if key:
                out = _cache_get("alpha:" + sym)
                if out is None:
                    out, _ = from_alpha(sym, key, deadline)
                    if out is not None:
                        _cache_put("alpha:" + sym, out, ALPHA_TTL)
        if out is not None:
            _cache_put(sym, out, CACHE_TTL)
            return out
        stale = self.store.quotes_get({sym}).get(sym)
        if stale and err[0] != "symbol":
            stale = dict(stale, stale=True, source="cache")
            stale["asOf"] = stale.get("time") or stale.get("fetchedAt")
            return stale
        res = {"error": err[1], "kind": err[0]}
        if err[0] in ("symbol", "http"):
            _cache_put(sym, res, ERROR_TTL)
        return res

    def fetch_many(self, symbols):
        start = time.monotonic()
        deadline = start + QUOTE_DEADLINE
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda s: self.fetch_symbol(s, deadline), symbols))
        self._log_batch(symbols, results, time.monotonic() - start)
        fresh = {s: {k: v for k, v in r.items() if k not in ("stale", "fetchedAt", "asOf")}
                 for s, r in zip(symbols, results) if r.get("price") is not None and not r.get("stale")}
        if fresh:
            try:
                self.store.quotes_put(fresh)
            except Exception as exc:  # a full disk must not stop live prices
                self.log(f"quotes: could not save last good prices: {exc}")
        return dict(zip(symbols, results))

    def search(self, text):
        text = (text or "").strip()
        if len(text) < 1 or len(text) > 40:
            return []
        hit = _cache_get("search:" + text.lower())
        if hit is not None:
            return hit
        data, err = _yahoo_get(f"/v1/finance/search?{urlencode({'q': text, 'quotesCount': 10, 'newsCount': 0})}",
                               time.monotonic() + 6, describe=lambda e: "")
        if err:
            return []
        out = []
        for q in (data or {}).get("quotes") or []:
            if q.get("quoteType") in SEARCH_TYPES and q.get("symbol"):
                out.append({"symbol": q["symbol"], "name": q.get("longname") or q.get("shortname") or "",
                            "exchange": q.get("exchDisp") or q.get("exchange") or "", "type": q.get("quoteType")})
        out = out[:8]
        _cache_put("search:" + text.lower(), out, SEARCH_TTL)
        return out

    def _log_batch(self, symbols, results, elapsed):
        """One line per batch that failed or was slow, one when quotes recover, and
        one per symbol whose own error (e.g. a delisted ticker) is new."""
        failed = []
        with _batch_lock:
            seen = _batch_state["symbol_errors"]
            for sym, r in zip(symbols, results):
                kind = r.get("kind")
                if kind == "symbol":
                    if seen.get(sym) != r["error"]:
                        seen[sym] = r["error"]
                        self.log(f"quote {sym}: {r['error']}")
                else:
                    seen.pop(sym, None)
                    if kind:
                        failed.append((sym, r))
            was_failing = _batch_state["failing"]
            _batch_state["failing"] = bool(failed)
        stale = [s for s, r in zip(symbols, results) if r.get("stale")]
        backup = Counter(r.get("source") for r in results if r.get("source") in ("yahoo-spark", "alphavantage"))
        if failed:
            kinds = ", ".join(f"{k} {n}" for k, n in Counter(r["kind"] for _, r in failed).most_common())
            sym, r = next(((s, r) for s, r in failed if r["kind"] not in ("offline", "deadline")), failed[0])
            self.log(f"quotes: {len(failed)}/{len(symbols)} failed in {elapsed:.1f}s ({kinds}); e.g. {sym}: {r['error']}")
        elif was_failing:
            self.log(f"quotes: recovered, {len(symbols)} ok in {elapsed:.1f}s")
        elif elapsed > SLOW_BATCH:
            self.log(f"quotes: slow, {len(symbols)} ok in {elapsed:.1f}s")
        if backup and not failed:
            self.log("quotes: main source failed, used " + ", ".join(f"{n} from {k}" for k, n in backup.items()))
        if stale and not failed:
            self.log(f"quotes: {len(stale)} served from the last good copy")
