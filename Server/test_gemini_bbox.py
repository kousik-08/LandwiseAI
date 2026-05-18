"""Unit tests for the two-call locator parsers and prompts."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.visual_debugger import (
    _to_pixel_box,
    parse_sentence_response,
    build_sentence_prompt,
    build_pinpoint_prompt,
)


def test_to_pixel_box_converts_normalized_coords():
    # [ymin=100, xmin=200, ymax=300, xmax=400] on a 1000×2000 page
    box = _to_pixel_box([100, 200, 300, 400], page_w_px=1000, page_h_px=2000)
    assert box == (200, 200, 400, 600)


def test_to_pixel_box_rejects_invalid_shapes():
    assert _to_pixel_box([1, 2, 3], 1000, 1000) is None
    assert _to_pixel_box("nope", 1000, 1000) is None
    # Zero-area (ymin == ymax)
    assert _to_pixel_box([100, 100, 100, 200], 1000, 1000) is None


def test_parse_sentence_response_groups_by_value():
    response = [
        {
            "value": "STELLA",
            "found": True,
            "context_sentence": "STELLA is the claimant",
            "context_box_0_1000": [100, 50, 200, 950],
        },
        {
            "value": "STELLA",
            "found": True,
            "context_sentence": "STELLA again",
            "context_box_0_1000": [400, 50, 500, 950],
        },
        {"value": "26400", "found": False},
    ]
    result = parse_sentence_response(response, page_w_px=1000, page_h_px=2000)
    assert "STELLA" in result and "26400" in result
    assert len(result["STELLA"]) == 2
    assert result["26400"] == []
    # Sentence + box plumbed through
    first = result["STELLA"][0]
    assert first["sentence"] == "STELLA is the claimant"
    assert first["context_box_px"] == (50, 200, 950, 400)


def test_parse_sentence_response_skips_invalid_boxes():
    response = [
        {"value": "X", "found": True, "context_box_0_1000": [0, 0, 0, 0]},  # zero-area
        {"value": "Y", "found": True},                                       # no box
        {"value": "Z", "found": True, "context_box_0_1000": [1, 2, 3]},     # wrong arity
    ]
    result = parse_sentence_response(response, page_w_px=1000, page_h_px=1000)
    assert result == {"X": [], "Y": [], "Z": []}


def test_build_sentence_prompt_lists_all_values_and_explains_schema():
    prompt = build_sentence_prompt(["STELLA", "26400"])
    assert "STELLA" in prompt and "26400" in prompt
    # Must mention the 0-1000 normalised coordinate system
    assert "1000" in prompt
    # Must explicitly ask for sentence-level box (not tight value box)
    assert "sentence" in prompt.lower()


def test_build_pinpoint_prompt_includes_value_and_hint():
    prompt = build_pinpoint_prompt("28/11/2014", "Registered on 28/11/2014 in the SRO")
    assert "28/11/2014" in prompt
    assert "Registered on 28/11/2014 in the SRO" in prompt
    # Tells the model coords are relative to THIS CROP
    assert "crop" in prompt.lower()


if __name__ == "__main__":
    test_to_pixel_box_converts_normalized_coords()
    test_to_pixel_box_rejects_invalid_shapes()
    test_parse_sentence_response_groups_by_value()
    test_parse_sentence_response_skips_invalid_boxes()
    test_build_sentence_prompt_lists_all_values_and_explains_schema()
    test_build_pinpoint_prompt_includes_value_and_hint()
    print("OK")
