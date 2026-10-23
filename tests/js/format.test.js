const test = require('node:test');
const assert = require('node:assert/strict');
require('../../web/js/format.js');
const F = globalThis.Folio;

test('escaping', () => assert.equal(F.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'));
test('rupees use lakh grouping and compact lakh/crore', () => {
  assert.equal(F.money(1234567, 'INR'), '₹12,34,567');
  assert.equal(F.compact(12500000, 'INR'), '₹1.25 Cr');
  assert.equal(F.compact(250000, 'INR'), '₹2.50 L');
});
test('signed values use a real minus', () => {
  assert.match(F.pct(-1.5), /^−1\.50%$/);
  assert.match(F.Sg(-5, 'USD'), /−\$5/);
  assert.equal(F.cls(1), 'gain');
  assert.equal(F.cls(-1), 'loss');
  assert.equal(F.cls(0), '');
});
