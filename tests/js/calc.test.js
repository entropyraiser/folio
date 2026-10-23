const test = require('node:test');
const assert = require('node:assert/strict');
require('../../web/js/format.js');
require('../../web/js/calc.js');
const F = globalThis.Folio;

const base = () => ({
  settings: { base: 'INR', fxManual: null, fxManualAt: 0, thbManual: null, thbManualAt: 0, aedManual: null, aedManualAt: 0 },
  us: [{ id: 'u', broker: 'IBKR', symbol: 'AAPL', qty: 10, avg: 100, manualPrice: 90, manualAt: 1000 }],
  in: [{ id: 'i', broker: 'Z', symbol: 'TCS', exchange: 'NSE', qty: 2, avg: 3000 }],
  bcash: [], bank: [{ id: 'b', bank: 'H', currency: 'INR', balance: 5000 }], hand: [], pf: [], other: [],
  cache: { quotes: {} }
});

test('symbols follow Yahoo conventions', () => {
  assert.equal(F.ySym('in', { symbol: 'tcs' }), 'TCS.NS');
  assert.equal(F.ySym('in', { symbol: 'TCS', exchange: 'BSE' }), 'TCS.BO');
  assert.equal(F.ySym('us', { symbol: 'brk-b' }), 'BRK-B');
});

test('live price wins, with its source and day change', () => {
  const live = { AAPL: { price: 120, prev: 110, source: 'yahoo', time: 5 }, 'USDINR=X': { price: 80 } };
  const c = F.compute(base(), live);
  const aapl = c.cats.us.items[0];
  assert.equal(aapl.src, 'live');
  assert.equal(aapl.value, 1200);
  assert.equal(aapl.pnl, 200);
  assert.equal(aapl.day, 100);
  assert.equal(c.fx.rate, 80);
  assert.equal(c.net, 1200 * 80 + 0 + 2 * 3000 + 5000);        // TCS has no quote: cost; AAPL in rupees
});

test('a stale server copy is shown as last known, never as live', () => {
  const live = { AAPL: { price: 120, prev: 110, stale: true, source: 'cache', asOf: 1700000000 }, 'USDINR=X': { price: 80 } };
  const aapl = F.compute(base(), live).cats.us.items[0];
  assert.equal(aapl.src, 'last');
  assert.equal(aapl.day, null);
  assert.ok(aapl.priceAt > 0);
});

test('without any quote the newest of fallback and last known is used, then cost', () => {
  const S = base();
  assert.equal(F.compute(S, {}).cats.us.items[0].src, 'manual');
  S.cache.quotes.AAPL = { price: 95, at: 2000 };
  const a = F.compute(S, {}).cats.us.items[0];
  assert.deepEqual([a.src, a.price], ['last', 95]);
  delete S.us[0].manualPrice;
  S.cache.quotes = {};
  const c = F.compute(S, {}).cats.us.items[0];
  assert.deepEqual([c.src, c.value, c.pnl], ['cost', 1000, 0]);
});

test('display currency converts through USD', () => {
  const S = base();
  S.settings.base = 'USD';
  const c = F.compute(S, { 'USDINR=X': { price: 80 }, AAPL: { price: 100, prev: 100 } });
  assert.equal(c.cats.bank.total, 5000 / 80);
});

test('which symbols to ask for', () => {
  const S = base();
  S.bcash.push({ id: 'c', broker: 'X', currency: 'THB', balance: 1 });
  assert.deepEqual(F.allSymbols(S).sort(), ['AAPL', 'TCS.NS', 'USDINR=X', 'USDTHB=X']);
});
