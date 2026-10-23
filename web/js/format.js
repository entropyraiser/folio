/* Escaping, money and number formatting, and the currencies beyond USD and INR. */
(function (G) {
'use strict';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const FX_EXTRA = {
  THB: { sym: 'USDTHB=X', manual: 'thbManual', at: 'thbManualAt', fallback: 33, locale: 'th-TH', sign: '฿',
    set: 'thb', field: 's-thb', label: 'Fallback USD/THB rate', ph: 'e.g. 32.50',
    hint: 'Baht per US dollar. Used for THB cash when the live rate can\'t be fetched.' },
  AED: { sym: 'USDAED=X', manual: 'aedManual', at: 'aedManualAt', fallback: 3.67, locale: 'en-AE', sign: 'AED ',
    set: 'aed', field: 's-aed', label: 'Fallback USD/AED rate', ph: 'e.g. 3.67',
    hint: 'Dirhams per US dollar. Used for AED cash when the live rate can\'t be fetched.' }
};
const money = (v, cur, dec = 0) => new Intl.NumberFormat((FX_EXTRA[cur] && FX_EXTRA[cur].locale) || (cur === 'INR' ? 'en-IN' : 'en-US'),
  { style: 'currency', currency: cur, minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
const M = (v, cur, dec = 0) => `<span class="num">${money(v, cur, dec)}</span>`;
const Sg = (v, cur, dec = 0) => `<span class="num">${v >= 0 ? '+' : '−'}${money(Math.abs(v), cur, dec)}</span>`;
const pct = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
const cls = v => v > 0.0000001 ? 'gain' : v < -0.0000001 ? 'loss' : '';
const qty = v => {
  const n = Number(v) || 0;
  const max = Math.abs(n) >= 10 ? 2 : 4;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: max }).format(n);
};
function compact(v, cur) {
  if (cur === 'INR') {
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} L`;
    return money(v, 'INR');
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(v);
}
function groupBy(items, key) {
  const m = [];
  const ix = new Map();
  for (const h of items) {
    const name = (h[key] || '').trim() || 'Unnamed';
    if (!ix.has(name)) { ix.set(name, m.length); m.push([name, []]); }
    m[ix.get(name)][1].push(h);
  }
  m.sort((a, b) => b[1].reduce((s, h) => s + h.valueBase, 0) - a[1].reduce((s, h) => s + h.valueBase, 0));
  return m;
}
G.Folio = Object.assign(G.Folio || {}, { esc, uid, FX_EXTRA, money, M, Sg, pct, cls, qty, compact, groupBy });
if (typeof module !== 'undefined') module.exports = G.Folio;
})(typeof window !== 'undefined' ? window : globalThis);
