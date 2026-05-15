"""Summarize bench_results.json into a per-case comparison and aggregate metrics."""
import json
import os
from collections import defaultdict


RESULTS_FILE = "bench_results.json"


def main():
    if not os.path.exists(RESULTS_FILE):
        print(f"[!] {RESULTS_FILE} missing.")
        return
    rows = json.load(open(RESULTS_FILE, encoding="utf-8"))

    by_case = defaultdict(dict)
    for r in rows:
        by_case[r["case_id"]][r["approach"]] = r

    # Aggregate metrics per approach
    agg = {a: {"found": 0, "errored": 0, "rejected": 0, "total_time": 0.0, "count": 0}
           for a in ("A", "B", "C")}

    print("=" * 96)
    print(f"{'CASE':<48}  {'A':<14} {'B':<14} {'C':<14}")
    print(f"{'-'*48}  {'-'*14} {'-'*14} {'-'*14}")
    for cid in sorted(by_case):
        a = by_case[cid].get("A", {})
        b = by_case[cid].get("B", {})
        c = by_case[cid].get("C", {})

        def short(r):
            if not r:
                return "—"
            if r.get("error"):
                return f"ERR {r['error'][:8]}"
            if r.get("bbox"):
                bx = r["bbox"]
                return f"box ({bx[0]},{bx[1]})"
            # No bbox, no error
            method = (r.get("method") or "")
            if "not_found" in method:
                return "not_found"
            verified = r.get("verified")
            if verified == "no":
                return "verify=no"
            return "no-box"

        print(f"{cid[:48]:<48}  {short(a):<14} {short(b):<14} {short(c):<14}")

        for name, r in [("A", a), ("B", b), ("C", c)]:
            agg[name]["count"] += 1
            agg[name]["total_time"] += float(r.get("elapsed_s") or 0)
            if r.get("error"):
                agg[name]["errored"] += 1
            elif r.get("bbox"):
                agg[name]["found"] += 1
            else:
                agg[name]["rejected"] += 1  # legitimately decided "not on page" or verified=no

    print()
    print("=" * 96)
    print("AGGREGATE METRICS")
    print("=" * 96)
    print(f"{'Approach':<12} {'Box drawn':>11} {'Skipped':>10} {'Errored':>10} {'Avg time':>11}")
    for name in ("A", "B", "C"):
        s = agg[name]
        n = s["count"] or 1
        avg = s["total_time"] / n
        print(f"  {name:<10} {s['found']:>11} {s['rejected']:>10} {s['errored']:>10} {avg:>9.1f}s")

    # Render side-by-side composite PNG per case for visual review
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return

    OUT = "bench_out"
    if not os.path.isdir(OUT):
        return

    def _font(sz):
        for f in ("arial.ttf", "DejaVuSans.ttf"):
            try: return ImageFont.truetype(f, sz)
            except OSError: continue
        return ImageFont.load_default()

    summary_dir = os.path.join(OUT, "_summary")
    os.makedirs(summary_dir, exist_ok=True)
    print(f"\nRendering side-by-side composites into {summary_dir}/ ...")
    for cid in sorted(by_case):
        case_dir = os.path.join(OUT, cid)
        if not os.path.isdir(case_dir):
            continue
        imgs = []
        for name in ("A", "B", "C"):
            p = os.path.join(case_dir, f"approach_{name}.png")
            if os.path.exists(p):
                im = Image.open(p).convert("RGB")
                # Downscale for composite if huge
                if im.width > 700:
                    ratio = 700 / im.width
                    im = im.resize((700, int(im.height * ratio)))
                imgs.append((name, im))
        if not imgs:
            continue
        gap = 24
        title_h = 36
        W = sum(im.width for _, im in imgs) + gap * (len(imgs) + 1)
        H = max(im.height for _, im in imgs) + title_h + gap * 2
        canvas = Image.new("RGB", (W, H), (250, 250, 250))
        d = ImageDraw.Draw(canvas)
        d.text((gap, 6), cid, fill=(0, 0, 0), font=_font(20))
        x = gap
        for name, im in imgs:
            d.text((x, title_h - 4), f"Approach {name}", fill=(0, 80, 160), font=_font(18))
            canvas.paste(im, (x, title_h + gap))
            x += im.width + gap
        out = os.path.join(summary_dir, f"{cid}.png")
        canvas.save(out)
    print(f"Done. Inspect {summary_dir}/<case>.png")


if __name__ == "__main__":
    main()
