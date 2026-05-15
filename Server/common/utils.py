from typing import Any, Dict
import os


class Utils:
    @staticmethod
    def setup_directories():
        """
        Ensures required local directories exist at startup. With S3
        backend, only tmp/ and .logs/ are needed on disk; inputs/ and
        outputs/ are virtual prefixes in the bucket.
        """
        backend = (os.environ.get("STORAGE_BACKEND") or "local").strip().lower()

        for directory in ["tmp", ".logs"]:
            os.makedirs(directory, exist_ok=True)

        LOG_SUBDIRS = ["validate", "download-ec", "getlandinfo", "other"]
        for sub in LOG_SUBDIRS:
            os.makedirs(os.path.join(".logs", sub), exist_ok=True)

        if backend != "s3":
            for d in [
                "inputs",
                "outputs",
                os.path.join("outputs", "validate"),
                os.path.join("outputs", "storage", "vault"),
                os.path.join("inputs", "validate"),
            ]:
                os.makedirs(d, exist_ok=True)

        print(f"Directory Structure Initialized (backend={backend})")

    @staticmethod
    def construct_output(
        response: Any, status_code: int = 200, message: str = "Success"
    ) -> Dict[str, Any]:
        """
        Standardizes API response format.
        """
        return {
            "statusCode": status_code,
            "body": {
                "statusCode": status_code,
                "responseMessage": message,
                "response": response,
            },
        }
