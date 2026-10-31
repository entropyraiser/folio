# Folio

Local net-worth tracker: stdlib-only Python server (`server.py`) + plain-JS dashboard in `web/` (no build step). Data in encrypted-optional SQLite `folio.db`. See README.md for features/layout.

## Live service: do not disturb
The real app runs under launchd (`com.networth.tracker`, KeepAlive) on :8787 against the real `folio.db`.
- Never `pkill`/kill by name. Restart only on request: `launchctl kickstart -k gui/$(id -u)/com.networth.tracker`
- Test on a scratch copy: `DB_FILE=/path/scratch.db PORT=8799 LOG_DIR=/path/logs python3 server.py`; stop it by PID (`lsof -tiTCP:8799`).
- Never run `folio.py encrypt`/`decrypt`/`restore` on the real DB unless asked (Keychain item; data unreadable without the key).
- `folio.db`, `data-backups/`, `logs/` hold personal financial data: never commit, print or paste them.

## Commands
- All tests: `tests/run.sh` (add `--no-browser` to skip headless-Chrome e2e)
- Python only: `python3 -W error::ResourceWarning -m unittest discover -s tests`
- JS only: `node --test tests/js/`; colour contrast: `node tools/contrast.js`
- Screenshots of every page: `node tests/shots.js OUTDIR`

## Gotchas
- `.py` edits need a server restart; `web/` edits only need a refresh.
- No third-party Python packages and nothing loads from another site (assets are vendored in `web/vendor`). Keep it that way.
- Run `tests/run.sh` against a throwaway DB only. The e2e already does this; don't point it at the real one.
