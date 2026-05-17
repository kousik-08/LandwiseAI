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


def test_json_parse_path_with_stub():
    """Exercise the happy path with a stubbed Gemini client — no real API call."""
    import unittest.mock as mock
    import json as _json

    helper = GeminiHelper.__new__(GeminiHelper)
    helper.model_id = "test-model"

    # Stub: upload returns an object whose state.name is "ACTIVE" so the poll loop exits.
    uploaded = mock.Mock()
    uploaded.state.name = "ACTIVE"
    uploaded.name = "files/x"

    mock_response = mock.Mock()
    mock_response.text = _json.dumps([{"value": "STELLA", "found": True, "box_0_1000": [10, 20, 30, 40]}])

    mock_client = mock.Mock()
    mock_client.files.upload.return_value = uploaded
    mock_client.models.generate_content.return_value = mock_response
    helper.client = mock_client

    # The file must exist for the FileNotFoundError guard to pass; use this test file itself.
    import os, sys
    here = os.path.dirname(os.path.abspath(__file__))

    result = helper.generate_json_from_file(
        file_path=os.path.join(here, "test_gemini_helper_json.py"),
        prompt="test",
        response_schema={"type": "ARRAY"},
    )

    assert result == [{"value": "STELLA", "found": True, "box_0_1000": [10, 20, 30, 40]}]
    mock_client.files.upload.assert_called_once()
    mock_client.models.generate_content.assert_called_once()


if __name__ == "__main__":
    test_method_exists_and_accepts_schema()
    test_json_parse_path_with_stub()
    print("OK")
