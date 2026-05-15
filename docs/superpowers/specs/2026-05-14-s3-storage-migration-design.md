# S3 Storage Migration Design

**Date:** 2026-05-14
**Status:** Approved
**Owner:** Backend

## Goal

Replace local `Server/inputs/` and `Server/outputs/` directories with S3-backed storage. Keep dev workflows working via a local backend toggle.

## Configuration

| Var | Value |
| --- | --- |
| `STORAGE_BACKEND` | `s3` (prod) / `local` (dev) |
| `S3_BUCKET` | `landwise-results` |
| `S3_REGION` | `ap-south-1` |
| `S3_PRESIGN_EXPIRES` | `3600` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | from env or instance role |

## Architecture

A `Server/common/storage.py` module exposes a single `Storage` interface with two backends:

- `LocalStorage` — keys are relative paths under `Server/` (preserves current behavior).
- `S3Storage` — `boto3` client, keys map 1:1 to bucket keys.

```python
class Storage:
    def put_bytes(key, data, content_type=None) -> str
    def put_file(key, local_path, content_type=None) -> str
    def get_bytes(key) -> bytes
    def download_to(key, local_path) -> str
    def open_stream(key) -> BinaryIO
    def exists(key) -> bool
    def list_prefix(prefix) -> list[str]
    def delete_prefix(prefix) -> int
    def presigned_url(key, expires=3600) -> str
    def local_copy(key) -> ContextManager[str]   # temp file for native libs
```

`get_storage()` returns a process-wide singleton selected by `STORAGE_BACKEND`.

## Key Format

Existing relative paths become S3 keys unchanged:

- `outputs/validate/<rid>/results.json`
- `inputs/validate/<rid>/sale_deeds/<file>.pdf`
- `outputs/storage/vault/<file>.pdf`

This means **no rewrite of existing `lw_documents.storage_key` values** is required.

## HTTP Serving

`StaticFiles` mounts at `/files` and `/input-files` become two thin endpoints in `app.py` that 302-redirect to a presigned S3 URL (1h expiry). Client URLs unchanged.

## Native-Library Code

Code that needs a real local path (pymupdf, pytesseract, pypdf, subprocess tooling) uses:

```python
with storage.local_copy(input_key) as path:
    do_native_thing(path)
storage.put_file(out_key, tmp_out_path)
```

`local_copy` writes into `Server/tmp/`.

## DB Changes

Additive alembic revision:

- `lw_documents.storage_backend VARCHAR(10) NULL DEFAULT 'local'`
- (Optional) `lw_legal_opinions.storage_backend VARCHAR(10) NULL DEFAULT 'local'`

Backfill script `Server/scripts/migrate_to_s3.py`:

1. Walk `inputs/` and `outputs/` on disk.
2. Upload each file to S3 with key = relative path.
3. Update `storage_backend='s3'` for affected `lw_documents` rows.
4. Idempotent; safe to re-run.

## Touched Files

Storage call sites:

- `Server/app.py` (StaticFiles → redirect endpoints)
- `Server/common/utils.py` (`setup_directories` becomes backend-aware)
- `Server/api/validate/handler.py` (largest footprint, ~30 path constructions)
- `Server/api/validate/{ec_processor,matcher,hierarchy_generator,visual_debugger,notes_handler,validator,risk_score_engine,sale_deed_processor,supporting_verifier}.py`
- `Server/api/landwise/router.py`
- `Server/api/download_ec/ec_downloader.py`
- `Server/services/analysis_bridge.py`
- `Server/scripts/{ingest_pdfs,wipe_all_data,wipe_all_forensic_data}.py`

New files:

- `Server/common/storage.py`
- `Server/scripts/migrate_to_s3.py`
- `Server/alembic/versions/<rev>_add_storage_backend.py`

## Verification

1. Boot with `STORAGE_BACKEND=local` — full smoke (upload → validate → analyze → render PDF).
2. Boot with `STORAGE_BACKEND=s3` against `landwise-results` — same smoke.
3. Confirm: PdfAnnotator renders via redirect, legal opinion PDF downloads, risk-score endpoints work.

## Rollback

`STORAGE_BACKEND=local` reverts behavior; local `inputs/`/`outputs/` kept on-disk for 7 days post-cutover.
