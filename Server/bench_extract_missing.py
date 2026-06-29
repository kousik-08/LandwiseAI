"""Extract page PNGs for benchmark cases that don't yet have a raw render."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fitz

VALIDATE_DIR = "outputs/validate/69a95897-ac3f-4859-bd87-bbec66a1320d"
TEMP_DIR = os.path.join(VALIDATE_DIR, "temp_debug")
DPI = 200
SCALE = DPI / 72.0


def find_source_pdf(doc_no: str) -> str | None:
    """Locate the source PDF for a given doc number under inputs/ or outputs/."""
    # Common patterns: 254_2011 → "254_2011.pdf" or "254-2011.pdf" or with prefix
    candidates = [
        f"inputs",
        f"outputs/validate/69a95897-ac3f-4859-bd87-bbec66a1320d/matched_docs",
    ]
    target_underscore = doc_no.replace("/", "_")
    target_slash = doc_no.replace("_", "/")
    for root in candidates:
        if not os.path.isdir(root):
            continue
        for dirpath, _, files in os.walk(root):
            for f in files:
                if not f.lower().endswith(".pdf"):
                    continue
                # Try matching the doc number in various formats
                fname = f.lower()
                if target_underscore.lower() in fname or target_slash.lower() in fname:
                    return os.path.join(dirpath, f)
    return None


def main():
    files = [f for f in os.listdir(VALIDATE_DIR) if f.endswith("_validation.json")]
    cases = []
    for f in files:
        full = os.path.join(VALIDATE_DIR, f)
        try:
            d = json.load(open(full, encoding="utf-8"))
        except Exception:
            continue
        doc_no = f.replace("_validation.json", "")
        for c in d.get("validation_result", {}).get("comparisons", []):
            status = (c.get("status") or "").upper()
            if "NOT MATCHED" not in status:
                continue
            val = str(c.get("metadata_value") or "").strip()
            if not val or val in ("*", "N/A", "-", "null", "None") or len(val) > 60:
                continue
            page_info = str(c.get("page_number") or "")
            pm = re.search(r"\d+", page_info)
            page_num = int(pm.group(0)) if pm else 1
            cases.append({"doc_no": doc_no, "field": c.get("field"),
                          "value": val, "page": page_num})

    # Find unique (doc_no, page) pairs missing a raw render
    needed = set()
    for c in cases:
        raw = os.path.join(TEMP_DIR, f"raw_{c['doc_no']}_p{c['page']}.png")
        if not os.path.exists(raw):
            needed.add((c["doc_no"], c["page"]))

    print(f"Need to extract {len(needed)} page(s): {sorted(needed)}")

    for doc_no, page_num in sorted(needed):
        pdf = find_source_pdf(doc_no)
        if not pdf:
            print(f"  [skip] no PDF found for {doc_no}")
            continue
        out_png = os.path.join(TEMP_DIR, f"raw_{doc_no}_p{page_num}.png")
        os.makedirs(TEMP_DIR, exist_ok=True)
        try:
            doc = fitz.open(pdf)
            if page_num < 1 or page_num > len(doc):
                print(f"  [skip] page {page_num} out of range for {pdf}")
                doc.close()
                continue
            page = doc.load_page(page_num - 1)
            pix = page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE))
            pix.save(out_png)
            doc.close()
            print(f"  [+] {doc_no} p{page_num}: {pix.width}x{pix.height} -> {out_png}")
        except Exception as e:
            print(f"  [!] {doc_no} p{page_num}: {e}")


if __name__ == "__main__":
    main()
