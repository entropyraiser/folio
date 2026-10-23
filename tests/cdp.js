/* A tiny Chrome DevTools driver for the end-to-end test: no packages, Node 22+ (global WebSocket and fetch). */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch({ width = 1400, height = 1000, port = 9333 + Math.floor(Math.random() * 500) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${dir}`,
    `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some(t => t.type === 'page')) break; } catch (e) {}
    await sleep(250);
  }
  const page = targets && targets.find(t => t.type === 'page');
  if (!page) { proc.kill(); throw new Error('Chrome did not start'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  const api = {
    errors,
    async goto(url) { await send('Page.navigate', { url }); await sleep(300); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text) + '\n' + expr);
      return r.result.value;
    },
    async waitFor(expr, ms = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { try { if (await api.eval(expr)) return true; } catch (e) {} await sleep(100); }
      throw new Error('timed out waiting for: ' + expr);
    },
    click: sel => api.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); e.click(); return true; })()`),
    async type(sel, text) {
      await api.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    },
    text: sel => api.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`),
    async screenshot(file, fullHeight) {
      const opts = { format: 'png' };
      if (fullHeight) { const w = await api.eval('document.documentElement.clientWidth'); opts.clip = { x: 0, y: 0, width: w, height: fullHeight, scale: 1 }; opts.captureBeyondViewport = true; }
      const r = await send('Page.captureScreenshot', opts); fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    async emulate(features) { await send('Emulation.setEmulatedMedia', { features }); },
    async close() { try { ws.close(); } catch (e) {} proc.kill(); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); }
  };
  return api;
}
module.exports = { launch, sleep };
