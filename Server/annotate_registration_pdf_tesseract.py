"""
annotate_registration_pdf_tesseract.py — OCR-only visual debugger for
Tamil Nadu land-registration PDFs.

Renders each page of a PDF, runs Tesseract OCR (default lang ``eng+tam``),
and draws three diagnostic layers directly onto the original PDF:

  - words   (every recognised token, with text + confidence labels)
  - lines   (Tesseract block/par/line grouping)
  - blocks  (Tesseract block grouping)

NO LLM call is made. The goal is to inspect exactly what Tesseract perceives
on a scanned / handwritten registration document — useful for tuning DPI,
language packs, and layout settings before any downstream classification.

# Install
    pip install pymupdf pytesseract Pillow

    # Linux
    sudo apt-get install tesseract-ocr tesseract-ocr-tam
    # macOS
    brew install tesseract tesseract-lang
    # Windows
    #   - choco install tesseract
    #   - or download the UB Mannheim installer and pass --tesseract-cmd

# Run
    python annotate_registration_pdf_tesseract.py input.pdf
        [-o output.pdf]
        [--dpi 300]
        [--lang eng+tam]
        [--min-conf 30]
        [--show-words/--no-show-words]
        [--show-lines/--no-show-lines]
        [--show-blocks/--no-show-blocks]
        [--tesseract-cmd /path/to/tesseract]

# Side outputs
    <input>_tesseract.pdf   annotated copy of the input PDF (selectable text preserved)
    <input>_ocr.json        raw image_to_data dump + PDF-space rects per page
    <input>_ocr.txt         plain OCR text per page, form-feed separated
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ── Layer config (FIELDS-style dict at module scope) ───────────────────────
# RGB triplets in [0,1] for fitz's draw_rect / insert_text.
LAYERS: Dict[str, Tuple[float, float, float]] = {
    "word":  (0.05, 0.45, 0.85),   # blue
    "line":  (0.10, 0.65, 0.30),   # green
    "block": (0.85, 0.20, 0.20),   # red
}

# Tesseract image_to_data `level` constants. We only care about word-level
# rows for box drawing; the higher levels are reconstructed from word-level
# (block_num, par_num, line_num) groupings.
LEVEL_PAGE  = 1
LEVEL_BLOCK = 2
LEVEL_PARA  = 3
LEVEL_LINE  = 4
LEVEL_WORD  = 5


# ── Dataclasses ────────────────────────────────────────────────────────────

@dataclass
class WordRow:
    """One Tesseract word, in both image-pixel and PDF-point coordinates."""
    text: str
    conf: float
    block_num: int
    par_num: int
    line_num: int
    word_num: int
    # Pixel coords exactly as Tesseract returned them
    left: int
    top: int
    width: int
    height: int
    # PDF-point rect (clamped to page), computed from the same zoom factor
    # used to rasterise the page for OCR.
    pdf_rect: Tuple[float, float, float, float]


@dataclass
class PageOcr:
    """All OCR results for one PDF page, plus rendering metadata."""
    page_number: int                                # 1-indexed
    dpi: int
    zoom: float                                     # dpi / 72
    image_size_px: Tuple[int, int]                  # (width, height)
    page_rect_pt: Tuple[float, float, float, float] # (x0, y0, x1, y1) in points
    text: str
    words: List[WordRow] = field(default_factory=list)
    raw_data: Dict[str, List[Any]] = field(default_factory=dict)  # full image_to_data dump


# ── Helpers ────────────────────────────────────────────────────────────────

def _eprint(*args, **kwargs) -> None:
    print(*args, file=sys.stderr, **kwargs)


def _check_tesseract(tesseract_cmd: Optional[str]) -> int:
    """Verify both the Python binding and the binary. Returns 0 on success."""
    try:
        import pytesseract  # noqa: F401
    except ImportError:
        _eprint("[!] pytesseract is not installed.")
        _eprint("    pip install pytesseract Pillow")
        return 2

    import pytesseract  # re-import for type-checker
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd

    try:
        version = pytesseract.get_tesseract_version()
        _eprint(f"[i] Tesseract version: {version}")
    except Exception as e:
        _eprint(f"[!] tesseract binary not found: {e}")
        _eprint("    Linux:   sudo apt-get install tesseract-ocr tesseract-ocr-tam")
        _eprint("    macOS:   brew install tesseract tesseract-lang")
        _eprint("    Windows: choco install tesseract (or UB Mannheim installer)")
        _eprint("    Or pass --tesseract-cmd /path/to/tesseract(.exe)")
        return 3
    return 0


def _clamp_rect(
    x0: float, y0: float, x1: float, y1: float,
    page_w: float, page_h: float,
) -> Tuple[float, float, float, float]:
    """Clamp a PDF-points rectangle to the page bounds."""
    x0 = max(0.0, min(x0, page_w))
    y0 = max(0.0, min(y0, page_h))
    x1 = max(0.0, min(x1, page_w))
    y1 = max(0.0, min(y1, page_h))
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return (x0, y0, x1, y1)


def _safe_label(text: str, conf: float) -> str:
    """ASCII-safe label for the PDF.

    fitz's built-in font (Helvetica) can't render Tamil glyphs, so any
    non-ASCII characters are replaced with '?' in the on-PDF label. The
    JSON sidecar carries the full Tamil text — this is just for visual
    cross-referencing of position.
    """
    ascii_text = text.encode("ascii", "replace").decode("ascii")
    return f"{ascii_text} ({conf:.0f})"


def _coerce_json(value: Any) -> Any:
    """Recursively coerce values into JSON-serialisable forms."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [_coerce_json(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _coerce_json(v) for k, v in value.items()}
    return str(value)


def _group_lines(words: List[WordRow]) -> List[Tuple[Tuple[int, int, int], List[WordRow]]]:
    groups: Dict[Tuple[int, int, int], List[WordRow]] = {}
    for w in words:
        groups.setdefault((w.block_num, w.par_num, w.line_num), []).append(w)
    return sorted(groups.items())


def _group_blocks(words: List[WordRow]) -> List[Tuple[int, List[WordRow]]]:
    groups: Dict[int, List[WordRow]] = {}
    for w in words:
        groups.setdefault(w.block_num, []).append(w)
    return sorted(groups.items())


def _union_rect(words: List[WordRow]) -> Tuple[float, float, float, float]:
    xs0 = [w.pdf_rect[0] for w in words]
    ys0 = [w.pdf_rect[1] for w in words]
    xs1 = [w.pdf_rect[2] for w in words]
    ys1 = [w.pdf_rect[3] for w in words]
    return (min(xs0), min(ys0), max(xs1), max(ys1))


# ── Core OCR + draw routines ───────────────────────────────────────────────

def _ocr_page(page, dpi: int, lang: str, min_conf: float) -> PageOcr:
    """Render `page` at `dpi`, run Tesseract image_to_data, return a PageOcr."""
    import fitz
    import pytesseract
    from PIL import Image
    from pytesseract import Output

    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

    data = pytesseract.image_to_data(img, lang=lang, output_type=Output.DICT)
    text = pytesseract.image_to_string(img, lang=lang)

    page_rect = page.rect
    page_w, page_h = page_rect.width, page_rect.height

    words: List[WordRow] = []
    n = len(data.get("text", []) or [])
    for i in range(n):
        try:
            if int(data["level"][i]) != LEVEL_WORD:
                continue
        except (TypeError, ValueError, KeyError):
            continue

        raw_text = (data["text"][i] or "")
        if not raw_text or not raw_text.strip():
            continue

        # Tesseract returns conf as either str ("95") or float depending on
        # version; coerce defensively. -1 means "not a word level row".
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError):
            conf = -1.0
        if conf < min_conf:
            continue

        try:
            left   = int(data["left"][i])
            top    = int(data["top"][i])
            width  = int(data["width"][i])
            height = int(data["height"][i])
        except (TypeError, ValueError, KeyError):
            continue

        # Image-pixel → PDF-point conversion uses the SAME zoom we rendered
        # with, so the box lands exactly back on the original ink.
        x0 = left / zoom
        y0 = top / zoom
        x1 = (left + width) / zoom
        y1 = (top + height) / zoom
        pdf_rect = _clamp_rect(x0, y0, x1, y1, page_w, page_h)

        words.append(WordRow(
            text=raw_text,
            conf=conf,
            block_num=int(data["block_num"][i]),
            par_num=int(data["par_num"][i]),
            line_num=int(data["line_num"][i]),
            word_num=int(data["word_num"][i]),
            left=left, top=top, width=width, height=height,
            pdf_rect=pdf_rect,
        ))

    return PageOcr(
        page_number=page.number + 1,
        dpi=dpi,
        zoom=zoom,
        image_size_px=(pix.width, pix.height),
        page_rect_pt=(page_rect.x0, page_rect.y0, page_rect.x1, page_rect.y1),
        text=text,
        words=words,
        raw_data=_coerce_json(data),
    )


def _draw_layers(
    page,
    ocr: PageOcr,
    show_words: bool,
    show_lines: bool,
    show_blocks: bool,
) -> None:
    """Draw the enabled layers onto the page in distinct colours."""
    import fitz

    page_rect = page.rect
    page_w, page_h = page_rect.width, page_rect.height

    # Block layer first so word boxes stack on top of it.
    if show_blocks:
        for _block_num, ws in _group_blocks(ocr.words):
            if not ws:
                continue
            rect = fitz.Rect(*_clamp_rect(*_union_rect(ws), page_w, page_h))
            if rect.is_empty:
                continue
            page.draw_rect(rect, color=LAYERS["block"], width=1.2)

    if show_lines:
        for _key, ws in _group_lines(ocr.words):
            if not ws:
                continue
            rect = fitz.Rect(*_clamp_rect(*_union_rect(ws), page_w, page_h))
            if rect.is_empty:
                continue
            page.draw_rect(rect, color=LAYERS["line"], width=0.7)

    if show_words:
        for w in ocr.words:
            rect = fitz.Rect(*w.pdf_rect)
            if rect.is_empty:
                continue
            page.draw_rect(rect, color=LAYERS["word"], width=0.4)

            label = _safe_label(w.text, w.conf)
            # Baseline just above the box, clamped to stay on-page. fitz's
            # insert_text draws upward from the baseline (smaller y in PDF
            # coords is higher on the page).
            fontsize = 4.5
            ty = rect.y0 - 1.0
            if ty - fontsize < page_rect.y0:
                # Not enough room above — drop the label below the box instead
                ty = min(rect.y1 + fontsize + 0.5, page_rect.y1 - 0.5)
            try:
                page.insert_text(
                    (rect.x0, ty),
                    label,
                    fontsize=fontsize,
                    color=LAYERS["word"],
                )
            except Exception:
                # Truly unrenderable — skip the label, keep the box.
                pass


# ── JSON / TXT sidecars ────────────────────────────────────────────────────

def _to_serialisable(page_ocr: PageOcr) -> Dict[str, Any]:
    """Plain-dict form of PageOcr suitable for json.dump."""
    d = asdict(page_ocr)
    # Tuples in nested fields are already converted to lists by asdict.
    return d


# ── CLI ────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="pytesseract-based visual debugger for TN registration PDFs.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("input", help="Input PDF path")
    p.add_argument(
        "-o", "--output", default=None,
        help="Output annotated PDF path (default: <input>_tesseract.pdf)",
    )
    p.add_argument("--dpi", type=int, default=300, help="Render DPI for OCR + coordinate mapping")
    p.add_argument("--lang", default="eng+tam", help="Tesseract language pack(s), e.g. 'eng+tam'")
    p.add_argument("--min-conf", type=float, default=30.0,
                   help="Skip words with Tesseract confidence below this threshold")
    p.add_argument("--show-words", action=argparse.BooleanOptionalAction, default=True,
                   help="Draw word-level boxes with text + conf labels")
    p.add_argument("--show-lines", action=argparse.BooleanOptionalAction, default=True,
                   help="Draw Tesseract line-grouped boxes (block/par/line)")
    p.add_argument("--show-blocks", action=argparse.BooleanOptionalAction, default=True,
                   help="Draw Tesseract block-grouped boxes")
    p.add_argument("--tesseract-cmd", default=None,
                   help="Override path to the tesseract binary (otherwise rely on PATH)")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    in_path = Path(args.input)
    if not in_path.exists():
        _eprint(f"[!] Input PDF not found: {in_path}")
        return 1

    out_path  = Path(args.output) if args.output else in_path.with_name(f"{in_path.stem}_tesseract.pdf")
    json_path = in_path.with_name(f"{in_path.stem}_ocr.json")
    txt_path  = in_path.with_name(f"{in_path.stem}_ocr.txt")

    rc = _check_tesseract(args.tesseract_cmd)
    if rc != 0:
        return rc

    try:
        import fitz  # noqa: F401
    except ImportError:
        _eprint("[!] PyMuPDF is not installed.")
        _eprint("    pip install pymupdf")
        return 4
    import fitz

    if "TESSDATA_PREFIX" in os.environ:
        print(f"[i] Honouring TESSDATA_PREFIX={os.environ['TESSDATA_PREFIX']}")

    print(f"[+] Opening {in_path}")
    doc = fitz.open(in_path)
    all_pages: List[PageOcr] = []
    try:
        for page_idx in range(len(doc)):
            page = doc.load_page(page_idx)
            print(f"[+] Page {page_idx + 1}/{len(doc)}: OCR @ {args.dpi} dpi, lang={args.lang}")
            ocr = _ocr_page(page, args.dpi, args.lang, args.min_conf)
            print(f"    {len(ocr.words)} words >= conf {args.min_conf}")
            _draw_layers(
                page, ocr,
                show_words=args.show_words,
                show_lines=args.show_lines,
                show_blocks=args.show_blocks,
            )
            all_pages.append(ocr)

        # Keep the original page geometry — don't pixelate. fitz.save writes
        # vector PDF with our overlay objects added on top of the source.
        print(f"[+] Writing annotated PDF -> {out_path}")
        doc.save(out_path)
    finally:
        doc.close()

    print(f"[+] Writing OCR JSON -> {json_path}")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(
            {"pages": [_to_serialisable(p) for p in all_pages]},
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"[+] Writing plain text -> {txt_path}")
    with open(txt_path, "w", encoding="utf-8") as f:
        # Form-feed (\f) is the standard page separator for OCR plaintext.
        f.write("\f".join((p.text or "").rstrip() for p in all_pages))

    print(f"[+] Done. Annotated PDF: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
