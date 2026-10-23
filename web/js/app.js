/* The dashboard: state, data loading, forms and events. What is drawn lives in views-*.js and charts.js; pure helpers in the other files here. */
(() => {
'use strict';
const { esc, uid, FX_EXTRA, money, qty, compact, PALETTES, BASE, parseCSV, detectCSV, csvToHoldings, applyImport, icon, Charts } = Folio;
const V = Folio.views;
const { isoDay, dayLabel } = V;
const dlgHead = (title, sub) => `<div class="dlg-h"><div><h2 id="dlg-title">${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div><button type="button" class="icon-btn sm" data-act="cancel" aria-label="Close">${icon('x', 16)}</button></div>`;

/* ---------- state ---------- */
const KEY = 'networth.v1';
const UI_KEY = 'folio.ui.v3';
const $ = (s, r = document) => r.querySelector(s);

/* per-browser view choices (not part of your data): grouping, broker filter, sort order */
const ui = (() => {
  const d = { group: 'broker', view: 'table', mapBy: 'day', ovList: 'largest', broker: { us: '', in: '' }, sorts: {} };
  try { const r = JSON.parse(localStorage.getItem(UI_KEY)); if (r && typeof r === 'object') return { ...d, ...r, broker: { ...d.broker, ...(r.broker || {}) }, sorts: r.sorts || {} }; } catch (e) {}
  return d;
})();
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) {} };

const paletteId = mode => {
  const set = PALETTES[mode];
  const saved = S.settings.palette && S.settings.palette[mode];
  return set[saved] ? saved : Object.keys(set)[0];
};

const defaults = () => ({
  settings: { base: 'INR', backend: '', alphaKey: '', fxManual: null, fxManualAt: 0, thbManual: null, thbManualAt: 0, aedManual: null, aedManualAt: 0, mask: false, mode: 'light', palette: { light: 'navy', dark: 'brass' } },
  us: [], in: [], bcash: [], bank: [], hand: [], pf: [], other: [], trades: [],
  cache: { quotes: {} }
});
const merge = r => {
  const d = defaults();
  return { ...d, ...r, settings: { ...d.settings, ...(r.settings || {}) }, cache: { quotes: {}, ...(r.cache || {}) } };
};
const load = () => { try { const r = JSON.parse(localStorage.getItem(KEY)); if (r) return merge(r); } catch (e) {} return defaults(); };
let S = load();
const remote = { on: false, state: 'off', timer: null, rev: 0, sending: false, dirty: false, body: null };   // state: off | saving | saved | error | conflict; body: what data.json holds

function resolveMode() {
  if (S.settings.mode === 'light' || S.settings.mode === 'dark') return S.settings.mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme() {
  const mode = resolveMode();
  const pal = PALETTES[mode][paletteId(mode)];
  const root = document.documentElement;
  Object.entries(BASE[mode]).forEach(([k, v]) => root.style.setProperty(k, v));
  Object.entries(pal).forEach(([k, v]) => { if (k.startsWith('--')) root.style.setProperty(k, v); });
  root.style.colorScheme = mode;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
  if (!remote.on) return;
  if (!remote.sending && !remote.dirty && JSON.stringify(dataForServer()) === remote.body) return;   // only the price cache changed
  remote.dirty = true;
  remote.state = 'saving';
  updateSyncNote();
  clearTimeout(remote.timer);
  remote.timer = setTimeout(pushRemote, 400);
}
function dataForServer() {
  const { cache, ...data } = S;
  data.settings = { ...S.settings };
  delete data.settings.backend;          // the server address stays per browser
  return data;
}
async function pushRemote() {
  if (remote.sending) return;
  remote.sending = true;
  remote.dirty = false;
  const sentRev = remote.rev;
  const body = JSON.stringify(dataForServer());
  try {
    const r = await fetch(apiBase() + '/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': String(sentRev) },
      body
    });
    if (r.status === 409) {
      remote.sending = false;
      await syncFromServer();
      remote.state = 'conflict';
      updateSyncNote();
      render();
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (typeof d.rev === 'number') remote.rev = d.rev;
    remote.body = body;
    remote.state = remote.dirty ? 'saving' : 'saved';
  } catch (e) { remote.state = 'error'; }
  remote.sending = false;
  updateSyncNote();
  if (remote.dirty && remote.on) pushRemote();
}
function syncText() {
  return {
    off: '', saving: 'Saving…', saved: '',
    error: 'Could not save to data.json',
    conflict: 'data.json changed elsewhere. Reloaded the saved copy.'
  }[remote.state];
}
function updateSyncNote() { const el = document.getElementById('sync'); if (el) el.textContent = syncText(); }
async function syncFromServer() {
  remote.on = false; remote.state = 'off';
  try {
    const r = await fetch(apiBase() + '/api/data');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    remote.on = true;
    remote.rev = typeof d.rev === 'number' ? d.rev : 0;
    remote.dirty = false;
    if (d.exists && d.data) {                       // the file on disk is the source of truth
      const cache = S.cache, backend = S.settings.backend;
      S = merge(d.data); S.cache = cache; S.settings.backend = backend;
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
      remote.body = JSON.stringify(dataForServer());
      remote.state = 'saved';
    } else if (KEYS_COUNT() > 0) {                  // first run with the file: move browser data into it
      remote.state = 'saving'; pushRemote();
    } else remote.state = 'saved';
  } catch (e) { remote.on = false; remote.state = 'off'; }
}
const KEYS_COUNT = () => KEYS.reduce((a, k) => a + S[k].length, 0);

let live = {};                       // symbol -> live quote from the server
const ySym = Folio.ySym;
const pick = (sym, manual, manualAt) => Folio.pick(S, live, sym, manual, manualAt);
const fxInfo = () => Folio.fxInfo(S, live);
const usesCur = code => Folio.usesCur(S, code);
const allSymbols = () => Folio.allSymbols(S);
const compute = () => Folio.compute(S, live);
let status = { state: 'loading' };
let tab = 'overview';
let book = 'overview';
let query = '';
let editing = null;

const KEYS = Folio.KEYS;

/* ---------- live quotes ---------- */
function apiBase() {
  const b = (S.settings.backend || '').trim();
  if (b) return b.replace(/\/$/, '');
  return location.protocol === 'file:' ? 'http://localhost:8787' : '';
}
const RETRY_FIRST = 10000, RETRY_MAX = 120000, STALE_AFTER = 5 * 60000;
let quoteSeq = 0, retryTimer = null, retryDelay = 0, lastQuotesAt = 0;
function scheduleRetry(transient) {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (!transient) { retryDelay = 0; return; }
  retryDelay = retryDelay ? Math.min(retryDelay * 2, RETRY_MAX) : RETRY_FIRST;
  retryTimer = setTimeout(loadQuotes, retryDelay);
}
async function loadQuotes() {
  const seq = ++quoteSeq;
  clearTimeout(retryTimer);
  status = { state: 'loading' };
  render();
  const syms = allSymbols();
  let transient = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(apiBase() + '/api/quotes?symbols=' + encodeURIComponent(syms.join(',')), { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (seq !== quoteSeq) return;
    live = {};
    const bad = [];
    for (const s of syms) {
      const q = d.quotes && d.quotes[s];
      if (q && q.price != null) {
        live[s] = q;
        if (q.stale) { bad.push(s); transient = true; }              // the server only had its last good copy
        else S.cache.quotes[s] = { price: q.price, at: Date.now() };
      } else { bad.push(s); if (!q || q.kind !== 'symbol') transient = true; }
    }
    save();
    lastQuotesAt = Date.now();
    status = bad.length === syms.length
      ? { state: 'offline', msg: 'The server answered, but no price source returned quotes. Check your internet connection.' }
      : { state: bad.length ? 'partial' : 'live', at: new Date(), bad };
  } catch (e) {
    if (seq !== quoteSeq) return;
    live = {};
    transient = true;
    status = { state: 'offline', msg: 'Price server not reachable.' };
  }
  scheduleRetry(transient);
  status.retrying = !!retryTimer;
  render();
  loadHistory();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastQuotesAt > STALE_AFTER) loadQuotes();
});
window.addEventListener('online', () => loadQuotes());

/* ---------- history ---------- */
let hist = [];                       // one entry per day from the server: { date, net (INR), cats, fx, final, filled, missing }
let trendRange = '3M';
let attr = null;                     // what moved net worth over trendRange: { range, from, data }
let health = null;                   // history snapshots: estimated days, last run
let splits = [];                     // stock splits waiting for the user
let storage = null;                  // database state shown in Settings
const getJson = async path => { const r = await fetch(apiBase() + path); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
const postJson = async (path, body) => {
  const r = await fetch(apiBase() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
  return r.json();
};
async function loadHistory() {
  if (!remote.on) { hist = []; attr = null; health = null; splits = []; return; }
  try {
    const [h, hh, sp] = await Promise.all([getJson('/api/history'), getJson('/api/history/health').catch(() => null), getJson('/api/splits').catch(() => null)]);
    hist = Array.isArray(h.days) ? h.days : [];
    health = hh;
    splits = sp && Array.isArray(sp.splits) ? sp.splits : [];
  } catch (e) { return; }
  loadStorage();
  await loadAttribution(false);
  if (tab === 'overview' || tab === 'us' || tab === 'in') render();
}
const rangeFrom = () => V.rangeFrom(trendRange);
async function loadAttribution(redraw = true) {
  if (!remote.on) return;
  const from = rangeFrom(), range = trendRange;
  try {
    const data = await getJson('/api/attribution' + (from ? '?from=' + from : ''));
    if (range === trendRange) attr = { range, from, data };
  } catch (e) { attr = null; }
  if (redraw && tab === 'overview') render();
}
async function loadStorage() {
  try { storage = await getJson('/api/status'); } catch (e) { storage = null; }
  if (tab === 'settings' || tab === 'overview') render();
}



/* ---------- what the views see ---------- */
let rebuilding = false;
let pending = [];                                  // charts to mount once the page is in the DOM
const rebuildFrom = () => { const e = health && health.estimated && health.estimated[0]; return e ? e.date : isoDay(new Date(Date.now() - 30 * 864e5)); };
const X = {
  get S() { return S; }, get live() { return live; }, get status() { return status; }, get remote() { return remote; }, get ui() { return ui; },
  get tab() { return tab; }, get query() { return query; }, get trendRange() { return trendRange; }, get hist() { return hist; }, get attr() { return attr; },
  get health() { return health; }, get splits() { return splits; }, get storage() { return storage; }, get rebuilding() { return rebuilding; },
  get mode() { return resolveMode(); }, paletteId, syncText, rebuildFrom,
  queue(sel, fn) { pending.push([sel, fn]); }
};

function render() {
  Charts.unmountAll();
  pending = [];
  const tip = document.getElementById('tip');
  if (tip) tip.hidden = true;
  const typing = document.activeElement && document.activeElement.id === 'q'
    ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  applyTheme();
  document.body.classList.toggle('masked', !!S.settings.mask);
  const c = compute();
  const html = { overview: () => V.overview(X, c), us: () => V.holdings(X, c, 'us'), in: () => V.holdings(X, c, 'in'),
    cash: () => V.cash(X, c), pf: () => V.pf(X, c), other: () => V.other(X, c), settings: () => V.settings(X, c) }[tab]();
  $('#app').innerHTML = html;
  document.title = `${V.PAGE[tab] || 'Overview'} · Folio`;
  pending.forEach(([sel, fn]) => { const el = $(sel); if (el) fn(el); });
  const q = document.getElementById('q');
  if (q && typing) { q.focus(); q.setSelectionRange(typing[0], typing[1]); }
}

/* ---------- toasts (with undo) ---------- */
function toast(message, opt = {}) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast'; el.setAttribute('role', 'status');
  el.append(Object.assign(document.createElement('span'), { textContent: message }));
  const close = () => { el.remove(); };
  if (opt.undo) {
    const b = Object.assign(document.createElement('button'), { className: 'btn sm', type: 'button', textContent: 'Undo' });
    b.addEventListener('click', () => { opt.undo(); close(); });
    el.append(b);
  }
  box.append(el);
  setTimeout(close, opt.undo ? 8000 : 4500);
}

/* ---------- command palette ---------- */
let pal = { items: [], shown: [], sel: 0 };
function paletteItems() {
  const go = (t, q) => () => { tab = t; query = q || ''; render(); window.scrollTo({ top: 0 }); };
  const out = [];
  [['overview', 'Overview', 'layout-dashboard'], ['us', 'US stocks', 'trending-up'], ['in', 'Indian stocks', 'chart-column'], ['cash', 'Cash', 'wallet'],
    ['pf', 'Provident fund', 'piggy-bank'], ['other', 'Other assets', 'package'], ['settings', 'Settings', 'settings']]
    .forEach(([t, n, ic]) => out.push({ group: 'Go to', label: n, icon: ic, run: go(t) }));
  out.push({ group: 'Actions', label: 'Add a US stock', icon: 'plus', run: () => openForm('us') },
    { group: 'Actions', label: 'Add an Indian stock', icon: 'plus', run: () => openForm('in') },
    { group: 'Actions', label: 'Add a bank account', icon: 'plus', run: () => openForm('bank') },
    { group: 'Actions', label: 'Import holdings from a CSV', icon: 'upload', run: () => { csvTarget = tab === 'in' ? 'in' : 'us'; $('#csvfile').click(); } },
    { group: 'Actions', label: 'Refresh prices', icon: 'refresh-cw', run: () => loadQuotes() },
    { group: 'Actions', label: S.settings.mask ? 'Show amounts' : 'Hide amounts', icon: S.settings.mask ? 'eye' : 'eye-off', run: () => { S.settings.mask = !S.settings.mask; save(); render(); } },
    { group: 'Actions', label: `Switch to ${resolveMode() === 'dark' ? 'light' : 'dark'} mode`, icon: resolveMode() === 'dark' ? 'sun' : 'moon', run: () => { S.settings.mode = resolveMode() === 'dark' ? 'light' : 'dark'; save(); render(); } },
    { group: 'Actions', label: 'Show amounts in ' + (S.settings.base === 'INR' ? 'USD' : 'INR'), icon: 'coins', run: () => { S.settings.base = S.settings.base === 'INR' ? 'USD' : 'INR'; save(); render(); } });
  ['us', 'in'].forEach(k => S[k].forEach(h => out.push({ group: 'Holdings', label: h.symbol, hint: `${h.broker || ''} · ${CAT_NAME[k]}`, icon: 'trending-up', run: go(k, h.symbol) })));
  S.bank.forEach(h => out.push({ group: 'Holdings', label: [h.bank, h.account].filter(Boolean).join(' · ') || 'Bank', hint: 'Bank', icon: 'landmark', run: go('cash', h.bank) }));
  S.pf.forEach(h => out.push({ group: 'Holdings', label: h.label || 'PF', hint: 'Provident fund', icon: 'piggy-bank', run: go('pf') }));
  S.other.forEach(h => out.push({ group: 'Holdings', label: h.label || h.symbol || 'Asset', hint: 'Other asset', icon: 'package', run: go('other') }));
  return out;
}
const CAT_NAME = { us: 'US stocks', in: 'Indian stocks' };
function paletteRender() {
  const q = $('#cmdk-q').value.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  pal.shown = pal.items.filter(i => terms.every(t => `${i.label} ${i.hint || ''} ${i.group}`.toLowerCase().includes(t))).slice(0, 40);
  pal.sel = Math.min(pal.sel, Math.max(0, pal.shown.length - 1));
  let last = '';
  $('#cmdk-list').innerHTML = pal.shown.length ? pal.shown.map((i, n) => {
    const head = i.group !== last ? `<div class="cmdk-group">${esc(i.group)}</div>` : '';
    last = i.group;
    return `${head}<button type="button" class="cmdk-item" role="option" data-n="${n}" aria-selected="${n === pal.sel}">${icon(i.icon, 16)}<span>${esc(i.label)}</span>${i.hint ? `<span class="hint-r">${esc(i.hint)}</span>` : ''}</button>`;
  }).join('') : '<div class="cmdk-empty">Nothing matches.</div>';
  const cur = $('#cmdk-list [aria-selected="true"]');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}
function openPalette() {
  const d = $('#cmdk');
  if (d.open) return;
  pal = { items: paletteItems(), shown: [], sel: 0 };
  $('#cmdk-q').value = '';
  paletteRender();
  d.showModal();
  $('#cmdk-q').focus();
}
function runPalette(n) {
  const item = pal.shown[n];
  if (!item) return;
  $('#cmdk').close();
  item.run();
}
/* ---------- forms ---------- */
const brokerF = { k: 'broker', label: 'Broker', type: 'text', req: 1, list: 'brokers', ph: 'e.g. Interactive Brokers' };
const curF = { k: 'currency', label: 'Currency', type: 'select', opts: ['USD', 'INR', ...Object.keys(FX_EXTRA)] };
const FORMS = {
  us: { title: 'US stock', hint: 'Use the ticker as it appears on Yahoo Finance, for example AAPL or BRK-B.', fields: [brokerF,
    { k: 'symbol', label: 'Ticker', type: 'text', req: 1, upper: 1, ph: 'AAPL' },
    { k: 'qty', label: 'Quantity', type: 'number', req: 1 },
    { k: 'avg', label: 'Average buy price (USD)', type: 'number', req: 1 },
    { k: 'manualPrice', label: 'Fallback price (USD)', type: 'number', adv: 1, hint: 'Used only when live prices are unavailable.' }] },
  in: { title: 'Indian stock', hint: 'Enter the plain symbol, for example RELIANCE. The .NS or .BO suffix is added from the exchange you pick. Only BSE holdings are labelled in the list.', fields: [brokerF,
    { k: 'symbol', label: 'Symbol', type: 'text', req: 1, upper: 1, ph: 'RELIANCE' },
    { k: 'exchange', label: 'Exchange', type: 'select', opts: ['NSE', 'BSE'] },
    { k: 'qty', label: 'Quantity', type: 'number', req: 1 },
    { k: 'avg', label: 'Average buy price (INR)', type: 'number', req: 1 },
    { k: 'manualPrice', label: 'Fallback price (INR)', type: 'number', adv: 1, hint: 'Used only when live prices are unavailable.' }] },
  bcash: { title: 'Broker cash', fields: [brokerF, curF, { k: 'balance', label: 'Balance', type: 'number', req: 1 }] },
  bank: { title: 'Bank account', fields: [
    { k: 'bank', label: 'Bank', type: 'text', req: 1, ph: 'e.g. HDFC Bank' },
    { k: 'account', label: 'Account name', type: 'text', ph: 'Savings' }, curF,
    { k: 'balance', label: 'Balance', type: 'number', req: 1 }] },
  hand: { title: 'Cash in hand', fields: [
    { k: 'label', label: 'Name', type: 'text', req: 1, ph: 'e.g. Wallet, travel cash' }, curF,
    { k: 'balance', label: 'Amount', type: 'number', req: 1 }] },
  pf: { title: 'PF account', fields: [
    { k: 'label', label: 'Account name', type: 'text', req: 1, ph: 'EPF, current employer' },
    { k: 'balance', label: 'Balance (INR)', type: 'number', req: 1 }] },
  other: { title: 'Other asset', hint: 'Crypto with a Yahoo symbol such as BTC-USD updates live. Choose the currency the symbol is quoted in.', fields: [
    { k: 'label', label: 'Name', type: 'text', req: 1, ph: 'e.g. Bitcoin on Coinbase' }, curF,
    { k: 'symbol', label: 'Live symbol (optional)', type: 'text', upper: 1, ph: 'BTC-USD' },
    { k: 'qty', label: 'Quantity (with symbol)', type: 'number' },
    { k: 'value', label: 'Value (without symbol)', type: 'number', hint: 'Enter a value directly if there is no live symbol.' },
    { k: 'price', label: 'Fallback price (with symbol)', type: 'number', adv: 1, hint: 'Used only when live prices are unavailable.' }] },
  contrib: { title: 'PF contribution', fields: [
    { k: 'month', label: 'Month', type: 'month', req: 1 },
    { k: 'amount', label: 'Amount (INR)', type: 'number', req: 1 }] }
};
const DEF = { bank: { currency: 'INR' }, bcash: { currency: 'USD' }, hand: { currency: 'INR' }, other: { currency: 'USD' }, in: { exchange: 'NSE' } };

const norm = s => String(s || '').trim().toLowerCase();
const findCash = (broker, cur) => S.bcash.find(b => norm(b.broker) === norm(broker) && b.currency === cur);
function tradeForm(kind, h, sk, cur) {
  const sell = kind === 'sell';
  const cash = findCash(h.broker, cur);
  const fields = [
    { k: 'qty', label: sell ? 'Quantity sold' : 'Quantity bought', type: 'number', req: 1, max: sell ? h.qty : null },
    { k: 'price', label: `${sell ? 'Sell' : 'Buy'} price (${cur})`, type: 'number', req: 1 },
    ...(sell ? [{ k: 'date', label: 'Date', type: 'date', req: 1 }] : []),
    { k: 'fees', label: 'Fees and taxes (optional)', type: 'number', adv: 0 }
  ];
  if (sell) fields.push({ k: 'cash', label: cash ? `Add the proceeds to ${h.broker || 'broker'} cash (${cur})` : `Add the proceeds as new ${h.broker || 'broker'} cash (${cur})`, type: 'check' });
  else if (cash) fields.push({ k: 'cash', label: `Pay from ${h.broker || 'broker'} cash (${cur})`, type: 'check' });
  return { title: `${sell ? 'Sell' : 'Buy more'} ${h.symbol}`, fields,
    hint: `You hold ${qty(h.qty)} at an average of ${money(h.avg || 0, cur, 2)}. ${sell ? 'Selling all of it removes the holding; the sale stays in Sales.' : 'The average cost is updated to include this purchase.'}` };
}
function fieldHtml(f, val) {
  const v = val[f.k] ?? '';
  if (f.type === 'check') return `<div class="field check"><label><input type="checkbox" name="${f.k}" id="f-${f.k}" ${v ? 'checked' : ''}> ${esc(f.label)}</label></div>`;
  const input = f.type === 'select'
    ? `<select id="f-${f.k}" name="${f.k}">${f.opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`
    : `<input id="f-${f.k}" name="${f.k}" type="${f.type}" ${f.type === 'number' ? 'step="any"' : ''} ${f.max != null ? `max="${f.max}"` : ''} value="${esc(v)}" ${f.list ? `list="${f.list}"` : ''} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''} ${f.req ? 'required' : ''}>`;
  return `<div class="field"><label for="f-${f.k}">${f.label}</label>${input}${f.hint ? `<span class="hint">${f.hint}</span>` : ''}</div>`;
}

function openForm(kind, id, sk) {
  let F = FORMS[kind];
  let val = {};
  if (kind === 'sell' || kind === 'buy') {
    const h = S[sk].find(x => x.id === id);
    if (!h) return;
    const cur = sk === 'us' ? 'USD' : 'INR';
    const pr = pick(ySym(sk, h), h.manualPrice, h.manualAt);
    F = tradeForm(kind, h, sk, cur);
    val = { qty: kind === 'sell' ? h.qty : '', price: pr ? +(+pr.p).toFixed(4) : (h.avg || ''), date: isoDay(new Date()), fees: '', cash: true };
  } else if (kind === 'contrib') val = { month: new Date().toISOString().slice(0, 7) };
  else if (id) val = S[kind].find(x => x.id === id) || {};
  else val = { ...(DEF[kind] || {}) };
  editing = { kind, id, sk };
  const names = new Set();
  ['us', 'in', 'bcash'].forEach(k => S[k].forEach(h => h.broker && names.add(h.broker)));
  $('#brokers').innerHTML = [...names].map(n => `<option value="${esc(n)}">`).join('');
  const title = kind === 'contrib' || kind === 'sell' || kind === 'buy' ? F.title : `${id ? 'Edit' : 'Add'} ${F.title}`;
  const main = F.fields.filter(f => !f.adv);
  const adv = F.fields.filter(f => f.adv);
  const advOpen = adv.some(f => val[f.k] != null && val[f.k] !== '');
  $('#frm').innerHTML = `${dlgHead(title)}`
    + main.map(f => fieldHtml(f, val)).join('')
    + (F.hint ? `<p class="hint">${F.hint}</p>` : '')
    + (adv.length ? `<details class="adv"${advOpen ? ' open' : ''}><summary>Fallback price</summary>${adv.map(f => fieldHtml(f, val)).join('')}</details>` : '')
    + `<p class="err" id="ferr" role="alert"></p><div class="actions"><button type="button" class="btn secondary" data-act="cancel">Cancel</button><button type="submit" class="btn">${kind === 'sell' ? 'Record sale' : kind === 'buy' ? 'Record purchase' : 'Save'}</button></div>`;
  $('#dlg').showModal();
  const first = $('#frm input, #frm select'); if (first) first.focus();
  if (['us', 'in', 'other'].includes(kind)) wireSymbol(kind);
}

/* ---------- symbol search and check ---------- */
function wireSymbol(kind) {
  const inp = $('#f-symbol');
  if (!inp || !remote.on) return;
  const wrap = inp.parentElement;
  const box = document.createElement('div'); box.className = 'suggest'; box.id = 'sugg'; box.hidden = true;
  const note = document.createElement('p'); note.className = 'hint symcheck'; note.id = 'symcheck'; note.setAttribute('aria-live', 'polite');
  wrap.append(box, note);
  const show = (kls, text) => { note.className = 'hint symcheck ' + kls; note.textContent = text; };
  const exSel = () => $('#f-exchange');
  let timer = null, seq = 0;
  async function check() {
    const raw = inp.value.trim();
    editing.symbolBad = false; editing.symbolConfirmed = false;
    if (!raw) return show('', '');
    const sym = ySym(kind, { symbol: raw, exchange: exSel() && exSel().value });
    const my = ++seq;
    try {
      const d = await getJson('/api/quotes?symbols=' + encodeURIComponent(sym));
      if (my !== seq) return;
      const q = d.quotes && d.quotes[sym];
      if (q && q.price != null) {
        const want = kind === 'us' ? 'USD' : kind === 'in' ? 'INR' : null;
        if (want && q.currency && q.currency !== want) { editing.symbolBad = true; show('bad', `${sym} is quoted in ${q.currency}, not ${want}. ${kind === 'us' ? 'This tracker values US stocks in dollars.' : 'Check the exchange.'}`); }
        else show('ok', `${q.name || sym}${q.exchange ? ' · ' + q.exchange : ''} · ${money(q.price, q.currency || 'USD', 2)}${q.stale ? ' (last known)' : ''}`);
      } else if (q && q.kind === 'symbol') {
        editing.symbolBad = true;
        show('bad', `No data found for ${sym}. Check the spelling${kind === 'in' ? ' and the exchange' : ''}.`);
      } else show('', '');
    } catch (e) { if (my === seq) show('', ''); }
  }
  inp.addEventListener('input', () => {
    clearTimeout(timer);
    editing.symbolBad = false; editing.symbolConfirmed = false;
    const text = inp.value.trim();
    if (text.length < 2) { box.hidden = true; return show('', ''); }
    timer = setTimeout(async () => {
      try {
        const d = await getJson('/api/search?q=' + encodeURIComponent(text));
        if (inp.value.trim() !== text) return;
        let rs = d.results || [];
        if (kind === 'in') rs = rs.filter(r => /\.(NS|BO)$/.test(r.symbol));
        else if (kind === 'us') rs = rs.filter(r => !/\.[A-Z]{1,3}$/.test(r.symbol));
        box.innerHTML = rs.slice(0, 6).map(r => `<button type="button" class="sg" data-act="pick-symbol" data-sym="${esc(r.symbol)}"><b>${esc(r.symbol)}</b><span>${esc(r.name)}</span><small>${esc(r.exchange)}</small></button>`).join('');
        box.hidden = !rs.length;
      } catch (e) { box.hidden = true; }
    }, 250);
  });
  inp.addEventListener('change', check);
  if (exSel()) exSel().addEventListener('change', check);
  editing.check = check;
}
function pickSymbol(sym) {
  const inp = $('#f-symbol');
  if (!inp) return;
  let s = sym;
  if (editing.kind === 'in') {
    const ex = $('#f-exchange');
    if (ex) ex.value = /\.BO$/.test(s) ? 'BSE' : 'NSE';
    s = s.replace(/\.(NS|BO)$/, '');
  }
  inp.value = s;
  const box = $('#sugg'); if (box) box.hidden = true;
  if (editing.check) editing.check();
}

$('#frm').addEventListener('submit', e => {
  e.preventDefault();
  const { kind, id, sk } = editing;
  const err = m => { $('#ferr').textContent = m; };
  if (kind === 'csv') return submitCsv(err);
  const F = kind === 'sell' || kind === 'buy' ? tradeForm(kind, S[sk].find(x => x.id === id) || {}, sk, sk === 'us' ? 'USD' : 'INR') : FORMS[kind];
  const fd = new FormData(e.target);
  const o = {};
  for (const f of F.fields) {
    if (f.type === 'check') { o[f.k] = fd.has(f.k); continue; }
    let v = String(fd.get(f.k) ?? '').trim();
    if (f.type === 'number') o[f.k] = v === '' ? null : parseFloat(v);
    else o[f.k] = f.upper ? v.toUpperCase() : v;
  }

  if (kind === 'sell' || kind === 'buy') return submitTrade(kind, sk, id, o, err);
  if (kind === 'contrib') {
    const h = S.pf.find(x => x.id === id);
    h.balance = (h.balance || 0) + o.amount;
    h.log = (h.log || []).concat({ month: o.month, amount: o.amount });
  } else {
    if (kind === 'other' && !(o.symbol && o.qty != null) && o.value == null) return err('Enter a live symbol with a quantity, or a value.');
    if (editing.symbolBad && !editing.symbolConfirmed && o.symbol) {
      editing.symbolConfirmed = true;
      return err('That symbol did not check out (see above). Press Save again to keep it anyway.');
    }
    const prev = id ? S[kind].find(x => x.id === id) : null;
    if (kind === 'us' || kind === 'in' || kind === 'other') {
      const mk = kind === 'other' ? 'price' : 'manualPrice', ak = kind === 'other' ? 'priceAt' : 'manualAt';
      if (o[mk] == null) o[ak] = 0;
      else o[ak] = prev && prev[mk] === o[mk] ? (prev[ak] || 0) : Date.now();
    }
    if (CASH_KINDS.includes(kind)) o.balanceAt = Date.now();   // saving the form confirms the balance
    if (prev) Object.assign(prev, o); else S[kind].push({ id: uid(), ...o });
  }
  save();
  $('#dlg').close();
  if (['us', 'in', 'other'].includes(kind) || (CASH_KINDS.includes(kind) && FX_EXTRA[o.currency])) loadQuotes();
  else render();
});

function submitTrade(kind, sk, id, o, err) {
  const h = S[sk].find(x => x.id === id);
  if (!h) return err('That holding no longer exists.');
  const cur = sk === 'us' ? 'USD' : 'INR';
  const q = o.qty, price = o.price, fees = o.fees || 0;
  if (!(q > 0)) return err('Enter a quantity above zero.');
  if (price == null || !(price >= 0)) return err('Enter the price.');
  if (kind === 'sell' && q > (h.qty || 0) + 1e-9) return err(`You hold ${qty(h.qty)}. Enter that or less.`);
  const cash = findCash(h.broker, cur);
  if (kind === 'sell') {
    const proceeds = q * price - fees;
    (S.trades = S.trades || []).push({ id: uid(), k: sk, date: o.date || isoDay(new Date()), broker: h.broker, symbol: h.symbol, exchange: h.exchange,
      qty: q, price, avg: h.avg || 0, fees, cur, realized: (price - (h.avg || 0)) * q - fees });
    h.qty = (h.qty || 0) - q;
    if (h.qty < 1e-9) S[sk] = S[sk].filter(x => x !== h);
    if (o.cash) {
      if (cash) { cash.balance = (cash.balance || 0) + proceeds; cash.balanceAt = Date.now(); }
      else S.bcash.push({ id: uid(), broker: h.broker, currency: cur, balance: proceeds, balanceAt: Date.now() });
    }
  } else {
    const total = (h.qty || 0) + q;
    h.avg = total ? ((h.avg || 0) * (h.qty || 0) + price * q + fees) / total : price;
    h.qty = total;
    if (o.cash && cash) { cash.balance = (cash.balance || 0) - (q * price + fees); cash.balanceAt = Date.now(); }
  }
  save();
  $('#dlg').close();
  render();
}

/* ---------- CSV import ---------- */
let csv = null, csvTarget = 'us';
function openCsv(text, defaultKind) {
  const rows = parseCSV(text);
  const det = detectCSV(rows);
  if (!det) { alert('Could not find a Symbol column and a Quantity column in that file. The first row of data needs headers such as Symbol, Quantity and Average cost.'); return; }
  csv = { rows, det, map: { ...det.map }, broker: '', defaultKind, mode: 'add' };
  editing = { kind: 'csv' };
  renderCsv();
  $('#dlg').showModal();
}
function renderCsv() {
  const res = csvToHoldings(csv.rows, { map: csv.map, headerIndex: csv.det.headerIndex, broker: csv.broker.trim(), defaultKind: csv.defaultKind });
  csv.result = res;
  const hdr = csv.det.headers;
  const col = (field, label, optional) => `<div class="field"><label for="c-${field}">${label}</label><select id="c-${field}" data-csv="map" data-field="${field}">${optional ? '<option value="">Not in the file</option>' : ''}${hdr.map((h, i) =>
    `<option value="${i}"${csv.map[field] === i ? ' selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('')}</select></div>`;
  const nUs = res.items.filter(i => i.kind === 'us').length, nIn = res.items.length - nUs;
  const preview = res.items.slice(0, 8).map(i => `<tr><td>${esc(i.symbol)}${i.exchange === 'BSE' ? ' <small>BSE</small>' : ''}</td><td class="r num">${qty(i.qty)}</td>
    <td class="r num">${i.avg ? money(i.avg, i.kind === 'us' ? 'USD' : 'INR', 2) : '—'}</td><td>${i.kind === 'us' ? 'US' : 'India'}</td></tr>`).join('');
  $('#frm').innerHTML = `${dlgHead('Import holdings from CSV')}
    <p class="hint">${res.items.length} holding${res.items.length === 1 ? '' : 's'} found (${nUs} US, ${nIn} Indian)${res.skipped.length ? `, ${res.skipped.length} row${res.skipped.length === 1 ? '' : 's'} skipped` : ''}. Nothing is saved until you press Import.</p>
    <div class="field"><label for="c-broker">Broker${csv.map.broker == null ? '' : ' (used when the file has no broker)'}</label><input id="c-broker" data-csv="broker" list="brokers" value="${esc(csv.broker)}" placeholder="e.g. Interactive Brokers"></div>
    <div class="row2">${col('symbol', 'Symbol column')}${col('qty', 'Quantity column')}</div>
    <div class="row2">${col('avg', 'Average cost column', true)}${col('total', 'Total cost column (if no average)', true)}</div>
    <div class="field"><label for="c-kind">Rows with no currency or exchange are</label><select id="c-kind" data-csv="kind"><option value="us"${csv.defaultKind === 'us' ? ' selected' : ''}>US stocks</option><option value="in"${csv.defaultKind === 'in' ? ' selected' : ''}>Indian stocks</option></select></div>
    <div class="field"><label for="c-mode">If the broker already has holdings here</label><select id="c-mode" data-csv="mode">
      <option value="add"${csv.mode === 'add' ? ' selected' : ''}>Add to them (same symbol: combine, average the cost)</option>
      <option value="replace"${csv.mode === 'replace' ? ' selected' : ''}>Replace them with the file</option></select></div>
    ${res.items.length ? `<div class="tw"><table class="mini"><thead><tr><th>Symbol</th><th class="r">Qty</th><th class="r">Avg</th><th>Market</th></tr></thead><tbody>${preview}</tbody></table></div>${res.items.length > 8 ? `<p class="hint">…and ${res.items.length - 8} more.</p>` : ''}` : ''}
    ${res.skipped.length ? `<details class="adv"><summary>Skipped rows</summary><ul class="log">${res.skipped.slice(0, 20).map(s => `<li><span>Line ${s.line}</span><span>${esc(s.symbol || '')}: ${esc(s.reason)}</span></li>`).join('')}</ul></details>` : ''}
    ${res.items.some(i => i.warn) ? '<p class="hint">Some rows have no average price. They import with a cost of zero until you edit them.</p>' : ''}
    <p class="err" id="ferr" role="alert"></p><div class="actions"><button type="button" class="btn secondary" data-act="cancel">Cancel</button><button type="submit" class="btn"${res.items.length ? '' : ' disabled'}>Import ${res.items.length || ''}</button></div>`;
}
function submitCsv(err) {
  const res = csv.result;
  if (!res || !res.items.length) return err('Nothing to import.');
  if (res.items.some(i => !i.broker)) return err('Enter the broker name.');
  if (csv.mode === 'replace') {
    const names = [...new Set(res.items.map(i => i.broker))].join(', ');
    if (!confirm(`Replace what ${names} currently holds in the imported markets with the file?`)) return;
  }
  const r = applyImport(S, res.items, csv.mode, uid);
  save();
  $('#dlg').close();
  loadQuotes();
  toast(`Imported ${r.added + r.merged} holding${r.added + r.merged === 1 ? '' : 's'}${r.merged ? ` (${r.merged} combined with existing)` : ''}${r.removed ? `, replaced ${r.removed}` : ''}.`);
}

/* ---------- actions ---------- */
function sample() {
  S.us.push({ id: uid(), broker: 'Sample Broker US', symbol: 'AAPL', qty: 10, avg: 170, manualPrice: null, manualAt: 0 },
            { id: uid(), broker: 'Sample Broker US', symbol: 'MSFT', qty: 5, avg: 320, manualPrice: null, manualAt: 0 });
  S.in.push({ id: uid(), broker: 'Sample Broker IN', symbol: 'RELIANCE', exchange: 'NSE', qty: 50, avg: 2400, manualPrice: null, manualAt: 0 },
            { id: uid(), broker: 'Sample Broker IN', symbol: 'TCS', exchange: 'NSE', qty: 20, avg: 3300, manualPrice: null, manualAt: 0 });
  S.bcash.push({ id: uid(), broker: 'Sample Broker US', currency: 'USD', balance: 1500 });
  S.bank.push({ id: uid(), bank: 'Sample Bank', account: 'Savings', currency: 'INR', balance: 350000 });
  S.pf.push({ id: uid(), label: 'Sample EPF', balance: 800000, log: [] });
  S.other.push({ id: uid(), label: 'Sample Bitcoin', currency: 'USD', symbol: 'BTC-USD', qty: 0.05, price: null, priceAt: 0, value: null });
  save(); loadQuotes();
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const itemName = (k, h) => k === 'bcash' ? (h.broker || 'broker cash') : k === 'bank' ? (h.bank || 'bank account') : k === 'hand' || k === 'pf' || k === 'other' ? (h.label || h.symbol || 'entry') : (h.symbol || 'holding');
function deleteEntry(k, id) {
  const list = S[k], at = list.findIndex(x => x.id === id);
  if (at < 0) return;
  const [gone] = list.splice(at, 1);
  save(); render();
  toast(`Deleted ${itemName(k, gone)}`, { undo: () => { S[k].splice(Math.min(at, S[k].length), 0, gone); save(); render(); } });
}
function deleteTrade(id) {
  const list = S.trades || [], at = list.findIndex(x => x.id === id);
  if (at < 0) return;
  const [gone] = list.splice(at, 1);
  save(); render();
  toast('Removed the sale from the list', { undo: () => { S.trades.splice(Math.min(at, S.trades.length), 0, gone); save(); render(); } });
}
const defaultDir = key => key === 'symbol' || key === 'broker' ? 1 : -1;

document.addEventListener('click', e => {
  const cm = e.target.closest('.cmdk-item');
  if (cm) { runPalette(+cm.dataset.n); return; }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act, k = t.dataset.k, id = t.dataset.id;
  switch (act) {
    case 'tab': {
      const next = t.dataset.tab;
      if (next !== tab) query = '';
      tab = next; render(); window.scrollTo({ top: 0 });
      if (next === 'settings') loadStorage();
      break;
    }
    case 'focus':
      if (t.dataset.tab) tab = t.dataset.tab; else ui.view = 'table';
      query = t.dataset.q || ''; if (t.dataset.tab) ui.broker[tab] = ''; saveUi();
      render(); window.scrollTo({ top: 0 });
      break;
    case 'sort': {
      const sid = t.dataset.sid, key = t.dataset.key, prev = ui.sorts[sid] || { key: 'value', dir: -1 };
      ui.sorts[sid] = { key, dir: prev.key === key ? -prev.dir : defaultDir(key) };
      saveUi(); render(); break;
    }
    case 'broker': ui.broker[k] = t.dataset.v; saveUi(); render(); break;
    case 'group': ui.group = t.dataset.g; saveUi(); render(); break;
    case 'view': ui.view = t.dataset.v; saveUi(); render(); break;
    case 'mapby': ui.mapBy = t.dataset.v; saveUi(); render(); break;
    case 'ovlist': ui.ovList = t.dataset.v; saveUi(); render(); break;
    case 'clear-filters': query = ''; ui.broker.us = ui.broker.in = ''; saveUi(); render(); break;
    case 'range': trendRange = t.dataset.range; render(); loadAttribution(); break;
    case 'palette': openPalette(); break;
    case 'base': S.settings.base = t.dataset.cur; save(); render(); break;
    case 'mask': S.settings.mask = !S.settings.mask; save(); render(); break;
    case 'mode': S.settings.mode = resolveMode() === 'dark' ? 'light' : 'dark'; save(); render(); break;
    case 'mode-set': S.settings.mode = t.dataset.m; save(); render(); break;
    case 'theme': {
      const mode = resolveMode();
      if (!S.settings.palette || typeof S.settings.palette !== 'object') S.settings.palette = { light: 'navy', dark: 'brass' };
      S.settings.palette[mode] = t.dataset.theme;
      save(); render(); break;
    }
    case 'refresh': loadQuotes(); break;
    case 'confirm': { const h = (S[k] || []).find(x => x.id === id); if (h) { h.balanceAt = Date.now(); save(); render(); toast('Balance confirmed'); } break; }
    case 'add': openForm(k); break;
    case 'edit': openForm(k, id); break;
    case 'contrib': openForm('contrib', id); break;
    case 'sell': case 'buy': openForm(act, id, k); break;
    case 'cancel': $('#dlg').close(); break;
    case 'del': deleteEntry(k, id); break;
    case 'del-trade': deleteTrade(id); break;
    case 'import-csv': csvTarget = k || 'us'; $('#csvfile').click(); break;
    case 'pick-symbol': pickSymbol(t.dataset.sym); break;
    case 'split-apply': applySplit(t.dataset.sym, t.dataset.date); break;
    case 'split-dismiss': resolveSplit(t.dataset.sym, t.dataset.date, 'dismissed'); break;
    case 'rebuild': runRebuild(t.dataset.from, false); break;
    case 'sample': sample(); break;
    case 'export': {
      const { cache, ...data } = S;
      download(`networth-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
      break;
    }
    case 'import': $('#file').click(); break;
    case 'reset':
      if (confirm('Erase all holdings and settings from this browser? Export a backup first if unsure.')) {
        try { localStorage.removeItem(KEY); } catch (err) {}
        S = defaults(); live = {}; save(); render(); loadQuotes();
      }
      break;
  }
});

async function resolveSplit(sym, date, status) {
  try { await postJson('/api/splits', { sym, date, status }); } catch (e) { toast('Could not reach the server: ' + e.message); return; }
  splits = splits.filter(x => !(x.sym === sym && x.date === date));
  render();
}
function applySplit(sym, date) {
  const s = splits.find(x => x.sym === sym && x.date === date);
  if (!s) return;
  for (const { h } of V.splitHoldings(X, s)) {
    h.qty = +((h.qty || 0) * s.ratio).toFixed(6);
    if (h.avg) h.avg = +(h.avg / s.ratio).toFixed(6);
    if (h.manualPrice) h.manualPrice = +(h.manualPrice / s.ratio).toFixed(6);
    h.splits = (h.splits || []).concat(date);
  }
  save();
  resolveSplit(sym, date, 'applied');
  toast(`${sym} adjusted for the split`);
}
async function runRebuild(from, current) {
  if (rebuilding) return;
  rebuilding = true; render();
  let msg;
  try { const r = await postJson('/api/history/rebuild', { from, currentHoldings: !!current }); msg = `Re-valued ${r.days} day${r.days === 1 ? '' : 's'} from closing prices.`; await loadHistory(); }
  catch (e) { msg = 'Could not recompute history: ' + e.message; }
  rebuilding = false;
  render();
  toast(msg);
}
document.addEventListener('submit', e => {
  if (e.target.id !== 'rebuild-form') return;
  e.preventDefault();
  runRebuild($('#r-from').value, $('#r-cur').checked);
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { query = e.target.value; render(); return; }
  if (e.target.id === 'cmdk-q') { pal.sel = 0; paletteRender(); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.set === 'alphaKey') { S.settings.alphaKey = t.value.trim(); save(); return; }
  if (t.dataset.csv && csv) {
    if (t.dataset.csv === 'map') csv.map[t.dataset.field] = t.value === '' ? undefined : +t.value;
    else if (t.dataset.csv === 'broker') csv.broker = t.value;
    else if (t.dataset.csv === 'kind') csv.defaultKind = t.value;
    else if (t.dataset.csv === 'mode') csv.mode = t.value;
    renderCsv();
    return;
  }
  if (t.dataset.set === 'backend') { remote.on = false; S.settings.backend = t.value.trim(); save(); syncFromServer().then(loadQuotes); }
  const fxSets = { fx: ['fxManual', 'fxManualAt'] };
  for (const fx of Object.values(FX_EXTRA)) fxSets[fx.set] = [fx.manual, fx.at];
  if (fxSets[t.dataset.set]) {
    const v = parseFloat(t.value);
    const [manual, at] = fxSets[t.dataset.set];
    S.settings[manual] = isNaN(v) ? null : v; S.settings[at] = Date.now(); save(); render();
  }
});

/* keyboard: ⌘K / Ctrl-K opens the palette, / jumps to the filter, arrows and Enter drive the palette */
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if ($('#cmdk').open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pal.sel = Math.max(0, Math.min(pal.shown.length - 1, pal.sel + (e.key === 'ArrowDown' ? 1 : -1)));
      paletteRender();
    } else if (e.key === 'Enter') { e.preventDefault(); runPalette(pal.sel); }
    return;
  }
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');
  if (e.key === '/' && !typing && !$('#dlg').open) { const q = $('#q'); if (q) { e.preventDefault(); q.focus(); } }
});
$('#cmdk').addEventListener('click', e => { if (e.target === $('#cmdk')) $('#cmdk').close(); });

$('#csvfile').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { openCsv(String(r.result), csvTarget); e.target.value = ''; };
  r.readAsText(f);
});
$('#file').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || typeof d !== 'object' || !('us' in d || 'bank' in d || 'settings' in d)) throw new Error('bad file');
      const cache = S.cache;
      S = merge(d); S.cache = cache; save(); loadQuotes();
    } catch (err) { alert('That file is not a valid backup from this tracker.'); }
    e.target.value = '';
  };
  r.readAsText(f);
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.settings.mode !== 'light' && S.settings.mode !== 'dark') render(); });

applyTheme();
render();
syncFromServer().then(loadQuotes);
})();
