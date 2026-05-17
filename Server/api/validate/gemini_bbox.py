"""
Gemini native bounding-box locator.

Replaces the grid+ruler pipeline. Sends ONE call per page containing a list of
values to locate; Gemini returns a JSON array of `{value, found, box_0_1000}`
entries, where `box_0_1000` follows the Gemini convention of
`[ymin, xmin, ymax, xmax]` normalized to 0-1000.

The class wraps a `GeminiHelper` instance and exposes `locate(...)`. The pure
helpers `build_locate_prompt` and `parse_bbox_response` are exported separately
so they can be unit-tested without a network call.
"""

# Pixel-area floor: anything below is treated as a hallucinated "speck."
# At typical deed DPI (200) a real word token is roughly 80 x 20 = 1600 px².
MIN_BOX_AREA_PX = 80 * 20


def build_locate_prompt(values):
    """Construct the per-page locate prompt for the given values."""
    bullet_list = "\n".join(f"  - {v!r}" for v in values)
    return f"""
TASK: For EACH of the following values, find ALL occurrences on this page and
return their bounding boxes. Tamil and English renderings of the same fact
both count as matches.

Values:
{bullet_list}

For every value, emit one entry per visible occurrence (or one entry with
"found": false if the value is not on the page in any rendering).

Coordinate system:
  - Each box is `[ymin, xmin, ymax, xmax]` normalized to integers in [0, 1000]
    measured from the TOP-LEFT corner of the page image.
  - Enclose ONLY the value token tightly — do NOT include the surrounding line
    or paragraph.

Return a JSON array. Do not include any prose outside the JSON.
""".strip()


# Response schema for google-genai structured output.
LOCATE_RESPONSE_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "value": {"type": "STRING"},
            "found": {"type": "BOOLEAN"},
            "box_0_1000": {
                "type": "ARRAY",
                "items": {"type": "INTEGER"},
            },
        },
        "required": ["value", "found"],
    },
}


def _to_pixel_box(box_0_1000, page_w_px, page_h_px):
    """Convert [ymin, xmin, ymax, xmax] (0-1000) -> (xmin, ymin, xmax, ymax) px."""
    if not isinstance(box_0_1000, list) or len(box_0_1000) != 4:
        return None
    try:
        ymin_n, xmin_n, ymax_n, xmax_n = [int(v) for v in box_0_1000]
    except (ValueError, TypeError):
        return None
    xmin = int(xmin_n / 1000 * page_w_px)
    ymin = int(ymin_n / 1000 * page_h_px)
    xmax = int(xmax_n / 1000 * page_w_px)
    ymax = int(ymax_n / 1000 * page_h_px)
    if xmax <= xmin or ymax <= ymin:
        return None
    area = (xmax - xmin) * (ymax - ymin)
    if area < MIN_BOX_AREA_PX:
        return None
    return (xmin, ymin, xmax, ymax)


def parse_bbox_response(response, page_w_px, page_h_px):
    """Group response entries by value; convert to pixel boxes; drop invalid."""
    out = {}
    for entry in response or []:
        if not isinstance(entry, dict):
            continue
        v = entry.get("value")
        if not isinstance(v, str):
            continue
        out.setdefault(v, [])
        if not entry.get("found"):
            continue
        box = _to_pixel_box(
            entry.get("box_0_1000"), page_w_px, page_h_px
        )
        if box is not None:
            out[v].append(box)
    return out


class GeminiBboxLocator:
    """Runtime wrapper that pairs the helpers above with a GeminiHelper."""

    def __init__(self, gemini_helper):
        self.gemini = gemini_helper

    def locate(self, page_image_path, page_w_px, page_h_px, values):
        """Locate every value on one page. Returns `{value: [pixel_box, ...]}`."""
        if not values:
            return {}
        prompt = build_locate_prompt(values)
        try:
            response = self.gemini.generate_json_from_file(
                file_path=page_image_path,
                prompt=prompt,
                response_schema=LOCATE_RESPONSE_SCHEMA,
                display_name="VD Locate",
            )
        except Exception as e:
            print(f"[VD] gemini bbox error: {e}")
            return {v: [] for v in values}
        return parse_bbox_response(response, page_w_px, page_h_px)
