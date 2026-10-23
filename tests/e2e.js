#!/usr/bin/env node
/* End-to-end: starts the real server on a throw-away database, drives the dashboard in headless Chrome,
   and checks what actually reaches the database. Needs Chrome (set CHROME=... if it is not in /Applications).
   Steps that need the internet (symbol lookup) are skipped when offline. SHOTS=dir saves a screenshot of each page. */
const assert = require('node:assert/strict');
const path = require('path');
const { launch, sleep } = require('./cdp.js');
const { startServer } = require('./harness.js');
const SHOTS = process.env.SHOTS || '';
let PORT = 0;
const getData = async () => (await (await fetch(`http://localhost:${PORT}/api/data`)).json());
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(['ok', name]); console.log('ok   ' + name); } catch (e) { results.push(['FAIL', name]); console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 6).join('\n     ')); } };

(async () => {
  const server = await startServer();
  PORT = server.port;
  let b;
  try {
    b = await launch({ width: 1300, height: 1000 });
    const url = `http://localhost:${PORT}/`;
    const online = await (async () => { try { const d = await (await fetch(`http://localhost:${PORT}/api/quotes?symbols=AAPL`)).json(); return d.quotes.AAPL && d.quotes.AAPL.price != null; } catch (e) { return false; } })();
    const shot = async name => { if (SHOTS) await b.screenshot(path.join(SHOTS, name + '.png')); };
    const wait = expr => b.waitFor(expr);
    const saved = async cond => { for (let i = 0; i < 40; i++) { const d = await getData(); if (cond(d.data)) return d.data; await sleep(150); } throw new Error('the change never reached the database'); };

    await step('overview loads without errors and shows the new numbers', async () => {
      await b.goto(url);
      await wait(`document.querySelector('.hero-num')`);
      await sleep(1500);
      assert.deepEqual(b.errors, []);
      const text = await b.text('#app');
      assert.match(text, /Unrealized P&L/);
      assert.match(text, /What moved it/);
      assert.match(text, /Markets/, 'what moved net worth');
      assert.match(text, /used estimated prices/, 'history health');
      assert.match(text, /AAPL split 4-for-1/, 'pending split');
      await shot('overview');
    });

    await step('applying a split changes quantity and average cost once', async () => {
      await b.click('[data-act=split-apply]');
      const data = await saved(d => d.us[0].qty === 40);
      assert.equal(data.us[0].avg, 37.5);
      assert.equal(data.us[0].manualPrice, 40);
      assert.equal(data.us[0].splits.length, 1);
      const splits = await (await fetch(`http://localhost:${PORT}/api/splits`)).json();
      assert.deepEqual(splits.splits, []);
      assert.doesNotMatch(await b.text('#app'), /split 4-for-1/);
    });

    await step('stock page: group, filter, and per-row actions', async () => {
      await b.click('[data-act=tab][data-tab=us]');
      await wait(`document.querySelector('table.tbl')`);
      assert.equal(await b.eval(`document.querySelectorAll('tr.grp').length`), 2, 'one group per broker');
      await b.click('[data-act=group][data-g=none]');
      assert.ok(await b.eval(`[...document.querySelectorAll('th')].some(t => t.innerText.includes('Broker'))`));
      await b.click('[data-act=broker][data-v=Etrade]');
      assert.equal(await b.eval(`document.querySelectorAll('tbody tr.trow').length`), 1);
      await b.click('[data-act=broker][data-v=""]');
      await b.click('[data-act=sort][data-key=symbol]');
      assert.equal(await b.eval(`document.querySelector('tbody tr.trow .tick').innerText`), 'AAPL', 'sorted by symbol');
      await b.click('[data-act=sort][data-key=symbol]');
      assert.equal(await b.eval(`document.querySelector('tbody tr.trow .tick').innerText`), 'MSFT', 'and back the other way');
      await b.click('[data-act=group][data-g=broker]');
      await shot('us-stocks');
    });

    await step('selling part of a position records realized profit and credits cash', async () => {
      await b.click('[data-act=sell][data-id=u1]');
      await wait(`document.querySelector('#dlg[open] #f-qty')`);
      await b.type('#f-qty', '10'); await b.type('#f-price', '50'); await b.type('#f-fees', '5');
      await shot('sell-dialog');
      await b.eval(`document.querySelector('#frm button[type=submit]').click()`);
      const d = await saved(x => x.trades && x.trades.length === 1);
      assert.equal(d.us[0].qty, 30);
      assert.equal(d.trades[0].realized, (50 - 37.5) * 10 - 5);
      assert.equal(d.bcash[0].balance, 1000 + 495);
      assert.match(await b.text('#app'), /Sales/);
    });

    await step('buying more updates the average cost and pays from cash', async () => {
      await b.click('[data-act=buy][data-id=u1]');
      await wait(`document.querySelector('#dlg[open] #f-qty')`);
      await b.type('#f-qty', '10'); await b.type('#f-price', '60');
      assert.ok(await b.eval(`!!document.querySelector('#f-cash')`), 'offers to pay from the IBKR cash');
      await b.eval(`document.querySelector('#frm button[type=submit]').click()`);
      const d = await saved(x => x.us[0].qty === 40);
      assert.equal(d.us[0].avg, (37.5 * 30 + 60 * 10) / 40);
      assert.equal(d.bcash[0].balance, 1495 - 600);
    });

    await step('selling more than you hold is refused; selling everything removes the holding', async () => {
      await b.click('[data-act=sell][data-id=u2]');
      await wait(`document.querySelector('#dlg[open] #f-qty')`);
      await b.type('#f-qty', '3');
      await b.eval(`document.querySelector('#frm button[type=submit]').click()`);
      await sleep(200);
      assert.ok(await b.eval(`document.querySelector('#dlg').open`), 'dialog stays open');
      await b.type('#f-qty', '2');
      await b.eval(`document.querySelector('#frm button[type=submit]').click()`);
      const d = await saved(x => x.us.length === 1);
      assert.equal(d.trades.length, 2);
      assert.equal(d.bcash.length, 2, 'proceeds went to a new Etrade cash balance');
    });

    await step('CSV import previews, then adds holdings', async () => {
      await b.eval(`(() => {
        const input = document.getElementById('csvfile'), dt = new DataTransfer();
        dt.items.add(new File(['Symbol,Quantity,Average Cost,Currency\\nNVDA,3,120.5,USD\\nTCS.NS,4,3000,INR\\nTotal,,,\\nBAD,-1,1,USD\\n'], 'positions.csv', { type: 'text/csv' }));
        input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await wait(`document.querySelector('#dlg[open] #c-broker')`);
      const text = await b.text('#frm');
      assert.match(text, /2 holdings found \(1 US, 1 Indian\), 2 rows skipped/);
      await b.eval(`document.querySelector('#frm button[type=submit]').click()`);
      await sleep(150);
      assert.match(await b.eval(`document.getElementById('ferr').textContent`), /broker/i, 'a broker name is required');
      await b.type('#c-broker', 'Fidelity');
      await b.eval(`document.querySelector('#frm button[type=submit]').click()`);
      const d = await saved(x => x.us.some(h => h.symbol === 'NVDA'));
      assert.equal(d.in.find(h => h.symbol === 'TCS').exchange, 'NSE');
      assert.equal(d.us.find(h => h.symbol === 'NVDA').broker, 'Fidelity');
      assert.match(await b.text('#toasts'), /Imported 2 holdings/);
    });

    await step('adding a holding checks the symbol with the server', async () => {
      if (!online) return console.log('     (offline: skipped)');
      await b.click('[data-act=add][data-k=us]');
      await wait(`document.querySelector('#dlg[open] #f-symbol')`);
      await b.type('#f-symbol', 'ZZZZNOPE');
      await wait(`document.getElementById('symcheck').classList.contains('bad')`);
      await b.type('#f-broker', 'IBKR'); await b.type('#f-qty', '1'); await b.type('#f-avg', '1');
      await b.eval(`document.querySelector('#frm button[type=submit]').click()`);
      assert.match(await b.eval(`document.getElementById('ferr').textContent`), /Press Save again/);
      await b.type('#f-symbol', 'AAPL');
      await wait(`document.getElementById('symcheck').classList.contains('ok')`);
      assert.match(await b.text('#symcheck'), /Apple/);
      await b.click('[data-act=cancel]');
    });

    await step('overview rows drill into the matching page, filtered', async () => {
      await b.click('[data-act=tab][data-tab=overview]');
      await wait(`document.querySelector('.rank-row[data-act=focus]')`);
      const want = await b.eval(`document.querySelector('.rank-row[data-act=focus]').dataset.q`);
      await b.click('.rank-row[data-act=focus]');
      assert.equal(await b.eval(`document.getElementById('q').value`), want);
      assert.ok(want.length > 0);
      assert.notEqual(await b.eval(`document.querySelector('h1').innerText`), 'Overview');
      assert.ok(await b.eval(`document.querySelectorAll('tbody tr:not([hidden])').length > 0`), 'the filter finds the row');
    });

    await step('settings shows storage state and the history form', async () => {
      await b.click('[data-act=tab][data-tab=settings]');
      await wait(`document.querySelector('#set-data .kv')`);
      const text = await b.text('#app');
      assert.match(text, /Encryption/);
      assert.ok(await b.eval(`!!document.querySelector('#rebuild-form')`));
      await shot('settings');
    });

    await step('the chart shows a crosshair tooltip', async () => {
      await b.click('[data-act=tab][data-tab=overview]');
      await wait(`document.querySelector('#ch-trend svg')`);
      await b.eval(`(() => { const s = document.querySelector('#ch-trend svg'), r = s.getBoundingClientRect();
        s.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.6, clientY: r.top + 80, bubbles: true })); return true; })()`);
      assert.ok(await b.eval(`!document.querySelector('.chart-tip').hidden`));
      assert.match(await b.text('.chart-tip'), /\$/);
    });

    await step('the map view draws a tile per holding', async () => {
      await b.click('[data-act=tab][data-tab=us]');
      await b.click('[data-act=view][data-v=map]');
      await wait(`document.querySelectorAll('.tm-tile').length >= 1`);
      await b.click('.tm-tile');
      assert.equal(await b.eval(`document.querySelectorAll('.toolbar ~ .tw tr.trow').length`), 1, 'clicking a tile filters the table to it');
      assert.equal(await b.eval(`document.querySelector('[data-act=view][data-v=table]').getAttribute('aria-pressed')`), 'true');
      await b.type('#q', '');
    });

    await step('the command palette jumps to a holding', async () => {
      await b.click('[data-act=tab][data-tab=overview]');
      await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
      await wait(`document.querySelector('#cmdk[open]')`);
      await b.type('#cmdk-q', 'tcs');
      await wait(`document.querySelector('.cmdk-item')`);
      await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await wait(`document.querySelector('h1').innerText === 'Indian stocks'`);
      assert.equal(await b.eval(`document.getElementById('q').value`), 'TCS');
    });

    await step('deleting can be undone', async () => {
      await b.click('[data-act=tab][data-tab=in]');
      await wait(`document.querySelector('[data-act=del]')`);
      const before = await b.eval(`document.querySelectorAll('tr.trow').length`);
      await b.click('[data-act=del]');
      assert.equal(await b.eval(`document.querySelectorAll('tr.trow').length`), before - 1);
      await b.eval(`document.querySelector('#toasts .btn').click()`);
      assert.equal(await b.eval(`document.querySelectorAll('tr.trow').length`), before);
      await saved(d => d.in.some(h => h.symbol === 'TCS'));
    });

    await step('reduced motion switches animation off', async () => {
      await b.emulate([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      const d = await b.eval(`(() => { const e = document.createElement('div'); e.style.animation = 'pop 5s'; e.style.transition = 'opacity 5s'; document.body.append(e);
        const cs = getComputedStyle(e); const out = [cs.animationDuration, cs.transitionDuration]; e.remove(); return out; })()`);
      assert.ok(d.every(x => parseFloat(x) < 0.01), JSON.stringify(d));
      await b.emulate([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    });

    await step('dark mode renders (contrast is checked separately by tools/contrast.js)', async () => {
      await b.click('[data-act=tab][data-tab=overview]');
      await b.click('[data-act=mode]');
      await sleep(200);
      assert.equal(await b.eval(`document.documentElement.style.colorScheme`), 'dark');
      await shot('overview-dark');
    });

    await step('a new empty server asks before adopting holdings the browser remembers', async () => {
      const fresh = await startServer({ empty: true });
      try {
        const furl = fresh.url, get = async () => (await (await fetch(`http://localhost:${fresh.port}/api/data`)).json());
        await b.goto(furl);
        await b.eval(`localStorage.setItem('networth.v1', JSON.stringify({ us: [{ id: 'x1', broker: 'Etrade', symbol: 'AAPL', qty: 3, avg: 100 }], settings: { base: 'USD' } }))`);
        await b.goto(furl);
        await wait(`document.querySelector('[data-act=orphan-keep]')`);
        await sleep(1000);
        assert.equal((await get()).exists, false, 'nothing is copied into the server unasked');
        await b.click('[data-act=orphan-keep]');
        for (let i = 0; i < 30 && !(await get()).exists; i++) await sleep(150);
        assert.equal((await get()).data.us[0].symbol, 'AAPL');
        assert.equal(await b.eval(`!!document.querySelector('[data-act=orphan-keep]')`), false);
      } finally { fresh.stop(); }
    });

    assert.deepEqual(b.errors, [], 'no console errors');
  } finally {
    if (b) await b.close();
    server.stop();
  }
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
