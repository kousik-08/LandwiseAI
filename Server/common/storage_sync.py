"""
Sync helpers: mirror local scratch writes into the configured Storage backend.

The codebase's native libraries (pymupdf, pytesseract, pypdf) require real
OS file paths, so processing must touch the filesystem. The pattern we
enforce is:

    local scratch in tmp/work/<rid>/   <->   S3 key prefix outputs/<kind>/<rid>/

These helpers take an arbitrary local file/directory and an optional
S3 key prefix, then upload so the S3 key tree is independent of where
the local mirror lives.

When STORAGE_BACKEND=local everything is a no-op.
"""
from __future__ import annotations

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Iterable, Optional, Tuple

from common.storage import get_storage


def _enabled() -> bool:
    return (os.environ.get("STORAGE_BACKEND") or "local").strip().lower() == "s3"


def _norm(p: str) -> str:
    return p.replace("\\", "/").lstrip("./").lstrip("/")


# In-memory manifest: key → (size, mtime_ns) of the last upload performed
# by this process. Lets repeat sync_dir() calls on the same scratch tree
# skip files that haven't been touched since the previous upload. Without
# this, every analyze step (matching, ec_extract, validation, hierarchy,
# vd, risk) re-uploads every artifact the previous step already pushed —
# we measured ~8 calls × ~80 files = ~640 redundant PUTs per parcel.
_upload_manifest: dict[str, Tuple[int, int]] = {}
_manifest_lock = threading.Lock()


def _file_signature(local_path: str) -> Tuple[int, int]:
    st = os.stat(local_path)
    return (st.st_size, st.st_mtime_ns)


def _should_skip(key: str, signature: Tuple[int, int]) -> bool:
    with _manifest_lock:
        return _upload_manifest.get(key) == signature


def _mark_uploaded(key: str, signature: Tuple[int, int]) -> None:
    with _manifest_lock:
        _upload_manifest[key] = signature


def _content_type_for(name: str) -> Optional[str]:
    """Cheap content-type guess for the file types we actually emit."""
    n = name.lower()
    if n.endswith(".pdf"):
        return "application/pdf"
    if n.endswith(".json"):
        return "application/json"
    if n.endswith(".txt"):
        return "text/plain; charset=utf-8"
    if n.endswith(".png"):
        return "image/png"
    if n.endswith(".jpg") or n.endswith(".jpeg"):
        return "image/jpeg"
    if n.endswith(".html") or n.endswith(".htm"):
        return "text/html; charset=utf-8"
    return None


# Default 12 workers — 32 was too aggressive for the bulk doc-import path
# (zipfile extraction → 20-50 deeds synced at once). Saturated TLS pools to
# ap-south-1 produced "Connection was closed before we received a valid
# response" and "SSL: UNEXPECTED_EOF_WHILE_READING" failures. 12 keeps
# throughput close to optimal while staying well under boto3's
# max_pool_connections=64 ceiling AND leaves headroom for the per-file
# retries in _upload_one to acquire fresh connections after a transient
# blip. Bump via S3_UPLOAD_WORKERS env var if your link is fat enough.
_PARALLEL_UPLOAD_WORKERS = int(os.environ.get("S3_UPLOAD_WORKERS", "12"))


def sync_file(
    local_path: str,
    content_type: Optional[str] = None,
    key: Optional[str] = None,
) -> Optional[str]:
    """
    Upload a single local file. Skipped if the file's (size, mtime_ns) is
    unchanged since the last upload of the same key in this process.
    """
    if not _enabled():
        return None
    if not os.path.isfile(local_path):
        return None
    effective_key = _norm(key) if key else _norm(os.path.relpath(local_path, "."))
    sig = _file_signature(local_path)
    if _should_skip(effective_key, sig):
        return effective_key
    ct = content_type or _content_type_for(os.path.basename(local_path))
    get_storage().put_file(effective_key, local_path, content_type=ct)
    _mark_uploaded(effective_key, sig)
    return effective_key


def sync_dir(
    local_dir: str,
    key_prefix: Optional[str] = None,
    exclude_suffixes: Iterable[str] = (),
) -> int:
    """
    Recursively upload every file under `local_dir` in parallel, skipping
    files unchanged since the last sync of the same key.

    Speed improvements vs the original sequential version:
    - Per-file skip via in-process (size, mtime_ns) manifest — repeat calls
      that re-scan the same scratch dir only upload files written since the
      previous call.
    - Up to S3_UPLOAD_WORKERS (default 32) uploads in flight at once,
      backed by the boto3 client's enlarged connection pool (see
      common.storage.S3Storage.__init__).
    - Content-Type inferred from extension so the browser serves PDFs,
      JSON, etc. correctly when the same key is fetched later.
    """
    if not _enabled():
        return 0
    if not os.path.isdir(local_dir):
        return 0
    storage = get_storage()
    exclude = tuple(exclude_suffixes)
    prefix = _norm(key_prefix).rstrip("/") if key_prefix else None

    # Phase 1: walk the dir, build the (key, local_path, signature) work list
    # while filtering out anything whose signature matches the last upload.
    work: list[tuple[str, str, Tuple[int, int], Optional[str]]] = []
    for dirpath, _, files in os.walk(local_dir):
        for name in files:
            if exclude and name.endswith(exclude):
                continue
            local = os.path.join(dirpath, name)
            try:
                sig = _file_signature(local)
            except OSError:
                continue  # disappeared between walk and stat — skip
            if prefix is not None:
                rel = os.path.relpath(local, local_dir).replace("\\", "/")
                key = f"{prefix}/{rel}"
            else:
                key = _norm(os.path.relpath(local, "."))
            if _should_skip(key, sig):
                continue
            work.append((key, local, sig, _content_type_for(name)))

    if not work:
        return 0

    # Phase 2: fan out uploads.
    # Per-file retry handles the SSL/connection-pool exhaustion failures
    # we see during bulk doc-import (e.g., 20+ deeds zipped → unzipped →
    # synced in parallel saturate the TLS pool and produce
    # "Connection was closed before we received a valid response" or
    # "SSL: UNEXPECTED_EOF_WHILE_READING"). boto3's own retry config only
    # covers HTTP-level errors; these connection-layer failures bypass it
    # and surface as raw exceptions from urllib3. We catch them here and
    # back off with jittered exponential delay before retrying.
    import time as _time
    import random as _random
    _PER_FILE_MAX_ATTEMPTS = 4

    def _upload_one(item: tuple[str, str, Tuple[int, int], Optional[str]]) -> Optional[str]:
        key, local, sig, ct = item
        last_err: Optional[Exception] = None
        for attempt in range(1, _PER_FILE_MAX_ATTEMPTS + 1):
            try:
                storage.put_file(key, local, content_type=ct)
                _mark_uploaded(key, sig)
                return key
            except Exception as e:
                last_err = e
                if not _is_transient_error(e) or attempt == _PER_FILE_MAX_ATTEMPTS:
                    break
                # Jittered exponential backoff: 0.3s, 0.9s, 2.1s. The jitter
                # spreads concurrent retriers so they don't all hammer S3
                # in lockstep (which would re-saturate the pool).
                base = 0.3 * (3 ** (attempt - 1))
                _time.sleep(base + _random.uniform(0, 0.3))
        print(f"[storage_sync] upload failed for {key} after {attempt} attempt(s): {last_err}")
        return None

    if len(work) == 1:
        # Tiny case — no point spinning a thread pool.
        return 1 if _upload_one(work[0]) else 0

    workers = min(_PARALLEL_UPLOAD_WORKERS, len(work))
    n = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for result in ex.map(_upload_one, work):
            if result is not None:
                n += 1
    return n


def invalidate_upload_cache(key_prefix: Optional[str] = None) -> int:
    """
    Force the next sync_file/sync_dir to re-upload the matching entries.
    Pass `key_prefix=None` to wipe the whole manifest. Returns the number
    of manifest entries removed.
    """
    with _manifest_lock:
        if key_prefix is None:
            n = len(_upload_manifest)
            _upload_manifest.clear()
            return n
        p = _norm(key_prefix).rstrip("/") + "/"
        victims = [k for k in _upload_manifest if k == _norm(key_prefix) or k.startswith(p)]
        for k in victims:
            del _upload_manifest[k]
        return len(victims)


def ensure_local(local_path: str, key: Optional[str] = None) -> bool:
    """
    Make sure a file exists at `local_path` for native libs that need an
    OS path. If missing and the corresponding S3 key exists, download it.
    - `key` overrides the default (= local_path normalized). Use when local
      scratch lives under tmp/ but the canonical S3 key is under outputs/.
    Returns True when the file is on disk after the call.

    Same single-roundtrip discipline as read_json: try download, treat
    NoSuchKey as "not there" rather than doing a pre-flight HEAD.
    """
    if os.path.isfile(local_path):
        return True
    if not _enabled():
        return False
    storage = get_storage()
    effective_key = _norm(key) if key else _norm(os.path.relpath(local_path, "."))
    os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
    try:
        storage.download_to(effective_key, local_path)
        return True
    except Exception as e:
        msg = str(e)
        if "NoSuchKey" in msg or "Not Found" in msg or "404" in msg:
            return False
        print(f"[storage] ensure_local({effective_key}) failed: {e}")
        return False


# ─── JSON convenience for tiny canonical files (cache index, checkpoints) ───

def _is_absent_error(e: Exception) -> bool:
    """True for errors that mean the key genuinely doesn't exist."""
    if isinstance(e, FileNotFoundError):
        return True
    msg = str(e)
    if "NoSuchKey" in msg or "FileNotFoundError" in msg:
        return True
    # Match 404 only when it's clearly a status-code reference, not a stray
    # "404" in some other diagnostic text.
    if "(404)" in msg or " 404 " in msg or "status: 404" in msg.lower() or "HTTP 404" in msg:
        return True
    if "Not Found" in msg and ("HeadObject" in msg or "GetObject" in msg or "S3" in msg):
        return True
    return False


def _is_transient_error(e: Exception) -> bool:
    """
    True for transient S3/network errors worth retrying. Without this the
    previous implementation silently treated a network blip as "file
    absent" and returned default=None, which surfaced as a 404 to the
    frontend. Reloading happened to retry and eventually succeeded —
    exactly the "becomes normal after multiple reloads" symptom.
    """
    msg = str(e).lower()
    transient_markers = (
        "timeout", "timed out", "connection reset", "connection aborted",
        "connection refused", "connection was closed",
        "broken pipe", "remote end closed", "before we received a valid response",
        "could not connect to the endpoint",
        "ssl", "tls", "unexpected_eof_while_reading", "eof occurred",
        "throttl", "slowdown", "service unavailable", "internalerror",
        "requestlimitexceeded", "requesttimeout", "requesttimetooskewed",
        "5xx", " 500 ", " 502 ", " 503 ", " 504 ",
        "(500)", "(502)", "(503)", "(504)",
        "endpointconnectionerror", "readtimeouterror", "connectionerror",
        "incompleteread", "chunkedencodingerror",
        "name or service not known", "temporary failure in name resolution",
    )
    return any(marker in msg for marker in transient_markers)


def read_json(key: str, default: Any = None, *, max_retries: int = 3) -> Any:
    """
    Read a JSON object from storage at `key`. Returns `default` only when
    the key genuinely doesn't exist (NoSuchKey / 404 / FileNotFoundError).
    Transient errors (5xx, throttling, timeouts, connection resets) are
    retried with exponential backoff so a brief S3 blip doesn't surface as
    a spurious 404 to the frontend.

    Drops the pre-flight exists() HEAD call that the old version did before
    every get_bytes() — that doubled every read's roundtrip count over S3.
    """
    storage = get_storage()
    last_err: Optional[Exception] = None
    for attempt in range(max_retries):
        try:
            return json.loads(storage.get_bytes(_norm(key)).decode("utf-8"))
        except Exception as e:
            if _is_absent_error(e):
                return default
            last_err = e
            if not _is_transient_error(e) or attempt == max_retries - 1:
                break
            # 0.2s, 0.6s, 1.4s — capped at ~2s total wait across 3 attempts.
            import time as _t
            _t.sleep(0.2 * (3 ** attempt))
    # Genuine, non-transient failure (or transient that exhausted retries):
    # propagate as a "real" error rather than masquerading as absence.
    # Caller can catch if it wants graceful behaviour, but the analyze /
    # hierarchy endpoints SHOULD surface a 5xx rather than a misleading 404.
    print(f"[storage] read_json({key}) failed: {last_err}")
    if last_err is not None and _is_transient_error(last_err):
        # Re-raise so the FastAPI handler can return 503, not 404.
        raise last_err
    return default


def write_json(key: str, data: Any) -> None:
    """Write a JSON object to storage at `key`. Best-effort, raises on serialization errors only."""
    payload = json.dumps(data, ensure_ascii=False, indent=2, default=str).encode("utf-8")
    try:
        get_storage().put_bytes(_norm(key), payload, content_type="application/json")
    except Exception as e:
        print(f"[storage] write_json({key}) failed: {e}")
