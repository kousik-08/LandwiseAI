import json
import os
import datetime
from typing import Any, Dict, Optional


class RequestLogger:
    def __init__(self, request_id: str, log_dir: str = ".logs"):
        self.request_id = request_id
        self.log_dir = log_dir
        self.log_file = os.path.join(self.log_dir, f"{self.request_id}.log")

        # Ensure log directory exists
        os.makedirs(self.log_dir, exist_ok=True)

    def _get_timestamp(self) -> str:
        """Returns ISO-8601 UTC timestamp."""
        return datetime.datetime.now(datetime.timezone.utc).isoformat()

    def _write_log(self, entry: Dict[str, Any]):
        """Writes a dictionary as a JSON line to the log file."""
        try:
            with open(self.log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            # Fallback: Print to stderr if file write fails, to avoid losing critical errors silently
            print(f"FAILED TO WRITE LOG file={self.log_file} error={e} entry={entry}")

    def log_request(self, payload: Any):
        """Logs the incoming request payload."""
        entry = {
            "type": "request",
            "time": self._get_timestamp(),
            "message": "Incoming request",
            "status": "started",
            "data": payload if isinstance(payload, dict) else {"payload": str(payload)},
        }
        self._write_log(entry)

    def log_output(
        self, duration_ms: float, success: bool, data: Optional[Dict[str, Any]] = None
    ):
        """Logs the final output/response summary."""
        status = "success" if success else "failed"
        entry = {
            "type": "output",
            "time": self._get_timestamp(),
            "message": f"Request finished in {duration_ms:.2f}ms",
            "status": status,
            "data": data or {},
        }
        self._write_log(entry)

    def log_error(self, error_message: str, data: Optional[Dict[str, Any]] = None):
        """Logs an error that occurred during processing."""
        entry = {
            "type": "error",
            "time": self._get_timestamp(),
            "message": error_message,
            "status": "failed",
            "data": data or {},
        }
        self._write_log(entry)
