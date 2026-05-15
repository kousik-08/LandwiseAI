"""Parse bench_progress.log into bench_results.json.

The log has per-case lines like:
  [1/12] 254_2011_p2_Document_Number
          value='234/2011'
     [A] bbox=[..] method='..' rend=.. verify=.. elapsed=..s err=..
     [B] ...
     [C] ...

We reconstruct one row per (case, approach) so the summarizer can pick up.
"""
import json
import os
import re

LOG = "bench_progress.log"
OUT = "bench_results.json"


def parse_value_for_field(raw: str) -> str | None:
    """Extract the value=... field from a 'value=...' line."""
    m = re.search(r"value=(.+)$", raw)
    if not m:
        return None
    s = m.group(1).strip()
    # Drop surrounding quote
    if s.startswith("'") and s.endswith("'"):
        s = s[1:-1]
    return s


def parse_bbox(s: str):
    m = re.search(r"bbox=(\[[^\]]+\]|None)", s)
    if not m:
        return None
    v = m.group(1)
    if v == "None":
        return None
    return json.loads(v)


def parse_kv(s: str, key: str):
    m = re.search(rf"\b{key}=('[^']*'|[^\s]+)", s)
    if not m:
        return None
    v = m.group(1)
    if v == "None":
        return None
    if v.startswith("'") and v.endswith("'"):
        v = v[1:-1]
    return v


def parse_elapsed(s: str):
    m = re.search(r"elapsed=([\d.]+)s", s)
    return float(m.group(1)) if m else None


def parse_err(s: str):
    m = re.search(r"err=(.+)$", s)
    if not m:
        return None
    v = m.group(1).strip()
    return None if v == "None" else v


def case_id(name: str) -> str:
    return name.strip()


def main():
    if not os.path.exists(LOG):
        print(f"[!] {LOG} missing")
        return

    rows = []
    cur_case = None
    cur_value = None
    with open(LOG, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            m = re.match(r"^\[\d+/\d+\]\s+(\S+)", line)
            if m:
                cur_case = m.group(1)
                cur_value = None
                continue
            mv = re.match(r"^\s+value=(.+)$", line)
            if mv:
                s = mv.group(1).strip()
                if s.startswith("'") and s.endswith("'"):
                    s = s[1:-1]
                cur_value = s
                continue
            ma = re.match(r"^\s+\[([ABC])\]\s+(.+)$", line)
            if ma and cur_case:
                approach = ma.group(1)
                rest = ma.group(2)
                rows.append({
                    "case_id": cur_case,
                    "approach": approach,
                    "value": cur_value,
                    "bbox": parse_bbox(rest),
                    "method": parse_kv(rest, "method"),
                    "rendition": parse_kv(rest, "rend"),
                    "verified": parse_kv(rest, "verify"),
                    "elapsed_s": parse_elapsed(rest),
                    "error": parse_err(rest),
                })

    # Need to backfill doc_no/page/field/png/note from bench_cases.json
    cases = json.load(open("bench_cases.json", encoding="utf-8"))
    def field_to_id(f):
        return re.sub(r"[^A-Za-z0-9]+", "_", f)[:30]
    case_meta = {}
    for c in cases:
        cid = f"{c['doc_no']}_p{c['page']}_{field_to_id(c['field'])}"
        case_meta[cid] = c

    for r in rows:
        meta = case_meta.get(r["case_id"])
        if meta:
            r["doc_no"] = meta["doc_no"]
            r["page"] = meta["page"]
            r["field"] = meta["field"]
            r["png"] = meta["png"]
        r["note"] = ""

    print(f"Parsed {len(rows)} approach-results across {len({r['case_id'] for r in rows})} cases")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
