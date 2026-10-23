#!/bin/bash
# Runs every test: Python (storage, history, quotes, server), JavaScript (CSV, valuation, formatting, contrast)
# and the browser end-to-end run. Usage: tests/run.sh [--no-browser]
set -e
cd "$(dirname "$0")/.."
echo "== Python"; python3 -W error::ResourceWarning -m unittest discover -s tests
echo "== JavaScript"; node --test tests/js/
if [ "$1" != "--no-browser" ]; then echo "== Browser"; node tests/e2e.js; fi
