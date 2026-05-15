"""
Benchmark all three visual-debugger redesign approaches against real mismatches.

Approach A — Native Gemini 2.5 bounding-box output + verification crop.
Approach B — Multi-engine OCR fusion (Tesseract + EasyOCR).
Approach C — Region proposal (EasyOCR detector) + Gemini classification.

For each case in bench_cases.json, runs all three approaches, times them,
records the returned bbox + provenance, and renders an annotated PNG so a
human can eyeball whether the box landed on the right ink.

Outputs:
  bench_results.json     — structured results for each case × approach
  bench_out/<case>/<approach>.png — annotated page PNG with the bbox drawn
"""
import io
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Optional

# Pin working dir for relative paths
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv()

from PIL import Image, ImageDraw, ImageFont, ImageStat  # noqa: E402

# Lazy / soft imports — keep startup fast and let missing libs fall through
try:
    import pytesseract
    from pytesseract import Output
    HAVE_TESS = True
except ImportError:
    HAVE_TESS = False

try:
    import easyocr  # noqa
    HAVE_EASY = True
except ImportError:
    HAVE_EASY = False

try:
    from google import genai
    from google.genai import types
    HAVE_GEMINI = True
except ImportError:
    HAVE_GEMINI = False

CASES_FILE = "bench_cases.json"
OUT_DIR = "bench_out"
RESULTS_FILE = "bench_results.json"
GEMINI_MODEL = os.getenv("GEMINI_MODEL_VISION") or "gemini-2.5-flash"


# ──────────────────────────────────────────────────────────────────────────────
# Shared utilities

@dataclass
class Result:
    approach: str
    case_id: str
    bbox: Optional[list] = None          # [xmin, ymin, xmax, ymax] in PNG pixels
    method: str = ""                      # which sub-strategy fired (tesseract / gemini / etc.)
    rendition: Optional[str] = None       # typed / handwritten / seal / unknown
    verified: Optional[str] = None        # yes / no / partial / skipped
    elapsed_s: float = 0.0
    error: Optional[str] = None
    note: str = ""


def _load_font(size: int):
    for family in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(family, size)
        except OSError:
            continue
    return ImageFont.load_default()


def annotate(png_path: str, bbox: Optional[list], label: str, out_path: str):
    """Draw a red bbox + label on the page PNG and save to out_path."""
    with Image.open(png_path) as img:
        rgb = img.convert("RGB").copy()
        if bbox:
            d = ImageDraw.Draw(rgb)
            x0, y0, x1, y1 = [int(v) for v in bbox]
            d.rectangle([x0, y0, x1, y1], outline=(255, 0, 0), width=4)
            f = _load_font(28)
            tb = d.textbbox((x0, max(0, y0 - 30)), label, font=f)
            d.rectangle(tb, fill=(255, 255, 255))
            d.text((x0, max(0, y0 - 30)), label, fill=(255, 0, 0), font=f)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        rgb.save(out_path)


_NORM_RE = re.compile(r"[\s,.\-/:;'\"`()\[\]{}|<>?!*&^%$#@~+=_‌‍]+")


def _normalize(s: str) -> str:
    return _NORM_RE.sub("", (s or "").lower())


def _trim_to_ink(img: Image.Image, bbox: list) -> list:
    """Snap bbox to the dark-ink bounding rect inside it."""
    W, H = img.size
    x0, y0, x1, y1 = [int(v) for v in bbox]
    x0 = max(0, x0); y0 = max(0, y0); x1 = min(W, x1); y1 = min(H, y1)
    if x1 - x0 < 5 or y1 - y0 < 5:
        return bbox
    gray = img.convert("L").crop((x0, y0, x1, y1))
    mask = gray.point(lambda p: 255 if p < 160 else 0)
    ink_ratio = ImageStat.Stat(mask).mean[0] / 255.0
    if ink_ratio < 0.015:
        return bbox
    inkbox = mask.getbbox()
    if not inkbox:
        return bbox
    l, t, r, b = inkbox
    return [x0 + l, y0 + t, x0 + r, y0 + b]


# ──────────────────────────────────────────────────────────────────────────────
# Gemini client (singleton)

_GEMINI_CLIENT = None


def gemini_client():
    global _GEMINI_CLIENT
    if _GEMINI_CLIENT is None and HAVE_GEMINI:
        key = os.getenv("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY not set")
        _GEMINI_CLIENT = genai.Client(api_key=key)
    return _GEMINI_CLIENT


def _gemini_call(image_bytes: bytes, prompt: str, mime="image/png", retries=2) -> str:
    cli = gemini_client()
    img_part = types.Part.from_bytes(data=image_bytes, mime_type=mime)
    last_err = None
    for attempt in range(retries):
        try:
            resp = cli.models.generate_content(
                model=GEMINI_MODEL,
                contents=[img_part, prompt],
                config=types.GenerateContentConfig(temperature=0.0, top_p=0.1),
            )
            return resp.text or ""
        except Exception as e:
            last_err = e
            time.sleep(2 ** attempt)
    raise last_err  # type: ignore


# ──────────────────────────────────────────────────────────────────────────────
# Tesseract fast-path (shared with Approach B too)

def tesseract_find(png_path: str, value: str, lang="tam+eng") -> Optional[dict]:
    if not HAVE_TESS or not value:
        return None
    try:
        with Image.open(png_path) as img:
            try:
                data = pytesseract.image_to_data(img, lang=lang, output_type=Output.DICT)
            except pytesseract.TesseractError:
                if lang != "eng":
                    data = pytesseract.image_to_data(img, lang="eng", output_type=Output.DICT)
                else:
                    return None
    except Exception:
        return None

    words = data.get("text", []) or []
    norm_lower = [(w or "").strip().lower() for w in words]
    norm_clean = [_normalize(w or "") for w in words]
    n = len(words)
    needle_lower = re.sub(r"\s+", " ", value).strip().lower()
    needle_norm = _normalize(value)
    if not needle_lower and not needle_norm:
        return None

    def _box(start: int, count: int):
        lefts, tops, rights, bots = [], [], [], []
        for j in range(start, start + count):
            if not (words[j] or "").strip():
                continue
            lefts.append(data["left"][j]); tops.append(data["top"][j])
            rights.append(data["left"][j] + data["width"][j])
            bots.append(data["top"][j] + data["height"][j])
        if not lefts:
            return None
        return [min(lefts), min(tops), max(rights), max(bots)]

    # 1. Verbatim sliding window
    tokens = needle_lower.split()
    if tokens:
        for i in range(n - len(tokens) + 1):
            win = " ".join(norm_lower[i:i + len(tokens)]).strip()
            if win == needle_lower:
                box = _box(i, len(tokens))
                if box:
                    return {"box": box, "method": "tesseract.exact"}

    # 2. Normalized-concat sliding window (1..6 tokens)
    if needle_norm:
        for w in range(1, 7):
            if w > n: break
            for i in range(n - w + 1):
                concat = "".join(norm_clean[i:i + w])
                if concat and concat == needle_norm:
                    box = _box(i, w)
                    if box:
                        return {"box": box, "method": f"tesseract.norm.w{w}"}

    # 3. Fuzzy (for digit/ID-heavy)
    if needle_norm and len(needle_norm) >= 4:
        best_ratio, best_box, best_meta = 0.0, None, None
        for w in range(1, 7):
            if w > n: break
            for i in range(n - w + 1):
                concat = "".join(norm_clean[i:i + w])
                if not concat: continue
                if abs(len(concat) - len(needle_norm)) > max(3, len(needle_norm) // 3):
                    continue
                r = SequenceMatcher(None, concat, needle_norm).ratio()
                if r > best_ratio:
                    best_ratio, best_box, best_meta = r, _box(i, w), (i, w, concat)
        if best_box and best_ratio >= 0.85:
            return {"box": best_box, "method": f"tesseract.fuzzy.{best_ratio:.2f}"}

    return None


# ──────────────────────────────────────────────────────────────────────────────
# Approach A — Native Gemini 2.5 bbox + verification

PROMPT_LOCATE = """\
TASK: Locate the value "{value}" on this page of a Tamil land deed.

The value may appear as:
  (a) TYPED machine-printed text (body, table, registrar block)
  (b) Inside a round SEAL or STAMP
  (c) HANDWRITTEN endorsement or margin note

If it appears in multiple renditions, prefer typed > seal > handwritten.
If the value does NOT appear, return "not_found".

Translation/format variants are valid hits:
  "April 14, 2008" == "14-04-2008" == "14-ந்தேதி ஏப்ரல்"

Return ONE JSON object on a single line, no prose, no backticks:
  {{"bbox":[ymin,xmin,ymax,xmax],"rendition":"typed|seal|handwritten","confidence":0.0-1.0}}
or
  {{"bbox":null,"rendition":"not_found","confidence":0.0}}

bbox values are normalized 0..1000 (Gemini native format).
Tightly enclose ONLY the value tokens, NOT the surrounding sentence.
"""


PROMPT_VERIFY = """\
The image is a crop from a Tamil land deed.
Question: does this crop contain the value "{value}"?

Reply with EXACTLY ONE word, no punctuation:
  yes      - the value is fully visible in the crop
  partial  - the value is partly visible (cut off at an edge)
  no       - the value is not in the crop
"""


def approach_a(png_path: str, value: str) -> Result:
    r = Result(approach="A", case_id="", method="approach_a")
    t0 = time.time()

    # 0. Tesseract fast-path stays — keeps the cheap wins
    tess = tesseract_find(png_path, value)
    if tess:
        r.bbox = tess["box"]
        r.method = tess["method"]
        r.rendition = "typed"
        r.verified = "skipped"
        r.elapsed_s = time.time() - t0
        return r

    # 1. Gemini native bbox
    try:
        with open(png_path, "rb") as f:
            page_bytes = f.read()
        with Image.open(png_path) as img:
            W, H = img.size
        resp = _gemini_call(page_bytes, PROMPT_LOCATE.format(value=value))
        # Extract JSON
        m = re.search(r"\{.*\}", resp, re.DOTALL)
        if not m:
            r.error = f"no_json_in_response: {resp[:120]}"
            r.elapsed_s = time.time() - t0
            return r
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError as e:
            r.error = f"bad_json: {e}; raw={resp[:120]}"
            r.elapsed_s = time.time() - t0
            return r

        if not data.get("bbox") or data.get("rendition") == "not_found":
            r.rendition = "not_found"
            r.method = "approach_a.gemini_not_found"
            r.elapsed_s = time.time() - t0
            return r

        ymin, xmin, ymax, xmax = data["bbox"]
        pixel_box = [
            round(xmin / 1000 * W),
            round(ymin / 1000 * H),
            round(xmax / 1000 * W),
            round(ymax / 1000 * H),
        ]
        r.rendition = data.get("rendition", "unknown")
        r.method = "approach_a.gemini_native"

        # 2. Verification crop (20% margin)
        try:
            mw = max(20, int((pixel_box[2] - pixel_box[0]) * 0.2))
            mh = max(20, int((pixel_box[3] - pixel_box[1]) * 0.2))
            cx0 = max(0, pixel_box[0] - mw); cy0 = max(0, pixel_box[1] - mh)
            cx1 = min(W, pixel_box[2] + mw); cy1 = min(H, pixel_box[3] + mh)
            with Image.open(png_path) as img:
                crop = img.crop((cx0, cy0, cx1, cy1))
                buf = io.BytesIO(); crop.save(buf, format="PNG")
            verdict = _gemini_call(buf.getvalue(), PROMPT_VERIFY.format(value=value)).strip().lower()
            verdict = verdict.split()[0] if verdict else "no"
            r.verified = verdict
            if verdict == "no":
                r.note = "verify=no, bbox discarded"
                r.bbox = None
            elif verdict == "partial":
                # widen 30% on each side once
                ww = (pixel_box[2] - pixel_box[0]) * 0.3
                hh = (pixel_box[3] - pixel_box[1]) * 0.3
                pixel_box = [max(0, int(pixel_box[0]-ww)), max(0, int(pixel_box[1]-hh)),
                             min(W, int(pixel_box[2]+ww)), min(H, int(pixel_box[3]+hh))]
                r.note = "verify=partial, widened"
                r.bbox = pixel_box
            else:
                r.bbox = pixel_box
        except Exception as e:
            r.verified = "error"
            r.bbox = pixel_box
            r.note = f"verify failed, kept original: {e}"

        # 3. Ink-snap
        if r.bbox:
            with Image.open(png_path) as img:
                r.bbox = _trim_to_ink(img, r.bbox)
        r.elapsed_s = time.time() - t0
        return r
    except Exception as e:
        r.error = f"{type(e).__name__}: {e}"
        r.elapsed_s = time.time() - t0
        return r


# ──────────────────────────────────────────────────────────────────────────────
# Approach B — Multi-engine OCR fusion (Tesseract + EasyOCR)

_EASY = None


def easy_reader():
    """English-only because EasyOCR's bundled Tamil model has a checkpoint
    size-mismatch in the current version. The CRAFT detector is language-
    agnostic, so Approach C (which only uses detection) is unaffected.
    Approach B (which uses recognition) will miss Tamil values — that's a
    genuine limitation of OCR-fusion approaches on this corpus."""
    global _EASY
    if _EASY is None and HAVE_EASY:
        _EASY = easyocr.Reader(['en'], gpu=False, verbose=False)
    return _EASY


def approach_b(png_path: str, value: str) -> Result:
    r = Result(approach="B", case_id="", method="approach_b")
    t0 = time.time()

    # 1. Tesseract first (fastest)
    tess = tesseract_find(png_path, value)
    if tess:
        r.bbox = tess["box"]
        r.method = "B.tesseract"
        r.rendition = "typed"
        with Image.open(png_path) as img:
            r.bbox = _trim_to_ink(img, r.bbox)
        r.elapsed_s = time.time() - t0
        return r

    # 2. EasyOCR
    try:
        reader = easy_reader()
        if reader is None:
            r.error = "easyocr_unavailable"
            r.elapsed_s = time.time() - t0
            return r
        result = reader.readtext(png_path, detail=1, paragraph=False)
        # result: list of (bbox_poly, text, confidence)
        needle_norm = _normalize(value)
        needle_lower = re.sub(r"\s+", " ", value).strip().lower()
        if not result:
            r.error = "easyocr_no_text"
            r.elapsed_s = time.time() - t0
            return r

        # Try exact / normalized / fuzzy on EasyOCR tokens
        best, best_ratio = None, 0.0
        for poly, text, conf in result:
            t_lower = (text or "").strip().lower()
            t_norm = _normalize(text or "")
            if needle_lower and (t_lower == needle_lower or needle_lower in t_lower):
                xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
                r.bbox = [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]
                r.method = f"B.easyocr.exact"
                r.rendition = "handwritten_or_typed"
                with Image.open(png_path) as img:
                    r.bbox = _trim_to_ink(img, r.bbox)
                r.elapsed_s = time.time() - t0
                return r
            if needle_norm and t_norm:
                if needle_norm == t_norm:
                    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
                    r.bbox = [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]
                    r.method = f"B.easyocr.norm"
                    r.rendition = "handwritten_or_typed"
                    with Image.open(png_path) as img:
                        r.bbox = _trim_to_ink(img, r.bbox)
                    r.elapsed_s = time.time() - t0
                    return r
                ratio = SequenceMatcher(None, t_norm, needle_norm).ratio()
                if ratio > best_ratio:
                    best_ratio = ratio
                    best = poly

        # Also try sliding-window concat across EasyOCR tokens (handles split tokens)
        tokens = [(_normalize(t), poly) for poly, t, _ in result if t]
        if needle_norm and tokens:
            for w in range(2, 6):
                for i in range(len(tokens) - w + 1):
                    concat = "".join(tok for tok, _ in tokens[i:i+w])
                    if not concat: continue
                    if concat == needle_norm:
                        polys = [p for _, p in tokens[i:i+w]]
                        all_pts = [pt for poly in polys for pt in poly]
                        xs = [p[0] for p in all_pts]; ys = [p[1] for p in all_pts]
                        r.bbox = [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]
                        r.method = f"B.easyocr.concat.w{w}"
                        r.rendition = "handwritten_or_typed"
                        with Image.open(png_path) as img:
                            r.bbox = _trim_to_ink(img, r.bbox)
                        r.elapsed_s = time.time() - t0
                        return r
                    ratio = SequenceMatcher(None, concat, needle_norm).ratio()
                    if ratio > best_ratio:
                        best_ratio = ratio
                        polys = [p for _, p in tokens[i:i+w]]
                        best = [pt for poly in polys for pt in poly]

        if best and best_ratio >= 0.80:
            xs = [p[0] for p in best]; ys = [p[1] for p in best]
            r.bbox = [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]
            r.method = f"B.easyocr.fuzzy.{best_ratio:.2f}"
            r.rendition = "handwritten_or_typed"
            with Image.open(png_path) as img:
                r.bbox = _trim_to_ink(img, r.bbox)
            r.elapsed_s = time.time() - t0
            return r

        r.error = f"easyocr_no_match (best_ratio={best_ratio:.2f})"
        r.elapsed_s = time.time() - t0
        return r
    except Exception as e:
        r.error = f"{type(e).__name__}: {e}"
        r.elapsed_s = time.time() - t0
        return r


# ──────────────────────────────────────────────────────────────────────────────
# Approach C — Region proposal (EasyOCR detector) + Gemini classification

PROMPT_CLASSIFY = """\
The image attached shows a Tamil land deed page with NUMBERED RED BOXES
overlaid on every detected text region. Each box has a unique integer index
printed at its top-left corner.

TASK: Which numbered box (or boxes) contains the value "{value}"?

The value may appear typed, inside a seal, or handwritten. Translation /
format variants are valid hits ("14-04-2008" == "April 14, 2008" ==
"14-ந்தேதி ஏப்ரல்").

Reply with ONE JSON object on a single line, no prose:
  {{"indices": [N], "rendition": "typed|seal|handwritten"}}
If no box contains the value, return:
  {{"indices": [], "rendition": "not_found"}}
Provide multiple indices ONLY if the value spans contiguous boxes.
"""


def approach_c(png_path: str, value: str) -> Result:
    r = Result(approach="C", case_id="", method="approach_c")
    t0 = time.time()

    # 1. Tesseract fast-path (same cheap win)
    tess = tesseract_find(png_path, value)
    if tess:
        r.bbox = tess["box"]
        r.method = "C.tesseract"
        r.rendition = "typed"
        with Image.open(png_path) as img:
            r.bbox = _trim_to_ink(img, r.bbox)
        r.elapsed_s = time.time() - t0
        return r

    # 2. Detect text regions with EasyOCR (detection only)
    try:
        reader = easy_reader()
        if reader is None:
            r.error = "easyocr_unavailable"
            r.elapsed_s = time.time() - t0
            return r
        # detail=1 gives polys; we'll IGNORE the recognized text (use only the boxes)
        det = reader.readtext(png_path, detail=1, paragraph=False)
        if not det:
            r.error = "no_regions_detected"
            r.elapsed_s = time.time() - t0
            return r

        # Convert polys → axis-aligned boxes
        regions = []
        for poly, _, _ in det:
            xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
            regions.append([int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))])

        # Render numbered-box overlay on the page
        with Image.open(png_path) as img:
            W, H = img.size
            overlay = img.convert("RGB").copy()
            d = ImageDraw.Draw(overlay)
            f = _load_font(22)
            for i, (x0, y0, x1, y1) in enumerate(regions):
                d.rectangle([x0, y0, x1, y1], outline=(255, 0, 0), width=2)
                # Label background for contrast
                lbl = str(i)
                tb = d.textbbox((x0, max(0, y0 - 22)), lbl, font=f)
                d.rectangle(tb, fill=(255, 255, 255))
                d.text((x0, max(0, y0 - 22)), lbl, fill=(255, 0, 0), font=f)
            buf = io.BytesIO()
            overlay.save(buf, format="PNG")

        # 3. Ask Gemini which box index
        resp = _gemini_call(buf.getvalue(), PROMPT_CLASSIFY.format(value=value))
        m = re.search(r"\{.*\}", resp, re.DOTALL)
        if not m:
            r.error = f"no_json: {resp[:120]}"
            r.elapsed_s = time.time() - t0
            return r
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError as e:
            r.error = f"bad_json: {e}"
            r.elapsed_s = time.time() - t0
            return r

        indices = data.get("indices") or []
        r.rendition = data.get("rendition", "unknown")
        if not indices:
            r.method = "approach_c.not_found"
            r.elapsed_s = time.time() - t0
            return r

        # Union the chosen regions
        chosen = [regions[i] for i in indices if 0 <= i < len(regions)]
        if not chosen:
            r.error = f"invalid_indices: {indices}"
            r.elapsed_s = time.time() - t0
            return r
        xs0 = min(c[0] for c in chosen); ys0 = min(c[1] for c in chosen)
        xs1 = max(c[2] for c in chosen); ys1 = max(c[3] for c in chosen)
        r.bbox = [xs0, ys0, xs1, ys1]
        r.method = f"approach_c.gemini.idx={indices}"
        with Image.open(png_path) as img:
            r.bbox = _trim_to_ink(img, r.bbox)
        r.elapsed_s = time.time() - t0
        return r
    except Exception as e:
        r.error = f"{type(e).__name__}: {e}"
        r.elapsed_s = time.time() - t0
        return r


# ──────────────────────────────────────────────────────────────────────────────
# Driver

def case_id(c: dict) -> str:
    field = re.sub(r"[^A-Za-z0-9]+", "_", c["field"])[:30]
    return f"{c['doc_no']}_p{c['page']}_{field}"


def main():
    if not os.path.exists(CASES_FILE):
        print(f"[!] {CASES_FILE} missing. Run bench_pick_cases.py first.")
        return
    cases = json.load(open(CASES_FILE, encoding="utf-8"))
    print(f"[*] {len(cases)} cases loaded")
    print(f"[*] Gemini model: {GEMINI_MODEL}")
    print(f"[*] HAVE_TESS={HAVE_TESS} HAVE_EASY={HAVE_EASY} HAVE_GEMINI={HAVE_GEMINI}")

    # Optional: filter by env CASE_LIMIT for quick iteration
    limit = int(os.getenv("CASE_LIMIT") or "0") or len(cases)
    cases = cases[:limit]

    # Optional: CASE_START to skip cases already done in a previous run
    start = int(os.getenv("CASE_START") or "1")
    # Optional: SKIP_APPROACH = "B" or "AB" to skip approaches per case
    skip_approaches = set(os.getenv("SKIP_APPROACH") or "")
    cases_to_run = cases[start - 1:]
    print(f"[*] Running cases {start}..{start + len(cases_to_run) - 1} (skip approaches: {skip_approaches or 'none'})\n")

    # Load existing results if present so we extend rather than overwrite
    results = []
    if os.path.exists(RESULTS_FILE):
        try:
            results = json.load(open(RESULTS_FILE, encoding="utf-8"))
            print(f"[*] Loaded {len(results)} pre-existing results — new rows will be appended")
        except Exception:
            results = []

    for idx, c in enumerate(cases_to_run, start):
        cid = case_id(c)
        png = c["png"]
        value = c["value"]
        print(f"[{idx}/{len(cases)}] {cid}")
        print(f"        value={value!r}")

        for approach_fn, name in [(approach_a, "A"), (approach_b, "B"), (approach_c, "C")]:
            if name in skip_approaches:
                print(f"   [{name}] skipped via SKIP_APPROACH")
                continue
            try:
                r = approach_fn(png, value)
            except Exception as e:
                r = Result(approach=name, case_id=cid, error=f"crash: {e}")
            r.case_id = cid
            label = f"Approach {name}"
            print(f"   [{name}] bbox={r.bbox} method={r.method!r} rend={r.rendition} "
                  f"verify={r.verified} elapsed={r.elapsed_s:.1f}s err={r.error}")
            out_png = os.path.join(OUT_DIR, cid, f"approach_{name}.png")
            try:
                annotate(png, r.bbox, label, out_png)
            except Exception as e:
                print(f"        [annotate failed: {e}]")
            results.append({
                "case_id": cid, "doc_no": c["doc_no"], "page": c["page"],
                "field": c["field"], "value": value, "png": png,
                "approach": name, "bbox": r.bbox, "method": r.method,
                "rendition": r.rendition, "verified": r.verified,
                "elapsed_s": r.elapsed_s, "error": r.error, "note": r.note,
            })
            # Persist after every approach so a crash mid-run doesn't lose progress
            with open(RESULTS_FILE, "w", encoding="utf-8") as f:
                json.dump(results, f, ensure_ascii=False, indent=2)
        print()

    print(f"[*] Saved results to {RESULTS_FILE}")


if __name__ == "__main__":
    main()
