/* A real server on a throw-away database, seeded with a small portfolio, twelve days of history and one pending split. */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');

function seed(dir) {
  const py = `
import os, sys, json, datetime
sys.path.insert(0, ${JSON.stringify(ROOT)}); sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tests'))})
from store import Store
from helpers import sample_portfolio
st = Store(os.path.join(${JSON.stringify(dir)}, 'folio.db'))
pf = sample_portfolio()
pf['us'][0].update(manualPrice=160, manualAt=1700000000000)
pf['us'].append({'id': 'u2', 'broker': 'Etrade', 'symbol': 'MSFT', 'qty': 2, 'avg': 300.0})
pf['settings'].update(base='USD', mode='light')
st.write_portfolio(pf, 0)
today = datetime.date.today()
recs = []
for n in range(12, 0, -1):
    d = (today - datetime.timedelta(days=n)).isoformat()
    price = 150 + (12 - n) * 2
    items = [{'k': 'us', 'id': 'u1', 'cur': 'USD', 'value': 10 * price, 'inr': 10 * price * 80, 'sym': 'AAPL', 'qty': 10, 'price': price},
             {'k': 'bank', 'id': 'b1', 'cur': 'INR', 'value': 100000, 'inr': 100000}]
    recs.append({'date': d, 'net': 10 * price * 80 + 100000, 'cats': {}, 'fx': {'USDINR': 80.0}, 'final': True, 'filled': False,
                 'missing': ['AAPL'] if n == 5 else [], 'items': items, 'holdings': {}, 'at': 0})
st.history_put(recs)
st.splits_note('AAPL', (today - datetime.timedelta(days=3)).isoformat(), 4.0)
`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('seed failed: ' + r.stderr);
}

async function startServer() {
  const port = 8800 + Math.floor(Math.random() * 90);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-e2e-'));
  seed(dir);
  const proc = spawn('python3', [path.join(ROOT, 'server.py')], { env: { ...process.env, PORT: String(port), DB_FILE: path.join(dir, 'folio.db'), LOG_DIR: path.join(dir, 'logs') }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch (e) {} await sleep(200); }
  return { port, dir, url: `http://localhost:${port}/`, stop() { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
module.exports = { startServer, ROOT };
