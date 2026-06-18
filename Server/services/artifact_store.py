"""
services.artifact_store — canonical three-tier read helper for analyze artifacts.

LandwiseAI's analyze pipeline writes JSON artifacts to BOTH local scratch
(`outputs/validate/<request_id>/...`) AND the configured storage backend
(local-disk-mirror or S3 under the same key shape). Some artifacts are
ALSO persisted to Postgres via `AnalysisResult` / `ValidationResult` rows
for queries that should survive scratch cleanup or S3 outages.

Historically each FastAPI endpoint that needed to read one of these
artifacts inlined its own three-tier probe — `os.path.exists()` for
local, `read_json()` for S3, then a hand-rolled DB query. We had four
near-identical copies (`handle_get_global_hierarchy`,
`handle_generate_report`, `get_report_sections`, and the chain-length
branch in `landwise/router.get_parcel_stats`). When the S3 fallback
behavior was fixed in one, the others drifted out of sync.

This module centralizes the pattern as `read_json_artifact()`. The DB
fallback is passed in as a callable closure so the helper stays
model-agnostic — `artifact_store` doesn't need to know about
`AnalysisResult`, `ValidationResult`, or any other SQLAlchemy model.

Read order:
    1. Local filesystem  — fastest, used during the active analyze run
    2. Storage backend   — canonical mirror, survives backend restarts
    3. db_fallback()     — optional caller-supplied closure, last resort
    4. Return None       — the caller decides whether None is an error
                            or a "graceful pending" state

The function NEVER raises on a missing artifact. If you need to
distinguish "not generated yet" from "infrastructure error", inspect
the storage-layer logs — `storage_sync.read_json()` retries transient
errors (5xx, throttle, SSL EOF) before declaring the key absent.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Callable, Optional

from common.storage_sync import read_json as _storage_read_json

logger = logging.getLogger(__name__)


def _local_path(request_id: str, rel_path: str) -> str:
    """Build the local-scratch path for a per-request artifact."""
    return os.path.join("outputs", "validate", request_id, rel_path)


def _storage_key(request_id: str, rel_path: str) -> str:
    """Build the storage-backend key. Forward-slash normalized for S3."""
    rel = rel_path.replace("\\", "/").lstrip("/")
    return f"outputs/validate/{request_id}/{rel}"


def read_json_artifact(
    request_id: str,
    rel_path: str,
    *,
    db_fallback: Optional[Callable[[], Any]] = None,
) -> Any:
    """
    Read a JSON artifact for a given analyze request_id, trying local
    scratch first, then the storage backend, then an optional DB fallback.

    Args:
        request_id: The analyze run identifier (UUID string).
        rel_path: Path relative to the request's artifact dir, e.g.
                  "hierarchy_tree.json" or "legal/legal_opinion_report.md.json".
                  Forward slashes preferred; backslashes are normalized.
        db_fallback: Optional zero-arg callable that returns the artifact
                     from Postgres when both filesystem and storage miss.
                     Pass a closure that knows about your SQLAlchemy model
                     so this helper stays model-agnostic.

    Returns:
        The parsed JSON value (dict, list, scalar) or None if every tier
        misses. Never raises on absence.
    """
    if not request_id or not rel_path:
        return None

    # Tier 1: local scratch — fast path during the active analyze
    local = _local_path(request_id, rel_path)
    if os.path.isfile(local):
        try:
            with open(local, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            # Corrupted local file shouldn't block S3 fallback. Log loudly
            # so the operator can clean up the bad scratch copy.
            logger.warning(
                "[artifact_store] local read failed for %s: %s — falling through to storage",
                local, e,
            )

    # Tier 2: storage backend (S3 in prod, local-mirror in dev).
    # read_json handles retries on transient errors and returns the
    # default ONLY when the key is genuinely absent.
    key = _storage_key(request_id, rel_path)
    try:
        from_storage = _storage_read_json(key, default=None)
    except Exception as e:
        # Storage layer raises on transient errors that exceeded the
        # internal retry budget — treat as a miss for this caller so we
        # can still try the DB. The storage layer already logged.
        logger.warning(
            "[artifact_store] storage read raised for %s: %s — falling through to DB",
            key, e,
        )
        from_storage = None
    if from_storage is not None:
        return from_storage

    # Tier 3: DB fallback — caller-supplied closure
    if db_fallback is not None:
        try:
            from_db = db_fallback()
            if from_db is not None:
                logger.info(
                    "[artifact_store] served %s for %s from DB fallback",
                    rel_path, request_id,
                )
                return from_db
        except Exception as e:
            logger.warning(
                "[artifact_store] db_fallback raised for %s/%s: %s",
                request_id, rel_path, e,
            )

    return None
