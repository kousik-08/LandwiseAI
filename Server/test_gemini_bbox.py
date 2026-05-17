"""Unit tests for GeminiBboxLocator parsing and prompt building."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.gemini_bbox import (
    GeminiBboxLocator,
    parse_bbox_response,
    build_locate_prompt,
)


def test_parse_response_extracts_boxes_per_value():
    """Gemini returns a list of {value, found, box_0_1000?}. Parser groups by value."""
    response = [
        {"value": "STELLA", "found": True, "box_0_1000": [100, 200, 300, 400]},
        {"value": "STELLA", "found": True, "box_0_1000": [500, 600, 700, 800]},
        {"value": "26400", "found": False},
    ]
    result = parse_bbox_response(response, page_w_px=1000, page_h_px=2000)
    assert "STELLA" in result
    assert "26400" in result
    assert len(result["STELLA"]) == 2
    assert result["26400"] == []


def test_parse_response_converts_normalized_to_pixels():
    """Box [ymin, xmin, ymax, xmax] in 0-1000 -> pixels using page dims."""
    response = [{"value": "X", "found": True, "box_0_1000": [100, 200, 300, 400]}]
    # Gemini convention: [ymin, xmin, ymax, xmax]
    result = parse_bbox_response(response, page_w_px=1000, page_h_px=2000)
    # ymin=100/1000*2000=200, xmin=200/1000*1000=200,
    # ymax=300/1000*2000=600, xmax=400/1000*1000=400
    xmin, ymin, xmax, ymax = result["X"][0]
    assert (xmin, ymin, xmax, ymax) == (200, 200, 400, 600)


def test_parse_response_skips_invalid_box_shapes():
    response = [
        {"value": "X", "found": True, "box_0_1000": [100, 200, 300]},  # wrong arity
        {"value": "Y", "found": True, "box_0_1000": [0, 0, 0, 0]},     # zero-area
        {"value": "Z", "found": True},                                  # no box
    ]
    result = parse_bbox_response(response, page_w_px=1000, page_h_px=1000)
    assert result == {"X": [], "Y": [], "Z": []}


def test_build_prompt_lists_all_values():
    prompt = build_locate_prompt(["STELLA", "26400"])
    assert "STELLA" in prompt
    assert "26400" in prompt
    # The prompt must mention the 0-1000 coordinate system.
    assert "1000" in prompt


if __name__ == "__main__":
    test_parse_response_extracts_boxes_per_value()
    test_parse_response_converts_normalized_to_pixels()
    test_parse_response_skips_invalid_box_shapes()
    test_build_prompt_lists_all_values()
    print("OK")
