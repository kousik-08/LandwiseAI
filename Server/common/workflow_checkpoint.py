"""
Workflow checkpoints persisted to the storage backend (S3 when enabled).

A single JSON file per request lives at:
    outputs/validate/<request_id>/checkpoint.json

It is rewritten on every stage transition so an external observer (or a
restarted server) can tell exactly where a run is. Failures of the checkpoint
write are swallowed - they must never break the pipeline.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional

from common.storage import get_storage


_STAGES = ["ec_extraction", "matching", "sale_deed_extraction", "hierarchy", "validation"]


class WorkflowCheckpoint:
    def __init__(self, request_id: str, kind: str = "validate"):
        self.request_id = request_id
        self.kind = kind
        self.key = f"outputs/{kind}/{request_id}/checkpoint.json"
        self.local_path = os.path.join("outputs", kind, request_id, "checkpoint.json")
        self.state: Dict[str, Any] = {
            "request_id": request_id,
            "kind": kind,
            "status": "in_progress",
            "current_stage": None,
            "completed_stages": [],
            "failed_stage": None,
            "error": None,
            "stage_started_at": {},
            "stage_completed_at": {},
            "started_at": time.time(),
            "updated_at": time.time(),
            "stages_total": list(_STAGES),
        }

    def _persist(self) -> None:
        self.state["updated_at"] = time.time()
        payload = json.dumps(self.state, indent=2, default=str).encode("utf-8")
        try:
            os.makedirs(os.path.dirname(self.local_path), exist_ok=True)
            with open(self.local_path, "wb") as f:
                f.write(payload)
        except Exception as e:
            print(f"[checkpoint] local write failed: {e}")
        try:
            get_storage().put_bytes(self.key, payload, content_type="application/json")
        except Exception as e:
            print(f"[checkpoint] storage write failed: {e}")

    def start_stage(self, stage: str) -> None:
        self.state["current_stage"] = stage
        self.state["stage_started_at"][stage] = time.time()
        self._persist()

    def complete_stage(self, stage: str, status: str = "success") -> None:
        self.state["stage_completed_at"][stage] = time.time()
        if status == "success":
            if stage not in self.state["completed_stages"]:
                self.state["completed_stages"].append(stage)
        self._persist()

    def fail_stage(self, stage: str, error: str) -> None:
        self.state["failed_stage"] = stage
        self.state["error"] = str(error)[:2000]
        self.state["status"] = "failed"
        self._persist()

    def finish(self, status: str = "completed", error: Optional[str] = None) -> None:
        self.state["status"] = status
        if error:
            self.state["error"] = str(error)[:2000]
        self.state["current_stage"] = None
        self._persist()


def load_checkpoint(request_id: str, kind: str = "validate") -> Optional[Dict[str, Any]]:
    """Read the latest checkpoint from storage for status queries. None if absent."""
    key = f"outputs/{kind}/{request_id}/checkpoint.json"
    storage = get_storage()
    try:
        if not storage.exists(key):
            return None
        return json.loads(storage.get_bytes(key).decode("utf-8"))
    except Exception as e:
        print(f"[checkpoint] load failed: {e}")
        return None
