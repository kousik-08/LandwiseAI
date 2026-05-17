"""End-to-end test for the all-pages VisualDebugger flow.

Uses a synthetic typed PDF so PdfTextLocator can find values without hitting
Gemini. Verifies that a value appearing on multiple pages is marked on EACH
page.
"""
import os
import sys
import tempfile

import fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.visual_debugger import VisualDebugger


def _make_multi_page_pdf(pages):
    """`pages` is a list of [(x, y, text), ...] per page."""
    doc = fitz.open()
    for page_content in pages:
        page = doc.new_page(width=595, height=842)
        for x, y, txt in page_content:
            page.insert_text(fitz.Point(x, y), txt, fontsize=12)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


def _stub_vd():
    """Build a VisualDebugger without a real Gemini connection."""
    import threading
    vd = VisualDebugger.__new__(VisualDebugger)
    vd.lock = threading.Lock()
    vd.output_dir = tempfile.mkdtemp(prefix="vd_out_")
    vd.temp_dir = os.path.join(vd.output_dir, "temp_debug")
    os.makedirs(vd.temp_dir, exist_ok=True)
    vd.gemini = None       # text-layer path doesn't need it
    vd.bbox_locator = None # stubbed; the typed-text fixtures never trigger Gemini
    return vd


def test_value_on_multiple_pages_gets_marked_on_each():
    pdf = _make_multi_page_pdf([
        [(50, 100, "STELLA appears on page 1")],
        [(50, 100, "STELLA also on page 2")],
        [(50, 100, "Nothing relevant here")],
    ])
    try:
        vd = _stub_vd()
        # Drain the generator
        for _ in vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="TEST/1",
            mismatches=[{"field": "Claimant Name", "value": "STELLA", "page_info": ""}],
        ):
            pass

        out_pdf = os.path.join(vd.output_dir, "matched_docs", os.path.basename(pdf))
        assert os.path.exists(out_pdf), "marked PDF should be written"

        def _page_content_bytes(doc, page):
            chunks = []
            for xref in page.get_contents():
                chunks.append(doc.xref_stream(xref) or b"")
            return b"".join(chunks)

        # Count drawing operations on each page — pages 1 & 2 should have at
        # least one rectangle stroked (Q/q + re + S in the content stream).
        result = fitz.open(out_pdf)
        try:
            for page_idx in (0, 1):
                page = result.load_page(page_idx)
                content = _page_content_bytes(result, page)
                # PyMuPDF draws stroked rects with 're' + 'S' tokens.
                assert b"re" in content, f"page {page_idx + 1} should have a rect"
            # Page 3 should NOT have the rect.
            page3 = result.load_page(2)
            assert b"re" not in _page_content_bytes(result, page3), \
                "page 3 should be untouched"
        finally:
            result.close()
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


if __name__ == "__main__":
    test_value_on_multiple_pages_gets_marked_on_each()
    print("OK")
