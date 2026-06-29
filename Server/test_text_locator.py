"""Unit tests for the cropping + PDF-annotation helpers of the new flow."""
import os
import sys
import tempfile
import threading

import fitz
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.visual_debugger import (
    VisualDebugger,
    ValuePinpointLocator,
    CONTEXT_PADDING_PX,
)


def _solid_png(width: int, height: int) -> str:
    img = Image.new("RGB", (width, height), color=(255, 255, 255))
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    img.save(path)
    return path


def test_crop_with_padding_expands_box_and_clips_to_image():
    src = _solid_png(2000, 3000)
    try:
        out_fd, out_path = tempfile.mkstemp(suffix=".png")
        os.close(out_fd)
        result = ValuePinpointLocator.crop_with_padding(
            page_image_path=src,
            context_box_px=(1000, 1500, 1100, 1600),
            padding_px=CONTEXT_PADDING_PX,
            out_path=out_path,
        )
        assert result is not None
        (cx0, cy0, cx1, cy1), (crop_w, crop_h) = result
        # 400 px padding on every side of the 100×100 sentence box
        assert (cx0, cy0, cx1, cy1) == (600, 1100, 1500, 2000)
        with Image.open(out_path) as im:
            assert im.size == (cx1 - cx0, cy1 - cy0) == (crop_w, crop_h)
        os.remove(out_path)
    finally:
        os.remove(src)


def test_crop_with_padding_clamps_against_image_edges():
    """Box near the top-left corner should be clipped, never go negative."""
    src = _solid_png(500, 500)
    try:
        out_fd, out_path = tempfile.mkstemp(suffix=".png")
        os.close(out_fd)
        result = ValuePinpointLocator.crop_with_padding(
            page_image_path=src,
            context_box_px=(10, 10, 50, 50),
            padding_px=400,
            out_path=out_path,
        )
        assert result is not None
        (cx0, cy0, cx1, cy1), _ = result
        # Clamped to image bounds
        assert (cx0, cy0, cx1, cy1) == (0, 0, 450, 450)
        os.remove(out_path)
    finally:
        os.remove(src)


def _make_typed_pdf():
    """1-page A4 PDF — used to exercise mark_pdf_with_boxes."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text(fitz.Point(50, 100), "TARGET VALUE", fontsize=12)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


def test_mark_pdf_with_boxes_draws_rect_from_pixel_coords():
    """Pass a pixel_box + img dims and confirm a rect is drawn on the PDF."""
    pdf = _make_typed_pdf()
    out_pdf = pdf.replace(".pdf", "_marked.pdf")
    try:
        vd = VisualDebugger.__new__(VisualDebugger)
        vd.lock = threading.Lock()
        vd.temp_dir = tempfile.mkdtemp(prefix="vd_test_")

        # Pretend we rasterized at 200 DPI and found a box at the top-left
        img_w = int(595 * VisualDebugger.SCALE)
        img_h = int(842 * VisualDebugger.SCALE)
        vd.mark_pdf_with_boxes(
            pdf,
            [{
                "page_num": 1,
                "pixel_box": [100, 200, 400, 260],
                "img_width": img_w,
                "img_height": img_h,
                "pdf_rect": (0, 0, 595, 842),
                "label": "Test field",
            }],
            out_pdf,
        )
        assert os.path.exists(out_pdf) and os.path.getsize(out_pdf) > 0
        result = fitz.open(out_pdf)
        try:
            content = b"".join(
                result.xref_stream(x) or b""
                for x in result.load_page(0).get_contents()
            )
            # PyMuPDF stroked rects emit a `re` operator
            assert b"re" in content
        finally:
            result.close()
    finally:
        for p in (pdf, out_pdf):
            if os.path.exists(p):
                os.remove(p)


if __name__ == "__main__":
    test_crop_with_padding_expands_box_and_clips_to_image()
    test_crop_with_padding_clamps_against_image_edges()
    test_mark_pdf_with_boxes_draws_rect_from_pixel_coords()
    print("OK")
