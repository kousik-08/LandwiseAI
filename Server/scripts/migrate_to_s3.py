"""
Backfill: upload local Server/inputs/ and Server/outputs/ contents to S3,
then mark affected lw_documents / lw_legal_opinions rows as storage_backend='s3'.

Idempotent: safe to re-run. Existing S3 objects are overwritten with the
local copy (use --skip-existing to skip them instead).

Usage (from the Server/ directory):
    set STORAGE_BACKEND=s3
    set S3_BUCKET=landwise-results
    set S3_REGION=ap-south-1
    python -m scripts.migrate_to_s3              # dry-run summary
    python -m scripts.migrate_to_s3 --apply      # actually upload + update DB
    python -m scripts.migrate_to_s3 --apply --skip-existing
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Iterable

# Ensure we run from Server/ so relative keys are correct
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_ROOT = os.path.dirname(HERE)
os.chdir(SERVER_ROOT)
sys.path.insert(0, SERVER_ROOT)

from dotenv import load_dotenv  # noqa: E402
load_dotenv()  # read Server/.env so STORAGE_BACKEND / S3_* / AWS_* / DATABASE_URL are populated

from common.storage import get_storage, S3Storage  # noqa: E402
from common.database import SessionLocal  # noqa: E402
from common.landwise_models import LandwiseDocument, LegalOpinion  # noqa: E402


ROOTS = ["inputs", "outputs"]


def iter_files(roots: Iterable[str]):
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _, files in os.walk(root):
            for name in files:
                local = os.path.join(dirpath, name)
                key = os.path.relpath(local, ".").replace("\\", "/")
                yield local, key


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Perform the upload + DB update")
    parser.add_argument("--skip-existing", action="store_true", help="Skip keys already present in S3")
    args = parser.parse_args()

    storage = get_storage()
    if not isinstance(storage, S3Storage):
        print(f"[!] STORAGE_BACKEND is not 's3' (got '{storage.backend}'). Aborting.")
        sys.exit(2)

    print(f"[*] Bucket: {storage.bucket}  Region: {storage.region}")
    print(f"[*] Mode: {'APPLY' if args.apply else 'DRY-RUN'}  skip-existing={args.skip_existing}")

    total = 0
    uploaded = 0
    skipped = 0
    failed = 0
    bytes_total = 0
    t0 = time.time()

    for local, key in iter_files(ROOTS):
        total += 1
        try:
            size = os.path.getsize(local)
        except OSError:
            size = 0
        bytes_total += size

        if not args.apply:
            if total <= 20:
                print(f"  would upload {key}  ({size} bytes)")
            continue

        try:
            if args.skip_existing and storage.exists(key):
                skipped += 1
                continue
            storage.put_file(key, local)
            uploaded += 1
            if uploaded % 50 == 0:
                print(f"  ... uploaded {uploaded}/{total}")
        except Exception as e:
            failed += 1
            print(f"  [!] FAILED {key}: {e}")

    elapsed = time.time() - t0
    print(f"[+] Files scanned: {total}  total bytes: {bytes_total:,}  ({elapsed:.1f}s)")
    if args.apply:
        print(f"[+] Uploaded: {uploaded}   Skipped: {skipped}   Failed: {failed}")

        # Mark DB rows as storage_backend='s3' where the storage_key is a path
        # under inputs/ or outputs/ — i.e. anything we just backfilled.
        try:
            db = SessionLocal()
            try:
                doc_n = (
                    db.query(LandwiseDocument)
                    .filter(LandwiseDocument.storage_backend != 's3')
                    .update({LandwiseDocument.storage_backend: 's3'}, synchronize_session=False)
                )
                op_n = (
                    db.query(LegalOpinion)
                    .filter(LegalOpinion.pdf_storage_key.isnot(None))
                    .filter(LegalOpinion.storage_backend != 's3')
                    .update({LegalOpinion.storage_backend: 's3'}, synchronize_session=False)
                )
                db.commit()
                print(f"[+] DB updated: lw_documents={doc_n}, lw_legal_opinions={op_n}")
            finally:
                db.close()
        except Exception as e:
            print(f"[!] DB update failed: {e}")


if __name__ == "__main__":
    main()
