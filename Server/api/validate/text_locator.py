"""
PyMuPDF text-layer search wrappers.

Two responsibilities, both kept small and side-effect-free so they can be unit
tested without a real Gemini call or a real network round-trip:

  * `search_in_page(page, variants)` — try every variant against `page.search_for`
    and return a deduped list of `fitz.Rect` rectangles in PDF points.
  * `has_useful_text_layer(page)` — text-density heuristic that decides whether
    the Gemini-vision fallback needs to run for this page.
"""
import fitz


class PdfTextLocator:
    # Pages below this character density (chars per sq inch) are treated as
    # scans. Empirically: typed deeds register 80–500; scans register 0–5.
    # The wide gap means the exact threshold doesn't matter much.
    MIN_CHARS_PER_SQ_INCH = 20

    # Two rectangles whose intersection-over-union exceeds this are considered
    # the same hit. Keeps duplicate hits from variants ("Stella" vs "STELLA")
    # that resolve to overlapping regions.
    IOU_DEDUPE_THRESHOLD = 0.5

    @classmethod
    def search_in_page(cls, page, variants):
        """Return deduped `fitz.Rect` hits for any variant present on `page`."""
        if not variants:
            return []
        hits = []
        for v in variants:
            v = (v or "").strip()
            if not v:
                continue
            try:
                rects = page.search_for(v)
            except Exception:
                continue
            for r in rects or []:
                if r.width <= 0 or r.height <= 0:
                    continue
                hits.append(r)
        return cls._dedupe_overlapping(hits)

    @classmethod
    def has_useful_text_layer(cls, page):
        text = page.get_text("text").strip()
        if not text:
            return False
        rect = page.rect
        area_in2 = max(1.0, (rect.width / 72.0) * (rect.height / 72.0))
        return (len(text) / area_in2) > cls.MIN_CHARS_PER_SQ_INCH

    # ── helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _iou(a, b):
        inter = a & b
        if inter.is_empty:
            return 0.0
        inter_area = inter.width * inter.height
        union = (a.width * a.height) + (b.width * b.height) - inter_area
        return inter_area / union if union > 0 else 0.0

    @classmethod
    def _dedupe_overlapping(cls, hits):
        kept = []
        for r in hits:
            if any(cls._iou(r, k) > cls.IOU_DEDUPE_THRESHOLD for k in kept):
                continue
            kept.append(r)
        return kept
