const test = require('node:test');
const assert = require('node:assert/strict');
const { check, ratio, hex } = require('../../tools/contrast.js');

test('the contrast formula matches known values', () => {
  assert.equal(ratio(hex('#000000'), hex('#ffffff')).toFixed(1), '21.0');
  assert.equal(ratio(hex('#777777'), hex('#ffffff')).toFixed(2), '4.48');
});

test('every colour pair the dashboard uses is readable in every mode and palette', () => {
  const bad = check().filter(r => r.value < r.min).map(r => `${r.mode}/${r.pid}: ${r.name} ${r.value.toFixed(2)} < ${r.min}`);
  assert.deepEqual(bad, []);
});
