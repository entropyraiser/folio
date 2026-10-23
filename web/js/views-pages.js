/* Views, part 4: cash, provident fund, other assets, settings. */
(function (G) {
'use strict';
const F = G.Folio;
const V = F.views;
const { esc, money, qty, icon, Charts, FX_EXTRA, PALETTES } = F;
const { CAT, STALE_DAYS, tone, signed, ageDays, ageText, initials } = V;

const statBlock = (lab, val, sub, t = '') => `<div class="stat"><span class="lab">${lab}</span><span class="val num sens ${t}">${val}</span><span class="sub num">${sub}</span></div>`;
const rowActs = (k, id, extra = '', label = 'entry') => `<td class="act"><span class="row-act">${extra}
  <button class="icon-btn sm" data-act="edit" data-k="${k}" data-id="${id}" title="Edit" aria-label="Edit ${esc(label)}">${icon('pencil', 15)}</button>
  <button class="icon-btn sm danger" data-act="del" data-k="${k}" data-id="${id}" title="Delete" aria-label="Delete ${esc(label)}">${icon('trash-2', 15)}</button></span></td>`;

/* ---------- cash ---------- */
function cash(X, c) {
  const groups = [['bcash', 'Broker cash', 'broker', 'Add broker cash'], ['bank', 'Bank accounts', 'bank', 'Add bank account'], ['hand', 'Cash in hand', 'label', 'Add cash']];
  const total = groups.reduce((a, [k]) => a + c.cats[k].total, 0);
  const showFx = groups.some(([k]) => c.cats[k].items.some(h => h.currency !== c.base));
  let stale = 0;
  const cur = {};
  const body = groups.map(([kind, name, nameKey, addLabel]) => {
    const x = c.cats[kind];
    const rows = x.items.map(h => {
      cur[h.currency] = (cur[h.currency] || 0) + h.valueBase;
      const old = !h.balanceAt || ageDays(h.balanceAt) > STALE_DAYS;
      if (old) stale++;
      const when = h.balanceAt
        ? `<span class="chip${old ? ' warn' : ''}" title="Balance last confirmed ${esc(new Date(h.balanceAt).toLocaleDateString([], { dateStyle: 'medium' }))}">${icon('clock', 12)}${ageText(h.balanceAt)}</span>`
        : '<span class="chip warn" title="Edit or confirm this balance to start tracking its age">date unknown</span>';
      const confirm = `<button class="icon-btn sm" data-act="confirm" data-k="${kind}" data-id="${h.id}" title="The balance is still correct" aria-label="Confirm balance">${icon('check', 15)}</button>`;
      return `<tr class="trow"><td><div class="cell-main"><span class="avatar" aria-hidden="true">${esc(initials(h[nameKey] || '?'))}</span><div class="nm"><span>${esc(h[nameKey] || 'Unnamed')}</span>${kind === 'bank' && h.account ? `<small>${esc(h.account)}</small>` : ''}</div></div></td>
        <td class="hide-sm"><span class="chip">${esc(h.currency)}</span></td>
        <td class="r"><b class="num sens" style="font-weight:600">${money(h.balance || 0, h.currency)}</b></td>
        ${showFx ? `<td class="r hide-sm num sens-cell">${h.currency !== c.base ? V.sens(money(h.valueBase || 0, c.base)) : ''}</td>` : ''}
        <td class="hide-sm">${when}</td>${rowActs(kind, h.id, confirm, h[nameKey] || name)}</tr>`;
    }).join('') || `<tr><td colspan="${showFx ? 6 : 5}" class="flat" style="padding:14px 22px">Nothing here yet.</td></tr>`;
    return `<tr class="grp"><td colspan="${showFx ? 6 : 5}"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><span><b>${name}</b> · <span class="num sens">${money(x.total, c.base)}</span></span>
      <button class="btn quiet sm" data-act="add" data-k="${kind}">${icon('plus', 14)}Add</button></div></td></tr>${rows}`;
  }).join('');
  const total2 = Object.values(cur).reduce((a, b) => a + b, 0);
  const curParts = Object.entries(cur).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([code, v], i) => ({ name: code, value: v, color: `var(--s${i + 1})` }));
  const alertHtml = stale ? `<div class="alerts"><div class="alert warn" role="status">${icon('clock', 17)}<div class="alert-body"><b>${stale === 1 ? '1 balance has' : `${stale} balances have`} not been updated in over ${STALE_DAYS} days</b>
    <div class="detail">Edit a balance, or press the tick if it hasn't changed.</div></div></div></div>` : '';
  const strip = `<section class="card strip">${statBlock('Total cash', money(total, c.base), `${((total / c.net) * 100 || 0).toFixed(1)}% of net worth`)}
    ${groups.map(([k, n]) => statBlock(n, money(c.cats[k].total, c.base), `${c.cats[k].items.length} account${c.cats[k].items.length === 1 ? '' : 's'}`)).join('')}</section>`;
  const byCur = curParts.length > 1 ? `<section class="card" style="margin-bottom:var(--gap)"><div class="card-h"><h3>By currency</h3></div><div class="card-b">${Charts.stack(curParts)}
    <ul class="legend-grid">${curParts.map(p => `<li class="legend-row"><i class="sw" style="background:${p.color}"></i><span class="nm">${esc(p.name)}</span><span class="vl num sens">${money(p.value, c.base)}</span><span class="pc num">${(p.value / total2 * 100).toFixed(0)}%</span></li>`).join('')}</ul></div></section>` : '';
  const th = `<thead><tr><th>Account</th><th class="hide-sm">Currency</th><th class="r">Balance</th>${showFx ? `<th class="r hide-sm">In ${c.base}</th>` : ''}<th class="hide-sm">Updated</th><th style="width:1%"></th></tr></thead>`;
  return V.shell(X, c, { title: 'Cash', sub: `${groups.reduce((a, [k]) => a + c.cats[k].items.length, 0)} balances`, actions: `<button class="btn" data-act="add" data-k="bank">${icon('plus', 15)}Add bank account</button>`,
    body: `${alertHtml}${strip}${byCur}<section class="card" style="margin-bottom:var(--gap)"><div class="tw"><table class="tbl">${th}<tbody>${body}</tbody></table></div></section>` });
}

/* ---------- provident fund ---------- */
function monthBars(log) {
  const by = {};
  (log || []).forEach(l => { by[l.month] = (by[l.month] || 0) + (l.amount || 0); });
  const months = Object.keys(by).sort().slice(-12);
  if (!months.length) return '';
  const max = Math.max(...months.map(m => by[m]), 1);
  return `<div class="contrib-chart" role="img" aria-label="Monthly contributions">${months.map(m => {
    const d = new Date(m + '-01T00:00');
    return `<div class="col" title="${esc(d.toLocaleDateString([], { month: 'long', year: 'numeric' }))}: ${esc(money(by[m], 'INR'))}"><i style="height:${Math.max(4, by[m] / max * 88)}px"></i><small>${esc(d.toLocaleDateString([], { month: 'short' }))}</small></div>`;
  }).join('')}</div>`;
}
function pf(X, c) {
  const x = c.cats.pf;
  const year = String(new Date().getFullYear());
  const thisYear = x.items.reduce((a, h) => a + (h.log || []).filter(l => String(l.month).startsWith(year)).reduce((s, l) => s + (l.amount || 0), 0), 0);
  const strip = `<section class="card strip">${statBlock('Total balance', money(x.total, c.base), `${((x.total / c.net) * 100 || 0).toFixed(1)}% of net worth`)}
    ${statBlock('Accounts', String(x.items.length), 'provident fund')}${statBlock(`Contributed in ${year}`, money(thisYear, 'INR'), 'from logged contributions')}</section>`;
  const showFx = c.base !== 'INR' && x.items.length > 0;
  const rows = x.items.map(h => `<tr class="trow"><td><div class="cell-main"><span class="avatar" aria-hidden="true">${esc(initials(h.label))}</span><div class="nm"><span>${esc(h.label)}</span><small>${(h.log || []).length ? `${(h.log || []).length} contribution${(h.log || []).length === 1 ? '' : 's'} logged` : 'no contributions logged'}</small></div></div></td>
    <td class="r"><b class="num sens" style="font-weight:600">${money(h.balance || 0, 'INR')}</b></td>${showFx ? `<td class="r hide-sm num sens">${money(h.valueBase, c.base)}</td>` : ''}
    ${rowActs('pf', h.id, `<button class="btn secondary sm" data-act="contrib" data-id="${h.id}" style="margin-right:6px">${icon('plus', 14)}Contribution</button>`, h.label)}</tr>`).join('');
  const table = x.items.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Account</th><th class="r">Balance</th>${showFx ? `<th class="r hide-sm">In ${c.base}</th>` : ''}<th style="width:1%"></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Adding a contribution increases the balance and keeps a monthly log. Edit the balance directly to record interest credits.</p>`
    : `<div class="empty"><h3>No PF account yet</h3><p>Add your provident fund balance to include it in your net worth.</p><button class="btn" data-act="add" data-k="pf">${icon('plus', 15)}Add PF account</button></div>`;
  const logs = x.items.filter(h => (h.log || []).length).map(h => `<section class="card" style="margin-bottom:var(--gap)"><div class="card-h"><h3>${esc(h.label)} · contributions</h3><span class="hint">last 12 months logged</span></div>
    <div class="card-b">${monthBars(h.log)}</div></section>`).join('');
  return V.shell(X, c, { title: 'Provident fund', sub: `${x.items.length} account${x.items.length === 1 ? '' : 's'}`, actions: `<button class="btn" data-act="add" data-k="pf">${icon('plus', 15)}Add PF account</button>`,
    body: `${strip}<section class="card" style="margin-bottom:var(--gap)">${table}</section>${logs}` });
}

/* ---------- other assets ---------- */
function other(X, c) {
  const x = c.cats.other;
  const showFx = x.items.some(h => h.cur !== c.base);
  const rows = x.items.map(h => `<tr class="trow"><td><div class="cell-main"><span class="avatar" aria-hidden="true">${esc(initials(h.label))}</span><div class="nm"><span>${esc(h.label)}</span><small>${h.sym ? `${esc(h.sym)} · ${V.sens(qty(h.qty))} units` : 'manual value'}</small></div></div></td>
    <td class="r hide-sm num">${h.price != null ? money(h.price, h.cur, 2) : '—'}${h.sym && h.src !== 'live' ? `<small><span class="chip warn">${V.SRC[h.src]}</span></small>` : ''}</td>
    <td class="r"><b class="num sens" style="font-weight:600">${money(h.value, h.cur)}</b></td>${showFx ? `<td class="r hide-sm num sens">${h.cur !== c.base ? money(h.valueBase, c.base) : ''}</td>` : ''}${rowActs('other', h.id, '', h.label)}</tr>`).join('');
  const body = x.items.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Asset</th><th class="r hide-sm">Price</th><th class="r">Value</th>${showFx ? `<th class="r hide-sm">In ${c.base}</th>` : ''}<th style="width:1%"></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty"><h3>Nothing here yet</h3><p>Crypto, gold, a property, anything with a value. Give it a Yahoo symbol such as BTC-USD and it updates live.</p><button class="btn" data-act="add" data-k="other">${icon('plus', 15)}Add asset</button></div>`;
  return V.shell(X, c, { title: 'Other assets', sub: `${x.items.length} asset${x.items.length === 1 ? '' : 's'}`, actions: `<button class="btn" data-act="add" data-k="other">${icon('plus', 15)}Add asset</button>`,
    body: `${V.alerts(X, c)}<section class="card strip">${statBlock('Total', money(x.total, c.base), `${((x.total / c.net) * 100 || 0).toFixed(1)}% of net worth`)}</section><section class="card" style="margin-bottom:var(--gap)">${body}</section>` });
}

/* ---------- settings ---------- */
function themePicker(X) {
  const mode = X.mode, cur = X.paletteId(mode);
  return `<div class="themes">${Object.entries(PALETTES[mode]).map(([id, p]) =>
    `<button type="button" class="theme-btn" data-act="theme" data-theme="${id}" aria-pressed="${id === cur}">
      <span class="chips" aria-hidden="true"><i style="background:${p['--accent']}"></i><i style="background:${p['--c-in']}"></i><i style="background:${p['--c-bcash']}"></i><i style="background:${p['--c-bank']}"></i></span>${esc(p.label)}</button>`).join('')}</div>`;
}
function settings(X, c) {
  const S = X.S, st = X.storage, remote = X.remote;
  const row = (title, desc, control, stack) => `<div class="setting${stack ? ' stack-l' : ''}"><div><p class="s-t">${title}</p>${desc ? `<p class="s-d">${desc}</p>` : ''}</div><div>${control}</div></div>`;
  const input = (id, set, val, ph, type = 'text') => `<input id="${id}" data-set="${set}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${esc(val ?? '')}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false">`;
  const modeSet = S.settings.mode === 'light' || S.settings.mode === 'dark' ? S.settings.mode : 'system';
  const safety = !remote.on ? '<p class="s-d">The price server is not connected, so your data is only in this browser.</p>'
    : st ? `<dl class="kv" style="margin:0">
        <div><dt>Stored in</dt><dd style="font-weight:450;overflow-wrap:anywhere">${esc(st.database)}</dd></div>
        <div><dt>Encryption</dt><dd>${st.encrypted ? '<span class="chip ok">on, key in the macOS Keychain</span>' : '<span class="chip warn">off</span>'}</dd></div>
        <div><dt>Backups</dt><dd>${st.backups} daily${st.lastBackup ? ` · newest ${esc(st.lastBackup.replace(/^folio-|\.db$/g, ''))}` : ''}</dd></div>
        <div><dt>Saved versions</dt><dd>${st.versions}</dd></div></dl>` : '<p class="s-d">Loading…</p>';
  return V.shell(X, c, { title: 'Settings', sub: 'Appearance, prices, data and history', body: `<div class="settings">
    <nav class="settings-nav" aria-label="Settings sections"><a href="#set-look">Appearance</a><a href="#set-prices">Prices</a><a href="#set-data">Your data</a><a href="#set-history">Daily history</a></nav>
    <div>
      <section class="card" id="set-look" style="margin-bottom:var(--gap)"><div class="card-h"><h3>Appearance</h3></div>
        ${row('Mode', 'Light, dark, or follow the system.', `<div class="seg" role="group" aria-label="Mode">${[['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([m, n]) => `<button data-act="mode-set" data-m="${m}" aria-pressed="${modeSet === m}">${n}</button>`).join('')}</div>`)}
        ${row('Colour', 'Changes the accent and the chart colours. Each mode remembers its own.', themePicker(X), true)}
      </section>
      <section class="card" id="set-prices" style="margin-bottom:var(--gap)"><div class="card-h"><h3>Prices</h3></div>
        ${row('Price server address', 'Only needed if you open the page from a file instead of through the server. The default then is http://localhost:8787.', input('s-backend', 'backend', S.settings.backend, 'Leave empty'))}
        ${row('Fallback USD/INR rate', 'Used when the live rate can’t be fetched.', input('s-fx', 'fx', S.settings.fxManual, 'e.g. 88.00', 'number'))}
        ${Object.values(FX_EXTRA).map(fx => row(esc(fx.label), esc(fx.hint), input(fx.field, fx.set, S.settings[fx.manual], fx.ph, 'number'))).join('')}
        ${row('Alpha Vantage key', 'A second source for prices when Yahoo is down. The free key allows 25 lookups a day, so it is only a backup. You can also save it in <code>alpha_vantage_api_key.txt</code>.', input('s-alpha', 'alphaKey', S.settings.alphaKey, 'Free key from alphavantage.co'))}
      </section>
      <section class="card" id="set-data" style="margin-bottom:var(--gap)"><div class="card-h"><h3>Your data</h3></div>
        <div class="card-b">${safety}
          ${remote.on ? `<p class="s-d" style="margin-top:12px"><b>Full backup</b> is one file with your holdings, every saved version and the whole daily history. Keep it somewhere safe, then restore it here on any machine running this tracker. ${st && st.encrypted ? 'Encryption is on, so the file can only be opened with your recovery key too.' : 'It is not encrypted, so treat the file like your statements.'}</p>
          <div class="row" style="margin-top:14px"><button class="btn" data-act="backup-dl">${icon('download', 15)}Download full backup</button><button class="btn secondary" data-act="backup-up">${icon('upload', 15)}Restore from backup…</button></div>
          <div class="row" style="margin-top:10px">` : `<div class="row" style="margin-top:14px"><button class="btn secondary" data-act="export">${icon('download', 15)}Export backup</button><button class="btn secondary" data-act="import">${icon('upload', 15)}Import backup</button>`}
          <button class="btn secondary" data-act="import-csv" data-k="us">${icon('upload', 15)}Import holdings from CSV</button><button class="btn secondary danger" data-act="reset">${icon('trash-2', 15)}Erase all data</button></div></div>
      </section>
      <section class="card" id="set-history" style="margin-bottom:var(--gap)"><div class="card-h"><h3>Daily history</h3></div>
        <div class="card-b"><p class="s-d" style="margin-bottom:14px">If you corrected a wrong quantity, or a day was valued with estimated prices, value the days again from closing prices. Days that were already settled are replaced.</p>
        <form id="rebuild-form" class="row" style="align-items:flex-end">
          <div class="field" style="margin:0"><label for="r-from">From</label><input id="r-from" type="date" required value="${esc(X.rebuildFrom())}" style="width:auto"></div>
          <label class="check-inline" style="padding-bottom:9px"><input type="checkbox" id="r-cur"> Use today’s holdings for those days</label>
          <button class="btn secondary" type="submit"${X.rebuilding ? ' disabled' : ''}>${icon('history', 15)}${X.rebuilding ? 'Recomputing…' : 'Recompute'}</button></form></div>
      </section>
    </div></div>` });
}

V.cash = cash; V.pf = pf; V.other = other; V.settings = settings;
})(typeof window !== 'undefined' ? window : globalThis);
