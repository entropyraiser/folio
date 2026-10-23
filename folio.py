#!/usr/bin/env python3
"""
Maintenance for the net worth tracker's database.

  python3 folio.py status                 what is stored, whether it is encrypted, the backups
  python3 folio.py backup [FILE]          copy the database (default: data-backups/folio-manual-<time>.db)
  python3 folio.py verify [FILE ...]      check backups open and decrypt (default: every backup)
  python3 folio.py restore FILE           replace everything with a backup (the current state is kept first)
  python3 folio.py restore-version REV    put back an earlier saved version of the holdings
  python3 folio.py restore-json FILE      put back holdings from an old data.json backup
  python3 folio.py encrypt                encrypt the stored data with a key kept in the macOS Keychain
  python3 folio.py decrypt                store the data unencrypted again
  python3 folio.py rebuild-history --from YYYY-MM-DD [--to YYYY-MM-DD] [--current-holdings]
                                          value those days again from closing prices

Stop the server before restore; the others are safe while it runs.
Use DB_FILE=... to point at another database.
"""
import argparse
import datetime
import glob
import json
import os
import sys

import crypto
import quotes
from history import History
from store import StoreError, open_default, verify_db

HERE = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.environ.get("DB_FILE", os.path.join(HERE, "folio.db"))


def open_store():
    return open_default(DB_FILE, log=print)


def cmd_status(args):
    st = open_store()
    pf, rev = st.read_portfolio()
    holdings = sum(len((pf or {}).get(k) or []) for k in ("us", "in", "bcash", "bank", "hand", "pf", "other"))
    print(f"Database   {st.path} ({os.path.getsize(st.path):,} bytes)")
    print(f"Encrypted  {'yes, key in the macOS Keychain' if st.encrypted() else 'no'}")
    print(f"Holdings   {holdings} (revision {rev}), {len(st.versions())} saved versions")
    print(f"History    {len(st.history_all())} day(s)")
    names = sorted(glob.glob(os.path.join(st.backup_dir, "folio-*.db")))
    print(f"Backups    {len(names)} in {st.backup_dir}" + (f", newest {os.path.basename(names[-1])}" if names else ""))
    pending = st.splits_list("pending")
    for s in pending:
        print(f"Split      {s['sym']} {s['ratio']:g}-for-1 on {s['date']} is waiting to be applied in the app")


def cmd_backup(args):
    st = open_store()
    dest = args.file or os.path.join(st.backup_dir, f"folio-manual-{datetime.datetime.now():%Y%m%dT%H%M%S}.db")
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    st.backup_to(dest)
    rep = verify_db(dest)
    print(f"Wrote {dest}")
    print("Verified." if rep["ok"] else "PROBLEM: " + "; ".join(rep["problems"]))
    return 0 if rep["ok"] else 1


def cmd_verify(args):
    st = open_store()
    files = args.files or sorted(glob.glob(os.path.join(st.backup_dir, "folio-*.db")))
    if not files:
        print("No backups to check.")
        return 1
    bad = 0
    for path in files:
        rep = verify_db(path)
        if rep["ok"]:
            print(f"ok   {os.path.basename(path)}  rev {rep['rev']}, {rep['holdings']} holdings, {rep['history_days']} history days")
        else:
            bad += 1
            print(f"FAIL {os.path.basename(path)}  {'; '.join(rep['problems'])}")
    return 1 if bad else 0


def cmd_restore(args):
    st = open_store()
    rep = verify_db(args.file)
    if not rep["ok"]:
        print("That file is not a usable backup: " + "; ".join(rep["problems"]))
        return 1
    print(f"Backup: rev {rep['rev']}, {rep['holdings']} holdings, {rep['history_days']} history days.")
    if not args.yes and input("Replace the current data with it? Type yes: ").strip() != "yes":
        print("Nothing changed.")
        return 1
    res = st.restore_from(args.file)
    print(f"Restored. What you had before is kept in {res['kept']}. Restart the server.")
    return 0


def cmd_restore_version(args):
    st = open_store()
    pf = st.read_version(args.rev)
    if pf is None:
        print(f"No saved version {args.rev}. Saved: " + ", ".join(str(v["rev"]) for v in st.versions()[:10]) + " ...")
        return 1
    _, rev = st.read_portfolio()
    new = st.write_portfolio(pf, rev)
    print(f"Holdings from version {args.rev} saved as revision {new}.")
    return 0


def cmd_restore_json(args):
    st = open_store()
    rev = st.restore_json(args.file)
    print(f"Holdings from {args.file} saved as revision {rev}.")
    return 0


def cmd_encrypt(args):
    st = open_store()
    if st.encrypted():
        print("Already encrypted.")
        return 0
    created = crypto.keychain_get() is None
    key = crypto.keychain_get() or crypto.keychain_create()
    backup = os.path.join(st.backup_dir, f"folio-before-encrypt-{datetime.datetime.now():%Y%m%dT%H%M%S}.db")
    os.makedirs(st.backup_dir, exist_ok=True)
    st.backup_to(backup)
    st.set_encryption(True, key)
    rep = verify_db(st.path, key)
    if not rep["ok"]:
        print("Verification failed after encrypting: " + "; ".join(rep["problems"]))
        return 1
    print("Encrypted. Old backups made before this are not encrypted; delete them once you are happy.")
    print(f"A plain copy from just before is {backup}")
    if created:
        print()
        print("A new key was stored in your login Keychain (item 'folio-db-key'). Without it the data cannot be read.")
        print("Save this recovery key somewhere safe, such as a password manager:")
        print("  " + key.hex())
    print("Restart the server.")
    return 0


def cmd_decrypt(args):
    st = open_store()
    if not st.encrypted():
        print("Not encrypted.")
        return 0
    st.set_encryption(False)
    print("Stored unencrypted again. Restart the server.")
    return 0


def cmd_rebuild(args):
    st = open_store()
    pf_cache = {}

    def load():
        if "pf" not in pf_cache:
            pf_cache["pf"] = st.read_portfolio()[0]
        return pf_cache["pf"]

    hist = History(st, load, quotes.yahoo_chart, print)
    n = hist.rebuild(args.start, args.to, args.current_holdings)
    print(f"Re-valued {n} day(s).")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    b = sub.add_parser("backup"); b.add_argument("file", nargs="?"); b.set_defaults(fn=cmd_backup)
    v = sub.add_parser("verify"); v.add_argument("files", nargs="*"); v.set_defaults(fn=cmd_verify)
    r = sub.add_parser("restore"); r.add_argument("file"); r.add_argument("--yes", action="store_true"); r.set_defaults(fn=cmd_restore)
    rv = sub.add_parser("restore-version"); rv.add_argument("rev", type=int); rv.set_defaults(fn=cmd_restore_version)
    rj = sub.add_parser("restore-json"); rj.add_argument("file"); rj.set_defaults(fn=cmd_restore_json)
    sub.add_parser("encrypt").set_defaults(fn=cmd_encrypt)
    sub.add_parser("decrypt").set_defaults(fn=cmd_decrypt)
    rb = sub.add_parser("rebuild-history")
    rb.add_argument("--from", dest="start", required=True)
    rb.add_argument("--to")
    rb.add_argument("--current-holdings", action="store_true")
    rb.set_defaults(fn=cmd_rebuild)
    args = p.parse_args(argv)
    try:
        return args.fn(args) or 0
    except (StoreError, crypto.CryptoError, ValueError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
