/* Valuation: which price to trust, exchange rates, and totals. Pure functions of the saved data (S) and the live quotes. */
(function (G) {
'use strict';
const KEYS = ['us', 'in', 'bcash', 'bank', 'hand', 'pf', 'other'];
const { FX_EXTRA } = G.Folio;
function ySym(kind, h) {
  const s = (h.symbol || '').trim().toUpperCase();
  if (!s) return '';
  if (kind === 'in') return /\.(NS|BO)$/.test(s) ? s : s + (h.exchange === 'BSE' ? '.BO' : '.NS');
  return s;
}
function usesCur(S, code) {
  return ['bcash', 'bank', 'hand', 'other'].some(k => (S[k] || []).some(h => h.currency === code));
}
function allSymbols(S) {
  const set = new Set(['USDINR=X']);
  for (const [code, fx] of Object.entries(FX_EXTRA)) if (usesCur(S, code)) set.add(fx.sym);
  ['us', 'in', 'other'].forEach(k => S[k].forEach(h => { const s = ySym(k, h); if (s) set.add(s); }));
  return [...set];
}
/* pick the best available price: live, else newest of fallback / last known, else none */
function pick(S, live, sym, manual, manualAt) {
  const l = live[sym];
  const c = [];
  if (l && l.price != null && !l.stale) return { p: l.price, prev: l.prev, src: 'live', source: l.source, asOf: l.time };
  if (l && l.price != null) c.push({ p: l.price, prev: null, src: 'last', at: (l.asOf || l.fetchedAt || 0) * 1000, source: 'server copy' });
  if (manual != null && manual !== '') c.push({ p: +manual, prev: null, src: 'manual', at: manualAt || 0 });
  const k = S.cache.quotes[sym];
  if (k) c.push({ p: k.price, prev: null, src: 'last', at: k.at });
  c.sort((a, b) => b.at - a.at);
  return c[0] || null;
}
function fxPair(S, live, sym, manual, manualAt, fallback) {
  const pr = pick(S, live, sym, manual, manualAt);
  return pr && pr.p > 0 ? { rate: pr.p, src: pr.src } : { rate: fallback, src: 'cost' };
}
function fxInfo(S, live) {
  const usdInr = fxPair(S, live, 'USDINR=X', S.settings.fxManual, S.settings.fxManualAt, 85);
  const extra = {};
  for (const [code, fx] of Object.entries(FX_EXTRA)) {
    extra[code] = fxPair(S, live, fx.sym, S.settings[fx.manual], S.settings[fx.at], fx.fallback);
  }
  return { rate: usdInr.rate, src: usdInr.src, extra };
}
function compute(S, live) {
  const base = S.settings.base;
  const fx = fxInfo(S, live);
  const conv = (v, cur) => {
    if (cur === base) return v;
    let usd;
    if (cur === 'USD') usd = v;
    else if (cur === 'INR') usd = v / fx.rate;
    else if (FX_EXTRA[cur]) usd = v / fx.extra[cur].rate;
    else usd = base === 'INR' ? v : v / fx.rate;
    return base === 'USD' ? usd : usd * fx.rate;
  };

  const stocks = (kind, cur) => S[kind].map(h => {
    const sym = ySym(kind, h);
    const pr = sym ? pick(S, live, sym, h.manualPrice, h.manualAt) : null;
    const price = pr ? pr.p : null;
    const cost = (h.qty || 0) * (h.avg || 0);
    const value = price != null ? (h.qty || 0) * price : cost;
    const pnl = value - cost;
    const day = pr && pr.src === 'live' && pr.prev != null ? (h.qty || 0) * (price - pr.prev) : null;
    return { ...h, cur, sym, price, src: pr ? pr.src : 'cost', source: pr && pr.source, priceAt: pr && (pr.at || (pr.asOf && pr.asOf * 1000)), cost, value, pnl, day,
      pnlPct: cost ? pnl / cost * 100 : null,
      valueBase: conv(value, cur), costBase: conv(cost, cur), pnlBase: conv(pnl, cur),
      dayBase: day != null ? conv(day, cur) : null };
  });
  const cash = kind => S[kind].map(h => ({ ...h, cur: h.currency, value: h.balance || 0, valueBase: conv(h.balance || 0, h.currency) }));
  const pf = S.pf.map(h => ({ ...h, cur: 'INR', value: h.balance || 0, valueBase: conv(h.balance || 0, 'INR') }));
  const other = S.other.map(h => {
    const sym = ySym('other', h);
    let price = null, src = 'manual', source = null, value = h.value || 0, day = null;
    if (sym) {
      const pr = pick(S, live, sym, h.price, h.priceAt);
      if (pr) {
        price = pr.p; src = pr.src; source = pr.source; value = (h.qty || 0) * pr.p;
        if (pr.src === 'live' && pr.prev != null) day = (h.qty || 0) * (pr.p - pr.prev);
      } else { src = 'cost'; }
    }
    return { ...h, cur: h.currency, sym, price, src, source, value, valueBase: conv(value, h.currency), dayBase: day != null ? conv(day, h.currency) : null };
  });

  const cats = { us: { items: stocks('us', 'USD') }, in: { items: stocks('in', 'INR') },
    bcash: { items: cash('bcash') }, bank: { items: cash('bank') }, hand: { items: cash('hand') }, pf: { items: pf }, other: { items: other } };
  let net = 0, day = 0, hasDay = false;
  for (const k of KEYS) {
    const c = cats[k];
    c.total = c.items.reduce((a, h) => a + h.valueBase, 0);
    c.pnl = c.items.reduce((a, h) => a + (h.pnlBase || 0), 0);
    c.hasPnl = k === 'us' || k === 'in';
    net += c.total;
    c.items.forEach(h => { if (h.dayBase != null) { day += h.dayBase; hasDay = true; } });
  }
  const hasExtra = {};
  for (const code of Object.keys(FX_EXTRA)) hasExtra[code] = usesCur(S, code);
  return { base, fx, conv, cats, net, day, hasDay, hasExtra, count: KEYS.reduce((a, k) => a + cats[k].items.length, 0) };
}
G.Folio = Object.assign(G.Folio || {}, { KEYS, ySym, usesCur, allSymbols, pick, fxPair, fxInfo, compute });
if (typeof module !== 'undefined') module.exports = G.Folio;
})(typeof window !== 'undefined' ? window : globalThis);
