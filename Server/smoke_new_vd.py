"""End-to-end smoke test of the new VisualDebugger against one real mismatch."""
import os
import sys
import shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv()

from common.gemini_helper import GeminiHelper
from api.validate.visual_debugger import VisualDebugger


def main():
    # Pick one case — case 12 (typed date "28/11/2014") since prior benchmarks
    # confirmed this value is present on page 3 of 9268_2014. Tests the new
    # two-call flow end-to-end: per page, sentence-context locate → padded
    # crop → pinpoint locate → draw. Source PDF located in matched_docs.
    src_pdf_input = "outputs/validate/4d85f2e2-5d03-41bf-98a8-601e91528fd7/matched_docs/9268_2014.pdf"
    target = {
        "doc_no": "9268_2014",
        "page": 3,
        # The actual value is a date; we just want to test the locator.
        "field": "Document Date",
        "value": "28/11/2014",
        "src_pdf": src_pdf_input,
    }
    print(f"[*] Smoke case: doc={target['doc_no']} p{target['page']} field={target['field']!r} value={target['value']!r}")

    # Use a persistent local workdir so the debug artefacts (raw / grid /
    # marked PNGs + context JSON) are still on disk after the run finishes.
    # Wiped at the START of every run so we never see stale artefacts.
    import fitz
    work = os.path.abspath(os.path.join("bench_out", "_smoke_new_vd_run"))
    if os.path.exists(work):
        shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    src_pdf = os.path.join(work, "smoke.pdf")
    shutil.copy(target["src_pdf"], src_pdf)
    print(f"[*] Source PDF: {src_pdf}")

    out_dir = os.path.join(work, "outputs")
    gemini = GeminiHelper(model_id="gemini-2.5-flash")
    vd = VisualDebugger(gemini, out_dir)

    print(f"[*] Running debug_mismatches_batch ...")
    last_msg = None
    for msg in vd.debug_mismatches_batch(
        pdf_path=src_pdf,
        doc_no=target["doc_no"],
        mismatches=[{
            "field": target["field"],
            "value": target["value"],
            "page_info": f"Page {target['page']}",  # ignored by new flow, kept for shape
        }],
    ):
        print(f"   [VD] {msg}")
        last_msg = msg

    marked = os.path.join(out_dir, "matched_docs", os.path.basename(src_pdf))
    if os.path.exists(marked):
        print(f"[OK] Marked PDF written: {marked}")
        dest_dir = os.path.join("bench_out", "_smoke_new_vd")
        os.makedirs(dest_dir, exist_ok=True)
        shutil.copy(marked, os.path.join(dest_dir, "marked.pdf"))
        # Render the targeted page → PNG for visual inspection
        d = fitz.open(marked)
        if target["page"] <= len(d):
            p = d.load_page(target["page"] - 1)
            pix = p.get_pixmap(matrix=fitz.Matrix(2, 2))
            png_dest = os.path.join(dest_dir, f"marked_p{target['page']}.png")
            pix.save(png_dest)
            print(f"[OK] Marked page render: {png_dest}")
        d.close()
    else:
        print(f"[FAIL] No marked PDF produced (last_msg={last_msg!r})")

    # Surface the artefact locations so the operator can open them directly.
    debug_dir = os.path.join(out_dir, "debug", target["doc_no"])
    print(f"[*] Debug artefacts (raw/grid/marked PNGs + context JSON): {debug_dir}")
    if os.path.isdir(debug_dir):
        for name in sorted(os.listdir(debug_dir)):
            print(f"      - {name}")
    print(f"[*] Workdir preserved at: {work}")


if __name__ == "__main__":
    main()
