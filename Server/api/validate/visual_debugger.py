import os
import re
import fitz  # PyMuPDF
from common.gemini_helper import GeminiHelper
from common.storage_sync import sync_file as _sync_file
import threading
import shutil


class VisualDebugger:
    """
    Visual debugger v5 — all-pages text-locator pipeline.

    For each mismatch, scan every page of the PDF:
        1. Try PdfTextLocator first (cheap, exact text-layer search).
        2. If no hit and the page has no useful text layer, batch the value
           into a per-page GeminiBboxLocator call.
        3. Draw all hits (red rectangle + label) onto the marked PDF.

    Each mismatch can produce 0..N boxes across the document. The grid /
    ruler overlay pipeline, cover-page heuristics, and verification crop
    from earlier iterations have been removed.
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

    # Color scheme: RED mismatch boxes
    MISMATCH_BOX_COLOR = (255, 0, 0)
    MISMATCH_TEXT_COLOR = (255, 0, 0)

    def __init__(self, gemini_helper: GeminiHelper, output_dir: str):
        from api.validate.gemini_bbox import GeminiBboxLocator   # local import to avoid cycles
        self.gemini = gemini_helper
        self.bbox_locator = GeminiBboxLocator(gemini_helper)
        self.output_dir = output_dir
        self.temp_dir = os.path.join(output_dir, "temp_debug")
        self.lock = threading.Lock()
        os.makedirs(self.temp_dir, exist_ok=True)

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

    @staticmethod
    def audit_coverage(doc_no, mismatches, per_mismatch_boxes, total_boxes):
        """
        Coverage report under the all-pages model: per mismatch, count boxes
        drawn. A mismatch with 0 boxes is a miss; ≥1 is a hit.
        """
        report = {
            "doc_no": doc_no,
            "total_mismatches": len(mismatches),
            "total_boxes_drawn": total_boxes,
            "hits": sum(1 for n in per_mismatch_boxes.values() if n > 0),
            "misses": sum(1 for n in per_mismatch_boxes.values() if n == 0),
            "per_mismatch": [
                {"field": f, "value": v, "boxes": n}
                for (f, v), n in per_mismatch_boxes.items()
            ],
            "all_marked": all(n > 0 for n in per_mismatch_boxes.values()),
        }
        if report["all_marked"]:
            print(f"[VD] Coverage OK: {report['hits']}/{len(mismatches)} mismatches marked for {doc_no} ({total_boxes} total boxes).")
        else:
            print(
                f"[VD] Coverage WARNING for {doc_no}: "
                f"{report['hits']}/{len(mismatches)} mismatches marked, "
                f"{report['misses']} missed."
            )
            for entry in report["per_mismatch"]:
                if entry["boxes"] == 0:
                    print(f"   [VD] miss: field={entry['field']!r} value={entry['value']!r}")
        return report

    # ── Batch debug entry point ──────────────────────────────────────────────

    def debug_mismatches_batch(self, pdf_path, doc_no, mismatches):
        """
        Process every mismatch for a single document. New flow (spec §3):

          for page in all_pages:
              text_hits = PdfTextLocator.search_in_page(page, variants_for_each_mismatch)
              if no hits for a mismatch on this page AND page has no text layer:
                  → batch into per-page Gemini call
              draw all hits

        Each mismatch can produce 0..N boxes across the document.
        """
        from api.validate.text_locator import PdfTextLocator
        from api.validate.value_variants import build_variants

        clean_doc_no = doc_no.replace("/", "_").replace("\\", "_")
        all_boxes: list[dict] = []
        per_mismatch_boxes: dict[tuple, int] = {}
        variants_by_mm: dict[tuple, list[str]] = {}
        for mm in mismatches:
            key = (mm["field"], mm["value"])
            if key not in per_mismatch_boxes:
                per_mismatch_boxes[key] = 0
                variants_by_mm[key] = build_variants(mm["value"], mm["field"])

        doc = fitz.open(pdf_path)
        try:
            total_pages = doc.page_count
            for page_idx in range(total_pages):
                page_num = page_idx + 1
                page = doc.load_page(page_idx)
                pdf_rect = (page.rect.x0, page.rect.y0, page.rect.x1, page.rect.y1)
                yield f"Scanning {doc_no} page {page_num}/{total_pages}"

                unresolved: list[tuple] = []
                for mm in mismatches:
                    key = (mm["field"], mm["value"])
                    variants = variants_by_mm[key]
                    hits = PdfTextLocator.search_in_page(page, variants)
                    if hits:
                        for r in hits:
                            all_boxes.append({
                                "page_num": page_num,
                                "pdf_rect_box": r,
                                "pdf_rect": pdf_rect,
                                "label": mm["field"],
                            })
                            per_mismatch_boxes[key] += 1
                    else:
                        unresolved.append(key)

                if not unresolved:
                    continue
                if PdfTextLocator.has_useful_text_layer(page):
                    continue
                if self.bbox_locator is None:
                    # No Gemini fallback configured (e.g. test harness) — skip.
                    continue

                base_img = os.path.join(
                    self.temp_dir, f"raw_{clean_doc_no}_p{page_num}.png"
                )
                extraction = self.extract_page_as_image(pdf_path, page_num, base_img)
                if not extraction:
                    continue
                # Pixel dimensions are deterministic from the page rect and SCALE.
                x0, y0, x1, y1 = pdf_rect
                page_w_px = round((x1 - x0) * self.SCALE)
                page_h_px = round((y1 - y0) * self.SCALE)
                values = list(dict.fromkeys(mm_value for (_, mm_value) in unresolved))
                hits_by_value = self.bbox_locator.locate(
                    page_image_path=base_img,
                    page_w_px=page_w_px,
                    page_h_px=page_h_px,
                    values=values,
                )
                for key in unresolved:
                    field, value = key
                    for pixel_box in hits_by_value.get(value, []):
                        all_boxes.append({
                            "page_num": page_num,
                            "pixel_box": list(pixel_box),
                            "img_width": page_w_px,
                            "img_height": page_h_px,
                            "pdf_rect": pdf_rect,
                            "label": field,
                        })
                        per_mismatch_boxes[key] += 1
        finally:
            doc.close()

        if not all_boxes:
            yield f"No occurrences found for any mismatch in {doc_no}"
            return None

        output_name = os.path.basename(pdf_path)
        output_path = os.path.join(self.output_dir, "matched_docs", output_name)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        active_source = output_path if os.path.exists(output_path) else pdf_path
        self.mark_pdf_with_boxes(active_source, all_boxes, output_path, doc_no=clean_doc_no)

        try:
            rid = os.path.basename(os.path.normpath(self.output_dir))
            kind = os.path.basename(os.path.dirname(os.path.normpath(self.output_dir))) or "validate"
            vd_key = f"outputs/{kind}/{rid}/matched_docs/{os.path.basename(output_path)}"
            _sync_file(output_path, content_type="application/pdf", key=vd_key)
        except Exception as _e:
            print(f"[VD] sync_file failed for {output_path}: {_e}")

        yield f"Marked {len(all_boxes)} occurrences across {doc_no}"

        self.last_coverage_report = self.audit_coverage(
            doc_no=doc_no,
            mismatches=mismatches,
            per_mismatch_boxes=per_mismatch_boxes,
            total_boxes=len(all_boxes),
        )
        return output_path

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
