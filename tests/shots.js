#!/usr/bin/env node
/* Screenshots of every page in light and dark, for looking at the design. Usage: node tests/shots.js OUTDIR [width] */
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./cdp.js');
const { startServer } = require('./harness.js');

(async () => {
  const out = process.argv[2] || '.';
  const width = +process.argv[3] || 1360;
  fs.mkdirSync(out, { recursive: true });
  const server = await startServer();
  const b = await launch({ width, height: 1000 });
  try {
    await b.goto(server.url);
    await b.waitFor(`document.querySelector('.hero-num')`);
    await sleep(2500);
    for (const mode of ['light', 'dark']) {
      await b.eval(`document.querySelector('[data-act=mode-set][data-m=${mode}]') || true`);
      for (const tab of ['overview', 'us', 'cash', 'pf', 'other', 'settings']) {
        await b.eval(`(() => { document.querySelector('[data-act=tab][data-tab=${tab}]').click(); return true; })()`);
        await sleep(900);
        const h = await b.eval('Math.min(2400, document.documentElement.scrollHeight)');
        await b.screenshot(path.join(out, `${tab}-${mode}.png`), h);
      }
      await b.eval(`document.querySelector('[data-act=tab][data-tab=us]').click()`);
      await sleep(300);
      await b.eval(`document.querySelector('[data-act=view][data-v=map]').click()`);
      await sleep(900);
      await b.screenshot(path.join(out, `map-${mode}.png`));
      await b.eval(`document.querySelector('[data-act=view][data-v=table]').click()`);
      await b.eval(`document.querySelector('[data-act=mode]').click()`);
      await sleep(400);
    }
    if (b.errors.length) console.log('console errors:', b.errors);
  } finally { await b.close(); server.stop(); }
})().catch(e => { console.error(e); process.exit(1); });
