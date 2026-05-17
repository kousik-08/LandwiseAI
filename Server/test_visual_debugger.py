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
    vd._cache_path = os.path.join(vd.output_dir, "vd_coord_cache.json")
    vd._coord_cache = {}
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


if __name__ == "__main__":
    test_debug_mismatches_batch_smoke_typed_pdf()
    print("OK")
