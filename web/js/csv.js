/* Reading a broker's holdings export (CSV) into stock holdings. Pure, so it can be tested without a browser. */
(function (G) {
'use strict';

const HEADERS = {
  symbol: ['symbol', 'ticker', 'instrument', 'security', 'stock', 'scrip', 'trading symbol', 'tradingsymbol', 'asset', 'underlying symbol', 'symbol/cusip'],
  qty: ['quantity', 'qty', 'qty.', 'qty #', 'shares', 'units', 'position', 'shares held', 'holding quantity', 'net qty', 'current qty'],
  avg: ['avg cost', 'avg. cost', 'average cost', 'avg price', 'avg. price', 'average price', 'cost price', 'price paid', 'price paid $', 'cost basis per share',
    'buy avg', 'buy average', 'purchase price', 'average buy price', 'avg buy price', 'average cost price', 'cost/share', 'unit cost', 'open price'],
  total: ['cost basis', 'total cost', 'invested', 'invested value', 'buy value', 'cost basis money', 'total cost basis', 'amount invested', 'cost value'],
  broker: ['broker', 'account', 'platform', 'account name', 'account alias'],
  currency: ['currency', 'ccy', 'curr'],
  exchange: ['exchange', 'exch', 'market', 'listing exchange', 'primary exchange']
};
const SKIP_SYMBOLS = new Set(['TOTAL', 'TOTALS', 'GRAND TOTAL', 'CASH', 'SUBTOTAL', 'ACCOUNT TOTAL', 'PENDING ACTIVITY']);
const INDIA_EXCH = new Set(['NSE', 'NSI', 'BSE', 'BOM', 'BO', 'NS', 'XNSE', 'XBOM']);
const US_EXCH = new Set(['NASDAQ', 'NYSE', 'ARCA', 'AMEX', 'NMS', 'NYQ', 'NGM', 'PCX', 'BATS', 'NYSE ARCA', 'NYSEARCA', 'NASDAQ GS', 'ISLAND']);

function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const firstLines = text.split(/\r?\n/).slice(0, 15).join('\n');
  const delims = [',', ';', '\t', '|'];
  const delim = delims.map(d => [d, (firstLines.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows.map(r => r.map(c => c.trim()));
}

const norm = s => String(s || '').toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();

function parseNum(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s || /^(-|--|n\/a|na)$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[−–]/g, '-').replace(/[^\d.\-eE]/g, '');   // currency signs, commas (1,23,456.78), spaces
  if (s === '' || s === '-' || s === '.') return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/* Find the header row and which column means what. Broker exports often start with a few lines of account info. */
function detect(rows) {
  let best = null;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const map = {};
    rows[i].forEach((h, idx) => {
      const n = norm(h);
      for (const [field, names] of Object.entries(HEADERS)) {
        if (map[field] == null && names.includes(n)) map[field] = idx;
      }
    });
    const score = Object.keys(map).length;
    if (map.symbol != null && map.qty != null && (!best || score > best.score)) best = { index: i, map, score };
  }
  if (!best) return null;
  return { headerIndex: best.index, headers: rows[best.index], map: best.map };
}

function cleanSymbol(raw) {
  let s = String(raw || '').trim().toUpperCase();
  let exchange = null;
  const prefix = s.match(/^(NSE|BSE|NASDAQ|NYSE|BOM):\s*(.+)$/);
  if (prefix) { s = prefix[2]; exchange = prefix[1] === 'NSE' ? 'NSE' : prefix[1] === 'BSE' || prefix[1] === 'BOM' ? 'BSE' : null; }
  if (/\.NS$/.test(s)) { s = s.slice(0, -3); exchange = 'NSE'; }
  else if (/\.BO$/.test(s)) { s = s.slice(0, -3); exchange = 'BSE'; }
  else if (/\.US$/.test(s)) s = s.slice(0, -3);
  s = s.replace(/^([A-Z]{1,5}) ([A-Z])$/, '$1-$2');   // IBKR writes BRK B for Yahoo's BRK-B; longer text stays as it is and is skipped
  return { symbol: s, exchange };
}

/* rows -> holdings. opts: { map, headerIndex, broker, defaultKind: 'us' | 'in' } */
function toHoldings(rows, opts) {
  const { map, headerIndex } = opts;
  const out = [], skipped = [];
  const at = (r, f) => (map[f] == null ? '' : r[map[f]]);
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i], line = i + 1;
    const { symbol, exchange: symEx } = cleanSymbol(at(r, 'symbol'));
    if (!symbol || SKIP_SYMBOLS.has(symbol)) { if (symbol) skipped.push({ line, symbol, reason: 'a total row' }); continue; }
    if (!/^[A-Z0-9.^&_\-]{1,24}$/.test(symbol)) { skipped.push({ line, symbol, reason: 'not a ticker' }); continue; }
    const qty = parseNum(at(r, 'qty'));
    if (qty == null) { skipped.push({ line, symbol, reason: 'no quantity' }); continue; }
    if (qty <= 0) { skipped.push({ line, symbol, reason: qty < 0 ? 'a short position' : 'zero quantity' }); continue; }
    let avg = parseNum(at(r, 'avg'));
    if (avg == null || avg <= 0) {
      const total = parseNum(at(r, 'total'));
      avg = total != null && total > 0 ? total / qty : null;
    }
    const ccy = norm(at(r, 'currency')).toUpperCase();
    const exch = String(at(r, 'exchange') || '').trim().toUpperCase();
    let kind = opts.defaultKind || 'us';
    let exchange = symEx;
    if (symEx || INDIA_EXCH.has(exch) || ccy === 'INR') { kind = 'in'; exchange = exchange || (exch === 'BSE' || exch === 'BOM' || exch === 'BO' || exch === 'XBOM' ? 'BSE' : 'NSE'); }
    else if (US_EXCH.has(exch) || ccy === 'USD') kind = 'us';
    else if (ccy && ccy !== 'USD' && ccy !== 'INR') { skipped.push({ line, symbol, reason: `${ccy} stocks are not supported here` }); continue; }
    const item = { kind, symbol, qty, avg: avg == null ? 0 : avg, broker: String(at(r, 'broker') || opts.broker || '').trim() };
    if (kind === 'in') item.exchange = exchange || 'NSE';
    if (avg == null) item.warn = 'no average price; set it after importing';
    out.push(item);
  }
  return { items: mergeLots(out), skipped };
}

/* the same symbol twice for one broker (separate lots): one holding with the weighted average cost */
function mergeLots(items) {
  const by = new Map(), out = [];
  for (const it of items) {
    const key = [it.kind, it.broker, it.symbol, it.exchange || ''].join('|');
    const hit = by.get(key);
    if (!hit) { const copy = { ...it }; by.set(key, copy); out.push(copy); continue; }
    const q = hit.qty + it.qty;
    hit.avg = q ? (hit.avg * hit.qty + it.avg * it.qty) / q : 0;
    hit.qty = q;
    if (it.warn) hit.warn = it.warn;
  }
  return out;
}

/* Put parsed items into the portfolio S. mode 'add' joins a holding the broker already has for that symbol
   (weighted average cost); 'replace' first removes what that broker holds in the kinds being imported. */
function applyImport(S, items, mode, uid) {
  let added = 0, merged = 0, removed = 0;
  if (mode === 'replace') {
    const scopes = new Set(items.map(i => i.kind + '|' + i.broker));
    for (const scope of scopes) {
      const [kind, broker] = scope.split('|');
      const keep = S[kind].filter(h => (h.broker || '') !== broker);
      removed += S[kind].length - keep.length;
      S[kind] = keep;
    }
  }
  for (const it of items) {
    const list = S[it.kind];
    const same = list.find(h => (h.broker || '') === it.broker && String(h.symbol).toUpperCase() === it.symbol && (it.kind !== 'in' || (h.exchange || 'NSE') === it.exchange));
    if (same) {
      const q = (same.qty || 0) + it.qty;
      same.avg = q ? ((same.avg || 0) * (same.qty || 0) + it.avg * it.qty) / q : 0;
      same.qty = q;
      merged++;
    } else {
      const h = { id: uid(), broker: it.broker, symbol: it.symbol, qty: it.qty, avg: it.avg, manualPrice: null, manualAt: 0 };
      if (it.kind === 'in') h.exchange = it.exchange;
      list.push(h);
      added++;
    }
  }
  return { added, merged, removed };
}

G.Folio = Object.assign(G.Folio || {}, { parseCSV, parseNum, detectCSV: detect, csvToHoldings: toHoldings, applyImport, CSV_FIELDS: Object.keys(HEADERS) });
if (typeof module !== 'undefined') module.exports = G.Folio;
})(typeof window !== 'undefined' ? window : globalThis);
