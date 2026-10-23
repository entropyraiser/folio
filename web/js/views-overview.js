/* Views, part 2: the overview page. */
(function (G) {
'use strict';
const F = G.Folio;
const V = F.views;
const { esc, money, M, Sg, pct, cls, qty, compact, icon, Charts } = F;
const { CAT, RANGES, tone, signed, delta, deltaMoney, histPoints, rangeFrom, catSeries, periodChange, ago, dayLabel, isoDay } = V;

const SHORT_OF = k => CAT[k].short;
const shareOf = (part, total) => total ? (part / total * 100).toFixed(1) : '0.0';

function emptyState() {
  return `<div class="card"><div class="empty"><h3>Start with your first holding</h3>
    <p>Add stocks, cash, PF and other assets. Prices and exchange rates load by themselves while the server runs.</p>
    <div class="row"><button class="btn" data-act="add" data-k="us">${icon('plus', 15)}Add a US stock</button>
    <button class="btn secondary" data-act="add" data-k="in">${icon('plus', 15)}Add an Indian stock</button>
    <button class="btn secondary" data-act="import-csv" data-k="us">${icon('upload', 15)}Import a CSV</button>
    <button class="btn quiet" data-act="sample">Load sample data</button></div></div></div>`;
}

function heroCard(X, c, pts) {
  const stocks = c.cats.us.total + c.cats.in.total;
  const cash = c.cats.bcash.total + c.cats.bank.total + c.cats.hand.total;
  const rest = c.cats.pf.total + c.cats.other.total;
  const pnl = c.cats.us.pnl + c.cats.in.pnl, cost = stocks - pnl;
  const other = c.base === 'INR' ? 'USD' : 'INR';
  const alt = compact(c.base === 'INR' ? c.net / c.fx.rate : c.net * c.fx.rate, other);
  const dayPct = c.net - c.day ? c.day / (c.net - c.day) * 100 : 0;
  const year = new Date().getFullYear();
  const per = [['1W', isoDay(new Date(Date.now() - 7 * 864e5))], ['1M', isoDay(new Date(Date.now() - 30 * 864e5))], ['YTD', `${year - 1}-12-31`]]
    .map(([label, from]) => { const p = periodChange(pts, c, from); return p ? delta(p.chg, `${Math.abs(p.pct).toFixed(2)}%`, label) : ''; }).join('');
  const stat = (label, value, sub, series, tab) => `<button class="stat" data-act="tab" data-tab="${tab}"><span class="lab">${label}</span><span class="val num sens">${value}</span>
    <span class="spark-wrap">${series ? Charts.spark(series, { tone: 'flat' }) : ''}</span><span class="sub">${sub}</span></button>`;
  return `<section class="card hero" aria-label="Net worth">
    <div class="hero-main">
      <p class="eyebrow">Net worth</p>
      <p class="hero-num num sens">${money(c.net, c.base)}</p>
      <div class="hero-meta">${c.hasDay ? deltaMoney(c.day, c.base, dayPct, 'today') : ''}${per}</div>
      <p class="hero-alt num">≈ <span class="sens">${alt}</span> · 1 USD = ₹${c.fx.rate.toFixed(2)}</p>
    </div>
    <div class="hero-stats">
      ${stat('Stocks', money(stocks, c.base), `${shareOf(stocks, c.net)}% of net worth`, catSeries(X, c, ['us', 'in'], stocks), 'us')}
      ${stat('Cash', money(cash, c.base), `${shareOf(cash, c.net)}% of net worth`, catSeries(X, c, ['bcash', 'bank', 'hand'], cash), 'cash')}
      ${stat('PF &amp; other', money(rest, c.base), `${shareOf(rest, c.net)}% of net worth`, catSeries(X, c, ['pf', 'other'], rest), 'pf')}
      <button class="stat" data-act="tab" data-tab="us"><span class="lab">Unrealized P&amp;L</span><span class="val num sens ${tone(pnl)}">${signed(pnl, c.base)}</span>
        <span class="spark-wrap"></span><span class="sub">${cost > 0 ? `${pnl >= 0 ? '+' : '−'}${Math.abs(pnl / cost * 100).toFixed(1)}% on ${V.sens(money(cost, c.base))} invested` : 'No cost basis yet'}</span></button>
    </div>
  </section>`;
}

function healthLine(X) {
  const health = X.health;
  if (!health) return '';
  const bits = [], lp = health.lastPass || {};
  if (lp.ok === false) bits.push(`<span class="chip bad">${icon('circle-alert', 12)}Last snapshot failed: ${esc(lp.error || 'unknown error')}</span>`);
  else if (lp.at && Date.now() / 1000 - lp.at > 3 * 3600) bits.push(`<span class="chip bad">${icon('clock', 12)}Snapshots look stalled · last ran ${esc(ago(lp.at * 1000))}</span>`);
  const est = health.estimated || [];
  if (est.length) {
    const tip = est.slice(0, 8).map(e => `${e.date}: no close for ${e.missing.join(', ')}`).join('\n');
    bits.push(`<span class="chip warn" title="${esc(tip)}">${icon('triangle-alert', 12)}${est.length} day${est.length > 1 ? 's' : ''} used estimated prices</span>${X.rebuilding ? '<span class="chip">Recomputing…</span>' : `<button class="btn quiet sm" data-act="rebuild" data-from="${esc(est[0].date)}">Recompute</button>`}`);
  }
  return bits.length ? `<div class="row" style="padding:0 22px 18px;gap:8px">${bits.join('')}</div>` : '';
}

function trendCard(X, c, pts) {
  const head = (extra = '') => `<div class="card-h"><h3>Net worth over time</h3>${extra}</div>`;
  if (!X.remote.on) return `<section class="card c8">${head()}<div class="chart-empty">History is recorded by the price server. Start it and a point is saved every day.</div></section>`;
  const from = rangeFrom(X.trendRange);
  const view = pts.filter(p => p.date >= from);
  const seg = `<div class="seg sm" role="group" aria-label="Chart range">${RANGES.map(([k]) => `<button data-act="range" data-range="${k}" aria-pressed="${k === X.trendRange}">${k}</button>`).join('')}</div>`;
  if (view.length < 2) {
    const msg = pts.length < 2 ? 'History starts today. The server saves a point every day, so the chart fills in from tomorrow.' : 'Only one day in this range. Pick a longer range.';
    return `<section class="card c8">${head(seg)}<div class="chart-empty">${msg}</div>${healthLine(X)}</section>`;
  }
  const first = view[0], end = view[view.length - 1];
  const chg = end.v - first.v, chgPct = first.v ? chg / first.v * 100 : 0;
  const mask = X.S.settings.mask;
  const note = p => p.date === isoDay(new Date()) ? 'Today, live'
    : p.missing ? `${p.missing} price${p.missing > 1 ? 's' : ''} estimated${p.final ? '' : ', still retrying'}`
    : !p.final ? 'Provisional until markets settle' : p.filled ? 'Filled in from closing prices' : '';
  const data = view.map(p => ({ t: new Date(p.date + 'T12:00'), v: p.v, p }));
  X.queue('#ch-trend', el => Charts.area(el, {
    pts: data, height: 270, left: 66,
    label: `Net worth from ${dayLabel(first.date, true)} to ${dayLabel(end.date, true)}, ${chg >= 0 ? 'up' : 'down'} ${Math.abs(chgPct).toFixed(1)} percent`,
    tick: v => compact(v, c.base),
    tip: i => {
      const p = data[i].p, d = data[i].v - first.v;
      const n = note(p);
      return `<div class="t-d">${esc(new Date(p.date + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</div>
        <div class="t-v num">${mask ? '•••' : money(data[i].v, c.base)}</div>
        <div class="t-n num ${tone(d)}">${mask ? '' : `${signed(d, c.base)} `}(${d >= 0 ? '+' : '−'}${Math.abs(first.v ? d / first.v * 100 : 0).toFixed(2)}%) since ${esc(dayLabel(first.date))}</div>${n ? `<div class="t-n">${esc(n)}</div>` : ''}`;
    }
  }));
  return `<section class="card c8 col">
    <div class="card-h"><div><h3>Net worth over time</h3><p class="hint num" style="margin-top:2px"><span class="${tone(chg)}"><span class="sens">${signed(chg, c.base)}</span> (${chgPct >= 0 ? '+' : '−'}${Math.abs(chgPct).toFixed(2)}%)</span> since ${esc(dayLabel(first.date, first.date.slice(0, 4) !== end.date.slice(0, 4)))}</p></div>${seg}</div>
    <div class="card-b grow"><div class="chart fill" id="ch-trend"></div></div>
    ${healthLine(X)}
  </section>`;
}

function allocationCard(X, c) {
  const segs = Object.keys(CAT).filter(k => c.cats[k].total > 0).map(k => ({ k, name: CAT[k].name, short: SHORT_OF(k), value: c.cats[k].total, color: `var(${CAT[k].color})`, tab: CAT[k].tab }));
  const top = holdingRows(c).sort((a, b) => b.value - a.value)[0];
  const foreign = Object.keys(CAT).reduce((a, k) => a + c.cats[k].items.filter(h => (h.cur || h.currency) && (h.cur || h.currency) !== 'INR').reduce((s, h) => s + h.valueBase, 0), 0) / (c.base === 'INR' ? 1 : 1);
  const nonInr = c.base === 'INR' ? foreign : c.net - c.cats.in.total - c.cats.pf.total - c.cats.bank.items.filter(h => h.currency === 'INR').reduce((s, h) => s + h.valueBase, 0);
  return `<section class="card c4"><div class="card-h"><h3>Allocation</h3><span class="hint num">${segs.length} classes</span></div>
    <div class="card-b">${F.Charts.stack(segs)}
      <ul class="legend-list">${segs.map(p => `<li><button class="legend-row" data-act="tab" data-tab="${p.tab}" title="${esc(p.name)}">
        <i class="sw" style="background:${p.color}"></i><span class="nm">${esc(p.short)}</span><span class="vl num sens">${money(p.value, c.base)}</span><span class="pc num">${shareOf(p.value, c.net)}%</span></button></li>`).join('')}</ul>
      <p class="mini-h">Concentration</p>
      <dl class="kv">${top ? `<div><dt>Largest holding</dt><dd>${esc(top.name)} <span class="num" style="color:var(--muted);font-weight:500">${shareOf(top.value, c.net)}%</span></dd></div>` : ''}
        <div><dt>Outside India</dt><dd class="num">${shareOf(Math.max(0, nonInr), c.net)}%</dd></div></dl></div></section>`;
}

function bridgeCard(X, c, pts) {
  const a = X.attr;
  const body = (() => {
    if (!X.remote.on) return '<p class="hint">Needs the price server.</p>';
    if (!a || a.range !== X.trendRange || !a.data || !a.data.days) return '<p class="hint">Appears once there are two days of history in this range.</p>';
    const d = a.data, k = c.base === 'USD' ? 1 / c.fx.rate : 1;
    const row = (label, v, tip, strong) => ({ label, value: v * k, text: signed(v * k, c.base), tip, strong });
    return Charts.diverging([
      row('Markets', d.price, 'Price changes of your stocks and other priced assets, valued at the old quantity.'),
      row('Currency', d.fx, 'Exchange-rate moves on money and stocks held in other currencies.'),
      row('Added or withdrawn', d.flows, 'Shares bought or sold, deposits, withdrawals and interest credited to balances.'),
      row('Net change', d.price + d.fx + d.flows, 'The three above added together.', true)
    ]);
  })();
  const year = new Date().getFullYear();
  const spans = [['1 week', isoDay(new Date(Date.now() - 7 * 864e5))], ['1 month', isoDay(new Date(Date.now() - 30 * 864e5))], ['3 months', isoDay(new Date(Date.now() - 92 * 864e5))], ['Year to date', `${year - 1}-12-31`], ['1 year', isoDay(new Date(Date.now() - 365 * 864e5))]];
  const per = spans.map(([label, from]) => { const p = periodChange(pts, c, from); return p ? `<div><dt>${label}</dt><dd class="num ${tone(p.chg)}"><span class="sens">${signed(p.chg, c.base)}</span> <span style="font-weight:500">(${p.pct >= 0 ? '+' : '−'}${Math.abs(p.pct).toFixed(1)}%)</span></dd></div>` : ''; }).join('');
  const label = a && a.data && a.data.from ? `since ${dayLabel(a.data.from)}` : '';
  return `<section class="card c4"><div class="card-h"><h3>What moved it</h3><span class="hint">${esc(label)}</span></div><div class="card-b">${body}
    ${per ? `<p class="mini-h">Change over time</p><dl class="kv">${per}</dl>` : ''}</div></section>`;
}

function holdingRows(c) {
  const rows = [];
  for (const k of Object.keys(CAT)) {
    for (const h of c.cats[k].items) {
      if (!(h.valueBase > 0)) continue;
      let name = h.symbol, sub = h.broker || '';
      if (k === 'bcash') { name = h.broker || 'Broker cash'; sub = `Cash · ${h.currency}`; }
      else if (k === 'bank') { name = [h.bank, h.account].filter(Boolean).join(' · ') || 'Bank'; sub = `Bank · ${h.currency}`; }
      else if (k === 'hand') { name = h.label || 'Cash'; sub = `In hand · ${h.currency}`; }
      else if (k === 'pf') { name = h.label || 'PF'; sub = 'Provident fund'; }
      else if (k === 'other') { name = h.label || h.sym || 'Asset'; sub = 'Other asset'; }
      const dayPct = h.dayBase != null && h.valueBase - h.dayBase ? h.dayBase / (h.valueBase - h.dayBase) * 100 : null;
      rows.push({ k, name, sub, value: h.valueBase, day: h.dayBase, dayPct, tab: CAT[k].tab, q: k === 'us' || k === 'in' ? h.symbol : name, mono: k === 'us' || k === 'in' });
    }
  }
  return rows;
}
function holdingsCard(X, c) {
  const rows = holdingRows(c);
  const mode = X.ui.ovList || 'largest';
  let list, empty = '';
  if (mode === 'largest') list = rows.slice().sort((a, b) => b.value - a.value).slice(0, 6);
  else {
    const moving = rows.filter(r => r.dayPct != null);
    list = moving.sort((a, b) => mode === 'gainers' ? b.dayPct - a.dayPct : a.dayPct - b.dayPct).filter(r => mode === 'gainers' ? r.dayPct > 0 : r.dayPct < 0).slice(0, 6);
    if (!list.length) empty = `<p class="hint" style="padding:18px 0">${moving.length ? `Nothing is ${mode === 'gainers' ? 'up' : 'down'} today.` : 'Day changes appear while markets are open and prices are live.'}</p>`;
  }
  const html = list.map(r => `<li><button class="rank-row" data-act="focus" data-tab="${esc(r.tab)}" data-q="${esc(r.q)}" title="Show ${esc(r.name)}">
    <span class="nm"><b${r.mono ? ' style="font-family:var(--mono);font-size:13.5px"' : ''}>${esc(r.name)}</b><small>${esc(r.sub)}</small></span>
    <span class="v num sens">${money(r.value, c.base)}</span><span class="w num">${shareOf(r.value, c.net)}%</span>
    <span class="d">${r.dayPct != null ? delta(r.dayPct, `${Math.abs(r.dayPct).toFixed(2)}%`) : '<span class="flat">—</span>'}</span></button></li>`).join('');
  const seg = `<div class="seg sm" role="group" aria-label="Holdings list">${[['largest', 'Largest'], ['gainers', 'Gainers'], ['losers', 'Losers']].map(([k, n]) =>
    `<button data-act="ovlist" data-v="${k}" aria-pressed="${k === mode}">${n}</button>`).join('')}</div>`;
  return `<section class="card c8"><div class="card-h"><h3>Holdings</h3>${seg}</div><div class="card-b"><ul class="rank">${html}</ul>${empty}</div></section>`;
}

function institutionsCard(X, c) {
  const g = {};
  const add = (name, v, k) => { name = (name || '').trim() || 'Unnamed'; const e = g[name] || (g[name] = { v: 0, by: {} }); e.v += v; e.by[k] = (e.by[k] || 0) + v; };
  c.cats.us.items.forEach(h => add(h.broker, h.valueBase, 'us'));
  c.cats.in.items.forEach(h => add(h.broker, h.valueBase, 'in'));
  c.cats.bcash.items.forEach(h => add(h.broker, h.valueBase, 'bcash'));
  c.cats.bank.items.forEach(h => add(h.bank, h.valueBase, 'bank'));
  c.cats.pf.items.forEach(h => add(h.label, h.valueBase, 'pf'));
  c.cats.other.items.forEach(h => add(h.label, h.valueBase, 'other'));
  const inst = Object.entries(g).map(([n, e]) => ({ name: n, value: e.v, tab: CAT[Object.entries(e.by).sort((a, b) => b[1] - a[1])[0][0]].tab }))
    .filter(i => i.value > 0).sort((a, b) => b.value - a.value).slice(0, 6);
  const max = Math.max(...inst.map(i => i.value), 1);
  return `<section class="card c6"><div class="card-h"><h3>By institution</h3></div><div class="card-b"><ul class="rank two">${inst.map(i => `<li><button class="rank-row" style="grid-template-columns:minmax(0,1fr) auto" data-act="focus" data-tab="${esc(i.tab)}" data-q="${esc(i.name)}">
    <span class="nm"><b>${esc(i.name)}</b><span class="bar"><i style="width:${Math.max(3, i.value / max * 100).toFixed(1)}%"></i></span></span><span class="v num sens">${money(i.value, c.base)}</span></button></li>`).join('')}</ul></div></section>`;
}

function dataCard(X, c) {
  const h = X.health, st = X.storage;
  const priced = [...c.cats.us.items, ...c.cats.in.items, ...c.cats.other.items.filter(i => i.sym)].filter(i => i.sym);
  const stale = priced.filter(i => i.src !== 'live').length;
  const lp = h && h.lastPass;
  const name = { live: ['ok', 'live'], manual: ['warn', 'your fallback'], last: ['warn', 'last known'], cost: ['bad', 'default'] };
  const rates = [['USD', c.fx.rate, c.fx.src]];
  for (const code of Object.keys(F.FX_EXTRA)) if (c.hasExtra[code]) rates.push([code, c.fx.rate / c.fx.extra[code].rate, c.fx.extra[code].src]);
  const rows = [
    ...rates.map(([code, v, src]) => [`1 ${esc(code)}`, `${money(v, 'INR', 2)} <span class="chip ${name[src][0]}">${name[src][1]}</span>`]),
    ['Prices', X.status.state === 'loading' ? '<span class="chip">checking…</span>' : stale ? `<span class="chip warn">${stale} not live</span>` : '<span class="chip ok">all live</span>'],
    ['Daily snapshot', !X.remote.on ? '<span class="chip">server off</span>' : !lp || !lp.at ? '<span class="chip">pending</span>' : lp.ok === false ? '<span class="chip bad">failed</span>' : `<span class="chip ok">${esc(ago(lp.at * 1000))}</span>`],
    ['History', h ? `${h.days} day${h.days === 1 ? '' : 's'}` : '—'],
    ['Backups', st ? (st.lastBackup ? `${st.backups} · ${esc(st.lastBackup.replace(/^folio-|\.db$/g, ''))}` : 'none yet') : '—'],
    ['Encryption', st ? (st.encrypted ? '<span class="chip ok">on</span>' : '<button class="chip warn" data-act="tab" data-tab="settings" style="border:0;cursor:pointer">off</button>') : '—']
  ];
  return `<section class="card c6"><div class="card-h"><h3>Rates and data</h3><button class="btn quiet sm" data-act="tab" data-tab="settings">Manage</button></div>
    <div class="card-b"><dl class="kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd class="num">${v}</dd></div>`).join('')}</dl></div></section>`;
}

function overview(X, c) {
  if (!c.count) return V.shell(X, c, { title: 'Overview', sub: new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }), body: emptyState() });
  const pts = histPoints(X, c);
  const body = `${V.alerts(X, c)}${heroCard(X, c, pts)}
    <div class="grid">${trendCard(X, c, pts)}${allocationCard(X, c)}</div>
    <div class="grid">${holdingsCard(X, c)}${bridgeCard(X, c, pts)}</div>
    <div class="grid">${institutionsCard(X, c)}${dataCard(X, c)}</div>`;
  return V.shell(X, c, { title: 'Overview', sub: new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }), body });
}

V.overview = overview;
})(typeof window !== 'undefined' ? window : globalThis);
