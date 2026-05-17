import os
import re
import fitz  # PyMuPDF
from PIL import Image, ImageDraw, ImageFont
from common.gemini_helper import GeminiHelper
from common.storage_sync import sync_file as _sync_file
import threading
import hashlib
import json
import shutil


class VisualDebugger:
    """
    Visual debugger v4 — single-pass grid + LLM pipeline.

    For each mismatch:
        1. Cache lookup (per pdf+page+field+value)
        2. Rasterize the page PNG at the module DPI (original size preserved)
        3. Overlay faint BLUE grid every GRID_SIZE px + top/left rulers
        4. Ask Gemini for the value's pixel bbox using the rulers
        5. Map pixel coords back into PDF points, draw a red rect + label

    The previous Tesseract fast-path, ink-snap post-processing, native-bbox
    output mode, and intersection-label grid mode have been removed in
    favour of a single, easy-to-reason-about path.
    """

    # ── Shared pixel-grid coordinate system ─────────────────────────────────
    # Every coordinate in this pipeline lives inside ONE pixel grid: the
    # rasterized page PNG. Three operations must agree on that grid so the
    # red boxes land exactly on the ink they describe:
    #
    #   1. Rasterize PDF page  → pixmap of (page_w_pts * SCALE) × (page_h_pts * SCALE) px
    #   2. Detect coordinates  → pixel coords inside that same PNG (Gemini)
    #   3. Draw on the PDF     → pixel coords divided by SCALE back to PDF points
    DPI = 200                  # Render resolution shared by raster, detect, draw
    SCALE = DPI / 72.0         # ≈ 2.778 — multiplier from PDF points to pixels
    GRID_SIZE = 200            # Grid line spacing (px) — 1 inch at DPI=200
    GRID_LABEL_INTERVAL = 200  # Ruler tick label spacing (px)
    COORD_PADDING = (8, 8, 8, 8)  # Tighter padding around detected region
    # Extra outward expansion (in PNG pixels) applied at PDF-draw time so the
    # red rectangle visibly surrounds the value rather than sitting on it.
    # Tuned for DPI=200 (≈ 36 px = 0.18 inch); raise to enlarge boxes further.
    BOX_DRAW_EXTRA_PX_X = 36   # Half-width added on EACH side (left + right)
    BOX_DRAW_EXTRA_PX_Y = 24   # Half-height added on EACH side (top + bottom)
    GRID_ALPHA = 70            # 0–255 alpha for grid lines
    LABEL_FONT_SIZE = 14       # Ruler tick label size
    _CACHE_VERSION = "18"      # Bumped: never skip — placeholder values fall back to field label

    # ── Accuracy controls ───────────────────────────────────────────────────
    # Verification: after Gemini returns a bbox, crop it from the raw page
    # PNG and ask Gemini to confirm the value is inside. This catches the
    # roughly-30% of locator hallucinations the benchmark identified. Doubles
    # API calls on the uncached path, so it can be disabled with VD_VERIFY=0.
    # Verification crop was rejecting too many valid boxes (Gemini answering
    # "no"/"partial" on legible matches). Disabled by default; can be opted
    # back in with VD_VERIFY=1.
    VERIFY_ENABLED = (os.getenv("VD_VERIFY", "0") == "1")
    # Reject suspiciously tiny boxes — Gemini sometimes returns a 5-px speck
    # in lieu of "not found". A real word token at DPI=200 / 12pt is bigger
    # than ~80 × 20 px.
    MIN_BOX_AREA_PX = 80 * 20
    # When `page_info` lists multiple metadata pages, annotate every one of
    # them. We used to fall back to page 1 above a small cap (3), but that
    # leaves the operator without grid/marker overlays on the body pages
    # they actually need to verify. A very high cap effectively disables
    # the fallback; tune downward only if Gemini quota becomes a concern.
    MAX_METADATA_PAGES_BEFORE_COVER_FALLBACK = 50

    # Color scheme: BLUE grid + rulers, RED mismatch boxes (clear separation)
    GRID_COLOR = (0, 120, 255)
    GRID_LABEL_COLOR = (0, 80, 180)
    GRID_BG_COLOR = (230, 242, 255)
    MISMATCH_BOX_COLOR = (255, 0, 0)
    MISMATCH_TEXT_COLOR = (255, 0, 0)

    # ── Field-level page overrides ──────────────────────────────────────────
    # Some deed fields reliably live on page 1 even when the validator's
    # page_info says otherwise (registrar's stamped block, handwritten
    # endorsements). Force these onto page 1 regardless of page_info.
    FIRST_PAGE_FIELD_KEYWORDS = (
        "date of registration",
        "registration date",
        "registered date",
        "survey number",
        "survey no",
        "executant",
        "claimant",
    )

    # Date-of-registration appears in both the document body (correct) AND
    # inside the registrar's round seal/endorsement (wrong, machine-stamped).
    # Tell Gemini explicitly to skip the seal for these fields.
    AVOID_SEAL_FIELD_KEYWORDS = (
        "date of registration",
        "registration date",
        "registered date",
    )

    @classmethod
    def _is_first_page_field(cls, field: str) -> bool:
        if not field:
            return False
        f = re.sub(r"\s+", " ", str(field)).strip().lower()
        return any(kw in f for kw in cls.FIRST_PAGE_FIELD_KEYWORDS)

    @classmethod
    def _avoid_seal(cls, field: str) -> bool:
        if not field:
            return False
        f = re.sub(r"\s+", " ", str(field)).strip().lower()
        return any(kw in f for kw in cls.AVOID_SEAL_FIELD_KEYWORDS)

    # ── page_info parsing ───────────────────────────────────────────────────
    # The validator emits page_info in many shapes:
    #   "Page 2 (Metadata)"
    #   "Page 1 (EC), Page 5 (Metadata)"
    #   "Page 1 (EC), Page 1, 2, 3, 4, 5, 6, 7 (Metadata)"
    #   "Page 5, 7"
    #   "5"
    # The deed PDF is the metadata side, NOT the EC side, so we must prefer
    # whichever number is associated with "Metadata". Falling back to the
    # first integer (the old behaviour) frequently picked the EC page,
    # which sent Gemini hunting on the wrong page.
    _METADATA_BLOCK_RE = re.compile(r"((?:\d+\s*,?\s*)+)\s*\(\s*Metadata\s*\)", re.IGNORECASE)
    _EC_BLOCK_RE = re.compile(r"((?:\d+\s*,?\s*)+)\s*\(\s*EC\s*\)", re.IGNORECASE)

    @classmethod
    def _parse_pages_from_info(cls, page_info: str) -> list[int]:
        """
        Return the list of metadata-side page numbers, in order.

        Strategy:
          1. If the string contains "(Metadata)", return the numbers
             immediately preceding it.
          2. Else strip any "(EC)" block and return the remaining numbers.
          3. Else return every integer found.
        """
        if not page_info:
            return []
        s = str(page_info)
        md = cls._METADATA_BLOCK_RE.search(s)
        if md:
            return [int(n) for n in re.findall(r"\d+", md.group(1)) if int(n) >= 1]
        # No "(Metadata)" tag — strip "(EC)" segment, then read everything else
        s_clean = cls._EC_BLOCK_RE.sub("", s)
        nums = [int(n) for n in re.findall(r"\d+", s_clean) if int(n) >= 1]
        return nums

    # ── value preprocessing ─────────────────────────────────────────────────
    # The validator sometimes stuffs structured context into the value field:
    #   "S. ராமதான், PNC சாமிநாதன் அவர்களின் குமாரர்" (name + kinship)
    #   "June 5, 2009 (execution narrative), 2nd day of [Month]" (date + note)
    #   "ரூ.26,400/- (Consideration)" (amount + label)
    # Sending the whole compound string to Gemini means it tries to match
    # something that never appears verbatim on the page. Strip the
    # parenthetical and trailing context, keep the primary identifier.
    @classmethod
    def _condense_value_for_search(cls, value: str) -> str:
        """
        Strip parenthetical context and trim list-style suffixes (kinship,
        execution narrative, etc.), while preserving commas that are part of
        a single logical token (thousands separators, `Month D, YYYY` dates).
        """
        if not value:
            return ""
        s = str(value).strip()
        # 1. Drop any "(parenthetical)" context
        s = re.sub(r"\s*\([^)]{0,80}\)\s*", " ", s).strip()
        s = re.sub(r"\s+", " ", s).strip()
        # 2. Short result → use as-is, no further splitting (preserves
        #    "ரூ.26,400/-" and "1200 + 1200 = 2400 சதுரடி").
        if len(s) <= 50:
            return s
        # 3. Long result → split on commas, keep joining chunks while the
        #    next chunk is a pure number (thousands, year) so dates and
        #    currency stay intact.
        chunks = [c.strip() for c in s.split(",")]
        out = chunks[0]
        for c in chunks[1:]:
            if not c:
                continue
            if re.match(r"^\d", c):  # next chunk starts with a digit
                out += ", " + c
            else:
                break
        return out[:60].strip()

    def __init__(self, gemini_helper: GeminiHelper, output_dir: str):
        self.gemini = gemini_helper
        self.output_dir = output_dir
        self.temp_dir = os.path.join(output_dir, "temp_debug")
        self.lock = threading.Lock()
        os.makedirs(self.temp_dir, exist_ok=True)

        # Coordinate cache, persisted per request
        self._cache_path = os.path.join(output_dir, "vd_coord_cache.json")
        self._coord_cache = self._load_cache()

    # ── Cache helpers ────────────────────────────────────────────────────────

    def _load_cache(self) -> dict:
        if os.path.exists(self._cache_path):
            try:
                with open(self._cache_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if data.get("_v") == self._CACHE_VERSION:
                        return data.get("coords", {})
                    print(f"[*] VD Cache format changed (v{data.get('_v', '?')} → v{self._CACHE_VERSION}). Clearing old cache.")
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

    # ── Page extraction ──────────────────────────────────────────────────────

    def extract_page_as_image(self, pdf_path, page_num, output_image_path):
        """
        Rasterize a single PDF page to PNG, preserving the original DPI.

        The PNG dimensions are derived from the PDF page size and SCALE so that
        every downstream step (grid drawing, Gemini detection, PDF box draw)
        shares one pixel grid. Returns ``{"path": str, "pdf_rect": (...)} `` or
        ``None`` on failure.
        """
        doc = fitz.open(pdf_path)
        try:
            if page_num < 1:
                print(f"[*] Page {page_num} corrected to 1")
                page_num = 1
            if page_num > len(doc):
                print(f"[!] Error: Page {page_num} out of range for {pdf_path}")
                return None

            page = doc.load_page(page_num - 1)
            r = page.rect
            pix = page.get_pixmap(matrix=fitz.Matrix(self.SCALE, self.SCALE))
            print(
                f"[VD] Page {page_num} | PDF rect: "
                f"({r.x0:.2f},{r.y0:.2f},{r.x1:.2f},{r.y1:.2f}) pts "
                f"({r.width:.2f}×{r.height:.2f}) | "
                f"DPI={self.DPI} | PNG: {pix.width}×{pix.height} px"
            )
            pix.save(output_image_path)
            return {"path": output_image_path, "pdf_rect": (r.x0, r.y0, r.x1, r.y1)}
        finally:
            doc.close()

    # ── Grid overlay ─────────────────────────────────────────────────────────

    @staticmethod
    def _load_font(size: int):
        for family in ("arial.ttf", "DejaVuSans.ttf"):
            try:
                return ImageFont.truetype(family, size)
            except OSError:
                continue
        return ImageFont.load_default()

    def draw_grid_on_image(self, image_path, grid_size=None, **_kwargs):
        """
        Overlay a faint blue grid and top/left rulers on the page PNG.

        Returns ``(grid_image_path, width, height)``. ``_kwargs`` is accepted
        and ignored for backwards compatibility with the previous signature
        (the old ``edge_labels_only`` / ``intersection_labels`` modes are
        gone — there is only one rendering mode now).
        """
        grid_size = grid_size or self.GRID_SIZE
        label_interval = self.GRID_LABEL_INTERVAL
        ruler_height = 26
        ruler_width = 50

        with Image.open(image_path) as img:
            base = img.convert("RGBA")
            width, height = base.size

            # Faint grid lines on a transparent overlay
            grid_overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            gd = ImageDraw.Draw(grid_overlay)
            grid_rgba = (*self.GRID_COLOR, self.GRID_ALPHA)
            for x in range(0, width, grid_size):
                gd.line([(x, 0), (x, height)], fill=grid_rgba, width=1)
            for y in range(0, height, grid_size):
                gd.line([(0, y), (width, y)], fill=grid_rgba, width=1)

            composed = Image.alpha_composite(base, grid_overlay)
            draw = ImageDraw.Draw(composed)
            font = self._load_font(self.LABEL_FONT_SIZE)

            # Solid ruler bands cover the faint grid lines inside them
            draw.rectangle([0, 0, width, ruler_height], fill=self.GRID_BG_COLOR)
            draw.rectangle([0, 0, ruler_width, height], fill=self.GRID_BG_COLOR)

            # Re-draw grid lines across the ruler bands at full opacity
            for x in range(0, width, grid_size):
                draw.line([(x, 0), (x, ruler_height)], fill=self.GRID_COLOR, width=1)
            for y in range(0, height, grid_size):
                draw.line([(0, y), (ruler_width, y)], fill=self.GRID_COLOR, width=1)

            # X tick labels on top ruler
            for x in range(0, width, label_interval):
                label = f"{x}"
                bbox = draw.textbbox((0, 0), label, font=font)
                tw = bbox[2] - bbox[0]
                draw.text((x - tw // 2, 4), label, fill=self.GRID_LABEL_COLOR, font=font)
                draw.line([(x, ruler_height - 5), (x, ruler_height)], fill=self.GRID_LABEL_COLOR, width=1)

            # Y tick labels on left ruler
            for y in range(0, height, label_interval):
                label = f"{y}"
                bbox = draw.textbbox((0, 0), label, font=font)
                tw = bbox[2] - bbox[0]
                th = bbox[3] - bbox[1]
                draw.text((ruler_width - tw - 5, y - th // 2), label, fill=self.GRID_LABEL_COLOR, font=font)
                draw.line([(ruler_width - 5, y), (ruler_width, y)], fill=self.GRID_LABEL_COLOR, width=1)

            # Corner origin label
            draw.text((4, 4), "(0,0)", fill=self.GRID_LABEL_COLOR, font=font)

            out_img = composed.convert("RGB")
            grid_image_path = image_path.replace(".png", "_grid.png")
            out_img.save(grid_image_path)
            return grid_image_path, width, height

    # ── Gemini coordinate extraction ─────────────────────────────────────────

    # ── Verification crop ────────────────────────────────────────────────────

    def _verify_bbox_contains_value(self, raw_image_path: str, pixel_box: list,
                                    value: str, condensed_value: str) -> str:
        """
        Crop the raw page PNG to ``pixel_box`` (+20% margin) and ask Gemini
        whether the value is inside. Returns 'yes', 'partial', 'no', or
        'error' (treat the last as 'yes' so a transient failure doesn't
        discard a likely-good box).
        """
        try:
            with Image.open(raw_image_path) as img:
                W, H = img.size
                xmin, ymin, xmax, ymax = [int(v) for v in pixel_box]
                mw = max(20, int((xmax - xmin) * 0.20))
                mh = max(20, int((ymax - ymin) * 0.20))
                cx0 = max(0, xmin - mw); cy0 = max(0, ymin - mh)
                cx1 = min(W, xmax + mw); cy1 = min(H, ymax + mh)
                crop = img.crop((cx0, cy0, cx1, cy1))
                crop_path = raw_image_path.replace(".png", "_verify.png")
                crop.save(crop_path)
        except Exception as e:
            print(f"[VD] verify: crop failed ({e}); treating as 'yes'")
            return "yes"

        prompt = (
            f'The image is a crop from a Tamil land deed. Does this crop '
            f'contain the value "{value}" (the condensed form is '
            f'"{condensed_value}")? Translation variants and re-orderings '
            f'count as a match.\n\n'
            f'Reply with EXACTLY ONE word:\n'
            f'  yes      — the value is fully visible in the crop\n'
            f'  partial  — the value is partly visible (cut off at an edge)\n'
            f'  no       — the value is not present in the crop\n'
        )
        try:
            resp = self.gemini.generate_from_file(
                crop_path, prompt, display_name="Verify Crop"
            )
            tok = (resp or "").strip().lower().split()[0] if (resp or "").strip() else ""
            if tok.startswith(("yes", "y")):
                return "yes"
            if tok.startswith("partial"):
                return "partial"
            if tok.startswith(("no", "n")):
                return "no"
            print(f"[VD] verify: unexpected response {resp!r}; treating as 'yes'")
            return "yes"
        except Exception as e:
            print(f"[VD] verify: error ({e}); treating as 'yes'")
            return "yes"

    def get_coordinates_from_gemini(self, grid_image_path, search_text, field_context=None):
        """
        Single Gemini call: returns the value's pixel bbox as
        ``[xmin, ymin, xmax, ymax]`` (with COORD_PADDING applied) or ``None``.

        The search text is condensed before sending (parenthetical context
        stripped, primary identifier extracted), and the returned box is
        rejected if it falls below ``MIN_BOX_AREA_PX`` or fails the
        verification crop (when ``VERIFY_ENABLED`` is True).
        """
        condensed = self._condense_value_for_search(search_text)
        if condensed != search_text:
            print(f"[VD] Condensed value: '{search_text}' → '{condensed}'")
        context_str = f" for the field '{field_context}'" if field_context else ""
        avoid_seal = bool(field_context and self._avoid_seal(field_context))
        cover_field_hint = ""
        if field_context and self._is_first_page_field(field_context):
            if avoid_seal:
                cover_field_hint = (
                    "\n        COVER-PAGE FIELD HINT (NO SEAL):\n"
                    f"        - '{field_context}' must be located in TYPED body text or the\n"
                    "          TYPED registrar endorsement block ONLY. EXPLICITLY IGNORE the\n"
                    "          round seal / stamp impression — its date is the stamp's printing\n"
                    "          date, not the registration date. Also ignore handwritten margin\n"
                    "          notes for this field. If no typed rendition exists on the page,\n"
                    "          return a zero-area box.\n"
                )
            else:
                cover_field_hint = (
                    "\n        COVER-PAGE FIELD HINT:\n"
                    f"        - '{field_context}' is a cover-page field. On this page the value\n"
                    "          typically appears in one of three places, in this STRICT order:\n"
                    "            (a) TYPED body text or the typed registrar block,\n"
                    "            (b) HANDWRITTEN endorsement in the margins or footer\n"
                    "                (registrar-clerk's pen — usually at the top-left corner\n"
                    "                 or in the margin near the document number block),\n"
                    "            (c) inside the registrar's round SEAL / STAMP impression\n"
                    "                — only if neither (a) nor (b) exists on the page.\n"
                    "          Mark (a) when present, else (b), else (c).\n"
                )
        where_to_look = (
            "        WHERE TO LOOK (priority order):\n"
            "        1. Scan the entire page — body paragraphs, headers, footers, table cells,\n"
            "           registry endorsements, signatures, handwritten margin notes.\n"
            "        2. EXPLICITLY IGNORE the round seal / stamp impression. The seal's\n"
            "           printed date is NOT the registration date for this field.\n"
            "        3. Mark only TYPED renditions of the value. If no typed match exists,\n"
            "           return a zero-area box (never fall back to seal or handwriting).\n"
        ) if avoid_seal else (
            "        WHERE TO LOOK (strict priority order — pick the first that exists):\n"
            "        1. TYPED occurrence — machine-printed body text, table cells, printed\n"
            "           registry endorsement block. ALWAYS prefer this when available.\n"
            "        2. HANDWRITTEN occurrence — pen / ink endorsement in the margins, top-left\n"
            "           corner, or footer. Choose this when no typed rendition exists.\n"
            "        3. SEAL / STAMP impression — LAST RESORT only. Only use the value baked\n"
            "           into the registrar's round seal if it appears in NEITHER typed NOR\n"
            "           handwritten form on the page. Most registrar seals carry the\n"
            "           registrar's own document number, NOT the document number you're\n"
            "           validating — pick the seal only when forced.\n"
            "        4. Never invent a location. If the value truly isn't on the page in any\n"
            "           form, return a zero-area box.\n"
        )
        prompt = f"""
        TASK: Find the exact pixel bounding box for the value: "{condensed}"{context_str}.
        (Original validator value, for context only: "{search_text}")

        CONTEXT:
        - The document is likely in Tamil.
        - The value may be translated or differently formatted
          (e.g. "April 14, 2008" might appear as "14-04-2008" or as
          "14-ந்தேதி ஏப்ரல்").
{cover_field_hint}
{where_to_look}

        IMAGE SPECS:
        - The TOP edge has a horizontal ruler with x-coordinate tick labels.
        - The LEFT edge has a vertical ruler with y-coordinate tick labels.
        - Faint BLUE grid lines every {self.GRID_SIZE} pixels help you
          interpolate between ticks.
        - Read coordinates from the rulers.

        OUTPUT:
        - Enclose ONLY the value text TIGHTLY — do not include the surrounding
          sentence, paragraph, or table cell.
        - For short tokens (dates, IDs, numbers) the box should be roughly the
          size of the token itself, not the whole line.
        - Return ONLY the list in this exact form: [xmin, ymin, xmax, ymax]
        """
        try:
            response_text = self.gemini.generate_from_file(
                grid_image_path, prompt, display_name="Grid Analysis"
            )
            match = re.search(r"\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]", response_text)
            if not match:
                print(f"[!] VD: Gemini did not return coords for '{search_text}'. Response: {response_text[:120]}...")
                return None
            coords = [int(x) for x in match.groups()]
            xmin, ymin, xmax, ymax = coords
            if xmax - xmin <= 0 or ymax - ymin <= 0:
                print(f"[!] VD: Gemini returned zero-area box for '{search_text}' (value likely absent)")
                return None
            # Reject suspiciously tiny boxes — likely a "wrong but non-zero"
            # answer pointing at meaningless ink.
            area = (xmax - xmin) * (ymax - ymin)
            if area < self.MIN_BOX_AREA_PX:
                print(f"[!] VD: Box area {area}px² below MIN_BOX_AREA_PX={self.MIN_BOX_AREA_PX}; "
                      f"discarding {coords} for '{search_text}'")
                return None
            pl, pt, pr, pb = self.COORD_PADDING
            padded = [xmin - pl, ymin - pt, xmax + pr, ymax + pb]
            print(f"[*] VD: Gemini coords {coords} for '{search_text}'")

            # Verification crop on the raw image (no grid overlay) so Gemini
            # reads ink, not blue lines. Drop the box on 'no'; widen on
            # 'partial'; keep as-is on 'yes' or transient errors.
            if self.VERIFY_ENABLED:
                raw_image_path = grid_image_path.replace("_grid.png", ".png")
                if os.path.exists(raw_image_path):
                    verdict = self._verify_bbox_contains_value(
                        raw_image_path, padded, search_text, condensed
                    )
                    print(f"[*] VD: verify={verdict} for '{condensed}'")
                    if verdict == "no":
                        return None
                    if verdict == "partial":
                        # Widen 30% on each axis once, then trust it
                        w = (padded[2] - padded[0]) * 0.30
                        h = (padded[3] - padded[1]) * 0.30
                        padded = [int(padded[0] - w), int(padded[1] - h),
                                  int(padded[2] + w), int(padded[3] + h)]
            return padded
        except Exception as e:
            print(f"[!] VD: Gemini error: {e}")
            return None

    # ── PDF annotation ───────────────────────────────────────────────────────

    def mark_pdf_with_boxes(self, pdf_path, boxes, output_pdf_path, doc_no: str = None):
        """
        Draw multiple red boxes onto the PDF in one open/save cycle.

        Each entry in ``boxes`` is a dict:
            {page_num, pixel_box, img_width, img_height, label, pdf_rect}

        ``doc_no`` is optional and only used to namespace the debug
        ``marked_pages/`` PNGs so two docs processed in the same output
        directory don't overwrite each other's renders.
        """
        # Track per-page label placements to avoid stacking labels on top of
        # each other when several mismatches sit close together on the page.
        placed_labels: dict[int, list] = {}
        # Sanitize doc_no for filesystem use
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

                    # Two box sources:
                    #   1. `pdf_rect_box` — text-layer hit, already in PDF points.
                    #      Use it directly; no scale conversion needed.
                    #   2. `pixel_box` + img_w/img_h — Gemini hit on the rasterized
                    #      page; convert pixel coords to PDF points.
                    if "pdf_rect_box" in box and box["pdf_rect_box"] is not None:
                        src = box["pdf_rect_box"]
                        rect = fitz.Rect(src.x0, src.y0, src.x1, src.y1)
                        print(
                            f"[VD] Box '{label}' page {page_num} (text-layer): "
                            f"rect=({rect.x0:.2f},{rect.y0:.2f},{rect.x1:.2f},{rect.y1:.2f})"
                        )
                    else:
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
                        print(
                            f"[VD] Box '{label}' page {page_num} (gemini): "
                            f"px=[{xmin},{ymin},{xmax},{ymax}] img={img_w}x{img_h} "
                            f"rect=({rect.x0:.2f},{rect.y0:.2f},{rect.x1:.2f},{rect.y1:.2f})"
                        )

                    rect &= page.rect

                    red = (1, 0, 0)
                    white = (1, 1, 1)
                    page.draw_rect(rect, color=red, width=2)

                    # ── Label rendering with pill background + collision shift ──
                    # The label sits above the rect's top-left by default. If a
                    # previously-placed label on this page would overlap, push
                    # this one downward in 14-pt steps until it clears.
                    label_text = label
                    font_size = 10
                    # Rough text width estimate: ~5pt per character at 10pt font
                    label_w = max(20, int(len(label_text) * 5.2)) + 4
                    label_h = font_size + 4
                    label_x = rect.x0
                    label_y = max(y0 + label_h, rect.y0 - 3)

                    # Collision avoidance against earlier labels on same page
                    page_labels = placed_labels.setdefault(page_num, [])
                    for _ in range(8):  # max 8 shifts then give up
                        clash = False
                        for (lx, ly, lw, lh) in page_labels:
                            if (label_x < lx + lw and label_x + label_w > lx
                                    and label_y - label_h < ly
                                    and label_y > ly - lh):
                                clash = True
                                break
                        if not clash:
                            break
                        label_y += label_h + 2  # shift down

                    # Keep label inside page
                    if label_y > y1 - 2:
                        label_y = y1 - 2
                    if label_x + label_w > x1:
                        label_x = max(x0, x1 - label_w)

                    # White pill background for readability over body text
                    pill = fitz.Rect(label_x - 2, label_y - label_h,
                                     label_x + label_w, label_y + 2)
                    pill &= page.rect
                    page.draw_rect(pill, color=red, fill=white, width=0.6)
                    page.insert_text(
                        fitz.Point(label_x, label_y - 3),
                        label_text, color=red, fontsize=font_size,
                    )
                    page_labels.append((label_x, label_y, label_w, label_h))

                # Save marked page images for inspection
                marked_img_dir = os.path.join(self.temp_dir, "marked_pages")
                os.makedirs(marked_img_dir, exist_ok=True)
                for page_num in set(b["page_num"] for b in boxes):
                    if 1 <= page_num <= len(doc):
                        p = doc.load_page(page_num - 1)
                        mp = p.get_pixmap(matrix=fitz.Matrix(self.SCALE, self.SCALE))
                        out_png = os.path.join(marked_img_dir,
                                               f"marked_{doc_prefix}p{page_num}.png")
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

    def _value_variants(self, value: str) -> list[str]:
        """
        Build a short list of search candidates from a single value, so a
        remark pass can try alternative phrasings if the canonical form
        misses. Strip parenthetical context, split on commas, keep tokens
        with at least one digit OR alpha word. De-duped, order preserved.
        """
        if not value:
            return []
        seen: list[str] = []

        def add(s: str):
            s = (s or "").strip()
            if s and s not in seen:
                seen.append(s)

        s = str(value).strip()
        add(s)
        # Strip parentheticals
        cleaned = re.sub(r"\s*\([^)]{0,80}\)\s*", " ", s).strip()
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        add(cleaned)
        # Comma-separated parts
        for part in cleaned.split(","):
            add(part.strip())
        # Slash-separated parts (e.g. "1200/2400" -> ["1200", "2400"])
        for part in re.split(r"[\/]", cleaned):
            add(part.strip())
        # Drop suffix-only / connector-only tokens
        return [v for v in seen if len(v) >= 2]

    def _remark_missed(
        self,
        pdf_path: str,
        doc_no: str,
        missing: list[tuple[int, dict]],
        page_image_cache: dict[int, dict],
    ) -> list[dict]:
        """
        Aggressive retry: for each (page, mismatch) we couldn't draw, try
        EVERY page in the PDF with EVERY value variant in turn. First hit
        wins per mismatch. Returns a list of box dicts ready to append to
        all_boxes.
        """
        try:
            doc = fitz.open(pdf_path)
            total_pages = doc.page_count
            doc.close()
        except Exception as e:
            print(f"[VD] remark: cannot open PDF: {e}")
            return []

        recovered: list[dict] = []
        for _hinted_page, mm in missing:
            field = mm.get("field") or ""
            value = mm.get("value") or ""
            variants = self._value_variants(value)
            hit = None
            for pn in range(1, total_pages + 1):
                # Ensure page grid is built
                if pn not in page_image_cache:
                    base_img = os.path.join(self.temp_dir, f"raw_{doc_no}_p{pn}.png")
                    extraction = self.extract_page_as_image(pdf_path, pn, base_img)
                    if not extraction:
                        continue
                    grid_img, img_w, img_h = self.draw_grid_on_image(base_img)
                    page_image_cache[pn] = {
                        "raw_img": base_img,
                        "grid_img": grid_img,
                        "img_w": img_w,
                        "img_h": img_h,
                        "pdf_rect": extraction["pdf_rect"],
                    }
                grid_img = page_image_cache[pn]["grid_img"]

                for v in variants:
                    ckey = self._cache_key(pdf_path, pn, field, v)
                    # Skip pages already cached as zero-area for this variant
                    if ckey in self._coord_cache:
                        cached = self._coord_cache[ckey]
                        if cached:
                            hit = (pn, v, cached)
                            break
                        continue
                    print(f"[VD] Remark: '{field}' variant={v!r} on page {pn}/{total_pages}")
                    pixel_box = self.get_coordinates_from_gemini(
                        grid_img, v, field_context=field
                    )
                    self._coord_cache[ckey] = pixel_box if pixel_box else None
                    self._save_cache()
                    if pixel_box:
                        hit = (pn, v, pixel_box)
                        break
                if hit:
                    break

            if hit:
                pn, v, box = hit
                pc = page_image_cache[pn]
                recovered.append({
                    "page_num": pn,
                    "pixel_box": box,
                    "img_width": pc["img_w"],
                    "img_height": pc["img_h"],
                    "pdf_rect": pc["pdf_rect"],
                    "label": field,
                    "field": field,
                    "value": value,
                })
            else:
                print(
                    f"[VD] Remark exhausted: '{field}' ({value!r}) not found in any of "
                    f"{total_pages} page(s) across {len(variants)} variant(s)."
                )
        return recovered

    def _scan_remaining_pages(
        self,
        pdf_path: str,
        doc_no: str,
        field: str,
        value: str,
        already_searched: set[int],
        page_image_cache: dict[int, dict],
    ) -> tuple[int | None, list | None, int]:
        """
        After the hinted page failed, try every other page of the PDF in
        turn and return the first one where Gemini finds the value.

        Returns (found_page_num, pixel_box, total_pages_scanned).
        Builds + caches page images lazily so a previously-cached page is
        re-used. Honours the persistent _coord_cache too.
        """
        try:
            doc = fitz.open(pdf_path)
            total_pages = doc.page_count
            doc.close()
        except Exception as e:
            print(f"[VD] could not open PDF for full scan: {e}")
            return None, None, 0

        scanned = 0
        for page_num in range(1, total_pages + 1):
            if page_num in already_searched:
                continue
            # Persistent cache first
            ckey = self._cache_key(pdf_path, page_num, field, value)
            if ckey in self._coord_cache:
                cached = self._coord_cache[ckey]
                scanned += 1
                if cached:
                    return page_num, cached, scanned
                continue  # cached as zero-area; not on this page

            # Build the page grid on demand
            if page_num not in page_image_cache:
                base_img = os.path.join(
                    self.temp_dir, f"raw_{doc_no}_p{page_num}.png"
                )
                extraction = self.extract_page_as_image(pdf_path, page_num, base_img)
                if not extraction:
                    scanned += 1
                    continue
                grid_img, img_w, img_h = self.draw_grid_on_image(base_img)
                page_image_cache[page_num] = {
                    "raw_img": base_img,
                    "grid_img": grid_img,
                    "img_w": img_w,
                    "img_h": img_h,
                    "pdf_rect": extraction["pdf_rect"],
                }
            grid_img = page_image_cache[page_num]["grid_img"]

            print(f"[VD] Full-scan: trying '{field}' on page {page_num}/{total_pages}")
            pixel_box = self.get_coordinates_from_gemini(
                grid_img, value, field_context=field
            )
            scanned += 1
            # Always cache the result (positive OR negative) so re-runs skip pages.
            self._coord_cache[ckey] = pixel_box if pixel_box else None
            self._save_cache()
            if pixel_box:
                return page_num, pixel_box, scanned

        return None, None, scanned

    @staticmethod
    def audit_coverage(doc_no, mismatches, page_groups, all_boxes, page_had_failure, skipped_no_page):
        """
        Build a structured coverage report comparing every mismatch we were
        asked to draw against the boxes we actually placed on the marked PDF.

        Returns a dict the validator / handler can persist alongside the
        validation result so the UI can show which mismatches were left
        un-annotated and why. Also prints a human-readable summary to stderr.

        Inputs:
          doc_no             — e.g. "6571/2013"
          mismatches         — original [{field, value, page_info}] list
          page_groups        — {page_num: [mm, ...]} after page resolution
          all_boxes          — list of dicts that actually got drawn
          page_had_failure   — {page_num: True} for any page where Gemini
                               returned a zero-area (no-box) for at least one
                               mismatch on it
          skipped_no_page    — count of mismatches that had no usable page_info
        """
        # Boxes per page (what we actually drew)
        drawn_per_page: dict[int, int] = {}
        for b in all_boxes:
            p = int(b.get("page_num", 0))
            drawn_per_page[p] = drawn_per_page.get(p, 0) + 1

        # Mismatches per page (what we WANTED to draw — after page resolution)
        wanted_per_page: dict[int, int] = {p: len(items) for p, items in page_groups.items()}

        # Per-page miss accounting
        per_page = []
        missed_fields_by_page: dict[int, list[str]] = {}
        for p, want in wanted_per_page.items():
            got = drawn_per_page.get(p, 0)
            missed = max(0, want - got)
            per_page.append({"page": p, "wanted": want, "drawn": got, "missed": missed})
            if missed and page_had_failure.get(p):
                missed_fields_by_page[p] = [mm.get("field", "?") for mm in page_groups[p]]

        total_wanted = sum(wanted_per_page.values())
        total_drawn = len(all_boxes)
        total_missed = max(0, total_wanted - total_drawn)

        report = {
            "doc_no": doc_no,
            "total_mismatches": len(mismatches),
            "skipped_no_page": skipped_no_page,
            "total_wanted_on_pages": total_wanted,
            "total_drawn": total_drawn,
            "total_missed_on_pages": total_missed,
            "all_marked": total_missed == 0 and skipped_no_page == 0,
            "per_page": sorted(per_page, key=lambda r: r["page"]),
            "missed_fields_by_page": missed_fields_by_page,
        }

        if report["all_marked"]:
            print(f"[VD] Coverage OK: {total_drawn}/{len(mismatches)} mismatches marked for {doc_no}.")
        else:
            print(
                f"[VD] Coverage WARNING for {doc_no}: "
                f"{total_drawn}/{len(mismatches)} mismatches marked. "
                f"skipped_no_page={skipped_no_page} pages_with_misses="
                f"{[p for p in missed_fields_by_page]}"
            )
            for p, fields in missed_fields_by_page.items():
                print(f"   [VD] page {p}: missed {fields}")
        return report

    def mark_pdf_with_box(
        self, pdf_path, page_num, pixel_box, img_width, img_height, output_pdf_path, **kwargs
    ):
        """Single-box wrapper around mark_pdf_with_boxes."""
        b = {
            "page_num": page_num,
            "pixel_box": pixel_box,
            "img_width": img_width,
            "img_height": img_height,
            "label": kwargs.get("label", "Mismatch"),
        }
        if "pdf_rect" in kwargs:
            b["pdf_rect"] = kwargs["pdf_rect"]
        self.mark_pdf_with_boxes(pdf_path, [b], output_pdf_path,
                                 doc_no=kwargs.get("doc_no"))

    # ── Batch debug entry point ──────────────────────────────────────────────

    def debug_mismatches_batch(self, pdf_path, doc_no, mismatches):
        """
        Process every mismatch for a single document in one pass.

        ``mismatches`` is a list of ``{field, value, page_info}`` dicts.
        Yields progress messages and writes the marked PDF in one save.
        """
        clean_doc_no = doc_no.replace("/", "_").replace("\\", "_")

        # Resolve which deed page to search on per mismatch. We prefer the
        # number associated with "(Metadata)" because the EC number refers to
        # a spreadsheet row, not a deed page.
        page_groups: dict[int, list] = {}
        skipped = 0
        for mm in mismatches:
            field = mm.get("field") or ""
            page_info = str(mm.get("page_info", "") or "")
            metadata_pages = self._parse_pages_from_info(page_info)

            if self._is_first_page_field(field):
                # Field-level override always wins
                page_num = 1
                if metadata_pages and metadata_pages[0] != 1:
                    print(
                        f"[VD] Field '{field}' overridden to page 1 "
                        f"(page_info='{page_info}' ignored)"
                    )
            elif not metadata_pages:
                # No usable page hint from the validator — default to page 1
                # and rely on _scan_remaining_pages + _remark_missed to
                # locate the real occurrence elsewhere in the document.
                # We previously skipped these entirely, which guaranteed
                # any NOT_MATCHED field without a page hint never got a
                # box. The user's requirement is that EVERY NOT_MATCHED
                # gets marked somewhere in the deed.
                print(
                    f"[VD] No page number in '{page_info}' for field {field!r} — "
                    f"defaulting to page 1 (full-scan fallback will recover)."
                )
                page_num = 1
            elif len(metadata_pages) > self.MAX_METADATA_PAGES_BEFORE_COVER_FALLBACK:
                # Value appears on many pages → canonical occurrence is the
                # cover page. Searching every listed page is wasteful and
                # frequently picks a body recurrence instead of the
                # authoritative one.
                print(
                    f"[VD] Field '{field}' lists {len(metadata_pages)} metadata "
                    f"pages — falling back to page 1 (cover-page only)"
                )
                page_num = 1
            else:
                page_num = max(1, metadata_pages[0])

            page_groups.setdefault(page_num, []).append(mm)

        if skipped:
            print(f"[VD] Skipped {skipped}/{len(mismatches)} mismatches for {doc_no} (no extractable page number).")

        if not page_groups:
            return None

        all_boxes = []
        # page_num -> {raw_img, grid_img, img_w, img_h, pdf_rect}
        page_image_cache: dict[int, dict] = {}
        # page_num -> True if every mismatch on that page produced a box.
        # Pages with any failure keep their debug artifacts; clean pages get
        # all temp files removed so temp_debug/ doubles as a failure log.
        page_had_failure: dict[int, bool] = {}

        for page_num, page_mismatches in page_groups.items():
            if page_num not in page_image_cache:
                base_img = os.path.join(self.temp_dir, f"raw_{clean_doc_no}_p{page_num}.png")
                extraction = self.extract_page_as_image(pdf_path, page_num, base_img)
                if not extraction:
                    page_had_failure[page_num] = True
                    continue
                yield f"Building grid for {doc_no} (Page {page_num})"
                grid_img, img_w, img_h = self.draw_grid_on_image(base_img)
                page_image_cache[page_num] = {
                    "raw_img": base_img,
                    "grid_img": grid_img,
                    "img_w": img_w,
                    "img_h": img_h,
                    "pdf_rect": extraction["pdf_rect"],
                }
                page_had_failure.setdefault(page_num, False)

            page_cache = page_image_cache[page_num]
            grid_img = page_cache["grid_img"]
            img_w = page_cache["img_w"]
            img_h = page_cache["img_h"]
            pdf_rect = page_cache["pdf_rect"]

            for mm in page_mismatches:
                field = mm["field"]
                value = mm["value"]

                ckey = self._cache_key(pdf_path, page_num, field, value)
                if ckey in self._coord_cache:
                    pixel_box = self._coord_cache[ckey]
                    print(f"[*] VD Cache HIT: {field} on page {page_num}")
                else:
                    yield f"Locating '{field}' on page {page_num} via Gemini"
                    pixel_box = self.get_coordinates_from_gemini(
                        grid_img, value, field_context=field
                    )
                    if pixel_box:
                        self._coord_cache[ckey] = pixel_box
                        self._save_cache()

                if pixel_box:
                    all_boxes.append({
                        "page_num": page_num,
                        "pixel_box": pixel_box,
                        "img_width": img_w,
                        "img_height": img_h,
                        "pdf_rect": pdf_rect,
                        "label": field,
                    })
                else:
                    # Hinted page didn't have it. Scan every other page of
                    # the document with Gemini before giving up.
                    page_had_failure[page_num] = True
                    yield f"'{field}' not on page {page_num}, scanning remaining pages of {doc_no}..."
                    found_on, found_box, total_pages = self._scan_remaining_pages(
                        pdf_path=pdf_path,
                        doc_no=clean_doc_no,
                        field=field,
                        value=value,
                        already_searched={page_num},
                        page_image_cache=page_image_cache,
                    )
                    if found_box:
                        new_ck = self._cache_key(pdf_path, found_on, field, value)
                        self._coord_cache[new_ck] = found_box
                        self._save_cache()
                        page_cache_hit = page_image_cache[found_on]
                        all_boxes.append({
                            "page_num": found_on,
                            "pixel_box": found_box,
                            "img_width": page_cache_hit["img_w"],
                            "img_height": page_cache_hit["img_h"],
                            "pdf_rect": page_cache_hit["pdf_rect"],
                            "label": field,
                            "field": field,
                            "value": value,
                        })
                        print(f"[VD] Recovered '{field}' on page {found_on} (was missing on hinted page {page_num})")
                    else:
                        print(
                            f"[VD] '{field}' ({value!r}) NOT found on hinted+remaining pages "
                            f"({total_pages} scanned) — queueing for remark pass."
                        )

        # ── Remark pass ─────────────────────────────────────────────────
        # Any mismatch that didn't end up in all_boxes gets one more
        # attempt with a permissive prompt + value variants across every
        # page of the document. This is the user's "ask llm to remark it"
        # guarantee — coverage gaps become explicit only when the value
        # truly isn't visible in any rendition on any page.
        drawn_keys = {(b.get("label"), b.get("value")) for b in all_boxes}
        missing = []
        for page_num, mms in page_groups.items():
            for mm in mms:
                key = (mm["field"], mm["value"])
                if (mm["field"], mm["value"]) in drawn_keys:
                    continue
                # Also tolerate label-only match (older all_boxes entries
                # didn't carry "value")
                if any(b.get("label") == mm["field"] for b in all_boxes):
                    continue
                missing.append((page_num, mm))

        if missing:
            yield f"Remark pass: retrying {len(missing)} missed mismatch(es) on {doc_no}"
            recovered = self._remark_missed(
                pdf_path=pdf_path,
                doc_no=clean_doc_no,
                missing=missing,
                page_image_cache=page_image_cache,
            )
            for box in recovered:
                all_boxes.append(box)
                page_had_failure[box["page_num"]] = False
                print(
                    f"[VD] Remark recovered '{box['label']}' on page {box['page_num']} "
                    f"({len(recovered)} remark hit(s) total)."
                )

        if not all_boxes:
            return None

        output_name = os.path.basename(pdf_path)
        output_path = os.path.join(self.output_dir, "matched_docs", output_name)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        active_source = output_path if os.path.exists(output_path) else pdf_path
        self.mark_pdf_with_boxes(active_source, all_boxes, output_path, doc_no=clean_doc_no)

        # Push the marked PDF to S3 immediately so the frontend can fetch it
        # via /files/{key} as soon as the partial_result event arrives.
        # output_dir is tmp/work/<kind>/<rid>; the canonical S3 key is
        # outputs/<kind>/<rid>/matched_docs/<name>.pdf.
        try:
            rid = os.path.basename(os.path.normpath(self.output_dir))
            kind = os.path.basename(os.path.dirname(os.path.normpath(self.output_dir))) or "validate"
            vd_key = f"outputs/{kind}/{rid}/matched_docs/{os.path.basename(output_path)}"
            _sync_file(output_path, content_type="application/pdf", key=vd_key)
        except Exception as _e:
            print(f"[VD] sync_file failed for {output_path}: {_e}")

        yield f"Marked {len(all_boxes)} mismatches on {doc_no}"

        # Selective cleanup. Pages where every mismatch was successfully
        # located → drop raw / grid / verify PNGs (clutter, not diagnostic).
        # Pages with any failure → keep all three so the operator can inspect
        # what Gemini saw and why verification rejected the box. Net effect:
        # temp_debug/ is a failure log, not a generic dump.
        kept_pages: list[int] = []
        cleaned_pages: list[int] = []
        for page_num, cache in page_image_cache.items():
            if page_had_failure.get(page_num):
                kept_pages.append(page_num)
                continue
            cleaned_pages.append(page_num)
            raw_path = cache.get("raw_img")
            grid_path = cache.get("grid_img")
            for p in (grid_path, raw_path):
                if p and os.path.exists(p):
                    try:
                        os.remove(p)
                    except OSError:
                        pass
            # The verify crop sits next to the raw image with a _verify suffix.
            if raw_path:
                verify_path = raw_path.replace(".png", "_verify.png")
                if os.path.exists(verify_path):
                    try:
                        os.remove(verify_path)
                    except OSError:
                        pass
        print(
            f"[VD] Cleanup: dropped artifacts for pages {cleaned_pages or '[]'}; "
            f"kept pages {kept_pages or '[]'} for diagnosis in {self.temp_dir}"
        )

        # Audit: confirm every mismatch we were given got an actual box on the
        # marked PDF. Stash the report on `self` so callers (validator) can read
        # it after the generator is drained.
        self.last_coverage_report = self.audit_coverage(
            doc_no=doc_no,
            mismatches=mismatches,
            page_groups=page_groups,
            all_boxes=all_boxes,
            page_had_failure=page_had_failure,
            skipped_no_page=skipped,
        )

        return output_path

    # ── Legacy single-mismatch entry point ───────────────────────────────────

    def debug_mismatch(self, pdf_path, doc_no, field, mismatch_value, page_info):
        """
        Single-mismatch wrapper kept for backwards compatibility.
        Yields progress messages; returns the output path on success.
        """
        metadata_pages = self._parse_pages_from_info(page_info or "")

        if self._is_first_page_field(field):
            page_num = 1
            if metadata_pages and metadata_pages[0] != 1:
                print(
                    f"[*] Field '{field}' overridden to page 1 "
                    f"(page_info='{page_info}' ignored)"
                )
        elif not metadata_pages:
            return None
        elif len(metadata_pages) > self.MAX_METADATA_PAGES_BEFORE_COVER_FALLBACK:
            print(
                f"[*] Field '{field}' lists {len(metadata_pages)} metadata "
                f"pages — falling back to page 1 (cover-page only)"
            )
            page_num = 1
        else:
            page_num = max(1, metadata_pages[0])

        clean_doc_no = doc_no.replace("/", "_").replace("\\", "_")

        base_img = os.path.join(self.temp_dir, f"raw_{clean_doc_no}_p{page_num}.png")
        extraction = self.extract_page_as_image(pdf_path, page_num, base_img)
        if not extraction:
            return None
        pdf_rect = extraction["pdf_rect"]

        yield f"Building grid for {doc_no} (Page {page_num})"
        grid_img, img_w, img_h = self.draw_grid_on_image(base_img)

        ckey = self._cache_key(pdf_path, page_num, field, mismatch_value)
        if ckey in self._coord_cache:
            pixel_box = self._coord_cache[ckey]
            print(f"[*] VD Cache HIT: {field} on page {page_num}")
        else:
            yield f"Locating '{field}' on page {page_num} via Gemini"
            pixel_box = self.get_coordinates_from_gemini(grid_img, mismatch_value, field_context=field)
            if pixel_box:
                self._coord_cache[ckey] = pixel_box
                self._save_cache()

        if pixel_box:
            output_name = os.path.basename(pdf_path)
            output_path = os.path.join(self.output_dir, "matched_docs", output_name)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            active_source = output_path if os.path.exists(output_path) else pdf_path
            self.mark_pdf_with_box(
                active_source, page_num, pixel_box, img_w, img_h, output_path,
                label=field, pdf_rect=pdf_rect, doc_no=clean_doc_no,
            )
            # Success — drop raw / grid / verify artifacts for this page.
            for p in (grid_img, base_img, base_img.replace(".png", "_verify.png")):
                if p and os.path.exists(p):
                    try:
                        os.remove(p)
                    except OSError:
                        pass
            return output_path

        # Failure — preserve artifacts in temp_debug/ for diagnosis.
        return None

    # ── Temp file cleanup ────────────────────────────────────────────────────

    def _cleanup_temp(self, doc_prefix: str = None):
        """Remove temp images for a specific document or all temps."""
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
        """Remove the entire temp_debug directory."""
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)
