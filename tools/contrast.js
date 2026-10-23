#!/usr/bin/env node
/* Checks the colour pairs the dashboard actually uses, in every mode and palette, against WCAG 2.2:
   text needs 4.5:1, chart colours and control borders need 3:1.
   Usage: node tools/contrast.js           (prints failures, exits 1 if there are any)
          node tools/contrast.js --all     (prints every pair) */
require('../web/js/palettes.js');
const { BASE, PALETTES } = globalThis.Folio;

const hex = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = rgb => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, pctA) => a.map((v, i) => Math.round(v * pctA + b[i] * (1 - pctA)));

function check() {
  const rows = [];
  for (const mode of Object.keys(PALETTES)) {
    for (const [pid, pal] of Object.entries(PALETTES[mode])) {
      const t = { ...BASE[mode], ...pal };
      const c = k => hex(t[k]);
      const hover = mix(c('--accent'), c('--surface'), 0.08);
      const text = (name, fg, bg, min = 4.5) => rows.push({ mode, pid, name, min, value: ratio(fg, bg) });
      for (const [bgName, bg] of [['canvas', c('--canvas')], ['bg', c('--bg')], ['surface', c('--surface')], ['hover row', hover]]) {
        text(`text on ${bgName}`, c('--text'), bg);
        text(`muted on ${bgName}`, c('--muted'), bg);
      }
      for (const k of ['--gain', '--loss', '--warn', '--accent']) {
        text(`${k.slice(2)} text on bg`, c(k), c('--bg'));
        text(`${k.slice(2)} text on surface`, c(k), c('--surface'));
      }
      text('button text on accent', c('--accent-ink'), c('--accent'));
      text('hero card muted text on accent', mix(c('--accent-ink'), c('--accent'), 0.86), c('--accent'));
      text('hero chip text on chip', c('--accent-ink'), mix(c('--accent-ink'), c('--accent'), 0.10));
      text('selected nav text on accent', c('--accent-ink'), c('--accent'));
      for (const k of ['--c-us', '--c-in', '--c-bcash', '--c-bank', '--c-pf', '--c-other', '--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8']) {
        text(`chart ${k.slice(2)} on surface`, c(k), c('--surface'), 3);
        text(`chart ${k.slice(2)} on card`, c(k), c('--bg'), 3);
      }
      for (const tone of ['--gain', '--loss']) text(`text on ${tone.slice(2)} treemap tile`, c('--text'), mix(c(tone), c('--bg'), 0.5));
      text('chart line (accent) on surface', c('--accent'), c('--surface'), 3);
      text('control border on bg', c('--edge'), c('--bg'), 3);
      text('control border on surface', c('--edge'), c('--surface'), 3);
      text('focus ring on bg', c('--focus'), c('--bg'), 3);
    }
  }
  return rows;
}

if (require.main === module) {
  const rows = check();
  const bad = rows.filter(r => r.value < r.min);
  for (const r of process.argv.includes('--all') ? rows : bad) {
    console.log(`${r.value < r.min ? 'FAIL' : 'ok  '} ${r.mode.padEnd(5)} ${r.pid.padEnd(7)} ${r.name.padEnd(34)} ${r.value.toFixed(2)} (needs ${r.min})`);
  }
  console.log(`${rows.length - bad.length}/${rows.length} pairs pass`);
  process.exit(bad.length ? 1 : 0);
}
module.exports = { check, ratio, hex };
