#!/usr/bin/env python3
"""
TEST / EXPERIMENT — "Story" matching: full deed context  vs  whole-EC narrative.

The idea
--------
Instead of comparing thin extracted METADATA field-by-field (what the production
pipeline does), this test feeds the LLM the *entire story* of each side and lets
it reason holistically:

    DEED SIDE  : the ENTIRE verbatim context of the deed PDF
                 (a faithful transcription that holds the whole story — every
                  party, date, survey, extent, consideration, schedule, and
                  endorsement, nothing summarised away).

    EC SIDE    : a single narrative "story" of the WHOLE Encumbrance Certificate
                 — its transaction history retold as a chronological account.

    MATCH      : the LLM reads the deed's story, locates it inside the EC's
                 story, and judges whether the deed is corroborated by / is
                 consistent with the EC — surfacing contradictions and anything
                 the deed claims that the EC never records.

This differs from `full_context_validation_test.py` (which transcribes verbatim
but then reuses the production *forensic field-by-field* prompt against a single
matched EC ROW). Here the EC side is a NARRATIVE of the whole certificate and the
matching is done by the LLM understanding the story — no document-number matcher.

It does NOT touch the production pipeline. It only reuses ECProcessor +
GeminiHelper read-only; all new prompts live in this file.

Usage
-----
Run from the Server/ directory.

  # Fresh EC extraction from a PDF:
  python experiments/deed_story_vs_ec_test.py \
      --ec /path/to/ec.pdf \
      --deeds /path/to/deeds_dir_or_single.pdf_or.zip \
      --out experiments/out/story_run1

  # Reuse a previous run's EC (skips OCR — fast iteration on the matching):
  python experiments/deed_story_vs_ec_test.py \
      --reuse-ec-run experiments/out/run_20260619_163533 \
      --deeds /path/to/deeds_dir \
      --out experiments/out/story_run2

    --ec              EC PDF (required unless --reuse-ec-run is given).
    --reuse-ec-run    A prior run dir containing ec_final.json + ec_raw_full.txt;
                      reuses it instead of re-OCRing the EC.
    --deeds           Directory of deed PDFs, a single deed .pdf, or a .zip.
    --limit           Process only the first N deed PDFs (0 = all). Default 0.
    --out             Output directory. Default: experiments/out/story_<timestamp>.
    --model           Gemini model id. Default: gemini-3.5-flash.

Outputs (under --out)
---------------------
  ec_narrative.txt          the whole-EC story the LLM was matched against
  <deed>_story.txt          the verbatim full-context "story" of each deed
  story_match_report.json   machine-readable per-deed verdicts
  story_match_report.md     human-readable summary + per-deed tables
  (plus ec_final.json / ec_raw_full.txt when freshly extracted)
"""

import argparse
import json
import os
import re
import shutil
import sys
import zipfile
from datetime import datetime

# Make api.validate.*, prompts.*, common.* importable regardless of CWD —
# production code uses Server/ as its import root.
SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

# Windows consoles default to cp1252 and crash on Tamil progress output.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# --- Reused production pieces (READ-ONLY — never modified here) ---
from api.validate.ec_processor import ECProcessor
from common.gemini_helper import GeminiHelper
# Production validation logic — imported so the A/B baseline is EXACTLY what the
# live Landwise app does today (deed metadata vs the single matched EC row).
from api.validate.validator import _build_ec_lookup
from api.validate.sale_deed_processor import SaleDeedProcessor
from prompts.validation_prompts import construct_validation_prompt

DEFAULT_MODEL = "gemini-3.5-flash"


# ===========================================================================
# Prompts (NEW — test-only)
# ===========================================================================

# 1) The deed's ENTIRE context — the "story" of the document, verbatim.
DEED_FULL_CONTEXT_PROMPT = """You are a faithful document transcription engine for Tamil Nadu land registration documents (sale deeds, settlement deeds, partition deeds, gift deeds, mortgage receipts, etc.).

TASK: Transcribe the ENTIRE document so the output holds the complete story of the deed. Do NOT summarize, interpret, judge, or extract only selected fields. Render everything the document says, page by page.

RULES:
1. Transcribe ALL text — Tamil and English — exactly as written. Preserve every name, relationship (s/o, w/o, d/o), date (handwritten AND typed), document number, survey/sub-division number, plot number, extent/area with its unit, boundaries, consideration/market value, stamp duty, and registration endorsements.
2. Keep the original reading order. Mark page breaks as "=== PAGE N ===".
3. For Tamil personal names and place names, give the Tamil text followed by an English transliteration in parentheses on first appearance.
4. Transcribe the SCHEDULE OF PROPERTY block in full (boundaries, extent, survey numbers).
5. Transcribe any list of SUPPORTING / IDENTITY DOCUMENTS (Aadhaar, PAN, Voter ID, Death Certificate, Legal Heir Certificate, POA references, parent-document references, etc.) exactly, including numbers where legible.
6. If a value is handwritten and a typed value also appears, transcribe BOTH and note which is handwritten.
7. Do NOT omit anything as "boilerplate". Endorsements, witness blocks, and SRO stamps are all part of the story.
8. If text is illegible, write "[illegible]" rather than guessing.

OUTPUT: Plain text only — the full transcription. No JSON, no commentary."""


# 2) The whole EC retold as ONE chronological narrative "story".
EC_NARRATIVE_PROMPT = """You are a Tamil Nadu title-search analyst. You are given the full contents of one Encumbrance Certificate (EC): a STRUCTURED list of its transactions (JSON) followed by the RAW OCR text of the EC.

TASK: Retell the ENTIRE EC as a single, faithful chronological narrative — the "story" of this property's recorded history. This narrative will later be compared against individual deeds.

RULES:
1. Order the transactions by date, oldest first.
2. For EACH transaction, write a short paragraph stating: the document number and date(s), the nature of the document (sale / mortgage / settlement / gift / partition / release / etc.), who transferred to whom (sellers → buyers, with relationships if given), the survey number(s), the extent with its unit, and the consideration / market value.
3. Make the chain explicit: note where a buyer in one transaction becomes the seller in a later one, and call out any apparent gaps, mortgages, attachments, or litigation references.
4. Use ONLY what the EC records. Do NOT invent, infer ownership not stated, or import outside knowledge. If something is unclear in the source, say so plainly.
5. Preserve every document number, date, name, survey number, and extent exactly as given (Tamil names may be followed by a transliteration in parentheses).

OUTPUT: Plain-text narrative only. Begin with a one-line header listing the survey number(s) and the total number of transactions, then the chronological paragraphs. No JSON."""


# 3) Match a single deed's story against the whole-EC narrative.
STORY_MATCH_PROMPT = """You are a meticulous Tamil Nadu title-verification examiner.

You are given TWO things:
  • DEED STORY     — the complete verbatim content of ONE registered deed.
  • EC NARRATIVE   — the chronological story of the WHOLE Encumbrance Certificate for the property.

Your job is to decide whether the deed's story is CORROBORATED BY and CONSISTENT WITH the EC's story.

DO THIS:
1. Read the deed story and identify its key facts: document number, registration date(s), nature of the transaction, sellers/transferors, buyers/transferees (with relationships), survey/sub-division number(s), plot number, extent with unit, consideration and market value, and any parent-document reference.
2. Locate the corresponding transaction inside the EC NARRATIVE. Match primarily by document number; if the number is absent or unreadable, match by the strongest combination of date + parties + survey + extent.
3. Compare each key fact between the deed and the EC. Treat Tamil/English transliteration variants of the SAME name as a match; treat genuinely different people as a mismatch. Normalise extents to a common unit before judging; allow minor rounding but flag material differences. Treat handwritten dates on the deed as authoritative when they conflict with typed ones.
4. Decide:
   - found_in_ec        : is this deed recorded in the EC at all?
   - overall_consistent : do the matched facts agree (no material contradictions)?
5. Be conservative: if the deed claims something the EC never records (e.g. a transfer that should appear but does not), report it under missing_in_ec. If the EC contradicts the deed, report it under contradictions. Never guess to force a match.

Return ONLY a JSON object with EXACTLY this shape:
{
  "matched_document_number": "<doc no the deed maps to in the EC, or null>",
  "found_in_ec": true | false,
  "overall_consistent": true | false,
  "confidence": "high" | "medium" | "low",
  "checks": [
    {
      "aspect": "document_number | date | nature | parties | survey | extent | consideration | parent_reference",
      "deed_says": "<value from the deed, or 'not stated'>",
      "ec_says": "<value from the EC, or 'not recorded'>",
      "status": "match" | "mismatch" | "deed_only" | "ec_only" | "unclear",
      "note": "<one short sentence>"
    }
  ],
  "contradictions": ["<EC directly contradicts the deed here>", "..."],
  "missing_in_ec": ["<deed claims this but the EC has no record>", "..."],
  "summary": "<2-3 sentence plain-language verdict an advocate could read>"
}
Output the JSON object and nothing else."""


# ===========================================================================
# Small utilities
# ===========================================================================
def _drain(gen):
    """Consume a progress-yielding generator and return its StopIteration value."""
    try:
        while True:
            print(f"      {next(gen)}")
    except StopIteration as stop:
        return stop.value


def _resolve_deed_pdfs(deeds_arg: str, scratch_dir: str) -> list:
    """Accept a directory of PDFs, a single .pdf, or a .zip; return a sorted list
    of deed PDF paths."""
    if os.path.isdir(deeds_arg):
        return sorted(
            os.path.join(deeds_arg, n)
            for n in os.listdir(deeds_arg)
            if n.lower().endswith(".pdf")
        )
    if os.path.isfile(deeds_arg) and deeds_arg.lower().endswith(".pdf"):
        return [deeds_arg]
    if zipfile.is_zipfile(deeds_arg):
        out = os.path.join(scratch_dir, "deeds_extracted")
        os.makedirs(out, exist_ok=True)
        with zipfile.ZipFile(deeds_arg, "r") as zf:
            for member in zf.infolist():
                if member.is_dir():
                    continue
                name = os.path.basename(member.filename)
                if name.lower().endswith(".pdf"):
                    with zf.open(member) as src, open(os.path.join(out, name), "wb") as dst:
                        shutil.copyfileobj(src, dst)
        return sorted(
            os.path.join(out, n) for n in os.listdir(out) if n.lower().endswith(".pdf")
        )
    raise SystemExit(f"--deeds is neither a directory, a .pdf, nor a .zip: {deeds_arg}")


def _read_ec_raw_text(run_dir: str) -> str:
    """Read ec_raw_full.txt, stripping the '# OCR_VERSION=N' header."""
    path = os.path.join(run_dir, "ec_raw_full.txt")
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    return re.sub(r"^#\s*OCR_VERSION=\d+\s*\n", "", raw, count=1)


def _call_gemini_json(gemini: GeminiHelper, payload: str, prompt: str) -> dict:
    """Send payload + prompt, parse the first JSON object from the reply."""
    resp = gemini.generate_from_text(payload, prompt)
    m = re.search(r"\{.*\}", resp or "", re.DOTALL)
    if not m:
        return {"error": "No JSON found", "raw_response": resp,
                "found_in_ec": False, "overall_consistent": False, "checks": []}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"error": "Failed to parse JSON", "raw_response": resp,
                "found_in_ec": False, "overall_consistent": False, "checks": []}


# ===========================================================================
# EC story
# ===========================================================================
def _get_ec_data(args, out_dir: str, gemini: GeminiHelper):
    """Return (ec_data: list[dict], ec_raw_text: str), either freshly extracted
    or reused from a prior run dir."""
    if args.reuse_ec_run:
        run_dir = args.reuse_ec_run
        ec_json = os.path.join(run_dir, "ec_final.json")
        if not os.path.exists(ec_json):
            raise SystemExit(f"--reuse-ec-run has no ec_final.json: {run_dir}")
        with open(ec_json, "r", encoding="utf-8") as f:
            ec_data = json.load(f)
        ec_raw = _read_ec_raw_text(run_dir)
        print(f"      Reused EC: {len(ec_data)} transactions from {run_dir}")
        return ec_data, ec_raw

    if not args.ec or not os.path.exists(args.ec):
        raise SystemExit("Provide --ec <pdf> or --reuse-ec-run <dir>.")
    ec_proc = ECProcessor(output_dir=out_dir, chunk_size=int(os.getenv("CHUNK_SIZE", 8)))
    ec_data = _drain(ec_proc.process(args.ec))
    if not isinstance(ec_data, list):
        ec_data = []
    ec_raw = _read_ec_raw_text(out_dir)
    print(f"      Extracted EC: {len(ec_data)} transactions")
    return ec_data, ec_raw


def _doc_no_from_filename(stem: str) -> str:
    """'10159_2011' -> '10159/2011' (deed filenames encode the document number)."""
    return stem.replace("_", "/", 1)


def _run_production_baseline(gemini, deed_proc, ec_lookup, file_path, stem):
    """
    Reproduce EXACTLY what the live Landwise app does for one deed:
      deed metadata (SaleDeedProcessor)  vs  the single matched EC row
      via construct_validation_prompt -> Gemini -> {match, comparisons, ...}.

    Returns a dict: {match, trustability_score, comparisons, matched_document_number}
    or {error: ...} when the deed has no EC row / extraction fails.
    """
    doc_no = _doc_no_from_filename(stem)
    ec_entry = ec_lookup.get(doc_no)
    if not ec_entry:
        return {"error": f"No EC row for document {doc_no}", "match": None,
                "matched_document_number": doc_no}
    try:
        deed_metadata = deed_proc.process_file(file_path)  # writes/returns *_metadata.txt
    except Exception as exc:
        return {"error": f"metadata extraction failed: {exc}", "match": None,
                "matched_document_number": doc_no}
    prompt = construct_validation_prompt(ec_entry, deed_metadata)
    data = _call_gemini_json(gemini, "", prompt)
    return {
        "matched_document_number": doc_no,
        "match": data.get("match"),
        "trustability_score": data.get("trustability_score"),
        "comparisons": data.get("comparisons") or [],
        "error": data.get("error"),
    }


def _build_ec_narrative(gemini: GeminiHelper, ec_data: list, ec_raw: str) -> str:
    """Ask the LLM to retell the whole EC as one chronological story."""
    payload = (
        "=== STRUCTURED EC TRANSACTIONS (JSON) ===\n"
        + json.dumps(ec_data, ensure_ascii=False, indent=2)
        + "\n\n=== RAW EC OCR TEXT ===\n"
        + (ec_raw or "(raw EC OCR text unavailable)")
    )
    return gemini.generate_from_text(payload, EC_NARRATIVE_PROMPT)


# ===========================================================================
# Report rendering
# ===========================================================================
def _write_markdown_report(report: dict, path: str) -> None:
    meta = report["run"]
    docs = report["documents"]
    lines = ["# Deed-Story vs Whole-EC-Narrative — Match Report\n"]
    lines.append(f"- **Run:** {meta['timestamp']}")
    lines.append(f"- **EC source:** `{meta['ec_source']}`")
    lines.append(f"- **Deeds:** `{meta['deeds']}`")
    lines.append(f"- **Model:** `{meta['model']}`")
    lines.append(f"- **EC transactions:** {meta['ec_txn_count']}")
    lines.append(f"- **Deeds tested:** {len(docs)}\n")

    found = [d for d in docs if (d.get("result") or {}).get("found_in_ec")]
    consistent = [d for d in docs if (d.get("result") or {}).get("overall_consistent")]
    has_baseline = any("baseline" in d for d in docs)
    lines.append("## Summary\n")
    lines.append(f"- Deeds **found in the EC story:** {len(found)} / {len(docs)}")
    lines.append(f"- Deeds **consistent with the EC story:** {len(consistent)} / {len(docs)}\n")

    if has_baseline:
        agree = [d for d in docs if d.get("agreement") == "agree"]
        diverge = [d for d in docs if d.get("agreement") == "DIVERGE"]
        lines.append("## Story approach vs current Landwise app logic\n")
        lines.append("> Baseline = the live app: deed *metadata* vs the single matched EC *row*. "
                     "Story = this test: deed *full context* vs the *whole-EC narrative*. "
                     "No advocate-labelled ground truth, so this is an **agreement** analysis — "
                     "divergences are the rows a human should adjudicate.\n")
        lines.append(f"- **Agree** (same verdict): {len(agree)} / {len(docs)}")
        lines.append(f"- **Diverge** (different verdict): {len(diverge)} / {len(docs)}\n")
        lines.append("| Deed file | Doc no | Story: consistent | Baseline: match | Agreement |")
        lines.append("|---|---|---|---|---|")
        for d in docs:
            if d.get("error"):
                lines.append(f"| {d['deed_file']} | — | ⚠ | — | — |")
                continue
            r, b = d["result"], d.get("baseline", {})
            s = "✅" if r.get("overall_consistent") else "❌"
            bm = b.get("match")
            bi = "—" if bm is None else ("✅" if bm else "❌")
            ag = {"agree": "agree", "DIVERGE": "⚠ DIVERGE", "n/a": "n/a"}.get(d.get("agreement"), "n/a")
            lines.append(f"| {d['deed_file']} | {r.get('matched_document_number') or '—'} | {s} | {bi} | {ag} |")
        lines.append("")

    lines.append("## Story-match detail (per deed)\n")
    lines.append("| Deed file | Matched doc no | Found | Consistent | Confidence | Summary |")
    lines.append("|---|---|---|---|---|---|")
    for d in docs:
        if d.get("error"):
            lines.append(f"| {d['deed_file']} | — | ⚠ | — | — | {d['error']} |")
            continue
        r = d["result"]
        found_i = "✅" if r.get("found_in_ec") else "❌"
        cons_i = "✅" if r.get("overall_consistent") else "❌"
        summ = (r.get("summary") or "").replace("\n", " ").replace("|", "/")
        lines.append(
            f"| {d['deed_file']} | {r.get('matched_document_number') or '—'} | {found_i} "
            f"| {cons_i} | {r.get('confidence', '—')} | {summ} |"
        )
    lines.append("")

    lines.append("## Per-deed detail\n")
    for d in docs:
        lines.append(f"### {d['deed_file']}\n")
        if d.get("error"):
            lines.append(f"> ⚠ {d['error']}\n")
            continue
        r = d["result"]
        lines.append(f"- Matched EC document: **{r.get('matched_document_number') or '—'}**")
        lines.append(f"- Found in EC: **{r.get('found_in_ec')}** · "
                     f"Consistent: **{r.get('overall_consistent')}** · "
                     f"Confidence: **{r.get('confidence', '—')}**")
        checks = r.get("checks") or []
        if checks:
            lines.append("\n| Aspect | Deed says | EC says | Status | Note |")
            lines.append("|---|---|---|---|---|")
            for c in checks:
                lines.append(
                    f"| {c.get('aspect','?')} | {c.get('deed_says','')} | {c.get('ec_says','')} "
                    f"| {c.get('status','')} | {(c.get('note','') or '').replace('|','/')} |"
                )
        for cd in (r.get("contradictions") or []):
            lines.append(f"\n- ⛔ **Contradiction:** {cd}")
        for ms in (r.get("missing_in_ec") or []):
            lines.append(f"- ⚠ **Missing in EC:** {ms}")

        b = d.get("baseline")
        if b is not None:
            lines.append(f"\n**Current-app baseline** (metadata vs EC row): "
                         f"match=**{b.get('match')}**, trustability={b.get('trustability_score', '—')} "
                         f"· agreement with story: **{d.get('agreement','n/a')}**")
            if b.get("error"):
                lines.append(f"> ⚠ baseline: {b['error']}")
            mism = [c for c in (b.get("comparisons") or [])
                    if "NOT" in str(c.get("status", "")).upper()]
            if mism:
                lines.append("\n| Baseline field | Status | EC value | Deed value |")
                lines.append("|---|---|---|---|")
                for c in mism:
                    lines.append(
                        f"| {c.get('field','?')} | {c.get('status','')} "
                        f"| {str(c.get('ec_value','')).replace('|','/')} "
                        f"| {str(c.get('deed_value','')).replace('|','/')} |"
                    )
        lines.append("")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


# ===========================================================================
# Main
# ===========================================================================
def run(args) -> None:
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)
    scratch = os.path.join(out_dir, "_scratch")
    os.makedirs(scratch, exist_ok=True)

    gemini = GeminiHelper(model_id=args.model)

    # 1. EC data (fresh or reused)
    print("[1/4] Getting EC data...")
    ec_data, ec_raw = _get_ec_data(args, out_dir, gemini)

    # Production-baseline setup (the live Landwise app's metadata-vs-EC-row logic).
    ec_lookup = _build_ec_lookup(ec_data) if args.compare_baseline else {}
    deed_proc = SaleDeedProcessor(output_dir=out_dir) if args.compare_baseline else None

    # 2. Build the whole-EC narrative "story"
    print("[2/4] Building whole-EC narrative...")
    ec_narrative = _build_ec_narrative(gemini, ec_data, ec_raw)
    with open(os.path.join(out_dir, "ec_narrative.txt"), "w", encoding="utf-8") as fh:
        fh.write(ec_narrative or "")
    print(f"      EC narrative: {len(ec_narrative or '')} chars")

    # 3. Deeds: verbatim full-context story for each
    deed_pdfs = _resolve_deed_pdfs(args.deeds, scratch)
    if args.limit and args.limit > 0:
        deed_pdfs = deed_pdfs[: args.limit]
    if not deed_pdfs:
        raise SystemExit(f"No deed PDFs found under: {args.deeds}")
    print(f"[3/4] Transcribing + matching {len(deed_pdfs)} deed(s)...")

    documents = []
    for idx, pdf in enumerate(deed_pdfs, 1):
        stem = os.path.splitext(os.path.basename(pdf))[0]
        print(f"   ({idx}/{len(deed_pdfs)}) {stem}")
        try:
            print("        - transcribing full deed context (the story)...")
            deed_story = gemini.generate_from_file(
                pdf, DEED_FULL_CONTEXT_PROMPT, display_name=f"{stem} (story)"
            )
            with open(os.path.join(out_dir, f"{stem}_story.txt"), "w", encoding="utf-8") as fh:
                fh.write(deed_story or "")

            print("        - matching deed story against EC narrative...")
            payload = (
                "=== DEED STORY (verbatim full content of one deed) ===\n"
                + (deed_story or "(deed story unavailable)")
                + "\n\n=== EC NARRATIVE (story of the whole Encumbrance Certificate) ===\n"
                + (ec_narrative or "(EC narrative unavailable)")
            )
            result = _call_gemini_json(gemini, payload, STORY_MATCH_PROMPT)
            print(f"        -> [story]    found_in_ec={result.get('found_in_ec')} "
                  f"consistent={result.get('overall_consistent')} "
                  f"matched={result.get('matched_document_number')}")

            entry = {"deed_file": os.path.basename(pdf), "result": result}

            if args.compare_baseline:
                print("        - baseline (current app: metadata vs EC row)...")
                baseline = _run_production_baseline(gemini, deed_proc, ec_lookup, pdf, stem)
                print(f"        -> [baseline] match={baseline.get('match')} "
                      f"trust={baseline.get('trustability_score')}")
                entry["baseline"] = baseline
                # Agreement: story 'consistent' vs baseline 'match' (both = "deed agrees with EC").
                s_ok, b_ok = result.get("overall_consistent"), baseline.get("match")
                entry["agreement"] = (
                    "n/a" if (s_ok is None or b_ok is None)
                    else ("agree" if bool(s_ok) == bool(b_ok) else "DIVERGE")
                )
                print(f"        -> agreement: {entry['agreement']}")

            documents.append(entry)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            documents.append({"deed_file": os.path.basename(pdf),
                              "error": f"{type(exc).__name__}: {exc}"})

    # 4. Reports
    print("[4/4] Writing reports...")
    report = {
        "run": {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "ec_source": args.reuse_ec_run or args.ec,
            "deeds": args.deeds,
            "model": args.model,
            "ec_txn_count": len(ec_data),
        },
        "ec_narrative": ec_narrative,
        "documents": documents,
    }
    json_path = os.path.join(out_dir, "story_match_report.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    md_path = os.path.join(out_dir, "story_match_report.md")
    _write_markdown_report(report, md_path)

    found = sum(1 for d in documents if (d.get("result") or {}).get("found_in_ec"))
    print("\n=== DONE ===")
    print(f"  EC narrative: {os.path.join(out_dir, 'ec_narrative.txt')}")
    print(f"  JSON report:  {json_path}")
    print(f"  MD report:    {md_path}")
    print(f"  Deeds: {len(documents)} | found in EC: {found}")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Match each deed's full-context story against the whole-EC narrative.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--ec", help="EC PDF (required unless --reuse-ec-run is given).")
    parser.add_argument("--reuse-ec-run", dest="reuse_ec_run",
                        help="Prior run dir with ec_final.json + ec_raw_full.txt to reuse.")
    parser.add_argument("--deeds", required=True,
                        help="Directory of deed PDFs, a single .pdf, or a .zip of them.")
    parser.add_argument("--limit", type=int, default=0, help="First N deeds (0 = all).")
    parser.add_argument(
        "--out",
        default=os.path.join(SERVER_DIR, "experiments", "out",
                             datetime.now().strftime("story_%Y%m%d_%H%M%S")),
        help="Output directory.",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Gemini model id.")
    parser.add_argument("--compare-baseline", dest="compare_baseline", action="store_true",
                        help="Also run the current Landwise app logic (metadata vs EC row) "
                             "per deed and report agreement/divergence.")
    args = parser.parse_args(argv)

    if not args.ec and not args.reuse_ec_run:
        parser.error("one of --ec or --reuse-ec-run is required")
    run(args)


if __name__ == "__main__":
    main()
