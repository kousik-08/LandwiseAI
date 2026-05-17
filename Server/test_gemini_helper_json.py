"""Unit test for GeminiHelper.generate_json_from_file (no real API call)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common.gemini_helper import GeminiHelper


def test_method_exists_and_accepts_schema():
    """The method must exist and accept (file_path, prompt, response_schema)."""
    # We can't call without GEMINI_API_KEY; just assert the method exists with right signature.
    assert hasattr(GeminiHelper, "generate_json_from_file"), \
        "GeminiHelper must expose generate_json_from_file"
    import inspect
    sig = inspect.signature(GeminiHelper.generate_json_from_file)
    params = list(sig.parameters)
    # self, file_path, prompt, response_schema, display_name, temperature, top_p
    assert "file_path" in params
    assert "prompt" in params
    assert "response_schema" in params


if __name__ == "__main__":
    test_method_exists_and_accepts_schema()
    print("OK")
