"""Tests for the rewritten VisualDebugger (all-pages flow).

Most coverage now lives in:
  - test_visual_debugger_all_pages.py (multi-page integration)
  - test_value_variants.py / test_text_locator.py / test_gemini_bbox.py (units)

This file keeps a small fixture builder used by the smoke test below.
"""
import os
import sys
import tempfile
import threading

import fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.visual_debugger import VisualDebugger


def create_sample_pdf(output_path):
    """Create a 1-page A4 PDF with a few typed lines simulating a sale deed."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    positions = [
        (50, 50, "Document No. 2420/2022"),
        (50, 100, "Date of Registration: 05-04-2022"),
        (50, 200, "Executant: S. Arulraj"),
        (50, 250, "Claimant: S. Sumesh"),
        (50, 350, "Survey Number: 47/6"),
        (50, 400, "Area: 2400 sq.ft"),
    ]
    for x, y, txt in positions:
        page.insert_text(fitz.Point(x, y), txt, fontsize=12)
    doc.save(output_path)
    doc.close()
    return output_path


def _stub_vd():
    """Build a VisualDebugger without a real Gemini connection."""
    vd = VisualDebugger.__new__(VisualDebugger)
    vd.lock = threading.Lock()
    vd.output_dir = tempfile.mkdtemp(prefix="vd_out_")
    vd.temp_dir = os.path.join(vd.output_dir, "temp_debug")
    os.makedirs(vd.temp_dir, exist_ok=True)
    vd.gemini = None
    vd.bbox_locator = None
    return vd


def test_debug_mismatches_batch_smoke_typed_pdf():
    """Mismatch value present in PDF text layer → marked PDF written."""
    fd, pdf_path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    create_sample_pdf(pdf_path)
    try:
        vd = _stub_vd()
        list(vd.debug_mismatches_batch(
            pdf_path=pdf_path,
            doc_no="DOC/2420",
            mismatches=[{"field": "Document Number", "value": "2420/2022", "page_info": ""}],
        ))
        out_pdf = os.path.join(vd.output_dir, "matched_docs", os.path.basename(pdf_path))
        assert os.path.exists(out_pdf), "marked PDF should be written"
        assert os.path.getsize(out_pdf) > 0, "marked PDF should not be empty"
    finally:
        if os.path.exists(pdf_path):
            os.remove(pdf_path)


# ── Page-targeted sentence search ────────────────────────────────────────────

def test_parse_pages():
    """_parse_pages extracts in-range 1-indexed pages from free-form hints."""
    p = VisualDebugger._parse_pages
    assert p("Page 2", 5) == [2]
    assert p("Page 1 & 4", 5) == [1, 4]
    assert p("Pages 3, 5", 5) == [3, 5]
    assert p("", 5) == []                 # unscoped
    assert p(None, 5) == []               # unscoped
    assert p("Page 99", 3) == []          # out of range dropped
    assert p("Page 2 and 2", 5) == [2]    # deduped
    assert p("N/A", 5) == []              # no digits
    # out-of-range filtered, in-range kept, order by first appearance
    assert p("Page 4 & 2 & 99", 5) == [4, 2]


class _RecordingSentenceLocator:
    """Records (page_num, values) per call; reports no hits."""

    def __init__(self):
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
        return {v: [] for v in values}


class _HitAllSentenceLocator(_RecordingSentenceLocator):
    """Records calls and reports a hit for EVERY value it is asked about, so
    the value is 'found' on whatever page it was queried — used to isolate the
    targeted (phase-1) page composition without the miss-fallback firing."""

    def locate(self, page_image_path, page_w_px, page_h_px, values):
        super().locate(page_image_path, page_w_px, page_h_px, values)
        return {
            v: [{
                "sentence": v,
                "context_box_px": (
                    int(page_w_px * 0.05), int(page_h_px * 0.10),
                    int(page_w_px * 0.95), int(page_h_px * 0.15),
                ),
            }]
            for v in values
        }


class _NoopPinpointLocator:
    def locate(self, *args, **kwargs):
        return None


class _BoxPinpointLocator:
    """Returns a small box inside the context box so a mark is actually drawn
    (which sets boxes_by_value > 0 and suppresses the miss-fallback)."""

    def __init__(self):
        self.last_prompt = ""
        self.last_raw_response = ""

    def locate(self, page_image_path, context_box_px, value, sentence_hint, crop_out_path):
        x0, y0, x1, y1 = context_box_px
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        return (cx - 50, cy - 10, cx + 50, cy + 10)


def _vd_with_recording_locator(sentence=None, pinpoint=None):
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
    vd.sentence_locator = sentence or _RecordingSentenceLocator()
    vd.pinpoint_locator = pinpoint or _NoopPinpointLocator()
    return vd


def _make_blank_pdf(num_pages):
    doc = fitz.open()
    for _ in range(num_pages):
        doc.new_page(width=595, height=842)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


def test_page_scoping_runs_only_targeted_page():
    """A mismatch with page_info='Page 2', found on page 2, is searched on
    page 2 only (the value hits there, so the miss-fallback never fires)."""
    pdf = _make_blank_pdf(3)
    try:
        vd = _vd_with_recording_locator(
            sentence=_HitAllSentenceLocator(), pinpoint=_BoxPinpointLocator()
        )
        list(vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="SCOPE/1",
            mismatches=[{"field": "Survey Number", "value": "47/5", "page_info": "Page 2"}],
        ))
        calls = vd.sentence_locator.calls
        assert len(calls) == 1, f"expected 1 sentence call, got {len(calls)}"
        assert calls[0][0] == 2, f"expected page 2, got page {calls[0][0]}"
        assert calls[0][1] == ["47/5"]
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


def test_unscoped_mismatch_falls_back_to_all_pages():
    """A mismatch with empty page_info is searched on every page."""
    pdf = _make_blank_pdf(3)
    try:
        vd = _vd_with_recording_locator()
        list(vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="SCOPE/2",
            mismatches=[{"field": "Claimant Name", "value": "STELLA", "page_info": ""}],
        ))
        pages = sorted(c[0] for c in vd.sentence_locator.calls)
        assert pages == [1, 2, 3], f"expected all pages scanned, got {pages}"
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


def test_mixed_scoped_and_unscoped_scans_all_pages_with_right_values():
    """Unscoped value rides along on every page; scoped value adds to its page.
    All values hit where queried, so phase-1 composition is what's observed."""
    pdf = _make_blank_pdf(3)
    try:
        vd = _vd_with_recording_locator(
            sentence=_HitAllSentenceLocator(), pinpoint=_BoxPinpointLocator()
        )
        list(vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="SCOPE/3",
            mismatches=[
                {"field": "Survey Number", "value": "47/5", "page_info": "Page 2"},
                {"field": "Claimant Name", "value": "STELLA", "page_info": ""},
            ],
        ))
        by_page = {c[0]: c[1] for c in vd.sentence_locator.calls}
        assert sorted(by_page) == [1, 2, 3]
        assert by_page[1] == ["STELLA"]
        assert by_page[3] == ["STELLA"]
        # Page 2 carries both, scoped value first, deduped.
        assert by_page[2] == ["47/5", "STELLA"]
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


if __name__ == "__main__":
    test_debug_mismatches_batch_smoke_typed_pdf()
    test_parse_pages()
    test_page_scoping_runs_only_targeted_page()
    test_unscoped_mismatch_falls_back_to_all_pages()
    test_mixed_scoped_and_unscoped_scans_all_pages_with_right_values()
    print("OK")
