"""End-to-end smoke test of the new VisualDebugger against one real mismatch."""
import os
import sys
import shutil
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv()

from common.gemini_helper import GeminiHelper
from api.validate.visual_debugger import VisualDebugger


def main():
    # Pick one case — case 12 (typed date "28/11/2014") since all 3 benchmark
    # approaches succeeded on it, giving us a known-good comparison.
    # Doc 9268_2014 page 3 — Date of Registration "28/11/2014" verified
    # positive in prior benchmark. Tests the full happy path: locate +
    # min-area + verify=yes + draw. Source PDF located in matched_docs.
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

    # Copy the source PDF to a temp workdir so we can target its real page numbers
    import fitz
    work = tempfile.mkdtemp(prefix="smoke_vd_")
    src_pdf = os.path.join(work, "smoke.pdf")
    shutil.copy(target["src_pdf"], src_pdf)
    print(f"[*] Source PDF: {src_pdf}")

    out_dir = os.path.join(work, "outputs")
    gemini = GeminiHelper(model_id="gemini-2.5-flash")
    vd = VisualDebugger(gemini, out_dir)

    mismatches = [{
        "field": target["field"],
        "value": target["value"],
        "page_info": f"Page {target['page']} (Metadata)",
    }]

    print(f"[*] Running debug_mismatches_batch ...")
    last_msg = None
    for msg in vd.debug_mismatches_batch(src_pdf, target["doc_no"], mismatches):
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

    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
