"""
Optional encryption of stored rows.

AES-256-CBC through macOS CommonCrypto (no packages needed) with an HMAC-SHA256
over the result, so a wrong key or a damaged row is detected instead of
returning garbage. The key lives in the macOS Keychain, so the folder alone
(copied to another machine, a backup drive, a sync service) cannot be read.

Row format: b"F1" + iv(16) + ciphertext + hmac(32).
"""
import ctypes
import hashlib
import hmac
import os
import subprocess
import sys

MAGIC = b"F1"
KEYCHAIN_SERVICE = "folio-db-key"
KEYCHAIN_ACCOUNT = "folio"


class CryptoError(Exception):
    pass


def _libsystem():
    if sys.platform != "darwin":
        raise CryptoError("Encryption needs macOS (CommonCrypto and the Keychain).")
    return ctypes.CDLL("/usr/lib/libSystem.B.dylib")


def _cc(op, key, iv, data):
    lib = _libsystem()
    out = ctypes.create_string_buffer(len(data) + 32)
    moved = ctypes.c_size_t()
    # op 0 encrypt / 1 decrypt, algorithm 0 = AES, options 1 = PKCS7 padding
    status = lib.CCCrypt(op, 0, 1, key, len(key), iv, data, len(data), out, len(out), ctypes.byref(moved))
    if status != 0:
        raise CryptoError(f"CommonCrypto failed ({status})")
    return out.raw[:moved.value]


def _subkeys(master):
    return hashlib.sha256(master + b"enc").digest(), hashlib.sha256(master + b"mac").digest()


def encrypt(master, plaintext):
    enc, mac = _subkeys(master)
    iv = os.urandom(16)
    body = MAGIC + iv + _cc(0, enc, iv, plaintext)
    return body + hmac.new(mac, body, hashlib.sha256).digest()


def decrypt(master, blob):
    if len(blob) < len(MAGIC) + 16 + 16 + 32 or not blob.startswith(MAGIC):
        raise CryptoError("not an encrypted row")
    enc, mac = _subkeys(master)
    body, tag = blob[:-32], blob[-32:]
    if not hmac.compare_digest(hmac.new(mac, body, hashlib.sha256).digest(), tag):
        raise CryptoError("wrong key or damaged row")
    iv = body[len(MAGIC):len(MAGIC) + 16]
    return _cc(1, enc, iv, body[len(MAGIC) + 16:])


# ---------- key storage ----------
def keychain_get():
    """The master key as bytes, or None when the Keychain has none."""
    env = os.environ.get("FOLIO_KEY")  # tests and headless machines
    if env:
        return bytes.fromhex(env)
    if sys.platform != "darwin":
        return None
    try:
        res = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
            capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    try:
        return bytes.fromhex(res.stdout.strip())
    except ValueError:
        return None


def keychain_create():
    """Create a random key in the Keychain and return it. The key goes to
    `security` over stdin, so it never appears in a process list."""
    if keychain_get() is not None:
        raise CryptoError("A key already exists in the Keychain.")
    key = os.urandom(32)
    line = f"add-generic-password -s {KEYCHAIN_SERVICE} -a {KEYCHAIN_ACCOUNT} -w {key.hex()} -j folio\n"
    try:
        res = subprocess.run(["security", "-i"], input=line, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        raise CryptoError(f"Could not run security: {exc}")
    if res.returncode != 0 or keychain_get() != key:
        raise CryptoError(f"Could not store the key in the Keychain: {(res.stderr or res.stdout).strip()}")
    return key
