"""
Visual debugger — two-call LLM flow.

For every mismatched value:
  1. SentenceContextLocator  (LLM call #1, full page):
        Returns a coarse box around the SENTENCE containing the value so the
        value is never isolated / hidden. One call per page covers every
        mismatch on that page.
  2. ValuePinpointLocator    (LLM call #2, cropped sentence with 400 px space):
        Crops the page to the sentence box + CONTEXT_PADDING_PX padding on
        every side, then asks Gemini for the tight pixel box of the value
        inside the crop. Coords are mapped back to full-page pixels.
  3. mark_pdf_with_boxes draws every located box on the PDF in one save cycle.

The previous text-layer + native-bbox + grid-ruler pipelines are removed.
"""
from __future__ import annotations

import os
import re
import json
import shutil
import hashlib
import threading

import fitz  # PyMuPDF
from PIL import Image, ImageDraw

from common.gemini_helper import GeminiHelper
from common.storage_sync import sync_file as _sync_file


# Padding (px) applied on every side when cropping the sentence box for
# LLM call #2. The "400 space" the spec calls out: keep the surrounding
# sentence visible so Gemini has enough context to pinpoint the value.
CONTEXT_PADDING_PX = 400

# Render DPI for page rasterization. Shared by every step:
#   PDF pts × SCALE = PNG px → Gemini coords → PNG px ÷ SCALE = PDF pts
DPI = 200
SCALE = DPI / 72.0

# Reject obvious hallucinations: at DPI=200 a real word token is ≥ ~80×20 px².
MIN_BOX_AREA_PX = 80 * 20

# Local debug artefacts: spacing (in PNG px) of the faint grid drawn onto
# `grid_<doc>_p<N>.png`. Matches CONTEXT_PADDING_PX so the operator can
# eyeball "one grid cell ≈ one crop padding band".
GRID_SPACING_PX = CONTEXT_PADDING_PX
GRID_COLOR = (0, 120, 255)
GRID_ALPHA = 70


def draw_grid_overlay(src_image_path: str, out_path: str,
                      spacing_px: int = GRID_SPACING_PX) -> str:
    """
    Save a copy of ``src_image_path`` with a faint blue grid every
    ``spacing_px`` pixels. Used only for local inspection — never sent to
    Gemini (call #1 sees the raw page, call #2 sees the raw crop).
    """
    with Image.open(src_image_path) as img:
        base = img.convert("RGBA")
        w, h = base.size
        overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        gd = ImageDraw.Draw(overlay)
        rgba = (*GRID_COLOR, GRID_ALPHA)
        for x in range(0, w, spacing_px):
            gd.line([(x, 0), (x, h)], fill=rgba, width=1)
        for y in range(0, h, spacing_px):
            gd.line([(0, y), (w, y)], fill=rgba, width=1)
        composed = Image.alpha_composite(base, overlay).convert("RGB")
        composed.save(out_path)
    return out_path


# ── LLM call #1: sentence-level descriptive locator ────────────────────────

SENTENCE_RESPONSE_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "value": {"type": "STRING"},
            "found": {"type": "BOOLEAN"},
            "context_sentence": {"type": "STRING"},
            "context_box_0_1000": {
                "type": "ARRAY",
                "items": {"type": "INTEGER"},
            },
        },
        "required": ["value", "found"],
    },
}


def build_sentence_prompt(values: list[str]) -> str:
    """Per-page descriptive locator prompt for LLM call #1."""
    bullet_list = "\n".join(f"  - {v!r}" for v in values)
    return f"""
TASK: For EACH value below, decide whether it appears anywhere on this page
(translations / re-orderings count as a match) and, if yes, return a SHORT
description of the surrounding sentence plus a COARSE bounding box that
encloses that whole sentence (not just the value).

Values:
{bullet_list}

For every value emit ONE entry:
  {{
    "value": <the value, verbatim from the list>,
    "found": <true | false>,
    "context_sentence": <≤ 120 chars of the sentence containing the value;
                         "" if not found>,
    "context_box_0_1000": [ymin, xmin, ymax, xmax]  // see Coordinate system.
                          // Use [0,0,0,0] when not found.
  }}

Coordinate system:
  - All numbers are integers in [0, 1000] measured from the TOP-LEFT corner
    of the page image.
  - The box must enclose the FULL SENTENCE (or table cell) containing the
    value, with a little breathing room — do NOT tightly enclose only the
    value. Tight pinpointing happens in a follow-up call.

Return a JSON array. No prose outside the JSON.
""".strip()


def _to_pixel_box(box_0_1000, page_w_px: int, page_h_px: int):
    """Convert [ymin, xmin, ymax, xmax] (0-1000) → (xmin, ymin, xmax, ymax) px."""
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
    return (xmin, ymin, xmax, ymax)


def parse_sentence_response(response, page_w_px: int, page_h_px: int):
    """
    Group entries by value. Returns ``{value: [SentenceHit, ...]}`` where each
    SentenceHit is ``{"sentence": str, "context_box_px": (x0,y0,x1,y1)}``.

    Entries with ``found=False`` or an invalid/zero-area box are skipped.
    """
    out: dict[str, list[dict]] = {}
    for entry in response or []:
        if not isinstance(entry, dict):
            continue
        v = entry.get("value")
        if not isinstance(v, str):
            continue
        out.setdefault(v, [])
        if not entry.get("found"):
            continue
        box = _to_pixel_box(entry.get("context_box_0_1000"), page_w_px, page_h_px)
        if box is None:
            continue
        out[v].append({
            "sentence": entry.get("context_sentence", "") or "",
            "context_box_px": box,
        })
    return out


class SentenceContextLocator:
    """LLM call #1: per-page descriptive locator (full page → coarse boxes)."""

    def __init__(self, gemini_helper):
        self.gemini = gemini_helper

    def locate(self, page_image_path, page_w_px, page_h_px, values):
        if not values:
            return {}
        prompt = build_sentence_prompt(values)
        try:
            response = self.gemini.generate_json_from_file(
                file_path=page_image_path,
                prompt=prompt,
                response_schema=SENTENCE_RESPONSE_SCHEMA,
                display_name="VD Sentence",
            )
        except Exception as e:
            print(f"[VD] sentence-locator error: {e}")
            return {v: [] for v in values}
        return parse_sentence_response(response, page_w_px, page_h_px)


# ── LLM call #2: pinpoint locator on a cropped sentence region ─────────────

PINPOINT_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "found": {"type": "BOOLEAN"},
        "box_0_1000": {
            "type": "ARRAY",
            "items": {"type": "INTEGER"},
        },
    },
    "required": ["found"],
}


def build_pinpoint_prompt(value: str, sentence_hint: str) -> str:
    hint = f'\nFor context, the value appears in this sentence: "{sentence_hint}".' if sentence_hint else ""
    return f"""
TASK: This image is a CROP from a larger page. Return the TIGHT bounding box
of the value: "{value}".{hint}

Coordinate system:
  - [ymin, xmin, ymax, xmax] as integers in [0, 1000] measured from the
    TOP-LEFT corner of THIS CROP (not the original page).
  - Enclose ONLY the value tokens themselves. Do not include surrounding
    words, the rest of the sentence, or the table cell.

Return JSON: {{"found": true|false, "box_0_1000": [ymin,xmin,ymax,xmax]}}.
Use found=false and box [0,0,0,0] only if the value is genuinely absent
from the crop.
""".strip()


class ValuePinpointLocator:
    """LLM call #2: locate the value tightly inside a sentence-padded crop."""

    def __init__(self, gemini_helper):
        self.gemini = gemini_helper

    @staticmethod
    def crop_with_padding(
        page_image_path: str,
        context_box_px: tuple,
        padding_px: int,
        out_path: str,
    ) -> tuple[tuple[int, int, int, int], tuple[int, int]] | None:
        """
        Crop ``page_image_path`` to ``context_box_px`` expanded by
        ``padding_px`` on every side, save to ``out_path``. Returns
        ``((cx0, cy0, cx1, cy1), (crop_w, crop_h))`` in full-page pixel coords.
        """
        try:
            with Image.open(page_image_path) as img:
                W, H = img.size
                x0, y0, x1, y1 = context_box_px
                cx0 = max(0, x0 - padding_px)
                cy0 = max(0, y0 - padding_px)
                cx1 = min(W, x1 + padding_px)
                cy1 = min(H, y1 + padding_px)
                if cx1 <= cx0 or cy1 <= cy0:
                    return None
                crop = img.crop((cx0, cy0, cx1, cy1))
                crop.save(out_path)
                return (cx0, cy0, cx1, cy1), crop.size
        except Exception as e:
            print(f"[VD] pinpoint: crop failed ({e})")
            return None

    def locate(
        self,
        page_image_path: str,
        context_box_px: tuple,
        value: str,
        sentence_hint: str,
        crop_out_path: str,
    ):
        """
        Returns the tight value box in FULL-PAGE pixel coords
        ``(xmin, ymin, xmax, ymax)`` or ``None``.
        """
        cropped = self.crop_with_padding(
            page_image_path, context_box_px, CONTEXT_PADDING_PX, crop_out_path
        )
        if cropped is None:
            return None
        (cx0, cy0, _cx1, _cy1), (crop_w, crop_h) = cropped

        prompt = build_pinpoint_prompt(value, sentence_hint)
        try:
            response = self.gemini.generate_json_from_file(
                file_path=crop_out_path,
                prompt=prompt,
                response_schema=PINPOINT_RESPONSE_SCHEMA,
                display_name="VD Pinpoint",
            )
        except Exception as e:
            print(f"[VD] pinpoint-locator error: {e}")
            return None

        if not isinstance(response, dict) or not response.get("found"):
            return None
        local = _to_pixel_box(response.get("box_0_1000"), crop_w, crop_h)
        if local is None:
            return None
        lxmin, lymin, lxmax, lymax = local
        area = (lxmax - lxmin) * (lymax - lymin)
        if area < MIN_BOX_AREA_PX:
            print(f"[VD] pinpoint: rejected tiny box {local} ({area}px²) for {value!r}")
            return None
        return (cx0 + lxmin, cy0 + lymin, cx0 + lxmax, cy0 + lymax)


# ── VisualDebugger orchestrator ─────────────────────────────────────────────


class VisualDebugger:
    """
    Two-call LLM visual debugger. See module docstring for the flow.
    """

    DPI = DPI
    SCALE = SCALE
    CONTEXT_PADDING_PX = CONTEXT_PADDING_PX
    MIN_BOX_AREA_PX = MIN_BOX_AREA_PX

    # Bump when the cache schema or LLM prompts change so stale entries
    # don't poison the new flow.
    _CACHE_VERSION = "20"

    MISMATCH_BOX_COLOR = (255, 0, 0)
    MISMATCH_TEXT_COLOR = (255, 0, 0)

    def __init__(self, gemini_helper: GeminiHelper, output_dir: str):
        self.gemini = gemini_helper
        self.sentence_locator = SentenceContextLocator(gemini_helper)
        self.pinpoint_locator = ValuePinpointLocator(gemini_helper)
        self.output_dir = output_dir
        self.temp_dir = os.path.join(output_dir, "temp_debug")
        # Per-document debug artefacts (raw / grid / marked PNGs + context JSON)
        # live under output_dir/debug/<doc_no>/. Kept across runs so an operator
        # can inspect the inputs Gemini saw.
        self.debug_dir = os.path.join(output_dir, "debug")
        self.lock = threading.Lock()
        os.makedirs(self.temp_dir, exist_ok=True)
        os.makedirs(self.debug_dir, exist_ok=True)
        self._cache_path = os.path.join(output_dir, "vd_coord_cache.json")
        self._coord_cache = self._load_cache()
        self.last_coverage_report = None

    # ── Cache ────────────────────────────────────────────────────────────────

    def _load_cache(self) -> dict:
        if os.path.exists(self._cache_path):
            try:
                with open(self._cache_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if data.get("_v") == self._CACHE_VERSION:
                        return data.get("coords", {})
                    print(
                        f"[*] VD Cache format changed (v{data.get('_v', '?')} → "
                        f"v{self._CACHE_VERSION}). Clearing old cache."
                    )
            except Exception:
                pass
        return {}

    def _save_cache(self):
        try:
            payload = {"_v": self._CACHE_VERSION, "coords": self._coord_cache}
            with open(self._cache_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except Exception as e:
            print(f"[!] VD cache save failed: {e}")

    @staticmethod
    def _cache_key(pdf_path: str, page_num: int, field: str, value: str) -> str:
        raw = f"{os.path.basename(pdf_path)}|{page_num}|{field}|{value}"
        return hashlib.md5(raw.encode()).hexdigest()

    def _doc_debug_dir(self, clean_doc_no: str) -> str:
        d = os.path.join(self.debug_dir, clean_doc_no)
        os.makedirs(d, exist_ok=True)
        return d

    @staticmethod
    def _save_context_json(path: str, doc_no: str, page_num: int,
                           values: list[str], hits_by_value: dict) -> None:
        """
        Persist the LLM #1 descriptive context for one page so the operator can
        see what Gemini said about every mismatched value (sentence + coarse box).
        """
        payload = {
            "doc_no": doc_no,
            "page": page_num,
            "values_queried": list(values),
            "hits": [
                {
                    "value": v,
                    "found": bool(hits),
                    "occurrences": [
                        {
                            "context_sentence": h.get("sentence", ""),
                            "context_box_px": list(h.get("context_box_px", ())),
                        }
                        for h in hits
                    ],
                }
                for v, hits in hits_by_value.items()
            ],
        }
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            print(f"[VD] Saved context JSON: {path}")
        except Exception as e:
            print(f"[VD] context json save failed for {path}: {e}")

    # ── Page rasterization ───────────────────────────────────────────────────

    def extract_page_as_image(self, pdf_path, page_num, output_image_path):
        """
        Rasterize a single PDF page to PNG at ``DPI``. Returns
        ``{"path": str, "pdf_rect": (x0,y0,x1,y1), "img_w": int, "img_h": int}``
        or ``None`` on failure.
        """
        doc = fitz.open(pdf_path)
        try:
            if page_num < 1 or page_num > len(doc):
                print(f"[!] VD: page {page_num} out of range for {pdf_path}")
                return None
            page = doc.load_page(page_num - 1)
            r = page.rect
            pix = page.get_pixmap(matrix=fitz.Matrix(self.SCALE, self.SCALE))
            pix.save(output_image_path)
            return {
                "path": output_image_path,
                "pdf_rect": (r.x0, r.y0, r.x1, r.y1),
                "img_w": pix.width,
                "img_h": pix.height,
            }
        finally:
            doc.close()

    # ── PDF annotation ───────────────────────────────────────────────────────

    def mark_pdf_with_boxes(self, pdf_path, boxes, output_pdf_path, doc_no: str = None):
        """
        Draw red boxes + labels for every entry in ``boxes`` in one save cycle.
        Each entry: ``{page_num, pixel_box, img_width, img_height, label, pdf_rect}``.
        """
        placed_labels: dict[int, list] = {}
        doc_prefix = ""
        if doc_no:
            doc_prefix = re.sub(r"[^A-Za-z0-9_]", "_", str(doc_no)) + "_"

        with self.lock:
            doc = fitz.open(pdf_path)
            try:
                for box in boxes:
                    page_num = box["page_num"]
                    label = box.get("label", "Mismatch")
                    if page_num < 1 or page_num > len(doc):
                        continue
                    page = doc.load_page(page_num - 1)

                    pdf_rect = box.get("pdf_rect")
                    if pdf_rect:
                        x0, y0, x1, y1 = pdf_rect
                    else:
                        pr = page.rect
                        x0, y0, x1, y1 = pr.x0, pr.y0, pr.x1, pr.y1

                    pixel_box = box["pixel_box"]
                    img_w = box["img_width"]
                    img_h = box["img_height"]
                    xmin, ymin, xmax, ymax = pixel_box
                    scale_x = (x1 - x0) / img_w
                    scale_y = (y1 - y0) / img_h
                    rect = fitz.Rect(
                        x0 + xmin * scale_x,
                        y0 + ymin * scale_y,
                        x0 + xmax * scale_x,
                        y0 + ymax * scale_y,
                    )
                    rect &= page.rect

                    red = (1, 0, 0)
                    white = (1, 1, 1)
                    page.draw_rect(rect, color=red, width=2)

                    font_size = 10
                    label_w = max(20, int(len(label) * 5.2)) + 4
                    label_h = font_size + 4
                    label_x = rect.x0
                    label_y = max(y0 + label_h, rect.y0 - 3)

                    # Collision avoidance against earlier labels on same page
                    page_labels = placed_labels.setdefault(page_num, [])
                    for _ in range(8):
                        clash = False
                        for (lx, ly, lw, lh) in page_labels:
                            if (label_x < lx + lw and label_x + label_w > lx
                                    and label_y - label_h < ly
                                    and label_y > ly - lh):
                                clash = True
                                break
                        if not clash:
                            break
                        label_y += label_h + 2

                    if label_y > y1 - 2:
                        label_y = y1 - 2
                    if label_x + label_w > x1:
                        label_x = max(x0, x1 - label_w)

                    pill = fitz.Rect(label_x - 2, label_y - label_h,
                                     label_x + label_w, label_y + 2)
                    pill &= page.rect
                    page.draw_rect(pill, color=red, fill=white, width=0.6)
                    page.insert_text(
                        fitz.Point(label_x, label_y - 3),
                        label, color=red, fontsize=font_size,
                    )
                    page_labels.append((label_x, label_y, label_w, label_h))

                # Save per-page marked renders for inspection. Prefer the
                # per-doc debug dir (output_dir/debug/<doc_no>/) when doc_no
                # is supplied; fall back to temp_debug/marked_pages/ otherwise
                # (kept for callers that drive mark_pdf_with_boxes directly).
                if doc_no:
                    marked_img_dir = os.path.join(
                        self.debug_dir,
                        re.sub(r"[^A-Za-z0-9_]", "_", str(doc_no)),
                    )
                else:
                    marked_img_dir = os.path.join(self.temp_dir, "marked_pages")
                os.makedirs(marked_img_dir, exist_ok=True)
                for page_num in set(b["page_num"] for b in boxes):
                    if 1 <= page_num <= len(doc):
                        p = doc.load_page(page_num - 1)
                        mp = p.get_pixmap(matrix=fitz.Matrix(self.SCALE, self.SCALE))
                        fname = (
                            f"marked_p{page_num}.png"
                            if doc_no
                            else f"marked_{doc_prefix}p{page_num}.png"
                        )
                        out_png = os.path.join(marked_img_dir, fname)
                        mp.save(out_png)
                        print(f"[VD] Saved marked page image: {out_png}")

                if pdf_path == output_pdf_path:
                    temp_path = str(output_pdf_path) + ".tmp"
                    doc.save(temp_path)
                    doc.close()
                    os.replace(temp_path, output_pdf_path)
                else:
                    doc.save(output_pdf_path)
                    doc.close()
            except Exception:
                doc.close()
                raise

    # ── Coverage audit ──────────────────────────────────────────────────────

    @staticmethod
    def audit_coverage(doc_no, mismatches, per_mismatch_boxes, total_boxes):
        report = {
            "doc_no": doc_no,
            "total_mismatches": len(mismatches),
            "total_boxes_drawn": total_boxes,
            "hits": sum(1 for n in per_mismatch_boxes.values() if n > 0),
            "misses": sum(1 for n in per_mismatch_boxes.values() if n == 0),
            "per_mismatch": [
                {"field": f, "value": v, "boxes": n}
                for (f, v), n in per_mismatch_boxes.items()
            ],
            "all_marked": all(n > 0 for n in per_mismatch_boxes.values()),
        }
        if report["all_marked"]:
            print(
                f"[VD] Coverage OK: {report['hits']}/{len(mismatches)} mismatches "
                f"marked for {doc_no} ({total_boxes} total boxes)."
            )
        else:
            print(
                f"[VD] Coverage WARNING for {doc_no}: "
                f"{report['hits']}/{len(mismatches)} mismatches marked, "
                f"{report['misses']} missed."
            )
            for entry in report["per_mismatch"]:
                if entry["boxes"] == 0:
                    print(
                        f"   [VD] miss: field={entry['field']!r} "
                        f"value={entry['value']!r}"
                    )
        return report

    # ── Batch entry point: the new two-call flow ────────────────────────────

    def debug_mismatches_batch(self, pdf_path, doc_no, mismatches):
        """
        For every page of the PDF:
          1. Rasterize the page.
          2. LLM call #1: for all mismatched values, get sentence-level
             context boxes (one call per page).
          3. LLM call #2: for each (value, sentence-box), crop with
             CONTEXT_PADDING_PX padding and get the tight value box.
          4. Mark every located box on the PDF in one save cycle.
        """
        clean_doc_no = doc_no.replace("/", "_").replace("\\", "_")
        values = [mm["value"] for mm in mismatches]
        field_by_value: dict[str, str] = {mm["value"]: mm["field"] for mm in mismatches}
        per_mismatch_boxes: dict[tuple, int] = {
            (mm["field"], mm["value"]): 0 for mm in mismatches
        }
        all_boxes: list[dict] = []

        if not mismatches:
            yield f"No mismatches queued for {doc_no}"
            return None

        doc = fitz.open(pdf_path)
        try:
            total_pages = doc.page_count
        finally:
            doc.close()

        doc_debug_dir = self._doc_debug_dir(clean_doc_no)
        print(f"[VD] Debug artefacts dir: {os.path.abspath(doc_debug_dir)}")

        for page_num in range(1, total_pages + 1):
            yield f"Scanning {doc_no} page {page_num}/{total_pages}"

            base_img = os.path.join(doc_debug_dir, f"raw_p{page_num}.png")
            extraction = self.extract_page_as_image(pdf_path, page_num, base_img)
            if not extraction:
                continue
            img_w = extraction["img_w"]
            img_h = extraction["img_h"]
            pdf_rect = extraction["pdf_rect"]

            # Local-only grid overlay for human inspection (never sent to Gemini)
            grid_img = os.path.join(doc_debug_dir, f"grid_p{page_num}.png")
            try:
                draw_grid_overlay(base_img, grid_img)
            except Exception as e:
                print(f"[VD] grid overlay failed for page {page_num}: {e}")

            # LLM call #1: sentence-level context boxes for every value
            sentence_hits = self.sentence_locator.locate(
                page_image_path=base_img,
                page_w_px=img_w,
                page_h_px=img_h,
                values=values,
            )
            # Persist the descriptive context so an operator can see what
            # Gemini reported per page (sentence + coarse box per value).
            self._save_context_json(
                path=os.path.join(doc_debug_dir, f"context_p{page_num}.json"),
                doc_no=doc_no,
                page_num=page_num,
                values=values,
                hits_by_value=sentence_hits,
            )

            # LLM call #2: pinpoint inside the padded crop for every hit
            for value, hits in sentence_hits.items():
                field = field_by_value.get(value, "")
                key = (field, value)
                for idx, hit in enumerate(hits):
                    ckey = self._cache_key(pdf_path, page_num, field, f"{value}#{idx}")
                    if ckey in self._coord_cache:
                        cached = self._coord_cache[ckey]
                        if not cached:
                            continue
                        pixel_box = tuple(cached)
                    else:
                        crop_path = os.path.join(
                            doc_debug_dir,
                            f"crop_p{page_num}_v{idx}.png",
                        )
                        pixel_box = self.pinpoint_locator.locate(
                            page_image_path=base_img,
                            context_box_px=hit["context_box_px"],
                            value=value,
                            sentence_hint=hit.get("sentence", ""),
                            crop_out_path=crop_path,
                        )
                        self._coord_cache[ckey] = list(pixel_box) if pixel_box else None
                        self._save_cache()
                        if pixel_box is None:
                            continue
                    all_boxes.append({
                        "page_num": page_num,
                        "pixel_box": list(pixel_box),
                        "img_width": img_w,
                        "img_height": img_h,
                        "pdf_rect": pdf_rect,
                        "label": field or value,
                    })
                    per_mismatch_boxes[key] += 1

        if not all_boxes:
            yield f"No occurrences found for any mismatch in {doc_no}"
            self.last_coverage_report = self.audit_coverage(
                doc_no=doc_no,
                mismatches=mismatches,
                per_mismatch_boxes=per_mismatch_boxes,
                total_boxes=0,
            )
            return None

        output_name = os.path.basename(pdf_path)
        output_path = os.path.join(self.output_dir, "matched_docs", output_name)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        active_source = output_path if os.path.exists(output_path) else pdf_path
        self.mark_pdf_with_boxes(
            active_source, all_boxes, output_path, doc_no=clean_doc_no
        )

        try:
            rid = os.path.basename(os.path.normpath(self.output_dir))
            kind = (
                os.path.basename(os.path.dirname(os.path.normpath(self.output_dir)))
                or "validate"
            )
            vd_key = (
                f"outputs/{kind}/{rid}/matched_docs/{os.path.basename(output_path)}"
            )
            _sync_file(output_path, content_type="application/pdf", key=vd_key)
        except Exception as _e:
            print(f"[VD] sync_file failed for {output_path}: {_e}")

        yield f"Marked {len(all_boxes)} occurrences across {doc_no}"

        self.last_coverage_report = self.audit_coverage(
            doc_no=doc_no,
            mismatches=mismatches,
            per_mismatch_boxes=per_mismatch_boxes,
            total_boxes=len(all_boxes),
        )
        return output_path

    # ── Temp cleanup ────────────────────────────────────────────────────────

    def _cleanup_temp(self, doc_prefix: str = None):
        if not os.path.exists(self.temp_dir):
            return
        for fname in os.listdir(self.temp_dir):
            if doc_prefix and not fname.startswith(f"raw_{doc_prefix}"):
                continue
            try:
                os.remove(os.path.join(self.temp_dir, fname))
            except OSError:
                pass

    def cleanup_all_temp(self):
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)
