/* Charts. d3 (vendor/d3.min.js) does the scales, ticks, shapes and treemap layout; this file turns them into markup.
   A chart is mounted into an element after the page is drawn, measures it, and redraws when it is resized. */
(function (G) {
'use strict';
const d3 = G.d3;
const F = () => G.Folio;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const live = new Set();           // observers of the charts on screen
let drawnOnce = false;             // the line draws itself in the first time only
function unmountAll() { live.forEach(ro => ro.disconnect()); live.clear(); }
function observe(el, draw) {
  draw();
  if (typeof ResizeObserver === 'undefined') return;
  let lastW = el.clientWidth, lastH = el.clientHeight;
  const ro = new ResizeObserver(() => {
    if (Math.abs(el.clientWidth - lastW) > 1 || Math.abs(el.clientHeight - lastH) > 1) { lastW = el.clientWidth; lastH = el.clientHeight; draw(); }
  });
  ro.observe(el);
  live.add(ro);
}

/* ---------- area chart with crosshair ---------- */
/* spec: { pts: [{ t: Date, v }], tick(v) -> text, tip(i) -> html, label, height } */
function area(el, spec) {
  const { pts } = spec;
  if (!d3 || pts.length < 2) { el.innerHTML = ''; return; }
  const animate = !drawnOnce;
  drawnOnce = true;
  let idx = null;
  function draw() {
    const w = Math.max(280, el.clientWidth), h = Math.max(spec.height || 260, el.classList.contains('fill') ? el.clientHeight : 0);
    const m = { t: 14, r: 14, b: 26, l: spec.left || 58 };
    const x = d3.scaleTime().domain(d3.extent(pts, d => d.t)).range([m.l, w - m.r]);
    const vals = pts.map(d => d.v);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = Math.max(hi - lo, Math.abs(hi) * 0.02, 1);
    const y = d3.scaleLinear().domain([lo - span * 0.14, hi + span * 0.14]).nice(4).range([h - m.b, m.t]);
    const yt = y.ticks(4);
    const long = (pts[pts.length - 1].t - pts[0].t) > 400 * 864e5;
    const fx = d3.timeFormat(long ? '%b %Y' : '%-d %b');
    const xt = x.ticks(Math.max(2, Math.floor((w - m.l - m.r) / 120)));
    const line = d3.line().x(d => x(d.t)).y(d => y(d.v)).curve(d3.curveMonotoneX);
    const ar = d3.area().x(d => x(d.t)).y0(h - m.b).y1(d => y(d.v)).curve(d3.curveMonotoneX);
    const iHi = vals.indexOf(hi), iLo = vals.indexOf(lo);
    const mark = (i, kind) => {
      const p = pts[i], px = x(p.t), py = y(p.v);
      if (pts.length < 6 || i === pts.length - 1 || (i === 0)) return '';
      const anchor = px < m.l + 60 ? 'start' : px > w - m.r - 60 ? 'end' : 'middle';
      return `<circle class="c-mark" cx="${px}" cy="${py}" r="3"/><text class="c-note num" x="${px}" y="${kind === 'hi' ? py - 9 : py + 17}" text-anchor="${anchor}">${esc(spec.tick(p.v, true))}</text>`;
    };
    const last = pts[pts.length - 1];
    el.innerHTML = `<svg class="chart-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" tabindex="0" aria-label="${esc(spec.label || '')}">
      <defs><linearGradient id="g-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.28"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient></defs>
      ${yt.map(v => `<line class="c-grid" x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="c-tick num" x="${m.l - 10}" y="${y(v) + 4}" text-anchor="end">${esc(spec.tick(v))}</text>`).join('')}
      ${xt.map(t => { const px = x(t); const anchor = px < m.l + 20 ? 'start' : px > w - m.r - 20 ? 'end' : 'middle'; return `<text class="c-tick" x="${px}" y="${h - 6}" text-anchor="${anchor}">${esc(fx(t))}</text>`; }).join('')}
      <path class="c-area" d="${ar(pts)}" fill="url(#g-area)"/>
      <path class="c-line${animate ? ' draw' : ''}" d="${line(pts)}" pathLength="1"/>
      ${mark(iHi, 'hi')}${mark(iLo, 'lo')}
      <circle class="c-end-ring" cx="${x(last.t)}" cy="${y(last.v)}" r="6"/><circle class="c-end" cx="${x(last.t)}" cy="${y(last.v)}" r="3.5"/>
      <g class="c-cross" hidden><line class="c-guide" y1="${m.t}" y2="${h - m.b}"/><circle class="c-ring" r="7"/><circle class="c-dot" r="4"/></g>
      <rect class="c-hit" x="${m.l}" y="0" width="${w - m.l - m.r}" height="${h}" fill="transparent"/>
    </svg><div class="chart-tip" hidden></div>`;
    const svg = el.firstElementChild, tip = el.lastElementChild;
    const cross = svg.querySelector('.c-cross');
    const show = i => {
      idx = i;
      const p = pts[i], px = x(p.t), py = y(p.v);
      cross.hidden = false;
      cross.querySelector('.c-guide').setAttribute('x1', px); cross.querySelector('.c-guide').setAttribute('x2', px);
      cross.querySelectorAll('circle').forEach(c => { c.setAttribute('cx', px); c.setAttribute('cy', py); });
      tip.innerHTML = spec.tip(i);
      tip.hidden = false;
      const tw = tip.offsetWidth || 180;
      tip.style.left = Math.max(4, Math.min(w - tw - 4, px - tw / 2)) + 'px';
      tip.style.top = Math.max(0, py - tip.offsetHeight - 16) + 'px';
    };
    const hide = () => { idx = null; cross.hidden = true; tip.hidden = true; };
    const at = clientX => {
      const r = svg.getBoundingClientRect();
      const t = x.invert(clientX - r.left);
      let i = d3.bisector(d => d.t).center(pts, t);
      return Math.max(0, Math.min(pts.length - 1, i));
    };
    svg.addEventListener('pointermove', e => show(at(e.clientX)));
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      show(Math.max(0, Math.min(pts.length - 1, (idx == null ? pts.length - 1 : idx) + (e.key === 'ArrowLeft' ? -1 : 1))));
    });
    if (idx != null) show(idx);
  }
  observe(el, draw);
}

/* ---------- treemap: size = value, colour = change ---------- */
/* spec: { items: [{ id, label, sub, value, chg }], max (largest |chg| for full colour), tip(item) -> html } */
function treemap(el, spec) {
  if (!d3 || !spec.items.length) { el.innerHTML = ''; return; }
  function draw() {
    const w = Math.max(280, el.clientWidth), h = spec.height || 360;
    const root = d3.hierarchy({ children: spec.items }).sum(d => d.value).sort((a, b) => b.value - a.value);
    d3.treemap().size([w, h]).paddingInner(3).round(true).tile(d3.treemapSquarify.ratio(1.3))(root);
    const max = spec.max || 1;
    el.style.height = h + 'px';
    el.innerHTML = root.leaves().map(l => {
      const d = l.data, tw = l.x1 - l.x0, th = l.y1 - l.y0;
      const k = d.chg == null ? 0 : Math.min(Math.abs(d.chg) / max, 1);
      const tone = d.chg == null || Math.abs(d.chg) < 0.005 ? 'flat' : d.chg > 0 ? 'up' : 'down';
      const bg = tone === 'flat' ? 'var(--surface)' : `color-mix(in srgb, var(--${tone === 'up' ? 'gain' : 'loss'}) ${(12 + 38 * k).toFixed(0)}%, var(--bg))`;
      const big = tw > 92 && th > 54, mid = tw > 54 && th > 34;
      return `<button type="button" class="tm-tile ${tone}" data-id="${esc(d.id)}" data-act="focus" data-q="${esc(d.label)}" style="left:${l.x0}px;top:${l.y0}px;width:${tw}px;height:${th}px;background:${bg}">
        ${mid ? `<b>${esc(d.label)}</b>${big ? `<span class="num">${esc(d.sub || '')}</span>` : ''}` : ''}</button>`;
    }).join('');
    el.querySelectorAll('.tm-tile').forEach(t => {
      const item = spec.items.find(i => String(i.id) === t.dataset.id);
      const tip = document.getElementById('tip');
      t.addEventListener('pointermove', e => {
        tip.hidden = false; tip.innerHTML = spec.tip(item);
        tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 220) + 'px';
        tip.style.top = Math.min(e.clientY + 14, window.innerHeight - 100) + 'px';
      });
      t.addEventListener('pointerleave', () => { tip.hidden = true; });
    });
  }
  observe(el, draw);
}

/* ---------- small things drawn as plain markup ---------- */
function spark(values, opt = {}) {
  const v = values.filter(x => Number.isFinite(x));
  if (v.length < 2) return '';
  const w = opt.w || 88, h = opt.h || 30, pad = 3;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((val, i) => [pad + i / (v.length - 1) * (w - pad * 2), h - pad - (val - lo) / span * (h - pad * 2)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const tone = opt.tone || (v[v.length - 1] >= v[0] ? 'up' : 'down');
  const [ex, ey] = pts[pts.length - 1];
  return `<svg class="spark ${tone}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}"/><circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="2.4"/></svg>`;
}

/* a 100% bar in segments with a 2px gap: [{ name, value, color }] */
function stack(parts) {
  const total = parts.reduce((a, p) => a + Math.max(p.value, 0), 0);
  if (total <= 0) return '';
  return `<div class="stack" role="img" aria-label="${esc(parts.map(p => `${p.name} ${(p.value / total * 100).toFixed(0)}%`).join(', '))}">${parts.filter(p => p.value > 0).map(p =>
    `<i style="flex:${p.value};background:${p.color}" title="${esc(p.name)} ${(p.value / total * 100).toFixed(1)}%"></i>`).join('')}</div>`;
}

/* Rows of bars that leave from a centre line: gains to the right, losses to the left. rows: [{ label, value, text, tip, strong }] */
function diverging(rows) {
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 1e-9);
  return `<div class="div-bars">${rows.map(r => {
    const w = Math.max(Math.abs(r.value) / max * 50, Math.abs(r.value) > 0 ? 1.5 : 0);
    const tone = r.value > 0 ? 'up' : r.value < 0 ? 'down' : 'flat';
    return `<div class="div-row${r.strong ? ' strong' : ''}" title="${esc(r.tip || '')}"><span class="div-l">${esc(r.label)}</span>
      <span class="div-track"><i class="${tone}" style="${r.value >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></i></span>
      <b class="div-v num sens ${tone}">${r.text}</b></div>`;
  }).join('')}</div>`;
}

G.Folio = Object.assign(G.Folio || {}, { Charts: { area, treemap, spark, stack, diverging, unmountAll } });
})(typeof window !== 'undefined' ? window : globalThis);
