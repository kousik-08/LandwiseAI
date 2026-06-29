"""End-to-end test for the new two-call VisualDebugger flow.

A value that occurs on multiple pages should produce a marked rect on EACH
page. The Gemini sentence + pinpoint locators are mocked so the test runs
without a real Gemini connection.
"""
import os
import sys
import json
import tempfile
import threading

import fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.visual_debugger import VisualDebugger


def _make_multi_page_pdf(num_pages: int):
    doc = fitz.open()
    for _ in range(num_pages):
        doc.new_page(width=595, height=842)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


class _StubSentenceLocator:
    """Pretends Gemini found the value's sentence on pages 1 & 2 only."""

    def __init__(self, target_value: str, hit_pages: set[int]):
        self.target_value = target_value
        self.hit_pages = hit_pages
        self.calls = []
        self.last_prompt = ""
        self.last_raw_response = ""

    def locate(self, page_image_path, page_w_px, page_h_px, values):
        # Track which page this is from the filename suffix `_p<N>.png`
        page_num = None
        base = os.path.basename(page_image_path)
        if "_p" in base:
            try:
                page_num = int(base.rsplit("_p", 1)[1].split(".")[0])
            except ValueError:
                pass
        self.calls.append((page_num, list(values)))

        result = {v: [] for v in values}
        if page_num in self.hit_pages and self.target_value in values:
            # Coarse sentence box near the top of the page (in pixels)
            result[self.target_value] = [{
                "sentence": f"The value {self.target_value} is on page {page_num}",
                "context_box_px": (
                    int(page_w_px * 0.05), int(page_h_px * 0.10),
                    int(page_w_px * 0.95), int(page_h_px * 0.15),
                ),
            }]
        return result


class _StubPinpointLocator:
    """Returns a small tight box inside the supplied context box."""

    def __init__(self):
        self.calls = []
        self.last_prompt = ""
        self.last_raw_response = ""

    def locate(self, page_image_path, context_box_px, value, sentence_hint, crop_out_path):
        self.calls.append((value, context_box_px))
        x0, y0, x1, y1 = context_box_px
        # A 200 × 40 px box centered horizontally in the sentence row
        cx = (x0 + x1) // 2
        cy = (y0 + y1) // 2
        return (cx - 100, cy - 20, cx + 100, cy + 20)


def _make_vd_with_stubs(target_value: str, hit_pages: set[int]):
    vd = VisualDebugger.__new__(VisualDebugger)
    vd.lock = threading.Lock()
    vd.output_dir = tempfile.mkdtemp(prefix="vd_out_")
    vd.temp_dir = os.path.join(vd.output_dir, "temp_debug")
    os.makedirs(vd.temp_dir, exist_ok=True)
    vd.gemini = None
    vd.debug_dir = os.path.join(vd.output_dir, "debug")
    os.makedirs(vd.debug_dir, exist_ok=True)
    vd._cache_path = os.path.join(vd.output_dir, "vd_coord_cache.json")
    vd._coord_cache = {}
    vd.last_coverage_report = None
    vd.sentence_locator = _StubSentenceLocator(target_value, hit_pages)
    vd.pinpoint_locator = _StubPinpointLocator()
    return vd


class _MultiValueSentenceLocator:
    """value -> set of pages where Gemini 'finds' it. Only reports a hit for a
    value it was actually asked about on that page (mirrors real scoping)."""

    def __init__(self, hits_by_value):
        self.hits_by_value = hits_by_value
        self.calls = []
        self.last_prompt = ""
        self.last_raw_response = ""

    def locate(self, page_image_path, page_w_px, page_h_px, values):
        base = os.path.basename(page_image_path)
        page_num = None
        if "_p" in base:
            try:
                page_num = int(base.rsplit("_p", 1)[1].split(".")[0])
            except ValueError:
                pass
        self.calls.append((page_num, list(values)))
        result = {v: [] for v in values}
        for v in values:
            if page_num in self.hits_by_value.get(v, set()):
                result[v] = [{
                    "sentence": f"{v} on page {page_num}",
                    "context_box_px": (
                        int(page_w_px * 0.05), int(page_h_px * 0.10),
                        int(page_w_px * 0.95), int(page_h_px * 0.15),
                    ),
                }]
        return result


def test_multiple_mismatches_marked_on_their_own_pages():
    """Two mismatches scoped to different pages each get a box on their own
    page only — and both are reported as covered."""
    pdf = _make_multi_page_pdf(4)
    try:
        vd = VisualDebugger.__new__(VisualDebugger)
        vd.lock = threading.Lock()
        vd.output_dir = tempfile.mkdtemp(prefix="vd_out_")
        vd.temp_dir = os.path.join(vd.output_dir, "temp_debug")
        os.makedirs(vd.temp_dir, exist_ok=True)
        vd.gemini = None
        vd.debug_dir = os.path.join(vd.output_dir, "debug")
        os.makedirs(vd.debug_dir, exist_ok=True)
        vd._cache_path = os.path.join(vd.output_dir, "vd_coord_cache.json")
        vd._coord_cache = {}
        vd.last_coverage_report = None
        vd.sentence_locator = _MultiValueSentenceLocator({"ALPHA": {1}, "BETA": {3}})
        vd.pinpoint_locator = _StubPinpointLocator()

        for _ in vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="MULTI/1",
            mismatches=[
                {"field": "Document Number", "value": "ALPHA", "page_info": "Page 1"},
                {"field": "Survey Number", "value": "BETA", "page_info": "Page 3"},
            ],
        ):
            pass

        # Only the two targeted pages were scanned, each asked only its value.
        by_page = {c[0]: c[1] for c in vd.sentence_locator.calls}
        assert sorted(by_page) == [1, 3], f"expected pages [1,3], got {sorted(by_page)}"
        assert by_page[1] == ["ALPHA"]
        assert by_page[3] == ["BETA"]

        out_pdf = os.path.join(vd.output_dir, "matched_docs", os.path.basename(pdf))
        result = fitz.open(out_pdf)
        try:
            def _has_rect(idx):
                page = result.load_page(idx)
                content = b"".join(
                    result.xref_stream(x) or b"" for x in page.get_contents()
                )
                return b"re" in content

            assert _has_rect(0), "page 1 (ALPHA) should be marked"
            assert _has_rect(2), "page 3 (BETA) should be marked"
            assert not _has_rect(1), "page 2 should be untouched"
            assert not _has_rect(3), "page 4 should be untouched"
        finally:
            result.close()

        # Both mismatches must be covered — nothing dropped.
        report = vd.last_coverage_report
        assert report["hits"] == 2, f"both mismatches should be marked, got {report['hits']}"
        assert report["misses"] == 0
        assert report["all_marked"] is True
        assert report["total_boxes_drawn"] == 2
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


def _make_vd_custom(sentence_locator):
    vd = VisualDebugger.__new__(VisualDebugger)
    vd.lock = threading.Lock()
    vd.output_dir = tempfile.mkdtemp(prefix="vd_out_")
    vd.temp_dir = os.path.join(vd.output_dir, "temp_debug")
    os.makedirs(vd.temp_dir, exist_ok=True)
    vd.gemini = None
    vd.debug_dir = os.path.join(vd.output_dir, "debug")
    os.makedirs(vd.debug_dir, exist_ok=True)
    vd._cache_path = os.path.join(vd.output_dir, "vd_coord_cache.json")
    vd._coord_cache = {}
    vd.last_coverage_report = None
    vd.sentence_locator = sentence_locator
    vd.pinpoint_locator = _StubPinpointLocator()
    return vd


def test_miss_fallback_recovers_wrong_matcher_page_and_stops_when_found():
    """page_info names the WRONG page (value really lives on page 2, matcher
    said page 5). The targeted scan misses, the fallback sweeps remaining pages
    in order, finds it on page 2, and STOPS — pages 3 and 4 are never scanned."""
    pdf = _make_multi_page_pdf(5)
    try:
        # Matcher said "Page 5", but DELTA actually appears on page 2.
        vd = _make_vd_custom(_MultiValueSentenceLocator({"DELTA": {2}}))
        for _ in vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="MISS/1",
            mismatches=[{"field": "Survey Number", "value": "DELTA", "page_info": "Page 5"}],
        ):
            pass

        scanned = [c[0] for c in vd.sentence_locator.calls]
        # Targeted page 5 first, then fallback pages 1, 2 — and it stops at 2.
        assert scanned == [5, 1, 2], f"expected [5,1,2] (early-stop), got {scanned}"
        assert 3 not in scanned and 4 not in scanned, \
            f"pages after the found page must not be scanned, got {scanned}"

        out_pdf = os.path.join(vd.output_dir, "matched_docs", os.path.basename(pdf))
        result = fitz.open(out_pdf)
        try:
            def _has_rect(idx):
                page = result.load_page(idx)
                content = b"".join(
                    result.xref_stream(x) or b"" for x in page.get_contents()
                )
                return b"re" in content

            assert _has_rect(1), "page 2 (the real location) should be marked"
            for idx in (0, 2, 3, 4):
                assert not _has_rect(idx), f"page {idx + 1} should be untouched"
        finally:
            result.close()

        report = vd.last_coverage_report
        assert report["hits"] == 1, "the recovered mismatch should count as covered"
        assert report["all_marked"] is True
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


def test_no_fallback_when_targeted_page_hits():
    """When the matcher page is correct, the fallback never fires — only the
    one targeted page is scanned (keeps the call savings)."""
    pdf = _make_multi_page_pdf(5)
    try:
        vd = _make_vd_custom(_MultiValueSentenceLocator({"EPSILON": {2}}))
        for _ in vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="HIT/1",
            mismatches=[{"field": "Survey Number", "value": "EPSILON", "page_info": "Page 2"}],
        ):
            pass
        scanned = [c[0] for c in vd.sentence_locator.calls]
        assert scanned == [2], f"only the targeted page should be scanned, got {scanned}"
        assert vd.last_coverage_report["hits"] == 1
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


def test_scoped_multipage_hint_marks_all_named_pages():
    """A single mismatch with page_info='Page 1 & 4' is scanned and marked on
    BOTH page 1 and page 4 (and no other page)."""
    pdf = _make_multi_page_pdf(5)
    try:
        vd = VisualDebugger.__new__(VisualDebugger)
        vd.lock = threading.Lock()
        vd.output_dir = tempfile.mkdtemp(prefix="vd_out_")
        vd.temp_dir = os.path.join(vd.output_dir, "temp_debug")
        os.makedirs(vd.temp_dir, exist_ok=True)
        vd.gemini = None
        vd.debug_dir = os.path.join(vd.output_dir, "debug")
        os.makedirs(vd.debug_dir, exist_ok=True)
        vd._cache_path = os.path.join(vd.output_dir, "vd_coord_cache.json")
        vd._coord_cache = {}
        vd.last_coverage_report = None
        vd.sentence_locator = _MultiValueSentenceLocator({"GAMMA": {1, 4}})
        vd.pinpoint_locator = _StubPinpointLocator()

        for _ in vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="MULTI/2",
            mismatches=[{"field": "Survey Number", "value": "GAMMA", "page_info": "Page 1 & 4"}],
        ):
            pass

        scanned = sorted(c[0] for c in vd.sentence_locator.calls)
        assert scanned == [1, 4], f"expected pages [1,4] scanned, got {scanned}"

        out_pdf = os.path.join(vd.output_dir, "matched_docs", os.path.basename(pdf))
        result = fitz.open(out_pdf)
        try:
            def _has_rect(idx):
                page = result.load_page(idx)
                content = b"".join(
                    result.xref_stream(x) or b"" for x in page.get_contents()
                )
                return b"re" in content

            assert _has_rect(0), "page 1 should be marked"
            assert _has_rect(3), "page 4 should be marked"
            assert not _has_rect(1) and not _has_rect(2) and not _has_rect(4), \
                "pages 2, 3, 5 should be untouched"
        finally:
            result.close()

        report = vd.last_coverage_report
        assert report["hits"] == 1
        assert report["total_boxes_drawn"] == 2  # one box on each of the two pages
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


def test_value_on_multiple_pages_gets_marked_on_each():
    pdf = _make_multi_page_pdf(3)
    try:
        vd = _make_vd_with_stubs(target_value="STELLA", hit_pages={1, 2})
        for _ in vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="TEST/1",
            mismatches=[{"field": "Claimant Name", "value": "STELLA", "page_info": ""}],
        ):
            pass

        # Sentence locator should be called once per page (3 pages total)
        assert len(vd.sentence_locator.calls) == 3
        # Pinpoint locator should be called once per (page-with-hit, value)
        assert len(vd.pinpoint_locator.calls) == 2

        out_pdf = os.path.join(vd.output_dir, "matched_docs", os.path.basename(pdf))
        assert os.path.exists(out_pdf), "marked PDF should be written"

        result = fitz.open(out_pdf)
        try:
            def _content_bytes(page):
                return b"".join(
                    result.xref_stream(x) or b"" for x in page.get_contents()
                )

            for page_idx in (0, 1):
                content = _content_bytes(result.load_page(page_idx))
                assert b"re" in content, f"page {page_idx + 1} should have a rect"
            assert b"re" not in _content_bytes(result.load_page(2)), \
                "page 3 should be untouched"
        finally:
            result.close()

        report = vd.last_coverage_report
        assert report is not None
        assert report["total_boxes_drawn"] == 2
        assert report["hits"] == 1  # one mismatch, multiple boxes

        # Per-page debug artefacts: raw + grid PNGs for ALL pages, marked
        # PNGs only for pages that got a box, context JSON for every page.
        doc_dir = os.path.join(vd.debug_dir, "TEST_1")
        for page_num in (1, 2, 3):
            assert os.path.exists(os.path.join(doc_dir, f"raw_p{page_num}.png"))
            assert os.path.exists(os.path.join(doc_dir, f"grid_p{page_num}.png"))
            ctx_path = os.path.join(doc_dir, f"context_p{page_num}.json")
            assert os.path.exists(ctx_path)
            with open(ctx_path, "r", encoding="utf-8") as f:
                ctx = json.load(f)
            assert ctx["page"] == page_num
            assert ctx["values_queried"] == ["STELLA"]
            # Pages 1 & 2 should report found=True; page 3 should not.
            stella = next(h for h in ctx["hits"] if h["value"] == "STELLA")
            assert stella["found"] is (page_num in (1, 2))
        for page_num in (1, 2):
            assert os.path.exists(os.path.join(doc_dir, f"marked_p{page_num}.png"))
        assert not os.path.exists(os.path.join(doc_dir, "marked_p3.png"))
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


if __name__ == "__main__":
    test_value_on_multiple_pages_gets_marked_on_each()
    print("OK")
