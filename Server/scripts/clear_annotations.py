"""
One-shot admin script to clear the document_annotations table.

Why: legacy notes saved before the area-vs-text fix and the placeholder-coord
fix have unreliable bounding_box data; the cleanest reset is to delete them
and re-create new ones, which now save with correct positions and types.

Usage:
    python scripts/clear_annotations.py            # dry run, prints counts
    python scripts/clear_annotations.py --yes      # actually deletes
    python scripts/clear_annotations.py --soft     # soft-delete only
                                                   # (sets deleted_at)
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

# Make the parent dir importable when running from Server/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common.database import SessionLocal
from common.landwise_models import DocumentAnnotation


def main() -> int:
    parser = argparse.ArgumentParser(description="Clear document_annotations rows.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually perform the deletion (otherwise it's a dry run).",
    )
    parser.add_argument(
        "--soft",
        action="store_true",
        help="Soft-delete only (set deleted_at) instead of removing rows.",
    )
    parser.add_argument(
        "--parcel-id",
        default=None,
        help="Limit deletion to a single parcel.",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        q = db.query(DocumentAnnotation)
        if args.parcel_id:
            q = q.filter(DocumentAnnotation.parcel_id == args.parcel_id)

        active_q = q.filter(DocumentAnnotation.deleted_at.is_(None))
        total = q.count()
        active = active_q.count()
        already_soft = total - active

        scope = f"parcel {args.parcel_id}" if args.parcel_id else "ALL parcels"
        print(f"[*] Scope: {scope}")
        print(f"[*] Total rows: {total}  (active: {active}, already soft-deleted: {already_soft})")

        if not args.yes:
            print("[i] Dry run. Re-run with --yes to actually delete.")
            return 0

        if args.soft:
            now = datetime.now(timezone.utc)
            updated = active_q.update(
                {DocumentAnnotation.deleted_at: now},
                synchronize_session=False,
            )
            db.commit()
            print(f"[+] Soft-deleted {updated} active annotation(s).")
        else:
            removed = q.delete(synchronize_session=False)
            db.commit()
            print(f"[+] Hard-deleted {removed} annotation(s) from the table.")

        return 0
    except Exception as e:
        db.rollback()
        print(f"[!] Error: {e}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
