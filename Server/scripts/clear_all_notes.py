"""
One-shot admin script to wipe ALL note data from the database.

Clears two tables:
  - document_annotations  (the new annotations powering the Notes Cockpit)
  - node_notes            (the legacy per-doc notes attached to hierarchy nodes)

Usage:
    python scripts/clear_all_notes.py          # dry run — prints counts only
    python scripts/clear_all_notes.py --yes    # actually deletes
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common.database import SessionLocal
from common.landwise_models import DocumentAnnotation
from common.models import NodeNote


def main() -> int:
    parser = argparse.ArgumentParser(description="Wipe ALL notes data from the database.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually perform the deletion (otherwise it's a dry run).",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        ann_count = db.query(DocumentAnnotation).count()
        note_count = db.query(NodeNote).count()

        print(f"[*] document_annotations rows: {ann_count}")
        print(f"[*] node_notes rows:           {note_count}")
        print(f"[*] Total notes-related rows:  {ann_count + note_count}")

        if not args.yes:
            print("[i] Dry run. Re-run with --yes to actually delete.")
            return 0

        removed_ann = db.query(DocumentAnnotation).delete(synchronize_session=False)
        removed_notes = db.query(NodeNote).delete(synchronize_session=False)
        db.commit()
        print(f"[+] Deleted {removed_ann} row(s) from document_annotations.")
        print(f"[+] Deleted {removed_notes} row(s) from node_notes.")
        print("[+] Done.")
        return 0
    except Exception as e:
        db.rollback()
        print(f"[!] Error: {e}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
