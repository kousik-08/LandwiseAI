import os
from typing import Dict
from common.database import SessionLocal
from common.models import NodeNote

def get_all_notes() -> Dict[str, str]:
    db = SessionLocal()
    try:
        notes = db.query(NodeNote).all()
        return {n.doc_no: n.note for n in notes}
    finally:
        db.close()

def save_note(doc_no: str, note: str):
    db = SessionLocal()
    try:
        existing = db.query(NodeNote).filter(NodeNote.doc_no == doc_no).first()
        if existing:
            existing.note = note
        else:
            new_note = NodeNote(doc_no=doc_no, note=note)
            db.add(new_note)
        db.commit()
    finally:
        db.close()

def handle_save_node_note(doc_no: str, note: str):
    save_note(doc_no, note)
    return {"status": "success", "doc_no": doc_no}

def handle_get_node_notes():
    return get_all_notes()
