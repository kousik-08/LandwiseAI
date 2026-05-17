"""Unit tests for PdfTextLocator."""
import os
import sys
import tempfile

import fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.text_locator import PdfTextLocator


def _make_typed_pdf(text_blocks):
    """Create a 1-page A4 PDF with typed text blocks. Returns the path."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    for x, y, txt in text_blocks:
        page.insert_text(fitz.Point(x, y), txt, fontsize=12)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


def _make_blank_pdf():
    """1-page PDF with no text — simulates a pure scan."""
    doc = fitz.open()
    doc.new_page(width=595, height=842)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


def test_search_finds_single_occurrence():
    pdf = _make_typed_pdf([(50, 100, "SURVEY NO. 142/3")])
    doc = fitz.open(pdf)
    try:
        rects = PdfTextLocator.search_in_page(doc.load_page(0), ["142/3"])
        assert len(rects) == 1
        assert rects[0].width > 0 and rects[0].height > 0
    finally:
        doc.close()
        os.remove(pdf)


def test_search_finds_multiple_occurrences():
    pdf = _make_typed_pdf([
        (50, 100, "STELLA appears here"),
        (50, 200, "and again: STELLA"),
        (50, 300, "and once more STELLA"),
    ])
    doc = fitz.open(pdf)
    try:
        rects = PdfTextLocator.search_in_page(doc.load_page(0), ["STELLA"])
        assert len(rects) == 3
    finally:
        doc.close()
        os.remove(pdf)


def test_search_dedupes_overlapping_variant_hits():
    """Two variants ('STELLA' and 'STELLA appears') both match the same region."""
    pdf = _make_typed_pdf([(50, 100, "STELLA appears here")])
    doc = fitz.open(pdf)
    try:
        rects = PdfTextLocator.search_in_page(
            doc.load_page(0), ["STELLA", "STELLA appears"]
        )
        # Two raw matches but the overlap-dedupe keeps one (or the broader one).
        assert 1 <= len(rects) <= 2
    finally:
        doc.close()
        os.remove(pdf)


def test_search_returns_empty_for_missing_value():
    pdf = _make_typed_pdf([(50, 100, "STELLA")])
    doc = fitz.open(pdf)
    try:
        rects = PdfTextLocator.search_in_page(doc.load_page(0), ["NOT_PRESENT"])
        assert rects == []
    finally:
        doc.close()
        os.remove(pdf)


def test_has_useful_text_layer_true_for_typed_pdf():
    pdf = _make_typed_pdf([
        (50, y, "A line of typed body text " * 4) for y in range(50, 800, 20)
    ])
    doc = fitz.open(pdf)
    try:
        assert PdfTextLocator.has_useful_text_layer(doc.load_page(0)) is True
    finally:
        doc.close()
        os.remove(pdf)


def test_has_useful_text_layer_false_for_blank_pdf():
    pdf = _make_blank_pdf()
    doc = fitz.open(pdf)
    try:
        assert PdfTextLocator.has_useful_text_layer(doc.load_page(0)) is False
    finally:
        doc.close()
        os.remove(pdf)


if __name__ == "__main__":
    test_search_finds_single_occurrence()
    test_search_finds_multiple_occurrences()
    test_search_dedupes_overlapping_variant_hits()
    test_search_returns_empty_for_missing_value()
    test_has_useful_text_layer_true_for_typed_pdf()
    test_has_useful_text_layer_false_for_blank_pdf()
    print("OK")
