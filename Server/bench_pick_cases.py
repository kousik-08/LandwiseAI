"""Pick representative NOT-MATCHED cases from the existing validation outputs."""
import json
import os
import re

VALIDATE_DIR = "outputs/validate/69a95897-ac3f-4859-bd87-bbec66a1320d"
TEMP_DIR = os.path.join(VALIDATE_DIR, "temp_debug")


def main():
    files = [f for f in os.listdir(VALIDATE_DIR) if f.endswith("_validation.json")]
    cases = []
    for f in files:
        full = os.path.join(VALIDATE_DIR, f)
        try:
            d = json.load(open(full, encoding="utf-8"))
        except Exception as e:
            print(f"[skip] {f}: {e}")
            continue
        doc_no = f.replace("_validation.json", "")
        for c in d.get("validation_result", {}).get("comparisons", []):
            status = (c.get("status") or "").upper()
            if "NOT MATCHED" not in status:
                continue
            val = str(c.get("metadata_value") or "").strip()
            if not val or val in ("*", "N/A", "-", "null", "None"):
                continue
            if len(val) > 60:
                continue
            page_info = str(c.get("page_number") or "")
            page_match = re.search(r"\d+", page_info)
            page_num = int(page_match.group(0)) if page_match else 1
            cases.append({
                "doc_no": doc_no,
                "field": c.get("field"),
                "value": val,
                "page": page_num,
            })
    print(f"Total NOT-MATCHED with usable values: {len(cases)}")
    # Show distribution
    by_field = {}
    for c in cases:
        by_field.setdefault(c["field"], 0)
        by_field[c["field"]] += 1
    print("\nBy field:")
    for k, v in sorted(by_field.items(), key=lambda x: -x[1]):
        print(f"  {v:3d}  {k}")

    # Check which have a raw page PNG already extracted
    available = []
    for c in cases:
        raw = os.path.join(TEMP_DIR, f"raw_{c['doc_no']}_p{c['page']}.png")
        if os.path.exists(raw):
            c["png"] = raw
            available.append(c)
    print(f"\nCases with raw PNG already extracted: {len(available)}")
    for c in available:
        print(f"  doc={c['doc_no']} page={c['page']} field={c['field']!r} value={c['value']!r}")

    with open("bench_cases.json", "w", encoding="utf-8") as f:
        json.dump(available, f, ensure_ascii=False, indent=2)
    print(f"\nSaved {len(available)} cases to bench_cases.json")


if __name__ == "__main__":
    main()
