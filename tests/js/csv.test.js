const test = require('node:test');
const assert = require('node:assert/strict');
require('../../web/js/csv.js');
const F = globalThis.Folio;

const run = (text, opts = {}) => {
  const rows = F.parseCSV(text), det = F.detectCSV(rows);
  return det && F.csvToHoldings(rows, { ...det, broker: 'Test', defaultKind: 'us', ...opts });
};

test('parses quoted cells, doubled quotes, semicolons, BOM and CRLF', () => {
  assert.deepEqual(F.parseCSV('﻿a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(F.parseCSV('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

test('numbers with symbols, separators and brackets', () => {
  assert.equal(F.parseNum('$1,234.50'), 1234.5);
  assert.equal(F.parseNum('₹12,34,567.8'), 1234567.8);
  assert.equal(F.parseNum('(25)'), -25);
  assert.equal(F.parseNum('−3'), -3);
  assert.equal(F.parseNum('--'), null);
  assert.equal(F.parseNum(''), null);
});

test('finds the header below account information', () => {
  const r = run('Account,U123\nGenerated,today\n\nSymbol,Quantity,Cost Price,Currency\nAAPL,10,170,USD');
  assert.equal(r.items.length, 1);
  assert.deepEqual([r.items[0].symbol, r.items[0].qty, r.items[0].avg, r.items[0].kind], ['AAPL', 10, 170, 'us']);
});

test('Zerodha holdings: Indian stocks, average from "Avg. cost"', () => {
  const r = run('Instrument,Qty.,Avg. cost,LTP,Cur. val\nRELIANCE,5,2400.50,2500,12500\nINFY,10,1500,1600,16000\nTotal,,,,28500', { defaultKind: 'in' });
  assert.deepEqual(r.items.map(i => [i.symbol, i.qty, i.avg, i.kind, i.exchange]), [['RELIANCE', 5, 2400.5, 'in', 'NSE'], ['INFY', 10, 1500, 'in', 'NSE']]);
  assert.equal(r.skipped[0].reason, 'a total row');
});

test('E*Trade style headers', () => {
  const r = run('Symbol,Qty #,Price Paid $,Value $\nMSFT,3,"1,410.00",1\n');
  assert.equal(r.items[0].avg, 1410);
});

test('average comes from total cost when there is no average column', () => {
  const r = run('Ticker,Shares,Cost Basis\nNVDA,4,800');
  assert.equal(r.items[0].avg, 200);
});

test('symbol clean-up: BRK B, .NS, exchange prefix, .US', () => {
  const r = run('Symbol,Quantity,Average Cost\nBRK B,1,400\nTCS.NS,2,3000\nBSE:SBIN,3,600\nAAPL.US,1,10');
  assert.deepEqual(r.items.map(i => [i.symbol, i.kind, i.exchange || null]), [['BRK-B', 'us', null], ['TCS', 'in', 'NSE'], ['SBIN', 'in', 'BSE'], ['AAPL', 'us', null]]);
});

test('currency and exchange columns pick the market; unsupported currencies are skipped', () => {
  const r = run('Symbol,Quantity,Cost Price,Currency,Exchange\nAAPL,1,1,USD,NASDAQ\nHDFCBANK,2,1,INR,NSE\nVOD,3,1,GBP,LSE');
  assert.deepEqual(r.items.map(i => i.kind), ['us', 'in']);
  assert.match(r.skipped[0].reason, /GBP/);
});

test('shorts, zero and unreadable rows are skipped with a reason', () => {
  const r = run('Symbol,Quantity,Cost Price\nA,-5,1\nB,0,1\nC,abc,1\n"D E F G",1,1\nOK,1,1');
  assert.deepEqual(r.items.map(i => i.symbol), ['OK']);
  assert.deepEqual(r.skipped.map(s => s.reason), ['a short position', 'zero quantity', 'no quantity', 'not a ticker']);
});

test('separate lots of one symbol become one holding with the weighted average', () => {
  const r = run('Symbol,Quantity,Cost Price\nAAPL,10,100\nAAPL,30,200');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].qty, 40);
  assert.equal(r.items[0].avg, 175);
});

test('a file without symbol and quantity columns is not guessed at', () => {
  assert.equal(F.detectCSV(F.parseCSV('Name,Amount\nRent,100')), null);
});

test('import: add combines with an existing holding; replace clears that broker first', () => {
  const S = { us: [{ id: 'a', broker: 'IBKR', symbol: 'AAPL', qty: 10, avg: 100 }, { id: 'b', broker: 'Other', symbol: 'AAPL', qty: 1, avg: 1 }], in: [] };
  const items = [{ kind: 'us', symbol: 'AAPL', qty: 10, avg: 200, broker: 'IBKR' }, { kind: 'us', symbol: 'MSFT', qty: 1, avg: 5, broker: 'IBKR' }];
  let n = 0;
  const added = F.applyImport(JSON.parse(JSON.stringify(S)), items, 'add', () => 'n' + n++);
  assert.deepEqual(added, { added: 1, merged: 1, removed: 0 });
  const T = JSON.parse(JSON.stringify(S));
  const replaced = F.applyImport(T, items, 'replace', () => 'n' + n++);
  assert.deepEqual(replaced, { added: 2, merged: 0, removed: 1 });
  assert.deepEqual(T.us.map(h => h.broker + h.symbol).sort(), ['IBKRAAPL', 'IBKRMSFT', 'OtherAAPL']);
  const merged = JSON.parse(JSON.stringify(S));
  F.applyImport(merged, items, 'add', () => 'x');
  assert.equal(merged.us[0].qty, 20);
  assert.equal(merged.us[0].avg, 150);
});
