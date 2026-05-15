"""Re-run only the (case, approach) pairs that errored or are missing."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bench_approaches import (
    approach_a, approach_b, approach_c, annotate, case_id, OUT_DIR
)


def main():
    rows = json.load(open("bench_results.json", encoding="utf-8"))
    cases = json.load(open("bench_cases.json", encoding="utf-8"))

    import re
    def field_to_id(f):
        return re.sub(r"[^A-Za-z0-9]+", "_", f)[:30]
    cases_by_id = {f"{c['doc_no']}_p{c['page']}_{field_to_id(c['field'])}": c for c in cases}

    # Find what's missing or had a network error
    by_case = {}
    for r in rows:
        by_case.setdefault(r["case_id"], {})[r["approach"]] = r

    todo = []
    for cid, c in cases_by_id.items():
        for ap in ("A", "B", "C"):
            r = by_case.get(cid, {}).get(ap)
            needs_rerun = False
            if not r:
                needs_rerun = True
            elif r.get("error") and "getaddrinfo" in (r["error"] or ""):
                needs_rerun = True
            if needs_rerun:
                todo.append((cid, ap, c))

    print(f"[*] {len(todo)} (case, approach) pairs to re-run")
    for cid, ap, _ in todo:
        print(f"    {cid}  approach={ap}")

    approach_fns = {"A": approach_a, "B": approach_b, "C": approach_c}

    for cid, ap, c in todo:
        print(f"\n--- {cid}  approach {ap} ---")
        try:
            r = approach_fns[ap](c["png"], c["value"])
            r.case_id = cid
        except Exception as e:
            print(f"  crash: {e}")
            continue
        print(f"  bbox={r.bbox} method={r.method!r} rend={r.rendition} verify={r.verified} elapsed={r.elapsed_s:.1f}s err={r.error}")
        # Replace existing row or append
        new_row = {
            "case_id": cid, "doc_no": c["doc_no"], "page": c["page"],
            "field": c["field"], "value": c["value"], "png": c["png"],
            "approach": ap, "bbox": r.bbox, "method": r.method,
            "rendition": r.rendition, "verified": r.verified,
            "elapsed_s": r.elapsed_s, "error": r.error, "note": r.note,
        }
        rows = [x for x in rows if not (x["case_id"] == cid and x["approach"] == ap)]
        rows.append(new_row)
        with open("bench_results.json", "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=2)

        # Re-render annotated PNG
        out_png = os.path.join(OUT_DIR, cid, f"approach_{ap}.png")
        try:
            annotate(c["png"], r.bbox, f"Approach {ap}", out_png)
        except Exception as e:
            print(f"  annotate failed: {e}")


if __name__ == "__main__":
    main()
