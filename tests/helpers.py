import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

KEY = bytes(range(32))


def sample_portfolio():
    return {
        "settings": {"base": "INR", "alphaKey": ""},
        "us": [{"id": "u1", "broker": "IBKR", "symbol": "AAPL", "qty": 10, "avg": 150.0, "manualPrice": None, "manualAt": 0}],
        "in": [{"id": "i1", "broker": "Zerodha", "symbol": "RELIANCE", "exchange": "NSE", "qty": 5, "avg": 2400.0}],
        "bcash": [{"id": "c1", "broker": "IBKR", "currency": "USD", "balance": 1000}],
        "bank": [{"id": "b1", "bank": "HDFC", "account": "Savings", "currency": "INR", "balance": 100000}],
        "hand": [], "pf": [{"id": "p1", "label": "EPF", "balance": 500000, "log": []}], "other": [], "trades": [],
    }


def tmpdir():
    return tempfile.TemporaryDirectory(prefix="folio-test-")
