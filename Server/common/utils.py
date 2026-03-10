from typing import Any, Dict
import os


class Utils:
    @staticmethod
    def setup_directories():
        """
        Ensures all required directories exist at startup.
        """
        REQUIRED_DIRS = ["inputs", "outputs", "tmp", ".logs"]
        for directory in REQUIRED_DIRS:
            os.makedirs(directory, exist_ok=True)

        # Ensure log sub-directories exist before any request handlers/middleware use them
        # Logs are split by endpoint in middleware: .logs/<endpoint>/
        LOG_SUBDIRS = ["validate", "download-ec", "getlandinfo", "other"]
        for sub in LOG_SUBDIRS:
            os.makedirs(os.path.join(".logs", sub), exist_ok=True)

        # Validate outputs base (requests create outputs/validate/<uuid>/...)
        os.makedirs(os.path.join("outputs", "validate"), exist_ok=True)
        # Global vault for persistent PDF storage
        os.makedirs(os.path.join("outputs", "storage", "vault"), exist_ok=True)
        # Ensure inputs base exists
        os.makedirs(os.path.join("inputs", "validate"), exist_ok=True)
        print("Directory Structure Initialized")

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
