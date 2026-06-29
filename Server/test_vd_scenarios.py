"""
Scenario tests for VisualDebugger's NEW behavior:

  1. Multi-page marking — a value that appears on N pages gets N boxes
     drawn (header + body + footer line all marked).
  2. Prior-confirmed fallback sweep — matcher's page_info is off-by-one,
     but the fallback sweep finds the value on the actual page.
  3. Genuinely absent — value really isn't in the doc; reported as absent
     after the full sweep, no boxes drawn.

We mock both LLM calls so no Gemini cost is paid. The mock encodes
"where each value visually lives in this fake PDF" via a fixture dict
and the VD's orchestration is run end-to-end against it.
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading

import fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.visual_debugger import VisualDebugger


# ── Fake-PDF builder ───────────────────────────────────────────────────────

def _make_pdf(num_pages: int = 5) -> str:
    """Empty N-page A4 PDF — content doesn't matter, only the page count
    drives the VD's iteration logic in our tests (locator hits are mocked)."""
    doc = fitz.open()
    for i in range(num_pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text(fitz.Point(50, 80), f"Page {i + 1}", fontsize=10)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


# ── Locator mocks ──────────────────────────────────────────────────────────

class _MockSentenceLocator:
    """
    Returns hits keyed by a fixture dict {(page_num, value): n_occurrences}.
    Each occurrence becomes one SentenceHit at a deterministic box so the
    pinpoint mock can also be deterministic.
    """
    def __init__(self, fixture: dict[tuple[int, str], int]):
        self.fixture = fixture
        self.last_prompt = None
        self.last_raw_response = None

    def locate(self, page_image_path, page_w_px, page_h_px, entries):
        hits: dict[str, list[dict]] = {}
        for _field, value in entries:
            page_num = _page_from_path(page_image_path)
            n = self.fixture.get((page_num, value), 0)
            hits[value] = [
                {
                    "sentence": f"page {page_num} occurrence {i + 1}",
                    # All boxes inside the image, just shifted vertically so
                    # they're disambiguable in the marked output.
                    "context_box_px": (100, 100 + i * 200, 400, 200 + i * 200),
                }
                for i in range(n)
            ]
        self.last_raw_response = {"mocked": True, "page": _page_from_path(page_image_path)}
        return hits


class _MockPinpointLocator:
    """Always returns a tight box derived from the context box. No LLM call."""
    def __init__(self):
        self.last_prompt = None
        self.last_raw_response = None

    @staticmethod
    def crop_with_padding(*args, **kwargs):
        # Pretend the crop happened; the orchestrator only cares it returns truthy.
        return ((0, 0, 100, 100), (100, 100))

    def locate(self, page_image_path, context_box_px, value, sentence_hint, crop_out_path):
        # Return a sub-box inside the context box — just enough for the
        # MIN_BOX_AREA_PX check (80 × 20 = 1600 px²) to pass.
        x0, y0, x1, y1 = context_box_px
        return (x0 + 5, y0 + 5, x0 + 200, y0 + 50)


def _page_from_path(p: str) -> int:
    """Pull '4' out of '.../raw_p4.png'."""
    import re
    m = re.search(r"raw_p(\d+)\.png$", p)
    return int(m.group(1)) if m else 0


# ── Test harness ───────────────────────────────────────────────────────────

def _run_vd(pdf_path: str, doc_no: str, mismatches: list, fixture: dict):
    """Instantiate VD with mocked locators and run debug_mismatches_batch
    to completion. Returns (boxes_per_mismatch, coverage_report, output_path)."""
    out_dir = tempfile.mkdtemp(prefix="vd_scenario_")
    vd = VisualDebugger.__new__(VisualDebugger)
    vd.output_dir = out_dir
    vd.temp_dir = os.path.join(out_dir, "temp")
    vd.debug_dir = os.path.join(out_dir, "debug")
    vd.lock = threading.Lock()
    os.makedirs(vd.temp_dir, exist_ok=True)
    os.makedirs(vd.debug_dir, exist_ok=True)
    vd._cache_path = os.path.join(out_dir, "vd_coord_cache.json")
    vd._coord_cache = {}
    vd.last_coverage_report = None

    # Inject mocks
    vd.sentence_locator = _MockSentenceLocator(fixture)
    vd.pinpoint_locator = _MockPinpointLocator()

    gen = vd.debug_mismatches_batch(pdf_path, doc_no, mismatches)
    progress: list[str] = []
    try:
        while True:
            progress.append(next(gen))
    except StopIteration as e:
        output_path = e.value

    return {
        "boxes": vd.last_coverage_report["per_mismatch"] if vd.last_coverage_report else [],
        "total_boxes": vd.last_coverage_report["total_boxes_drawn"] if vd.last_coverage_report else 0,
        "report": vd.last_coverage_report,
        "output": output_path,
        "progress": progress,
    }


# ── Scenarios ──────────────────────────────────────────────────────────────

def test_multi_page_marking_marks_every_occurrence():
    """
    The deed shows 'Date of Registration: 29-Dec-2008' three times — on the
    header band of page 1, in the body of page 1, and on the sign-off block
    of page 4. matcher says page_info='Page 1'. Expectation: page 1 yields
    2 boxes (header + body), and the fallback finds the page-4 occurrence.
    """
    pdf = _make_pdf(num_pages=4)
    try:
        fixture = {
            (1, "29-Dec-2008"): 2,   # header + body on page 1
            (4, "29-Dec-2008"): 1,   # sign-off block on page 4
        }
        result = _run_vd(
            pdf, "TEST/0001",
            mismatches=[{"field": "Date of Registration",
                         "value": "29-Dec-2008",
                         "page_info": "Page 1"}],
            fixture=fixture,
        )
        boxes_for_date = sum(
            e["boxes"] for e in result["boxes"]
            if e["field"] == "Date of Registration"
        )
        # Page 1's hits give 2 boxes; the fallback sweep then visits page 4
        # and adds the 3rd.
        assert boxes_for_date == 3, (
            f"Expected 3 boxes (header+body on p1, sign-off on p4); "
            f"got {boxes_for_date}. progress={result['progress']}"
        )
        assert result["total_boxes"] == 3
        print(f"  multi-page         : {boxes_for_date} boxes across pages "
              f"(prior-confirmed sweep caught the page-4 occurrence)")
    finally:
        os.remove(pdf)


def test_fallback_sweep_finds_value_on_wrong_hinted_page():
    """
    matcher said the value is on Page 2 (wrong); it's actually on Page 3.
    Without the fallback sweep, this value would silently disappear.
    """
    pdf = _make_pdf(num_pages=5)
    try:
        fixture = {(3, "S. Vijayakumar"): 1}   # only on page 3
        result = _run_vd(
            pdf, "TEST/0002",
            mismatches=[{"field": "Executant Name",
                         "value": "S. Vijayakumar",
                         "page_info": "Page 2"}],
            fixture=fixture,
        )
        boxes = sum(
            e["boxes"] for e in result["boxes"]
            if e["field"] == "Executant Name"
        )
        assert boxes == 1, f"Expected 1 box (found via fallback). got {boxes}"
        assert any("Fallback scan" in p for p in result["progress"]), (
            f"Expected a 'Fallback scan' progress line. got {result['progress']}"
        )
        print(f"  wrong-page hint    : 1 box drawn via fallback sweep")
    finally:
        os.remove(pdf)


def test_genuinely_absent_value_reported():
    """
    Value isn't anywhere in the doc. Expectation: zero boxes; coverage
    report's 'misses' count is 1; the fallback sweep ran (every page tried)
    but found nothing.
    """
    pdf = _make_pdf(num_pages=3)
    try:
        result = _run_vd(
            pdf, "TEST/0003",
            mismatches=[{"field": "Survey Number",
                         "value": "46/9999",
                         "page_info": "Page 1"}],
            fixture={},   # nowhere
        )
        boxes = sum(
            e["boxes"] for e in result["boxes"]
            if e["field"] == "Survey Number"
        )
        assert boxes == 0, f"Expected 0 boxes. got {boxes}"
        assert result["report"]["misses"] == 1
        assert any("Fallback scan" in p for p in result["progress"]), (
            "Expected fallback sweep to have run before declaring absent"
        )
        print(f"  genuinely absent   : 0 boxes (fallback ran, reported clean)")
    finally:
        os.remove(pdf)


def test_unscoped_value_no_page_hint_scans_every_page():
    """
    Mismatch has page_info='' (matcher couldn't pin it). Value is on page 2.
    Should still be found via the unscoped path.
    """
    pdf = _make_pdf(num_pages=3)
    try:
        fixture = {(2, "Rs. 26,400/-"): 1}
        result = _run_vd(
            pdf, "TEST/0004",
            mismatches=[{"field": "Consideration",
                         "value": "Rs. 26,400/-",
                         "page_info": ""}],
            fixture=fixture,
        )
        boxes = sum(
            e["boxes"] for e in result["boxes"]
            if e["field"] == "Consideration"
        )
        assert boxes == 1, f"Expected 1 box. got {boxes}"
        print(f"  unscoped (no hint) : 1 box found on page 2 (every-page scan)")
    finally:
        os.remove(pdf)


def test_marked_output_pdf_has_red_rects():
    """End-to-end: the resulting PDF actually contains drawn rectangles."""
    pdf = _make_pdf(num_pages=2)
    try:
        fixture = {(1, "TARGET"): 1}
        result = _run_vd(
            pdf, "TEST/0005",
            mismatches=[{"field": "Document Number",
                         "value": "TARGET",
                         "page_info": "Page 1"}],
            fixture=fixture,
        )
        assert result["output"] and os.path.exists(result["output"])
        out = fitz.open(result["output"])
        try:
            page = out.load_page(0)
            content = b"".join(
                out.xref_stream(x) or b""
                for x in page.get_contents()
            )
            assert b"re" in content, "Expected at least one rectangle drawn"
        finally:
            out.close()
        print(f"  output PDF         : drawn rect verified")
    finally:
        os.remove(pdf)


if __name__ == "__main__":
    print("Running Visual Debugger scenario tests...")
    print()
    test_multi_page_marking_marks_every_occurrence()
    test_fallback_sweep_finds_value_on_wrong_hinted_page()
    test_genuinely_absent_value_reported()
    test_unscoped_value_no_page_hint_scans_every_page()
    test_marked_output_pdf_has_red_rects()
    print()
    print("All scenarios passed.")
