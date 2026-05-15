"""Re-run Approach A on the verify=no cases WITHOUT the verification step.

Test: are the locator bboxes actually correct? If yes, the verification step
is the only thing preventing A from being the clear winner.
"""
import io
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image
from bench_approaches import (
    _gemini_call, _trim_to_ink, annotate, tesseract_find,
    PROMPT_LOCATE, OUT_DIR,
)


def locate_only(png_path: str, value: str):
    """Gemini native bbox WITHOUT verification — pure locator output."""
    # Skip Tesseract here so we see the Gemini bbox specifically
    t0 = time.time()
    with open(png_path, "rb") as f:
        page_bytes = f.read()
    with Image.open(png_path) as img:
        W, H = img.size
    resp = _gemini_call(page_bytes, PROMPT_LOCATE.format(value=value))
    m = re.search(r"\{.*\}", resp, re.DOTALL)
    if not m:
        return None, f"no_json: {resp[:120]}", time.time() - t0
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        return None, f"bad_json: {e}", time.time() - t0
    if not data.get("bbox") or data.get("rendition") == "not_found":
        return None, "not_found", time.time() - t0
    ymin, xmin, ymax, xmax = data["bbox"]
    pixel_box = [
        round(xmin / 1000 * W), round(ymin / 1000 * H),
        round(xmax / 1000 * W), round(ymax / 1000 * H),
    ]
    with Image.open(png_path) as img:
        pixel_box = _trim_to_ink(img, pixel_box)
    return pixel_box, data.get("rendition", "unknown"), time.time() - t0


def main():
    rows = json.load(open("bench_results.json", encoding="utf-8"))
    # Find A-rows where verify=no
    targets = [r for r in rows if r["approach"] == "A" and r.get("verified") == "no"]
    print(f"[*] Re-running {len(targets)} A-cases WITHOUT verification")

    for r in targets:
        png = r["png"]; value = r["value"]; cid = r["case_id"]
        print(f"\n--- {cid} ---")
        print(f"    value={value!r}")
        bbox, rend, elapsed = locate_only(png, value)
        print(f"    locator-only bbox={bbox} rendition={rend} elapsed={elapsed:.1f}s")
        out_png = os.path.join(OUT_DIR, cid, "approach_A_noverify.png")
        try:
            annotate(png, bbox, "Approach A (no verify)", out_png)
        except Exception as e:
            print(f"    annotate failed: {e}")


if __name__ == "__main__":
    main()
