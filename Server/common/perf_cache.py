"""
common.perf_cache
=================
Tiny thread-safe in-memory TTL cache used by hot read paths (e.g. /auth/me).
Intentionally dependency-free (stdlib only) so we don't introduce a new
runtime requirement just for performance plumbing.

Usage:
    cache = TTLCache(maxsize=512, ttl=60)
    cache.set("key", value)
    value = cache.get("key")       # None if missing/expired
    cache.delete("key")
    cache.clear()
"""

from __future__ import annotations

import threading
import time
from typing import Any, Optional, Tuple


class TTLCache:
    """A minimal thread-safe TTL cache. Evicts oldest on overflow.

    Keys must be hashable. Values are stored alongside an absolute
    expiry timestamp (seconds since epoch).
    """

    __slots__ = ("_data", "_ttl", "_maxsize", "_lock")

    def __init__(self, maxsize: int = 512, ttl: float = 60.0) -> None:
        self._data: dict[Any, Tuple[float, Any]] = {}
        self._ttl = float(ttl)
        self._maxsize = int(maxsize)
        self._lock = threading.Lock()

    def get(self, key: Any) -> Optional[Any]:
        now = time.monotonic()
        with self._lock:
            entry = self._data.get(key)
            if not entry:
                return None
            expires_at, value = entry
            if expires_at < now:
                # Expired — drop and miss.
                self._data.pop(key, None)
                return None
            return value

    def set(self, key: Any, value: Any) -> None:
        expires_at = time.monotonic() + self._ttl
        with self._lock:
            # Cheap LRU-ish eviction: drop the oldest insertion when over cap.
            if key not in self._data and len(self._data) >= self._maxsize:
                try:
                    oldest_key = next(iter(self._data))
                    self._data.pop(oldest_key, None)
                except StopIteration:
                    pass
            self._data[key] = (expires_at, value)

    def delete(self, key: Any) -> None:
        with self._lock:
            self._data.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
