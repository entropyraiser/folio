/* Views, part 3: the US and Indian stock pages (table and treemap) and the sales log. */
(function (G) {
'use strict';
const F = G.Folio;
const V = F.views;
const { esc, money, qty, icon, Charts } = F;
const { CAT, SRC, SOURCES, tone, signed, arrowFor, ago, dayLabel, initials } = V;

const SORTS = {
  symbol: (a, b) => a.symbol.localeCompare(b.symbol),
  broker: (a, b) => a.brokerName.localeCompare(b.brokerName),
  qty: (a, b) => (a.qty || 0) - (b.qty || 0),
  price: (a, b) => (a.price ?? -1) - (b.price ?? -1),
  avg: (a, b) => (a.avg || 0) - (b.avg || 0),
  value: (a, b) => a.valueBase - b.valueBase,
  day: (a, b) => (a.dayBase ?? -Infinity) - (b.dayBase ?? -Infinity),
  pnl: (a, b) => a.pnlBase - b.pnlBase
};

/* money on top, percentage with its arrow underneath, coloured by sign */
function pnlCell(abs, p, cur) {
  if (abs == null) return '<span class="flat">—</span>';
  const t = tone(abs);
  return `<span class="pnl ${t}"><b class="num sens">${signed(abs, cur)}</b>${p == null ? '' : `<small class="num">${arrowFor(abs)}${Math.abs(p).toFixed(2)}%</small>`}</span>`;
}

function priceNote(h) {
  if (h.src === 'live') return h.source && h.source !== 'yahoo' ? `<span class="chip warn" title="Yahoo failed; this price came from ${esc(SOURCES[h.source] || h.source)}">via ${esc(SOURCES[h.source] || h.source)}</span>` : '';
  if (h.src === 'cost') return '<span class="chip bad" title="No price at all, so the cost is used">no price</span>';
  return `<span class="chip warn" title="Not a live price">${SRC[h.src]}${h.src === 'last' && h.priceAt ? ' · ' + esc(ago(h.priceAt)) : ''}</span>`;
}

function headCell(X, sid, key, label, opts = {}) {
  const s = X.ui.sorts[sid] || { key: 'value', dir: -1 };
  const on = s.key === key;
  return `<th class="${opts.r ? 'r ' : ''}${opts.sm ? 'hide-sm' : ''}" aria-sort="${on ? (s.dir < 0 ? 'descending' : 'ascending') : 'none'}"${opts.w ? ` style="width:${opts.w}"` : ''}>${key ? `<button type="button" class="sort" data-act="sort" data-sid="${sid}" data-key="${key}">${label}</button>` : label}</th>`;
}

function stockRow(X, c, h, kind, cur, flat) {
  const bse = kind === 'in' && h.exchange === 'BSE';
  return `<tr class="trow">
    <td><div class="cell-main"><span class="avatar" aria-hidden="true">${esc(initials(h.symbol))}</span><div class="nm"><span class="tick">${esc(h.symbol)}</span>${bse ? ' <span class="chip">BSE</span>' : ''}<small>${esc(h.name || (flat ? h.brokerName : ''))}</small></div></div></td>
    ${flat ? `<td class="hide-sm">${esc(h.brokerName)}</td>` : ''}
    <td class="r hide-sm num sens-cell">${V.sens(qty(h.qty))}</td>
    <td class="r hide-sm"><span class="num">${h.price != null ? money(h.price, cur, 2) : '—'}</span>${priceNote(h) ? `<small>${priceNote(h)}</small>` : ''}</td>
    <td class="r hide-sm num">${money(h.avg || 0, cur, 2)}</td>
    <td class="r"><b class="num sens" style="font-weight:600">${money(h.value, cur)}</b>${cur !== c.base ? `<small class="num sens">${money(h.valueBase, c.base)}</small>` : ''}</td>
    <td class="r hide-sm"><span class="wbar"><span class="num">${h.weight.toFixed(1)}%</span><i style="--w:${Math.min(100, h.weight * 2).toFixed(0)}%"></i></span></td>
    <td class="r">${pnlCell(h.day, h.dayPct, cur)}</td>
    <td class="r">${pnlCell(h.pnl, h.pnlPct, cur)}</td>
    <td class="act"><span class="row-act">
      <button class="icon-btn sm" data-act="buy" data-k="${kind}" data-id="${h.id}" title="Buy more" aria-label="Buy more ${esc(h.symbol)}">${icon('plus', 15)}</button>
      <button class="icon-btn sm" data-act="sell" data-k="${kind}" data-id="${h.id}" title="Sell" aria-label="Sell ${esc(h.symbol)}">${icon('minus', 15)}</button>
      <button class="icon-btn sm" data-act="edit" data-k="${kind}" data-id="${h.id}" title="Edit" aria-label="Edit ${esc(h.symbol)}">${icon('pencil', 15)}</button>
      <button class="icon-btn sm danger" data-act="del" data-k="${kind}" data-id="${h.id}" title="Delete" aria-label="Delete ${esc(h.symbol)}">${icon('trash-2', 15)}</button></span></td></tr>`;
}

function salesCard(X, c, kind) {
  const ts = (X.S.trades || []).filter(t => t.k === kind).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!ts.length) return '';
  const cur = kind === 'us' ? 'USD' : 'INR';
  const total = ts.reduce((a, t) => a + c.conv(t.realized || 0, t.cur || cur), 0);
  const rows = ts.slice(0, 40).map(t => `<tr class="trow"><td>${esc(dayLabel(t.date, true))}<small>${esc(t.broker || '')}</small></td>
    <td><span class="tick" style="font-family:var(--mono);font-weight:600">${esc(t.symbol)}</span></td>
    <td class="r hide-sm num">${V.sens(qty(t.qty))}</td><td class="r hide-sm num">${money(t.price, t.cur || cur, 2)}</td>
    <td class="r">${pnlCell(t.realized, (t.avg ? (t.price - t.avg) / t.avg * 100 : null), t.cur || cur)}</td>
    <td class="act"><span class="row-act"><button class="icon-btn sm danger" data-act="del-trade" data-id="${esc(t.id)}" title="Remove this line. The shares and cash stay as they are." aria-label="Remove this sale from the list">${icon('x', 15)}</button></span></td></tr>`).join('');
  return `<section class="card" style="margin-bottom:var(--gap)"><div class="card-h"><h3>Sales</h3><span class="hint num">Realized <b class="${tone(total)} sens">${signed(total, c.base)}</b></span></div>
    <div class="tw" style="margin-top:10px"><table class="tbl"><thead><tr><th>Sold</th><th>Symbol</th><th class="r hide-sm">Qty</th><th class="r hide-sm">Price</th><th class="r">Realized</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Realized profit is worked out against your average cost. It is not part of the unrealized P&amp;L above.</p></section>`;
}

function holdings(X, c, kind) {
  const x = c.cats[kind], cur = kind === 'us' ? 'USD' : 'INR';
  const title = CAT[kind].name;
  const brokerOf = h => (h.broker || '').trim() || 'Unnamed';
  const addBtns = `<button class="btn secondary" data-act="import-csv" data-k="${kind}">${icon('upload', 15)}Import CSV</button>
    <button class="btn" data-act="add" data-k="${kind}">${icon('plus', 15)}Add holding</button>`;
  if (!x.items.length) {
    return V.shell(X, c, { title, sub: 'No holdings yet', actions: addBtns, body: `${V.alerts(X, c)}<div class="card"><div class="empty"><h3>Nothing here yet</h3><p>Add a holding by hand, or import the positions export from your broker.</p>
      <div class="row"><button class="btn" data-act="add" data-k="${kind}">${icon('plus', 15)}Add holding</button><button class="btn secondary" data-act="import-csv" data-k="${kind}">${icon('upload', 15)}Import CSV</button></div></div></div>` });
  }
  const brokers = [...new Set(x.items.map(brokerOf))].sort();
  let sel = X.ui.broker[kind] || '';
  if (sel && !brokers.includes(sel)) sel = '';
  const q = X.query.trim().toLowerCase();
  const view = X.ui.view === 'map' ? 'map' : 'table';
  const flat = X.ui.group === 'none';
  const sid = `${kind}:${flat ? 'all' : 'grp'}`;
  const mapBy = X.ui.mapBy === 'pnl' || (X.ui.mapBy === 'day' && !x.items.some(h => h.dayBase != null && Math.abs(h.dayBase) > 0)) ? 'pnl' : 'day';
  const sort = X.ui.sorts[sid] || { key: 'value', dir: -1 };

  let rows = x.items.map(h => {
    const sym = F.ySym(kind, h), lq = X.live[sym];
    const base = h.valueBase - (h.dayBase || 0);
    return { ...h, brokerName: brokerOf(h), name: lq && lq.name, weight: x.total ? h.valueBase / x.total * 100 : 0,
      dayPct: h.dayBase != null && base ? h.dayBase / base * 100 : null };
  });
  if (sel) rows = rows.filter(h => h.brokerName === sel);
  if (q) rows = rows.filter(h => `${h.symbol} ${h.brokerName} ${h.name || ''}`.toLowerCase().includes(q));
  const cmp = SORTS[sort.key] || SORTS.value;
  rows.sort((a, b) => cmp(a, b) * sort.dir);

  const costBase = x.items.reduce((a, h) => a + h.costBase, 0);
  const dayTotal = x.items.reduce((a, h) => a + (h.dayBase || 0), 0);
  const anyDay = x.items.some(h => h.dayBase != null);
  const dayBase0 = x.total - dayTotal;
  const realized = (X.S.trades || []).filter(t => t.k === kind).reduce((a, t) => a + c.conv(t.realized || 0, t.cur || cur), 0);
  const hasSales = (X.S.trades || []).some(t => t.k === kind);
  const stat = (lab, val, sub, t = '') => `<div class="stat"><span class="lab">${lab}</span><span class="val num sens ${t}">${val}</span><span class="sub num">${sub}</span></div>`;
  const strip = `<section class="card strip" aria-label="Summary">
    ${stat('Market value', money(x.total, c.base), `${x.items.length} holding${x.items.length === 1 ? '' : 's'}`)}
    ${stat('Cost basis', money(costBase, c.base), 'what you paid')}
    ${stat('Unrealized P&amp;L', signed(x.pnl, c.base), costBase > 0 ? `${x.pnl >= 0 ? '+' : '−'}${Math.abs(x.pnl / costBase * 100).toFixed(2)}%` : '—', tone(x.pnl))}
    ${stat('Today', anyDay ? signed(dayTotal, c.base) : '—', anyDay && dayBase0 ? `${dayTotal >= 0 ? '+' : '−'}${Math.abs(dayTotal / dayBase0 * 100).toFixed(2)}%` : 'market closed or no live prices', anyDay ? tone(dayTotal) : '')}
    ${hasSales ? stat('Realized', signed(realized, c.base), 'from sales, all time', tone(realized)) : ''}
  </section>`;

  const toolbar = `<div class="toolbar">
    <label class="search-field">${icon('search', 15)}<input id="q" type="search" placeholder="Filter by symbol, name or broker" value="${esc(X.query)}" aria-label="Filter holdings"></label>
    <div class="pills" role="group" aria-label="Broker">
      <button class="pill-btn" data-act="broker" data-k="${kind}" data-v="" aria-pressed="${!sel}">All</button>
      ${brokers.map(b => `<button class="pill-btn" data-act="broker" data-k="${kind}" data-v="${esc(b)}" aria-pressed="${b === sel}">${esc(b)}</button>`).join('')}</div>
    <span class="grow"></span>
    ${view === 'table' ? `<div class="seg sm" role="group" aria-label="Grouping"><button data-act="group" data-g="broker" aria-pressed="${!flat}">By broker</button><button data-act="group" data-g="none" aria-pressed="${flat}">One list</button></div>` : `<div class="seg sm" role="group" aria-label="Colour by"><button data-act="mapby" data-v="day" aria-pressed="${mapBy === 'day'}">Today</button><button data-act="mapby" data-v="pnl" aria-pressed="${mapBy === 'pnl'}">P&amp;L</button></div>`}
    <div class="seg sm" role="group" aria-label="View"><button data-act="view" data-v="table" aria-pressed="${view === 'table'}">${icon('list', 14)} Table</button><button data-act="view" data-v="map" aria-pressed="${view === 'map'}">${icon('layout-grid', 14)} Map</button></div>
  </div>`;

  let body;
  if (!rows.length) body = `<div class="empty"><h3>No match</h3><p>Nothing matches the filter.</p><button class="btn secondary sm" data-act="clear-filters">Clear filters</button></div>`;
  else if (view === 'map') {
    const by = mapBy;
    const items = rows.filter(h => h.valueBase > 0).map(h => ({ id: h.id, label: h.symbol, value: h.valueBase, chg: by === 'pnl' ? h.pnlPct : h.dayPct,
      sub: (by === 'pnl' ? h.pnlPct : h.dayPct) == null ? '' : `${(by === 'pnl' ? h.pnlPct : h.dayPct) >= 0 ? '+' : '−'}${Math.abs(by === 'pnl' ? h.pnlPct : h.dayPct).toFixed(2)}%`, h }));
    const maxChg = Math.max(2, ...items.map(i => Math.abs(i.chg || 0)));
    X.queue('#ch-tm', el => Charts.treemap(el, {
      items, max: maxChg, height: 380,
      tip: i => `<b style="font-family:var(--mono)">${esc(i.h.symbol)}</b>${i.h.name ? `<span>${esc(i.h.name)}</span><br>` : ''}<span class="num">${X.S.settings.mask ? '•••' : money(i.h.valueBase, c.base)}</span><br>
        <span class="num ${tone(i.h.dayBase || 0)}">Today ${i.h.dayPct == null ? '—' : `${i.h.dayPct >= 0 ? '+' : '−'}${Math.abs(i.h.dayPct).toFixed(2)}%`}</span> ·
        <span class="num ${tone(i.h.pnl)}">P&amp;L ${i.h.pnlPct == null ? '—' : `${i.h.pnlPct >= 0 ? '+' : '−'}${Math.abs(i.h.pnlPct).toFixed(2)}%`}</span>`
    }));
    body = `<div class="card-b" style="padding-top:18px"><div class="tm" id="ch-tm"></div>
      <div class="tm-legend"><span class="num">−${maxChg.toFixed(0)}%</span><i></i><span class="num">+${maxChg.toFixed(0)}%</span><span style="margin-left:8px">Size is value. Colour is ${by === 'pnl' ? 'profit or loss on cost' : "today's move"}.</span></div></div>`;
  } else {
    const th = h => h;
    const head = `<thead><tr>${headCell(X, sid, 'symbol', 'Holding')}${flat ? headCell(X, sid, 'broker', 'Broker', { sm: 1 }) : ''}${headCell(X, sid, 'qty', 'Qty', { r: 1, sm: 1 })}${headCell(X, sid, 'price', 'Price', { r: 1, sm: 1 })}${headCell(X, sid, 'avg', 'Avg cost', { r: 1, sm: 1 })}${headCell(X, sid, 'value', 'Value', { r: 1 })}${headCell(X, sid, 'value', 'Weight', { r: 1, sm: 1 })}${headCell(X, sid, 'day', 'Today', { r: 1 })}${headCell(X, sid, 'pnl', 'P&amp;L', { r: 1 })}<th style="width:1%"></th></tr></thead>`;
    const ncols = 9 + (flat ? 1 : 0);
    let tbody;
    if (flat) tbody = rows.map(h => stockRow(X, c, h, kind, cur, true)).join('');
    else {
      const groups = new Map();
      rows.forEach(h => { if (!groups.has(h.brokerName)) groups.set(h.brokerName, []); groups.get(h.brokerName).push(h); });
      tbody = [...groups.entries()].sort((a, b) => b[1].reduce((s, h) => s + h.valueBase, 0) - a[1].reduce((s, h) => s + h.valueBase, 0)).map(([name, items]) =>
        `<tr class="grp"><td colspan="${ncols}"><div style="display:flex;justify-content:space-between;gap:12px"><span><b>${esc(name)}</b> · ${items.length} holding${items.length === 1 ? '' : 's'}</span><span class="num sens">${money(items.reduce((s, h) => s + h.valueBase, 0), c.base)}</span></div></td></tr>`
        + items.map(h => stockRow(X, c, h, kind, cur, false)).join('')).join('');
    }
    body = `<div class="tw"><table class="tbl">${head}<tbody>${tbody}</tbody></table></div>`;
  }
  const sub = `${x.items.length} holding${x.items.length === 1 ? '' : 's'} across ${brokers.length} broker${brokers.length === 1 ? '' : 's'}`;
  return V.shell(X, c, { title, sub, actions: addBtns, body: `${V.alerts(X, c)}${strip}<section class="card" style="margin-bottom:var(--gap)">${toolbar}${body}</section>${salesCard(X, c, kind)}` });
}

V.holdings = holdings;
})(typeof window !== 'undefined' ? window : globalThis);
