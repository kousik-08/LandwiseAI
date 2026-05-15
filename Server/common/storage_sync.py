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
from typing import Any, Iterable, Optional

from common.storage import get_storage


def _enabled() -> bool:
    return (os.environ.get("STORAGE_BACKEND") or "local").strip().lower() == "s3"


def _norm(p: str) -> str:
    return p.replace("\\", "/").lstrip("./").lstrip("/")


def sync_file(
    local_path: str,
    content_type: Optional[str] = None,
    key: Optional[str] = None,
) -> Optional[str]:
    """
    Upload a single local file.
    - If `key` is given, use it as the S3 key.
    - Otherwise the key is the local path relative to the current working
      directory (legacy behavior — only safe when local_path already
      mirrors the desired S3 layout, e.g. starts with "outputs/").
    Returns the uploaded key, or None if skipped.
    """
    if not _enabled():
        return None
    if not os.path.isfile(local_path):
        return None
    effective_key = _norm(key) if key else _norm(os.path.relpath(local_path, "."))
    get_storage().put_file(effective_key, local_path, content_type=content_type)
    return effective_key


def sync_dir(
    local_dir: str,
    key_prefix: Optional[str] = None,
    exclude_suffixes: Iterable[str] = (),
) -> int:
    """
    Recursively upload every file under `local_dir`.
    - If `key_prefix` is given, each file's S3 key becomes
      "<key_prefix>/<path-relative-to-local_dir>".
    - Otherwise the key is the file's path relative to CWD (legacy).
    Returns the number of files uploaded.
    """
    if not _enabled():
        return 0
    if not os.path.isdir(local_dir):
        return 0
    storage = get_storage()
    exclude = tuple(exclude_suffixes)
    prefix = _norm(key_prefix).rstrip("/") if key_prefix else None
    n = 0
    for dirpath, _, files in os.walk(local_dir):
        for name in files:
            if exclude and name.endswith(exclude):
                continue
            local = os.path.join(dirpath, name)
            if prefix is not None:
                rel = os.path.relpath(local, local_dir).replace("\\", "/")
                key = f"{prefix}/{rel}"
            else:
                key = _norm(os.path.relpath(local, "."))
            storage.put_file(key, local)
            n += 1
    return n


def ensure_local(local_path: str, key: Optional[str] = None) -> bool:
    """
    Make sure a file exists at `local_path` for native libs that need an
    OS path. If missing and the corresponding S3 key exists, download it.
    - `key` overrides the default (= local_path normalized). Use when local
      scratch lives under tmp/ but the canonical S3 key is under outputs/.
    Returns True when the file is on disk after the call.
    """
    if os.path.isfile(local_path):
        return True
    if not _enabled():
        return False
    storage = get_storage()
    effective_key = _norm(key) if key else _norm(os.path.relpath(local_path, "."))
    if not storage.exists(effective_key):
        return False
    os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
    storage.download_to(effective_key, local_path)
    return True


# ─── JSON convenience for tiny canonical files (cache index, checkpoints) ───

def read_json(key: str, default: Any = None) -> Any:
    """Read a JSON object from storage at `key`. Returns `default` if absent."""
    storage = get_storage()
    try:
        if not storage.exists(_norm(key)):
            return default
        return json.loads(storage.get_bytes(_norm(key)).decode("utf-8"))
    except Exception as e:
        print(f"[storage] read_json({key}) failed: {e}")
        return default


def write_json(key: str, data: Any) -> None:
    """Write a JSON object to storage at `key`. Best-effort, raises on serialization errors only."""
    payload = json.dumps(data, ensure_ascii=False, indent=2, default=str).encode("utf-8")
    try:
        get_storage().put_bytes(_norm(key), payload, content_type="application/json")
    except Exception as e:
        print(f"[storage] write_json({key}) failed: {e}")
