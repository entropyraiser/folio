/* Views, part 1: shared constants and helpers, the page shell, and the alerts that sit above the pages.
   Every view is a function of (X, c): X is the app's state and actions (app.js), c is the computed portfolio (calc.js). */
(function (G) {
'use strict';
const F = G.Folio;
const { esc, money, M, Sg, pct, cls, qty, icon } = F;

const CAT = {
  us:    { name: 'US stocks',     short: 'US',      color: '--c-us',    tab: 'us' },
  in:    { name: 'Indian stocks', short: 'India',   color: '--c-in',    tab: 'in' },
  bcash: { name: 'Broker cash',   short: 'Broker',  color: '--c-bcash', tab: 'cash' },
  bank:  { name: 'Bank cash',     short: 'Bank',    color: '--c-bank',  tab: 'cash' },
  hand:  { name: 'Cash in hand',  short: 'In hand', color: '--s7',      tab: 'cash' },
  pf:    { name: 'Employee PF',   short: 'PF',      color: '--c-pf',    tab: 'pf' },
  other: { name: 'Other',         short: 'Other',   color: '--c-other', tab: 'other' }
};
const SRC = { live: 'live', manual: 'fallback', last: 'last known', cost: 'no price' };
const SOURCES = { yahoo: 'Yahoo', 'yahoo-spark': 'Yahoo (backup feed)', alphavantage: 'Alpha Vantage', 'server copy': 'saved copy' };
const RANGES = [['1W', 7], ['1M', 31], ['3M', 92], ['YTD', 'ytd'], ['1Y', 366], ['All', Infinity]];
const STALE_DAYS = 30;
const EPS = 1e-7;

const isoDay = d => d.toLocaleDateString('en-CA');
const dayLabel = (iso, year) => new Date(iso + 'T00:00').toLocaleDateString([], { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) });
const tone = v => v > EPS ? 'up' : v < -EPS ? 'down' : 'flat';
const signed = (v, cur, dec = 0) => `${v < -EPS ? '−' : '+'}${money(Math.abs(v), cur, dec)}`;
const arrowFor = v => icon(v > EPS ? 'arrow-up-right' : v < -EPS ? 'arrow-down-right' : 'minus', 13);

function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 2) return 'just now';
  if (m < 90) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
const ageDays = at => {
  const day = t => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  return Math.round((day(Date.now()) - day(at)) / 864e5);
};
function ageText(at) {
  const d = ageDays(at);
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 60) return `${d}d ago`;
  return `${Math.floor(d / 30)} mo ago`;
}

/* a coloured change with its arrow: the arrow means it is not colour alone */
function delta(v, text, label) {
  const t = tone(v);
  return `<span class="delta ${t}">${arrowFor(v)}<span class="num">${text}</span>${label ? `<span class="lab">${esc(label)}</span>` : ''}</span>`;
}
const sens = s => `<span class="sens">${s}</span>`;
const deltaMoney = (v, cur, p, label) => delta(v, `${sens(money(Math.abs(v), cur))}${p == null ? '' : ` (${Math.abs(p).toFixed(2)}%)`}`, label);

function initials(sym) { return String(sym || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase(); }

/* ---------- history helpers shared by several pages ---------- */
function histPoints(X, c) {
  const today = isoDay(new Date());
  const all = X.hist.map(h => ({ ...h, v: c.base === 'INR' ? h.net : h.net / ((h.fx && h.fx.USDINR) || c.fx.rate) }));
  const last = all[all.length - 1];
  if (last && last.date === today) last.v = c.net;          // today follows the live number
  else if (all.length) all.push({ date: today, v: c.net, final: false });
  return all;
}
function rangeFrom(range) {
  const def = RANGES.find(([k]) => k === range) || RANGES[2];
  if (def[1] === Infinity) return '';
  if (def[1] === 'ytd') return `${new Date().getFullYear() - 1}-12-31`;
  return isoDay(new Date(Date.now() - def[1] * 864e5));
}
/* one category group's value over the last weeks, in the display currency, for a sparkline */
function catSeries(X, c, keys, current) {
  const rows = X.hist.slice(-40).map(h => {
    const v = keys.reduce((a, k) => a + ((h.cats && h.cats[k]) || 0), 0);
    return c.base === 'INR' ? v : v / ((h.fx && h.fx.USDINR) || c.fx.rate);
  });
  if (rows.length) rows.push(current);
  return rows;
}
function periodChange(pts, c, from) {
  let base = null;
  for (const p of pts) { if (p.date <= from) base = p; else break; }
  if (!base || !base.v) return null;
  return { chg: c.net - base.v, pct: (c.net - base.v) / base.v * 100 };
}

/* ---------- the page shell ---------- */
const NAV = [
  ['Portfolio', [['overview', 'Overview', 'layout-dashboard'], ['us', 'US stocks', 'trending-up'], ['in', 'Indian stocks', 'chart-column'], ['cash', 'Cash', 'wallet']]],
  ['Accounts', [['pf', 'Provident fund', 'piggy-bank'], ['other', 'Other assets', 'package']]]
];
const PAGE = { overview: 'Overview', us: 'US stocks', in: 'Indian stocks', cash: 'Cash', pf: 'Provident fund', other: 'Other assets', settings: 'Settings' };

function statusBlock(X) {
  const s = X.status;
  let text = 'Fetching prices…', cls2 = 'loading', title = 'Fetching live prices';
  if (s.state === 'live') { text = `Live · ${s.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; cls2 = 'live'; title = 'Live prices. Click to refresh.'; }
  else if (s.state === 'partial') { text = s.bad.length === 1 ? `No live price for ${s.bad[0]}` : `${s.bad.length} prices not live`; cls2 = 'partial'; title = `No live quote for ${s.bad.join(', ')}.${s.retrying ? ' Retrying automatically.' : ''}`; }
  else if (s.state === 'offline') { text = s.retrying ? 'Offline · retrying' : 'Offline'; cls2 = 'offline'; title = `${s.msg || ''}${s.retrying ? ' Retrying automatically.' : ''}`; }
  const sync = X.syncText();
  return `<div class="status ${cls2}" role="status" title="${esc(title)}"><i class="dot"></i><span class="st-text">${esc(text)}</span>
    <button class="icon-btn sm" data-act="refresh" aria-label="Refresh prices" title="Refresh prices">${icon('refresh-cw', 14)}</button></div>
    <p class="sync-note${X.remote.state === 'error' || X.remote.state === 'conflict' ? ' bad' : ''}" id="sync" aria-live="polite">${esc(sync)}</p>`;
}

function shell(X, c, { title, sub, actions = '', body }) {
  const S = X.S, mode = X.mode, nextMode = mode === 'dark' ? 'light' : 'dark';
  const nav = NAV.map(([label, items]) => `<p class="nav-label">${label}</p>` + items.map(([k, n, ic]) => {
    const count = k === 'us' || k === 'in' ? c.cats[k].items.length : '';
    return `<button class="nav-item" data-act="tab" data-tab="${k}"${X.tab === k ? ' aria-current="page"' : ''}>${icon(ic, 17)}<span>${n}</span>${count ? `<span class="nav-count">${count}</span>` : ''}</button>`;
  }).join('')).join('');
  return `<div class="app">
    <aside class="rail" aria-label="Main">
      <div class="brand"><span class="brand-mark">${icon('sparkles', 17)}</span><div><strong>Folio</strong><small>Net worth</small></div></div>
      <nav aria-label="Sections">${nav}
        <p class="nav-label">App</p>
        <button class="nav-item" data-act="tab" data-tab="settings"${X.tab === 'settings' ? ' aria-current="page"' : ''}>${icon('settings', 17)}<span>Settings</span></button>
      </nav>
      <div class="rail-foot">${statusBlock(X)}</div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="cmdk-trigger" data-act="palette" aria-label="Search or jump to">${icon('search', 16)}<span>Search holdings or jump to…</span><kbd>⌘K</kbd></button>
        <div class="tools">
          <div class="seg" role="group" aria-label="Display currency">
            <button data-act="base" data-cur="INR" aria-pressed="${c.base === 'INR'}">₹ INR</button><button data-act="base" data-cur="USD" aria-pressed="${c.base === 'USD'}">$ USD</button></div>
          <button class="icon-btn" data-act="mask" aria-pressed="${!!S.settings.mask}" title="${S.settings.mask ? 'Show amounts' : 'Hide amounts'}" aria-label="${S.settings.mask ? 'Show amounts' : 'Hide amounts'}">${icon(S.settings.mask ? 'eye-off' : 'eye', 17)}</button>
          <button class="icon-btn" data-act="mode" title="Switch to ${nextMode} mode" aria-label="Switch to ${nextMode} mode">${icon(nextMode === 'light' ? 'sun' : 'moon', 17)}</button>
        </div>
      </header>
      <main class="page" id="page">
        <div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="page-actions">${actions}</div></div>
        ${body}
      </main>
    </div>
  </div>`;
}

/* ---------- alerts: things worth knowing before trusting the numbers ---------- */
const ratioText = r => r >= 1 ? `${+r.toFixed(4)}-for-1` : `1-for-${+(1 / r).toFixed(4)}`;
function splitHoldings(X, s) {
  return ['us', 'in'].flatMap(k => X.S[k].filter(h => F.ySym(k, h) === s.sym && !(h.splits || []).includes(s.date)).map(h => ({ k, h })));
}
function alerts(X, c) {
  const out = [];
  if (X.remote.orphan) out.push(`<div class="alert warn" role="alert">${icon('database', 17)}<div class="alert-body"><b>This tracker has no saved data yet, but this browser remembers holdings</b>
      <div class="detail">They are from an earlier install. Keep them to save them into this tracker (daily history starts again), restore a full backup file to get everything back, or start blank.</div></div>
      <div class="alert-act"><button class="btn sm" data-act="orphan-keep">Keep these holdings</button>
      <button class="btn secondary sm" data-act="backup-up">Restore a backup…</button>
      <button class="btn secondary sm" data-act="orphan-blank">Start blank</button></div></div>`);
  for (const s of X.splits) {
    const hs = splitHoldings(X, s);
    if (!hs.length) continue;
    const lines = hs.map(({ k, h }) => `${esc(h.broker || 'Unnamed')}: ${qty(h.qty)} → ${qty(h.qty * s.ratio)} shares, average ${money(h.avg || 0, k === 'us' ? 'USD' : 'INR', 2)} → ${money((h.avg || 0) / s.ratio, k === 'us' ? 'USD' : 'INR', 2)}`);
    out.push(`<div class="alert warn" role="alert">${icon('git-compare-arrows', 17)}<div class="alert-body"><b>${esc(s.sym)} split ${ratioText(s.ratio)} on ${esc(dayLabel(s.date, true))}</b>
      <div class="detail">Your saved quantity and average cost may still be from before it. <span class="num">${lines.join(' · ')}</span></div></div>
      <div class="alert-act"><button class="btn sm" data-act="split-apply" data-sym="${esc(s.sym)}" data-date="${esc(s.date)}">Apply</button>
      <button class="btn secondary sm" data-act="split-dismiss" data-sym="${esc(s.sym)}" data-date="${esc(s.date)}">Already correct</button></div></div>`);
  }
  const st = X.status.state;
  if (st !== 'loading' && st !== undefined) {
    const priced = [...c.cats.us.items, ...c.cats.in.items, ...c.cats.other.items.filter(h => h.sym)].filter(h => h.sym);
    const notLive = priced.filter(h => h.src !== 'live');
    const backup = priced.filter(h => h.src === 'live' && h.source && h.source !== 'yahoo');
    if (notLive.length) {
      const olds = notLive.filter(h => h.src === 'last' && h.priceAt).map(h => h.priceAt);
      const oldest = olds.length ? ` The oldest is from ${ago(Math.min(...olds))}.` : '';
      const kinds = [...new Set(notLive.map(h => SRC[h.src]))].join(' or ');
      out.push(`<div class="alert warn" role="status">${icon('triangle-alert', 17)}<div class="alert-body"><b>${notLive.length} of ${priced.length} prices are not live</b>
        <div class="detail">Showing ${kinds} prices instead.${oldest}${X.status.retrying ? ' Retrying automatically.' : ''}</div></div>
        <div class="alert-act"><button class="btn secondary sm" data-act="refresh">${icon('refresh-cw', 14)}Refresh</button></div></div>`);
    } else if (backup.length) {
      const names = [...new Set(backup.map(h => SOURCES[h.source] || h.source))].join(', ');
      out.push(`<div class="alert info" role="status">${icon('info', 17)}<div class="alert-body">${backup.length} price${backup.length > 1 ? 's' : ''} came from a backup source (${esc(names)}) because Yahoo did not answer.</div></div>`);
    }
  }
  return out.length ? `<div class="alerts">${out.join('')}</div>` : '';
}

F.views = Object.assign(F.views || {}, {
  CAT, SRC, SOURCES, RANGES, STALE_DAYS, EPS, PAGE, isoDay, dayLabel, tone, signed, arrowFor, ago, ageDays, ageText, delta, deltaMoney, sens, initials,
  histPoints, rangeFrom, catSeries, periodChange, shell, alerts, splitHoldings, ratioText
});
if (typeof module !== 'undefined') module.exports = F;
})(typeof window !== 'undefined' ? window : globalThis);
