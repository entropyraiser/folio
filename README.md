# Net worth tracker

![Overview of holdings, allocation, and today's moves](screenshot.png)

1. Install Python 3.8+ (no other packages needed).
2. In this folder run: `python3 server.py`
3. Open http://localhost:8787

The server fetches live prices each time you load or refresh the page, keeps your holdings and a daily net worth record in one database file (`folio.db`), and serves the dashboard from `web/`.

Symbols: US stocks use the plain ticker (AAPL). Indian stocks use the plain symbol plus NSE or BSE (RELIANCE). Crypto and other assets can use any Yahoo symbol, e.g. BTC-USD. When you add a holding the form searches as you type and checks the symbol against the price source before you save.

## What you see
- **Overview**: net worth as the headline, with today's move and the change over the last week, month and year to date; stocks, cash, PF and unrealized P&L beside it, each with a sparkline. Below: an interactive chart (hover or use the arrow keys for the value on any day), allocation with concentration, what moved net worth (markets, currency, or money you added or withdrew) and the change over each period, your largest holdings or today's gainers and losers, institutions, and the state of your rates, snapshots and backups. Alerts appear on top when something needs attention: prices that are not live, a stock split, days valued with estimated prices.
- **Stock pages**: a summary strip, then a table you can filter (search and broker chips), sort, group by broker, or switch to a **map** where size is value and colour is today's move or your profit. Row actions: buy more, sell, edit, delete (deleting can be undone). **Sell** and **Buy** update quantity and average cost, record the realized profit under *Sales*, and can move the cash. **Import CSV** reads a holdings export from your broker (Interactive Brokers, Zerodha, E*Trade and anything with Symbol and Quantity columns), shows a preview, then adds or replaces.
- **Prices**: Yahoo Finance first. If that fails, Yahoo's lighter feed, then Alpha Vantage if you paste a free key in Settings, or save it in `alpha_vantage_api_key.txt` next to `server.py` (25 lookups a day; it is only a backup). If every source fails you see the last good price, marked *last known* with its age.
- **Splits**: when a stock you hold splits, the dashboard offers to adjust quantity and average cost. Until you apply it, the chart already values past days correctly.
- **Keyboard**: <kbd>⌘K</kbd> (or <kbd>Ctrl K</kbd>) opens search: jump to a page, a holding, or run an action. <kbd>/</kbd> focuses the filter on a stock page.

If prices can't be fetched (for example right after the Mac wakes, before the network is back), the page retries on its own after 10 seconds, backing off to every 2 minutes, and refreshes when you come back to a tab that has been idle for 5 minutes.

## Net worth history
While the server runs, it records your net worth once a day. The laptop does not need to be on every day. Each day is valued at that day's closing prices, so days the Mac was closed or asleep are filled in the next time the server runs, using the holdings you had then. A day stays provisional until noon the next day, when every market has closed for it. Bank, PF and other manual balances stay at their last value across a gap.

If a day was valued with an estimated price, or you fixed a wrong quantity, value the days again: *Recompute* on the chart, Settings > Daily history, or `python3 folio.py rebuild-history --from 2026-10-01 [--current-holdings]`.

## Where your data lives
Everything is in `folio.db` next to `server.py` (change with `DB_FILE=/path/folio.db`): holdings, every saved version of them (last 30), the daily history, the last good prices and pending splits. A browser that is behind another save is asked to reload instead of overwriting it.

- **Backups**: the first write each day copies the database to `data-backups/folio-YYYY-MM-DD.db` (last 30 kept). The server opens the newest one at every start and logs whether it is readable.
- **Move to another machine**: in Settings → Your data, **Download full backup** saves one `.db` file with everything above, and **Restore from backup…** on the other machine's dashboard loads it (it shows what is in the file first, and keeps what you had as a backup). If encryption is on, also keep the recovery key.
- **Check and restore** (`python3 folio.py --help` lists everything):
  - `python3 folio.py status` shows what is stored.
  - `python3 folio.py verify` opens every backup, decrypts it and checks it, so you know a restore would work.
  - `python3 folio.py restore data-backups/folio-2026-10-20.db` replaces everything with a backup. Stop the server first. What you had is kept as `folio-before-restore-*.db`.
  - `python3 folio.py restore-version 120` puts back an earlier saved version of just the holdings.
  - `python3 folio.py restore-json data-2026-10-20.json` restores holdings from a backup made by version 1.
- **Encryption** (optional, macOS): `python3 folio.py encrypt` encrypts the holdings and history inside `folio.db` with a random key kept in your login Keychain, so the folder alone (copied, synced, backed up) can't be read. It prints a recovery key once; keep it in a password manager, because without the key the data cannot be opened. Backups made while encrypted are encrypted too; plain backups made earlier are not, so delete them once you are happy. `python3 folio.py decrypt` reverses it. The server needs the Keychain unlocked at start; if it is not, it logs why and launchd tries again.
- **Moving from version 1**: on first start the server imports `data.json` and `history.jsonl` into `folio.db` and leaves them where they are. They are no longer updated; keep them as an old backup or delete them. To move to a new computer, copy `folio.db`. It contains your financial details, so keep the folder private.
- If you open the dashboard without the server, data is kept in that browser only.

## Keep it running on a Mac
Run `./install-mac.sh` once. It starts at every login and restarts if it crashes.
Remove it with `./uninstall-mac.sh`. Logs are in `logs/server.log` (rotated at 1 MB, 3 old files kept). If the server itself crashes, the traceback is in `logs/launchd.log`.
Tip: keep this folder somewhere like ~/networth-tracker rather than Desktop, Documents or Downloads, which macOS can restrict for background jobs.

Edits to files in `web/` take effect on refresh. After editing a `.py` file, restart the server:
`launchctl kickstart -k gui/$(id -u)/com.networth.tracker`

## Layout
- `server.py` web server and API, `quotes.py` price sources, `history.py` daily records, splits and what-moved-it, `store.py` database, backups and restore, `crypto.py` encryption, `folio.py` maintenance commands.
- `web/` the dashboard, plain scripts with no build step: `style.css` (design tokens, layout, components); `js/` with `palettes.js` (colours), `format.js`, `calc.js` (valuation), `csv.js`, `icons.js`, `charts.js` (d3 charts), `views-*.js` (one function per page), `app.js` (state, loading, forms, events). Open-source pieces (d3, Lucide icons, Geist fonts) are in `vendor/`, `js/icons.js` and `fonts/`, listed in `web/THIRD_PARTY.md`; nothing loads from another site.
- `tests/shots.js OUTDIR` saves a screenshot of every page in light and dark, for looking at the design.
- `tools/contrast.js` checks that every text, chart and control colour is readable in every theme (`node tools/contrast.js`).

## Tests
`tests/run.sh` runs everything: Python unit tests (storage, backups and restore, encryption, history, quotes, server security), JavaScript tests (CSV import, valuation, formatting, colour contrast) and an end-to-end run in headless Chrome against a throw-away database. `tests/run.sh --no-browser` skips the last part.
