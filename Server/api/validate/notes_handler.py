import os
import json
from typing import Dict

NOTES_FILE = "outputs/storage/node_notes.json"

def get_all_notes() -> Dict[str, str]:
    if not os.path.exists(NOTES_FILE):
        return {}
    try:
        with open(NOTES_FILE, "r") as f:
            return json.load(f)
    except:
        return {}

def save_note(doc_no: str, note: str):
    notes = get_all_notes()
    notes[doc_no] = note
    
    os.makedirs(os.path.dirname(NOTES_FILE), exist_ok=True)
    with open(NOTES_FILE, "w") as f:
        json.dump(notes, f, indent=2)

def handle_save_node_note(doc_no: str, note: str):
    save_note(doc_no, note)
    return {"status": "success", "doc_no": doc_no}

def handle_get_node_notes():
    return get_all_notes()
