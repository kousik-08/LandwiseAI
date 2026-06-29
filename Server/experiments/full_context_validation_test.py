#!/usr/bin/env python3
"""
EXPERIMENT — Full-context vs metadata-only EC↔Deed validation.

Why this exists
---------------
The production pipeline (api/validate/*) validates each sale deed against its
EC row by comparing THIN METADATA on both sides:

    EC metadata (ec_final.json entry)  ──►  construct_validation_prompt  ◄──  deed metadata (*_metadata.txt)

This experiment tests a hypothesis: does the LLM judge match/mismatch MORE
accurately when it also sees the FULL CONTEXT (verbatim content) of both
documents, not just the extracted metadata?

For every matched deed it runs TWO comparisons and reports them side-by-side:

  • BASELINE      — exactly what production does today (metadata ↔ metadata).
  • FULL CONTEXT  — metadata header + the whole document body on BOTH sides:
                      deed side : metadata + verbatim deed transcription
                      EC side   : metadata + raw EC OCR text for the
                                  transaction's page(s)

Both comparisons use the SAME forensic rules and the SAME output schema
(construct_validation_prompt) — only the INPUTS differ — so any verdict
difference is attributable purely to "more context", making the A/B fair.

It does NOT touch the production pipeline. It only IMPORTS and reuses the
existing classes/prompts read-only. New prompts live inside this file.

Usage
-----
Run from the Server/ directory:

    python experiments/full_context_validation_test.py \
        --ec /path/to/ec.pdf \
        --deeds /path/to/deeds_dir_or_zip \
        --limit 0 \
        --out experiments/out/run1

    --ec        EC PDF (required)
    --deeds     directory of deed PDFs, OR a .zip of them (required)
    --limit     last-N transactions to test (0 = all). Default 0.
    --out       output directory for artifacts + report. Default: experiments/out/<timestamp>.
    --ec-context {page,full}
                how much EC text to feed as "full context":
                  page = only the EC page(s) the transaction sits on (default, recommended)
                  full = the entire EC OCR text (token-heavy, noisier)

Outputs (under --out)
---------------------
  comparison_report.json   machine-readable: per-doc baseline + full_context + diffs
  comparison_report.md     human-readable: summary + per-doc diff tables
  <doc>_fullcontext.txt     verbatim deed transcription (full-context input)
  <doc>_ec_context.txt      EC text slice used as the EC full-context input
  (plus ec_final.json, *_metadata.txt, matched PDFs from the reused pipeline)
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime

# Make `api.validate.*`, `prompts.*`, `common.*` importable regardless of CWD —
# the production code uses Server/ as its import root.
SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

# Windows consoles default to cp1252 and crash on non-ASCII progress output.
# Force UTF-8 on stdout/stderr so logs (and any Tamil text echoed) don't abort.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# --- Reused production pieces (READ-ONLY — never modified by this script) ---
from api.validate.ec_processor import ECProcessor
from api.validate.matcher import DocumentMatcher
from api.validate.sale_deed_processor import SaleDeedProcessor
from api.validate.validator import _build_ec_lookup
from prompts.validation_prompts import construct_validation_prompt
from common.gemini_helper import GeminiHelper

# Same model the production Validator/SaleDeedProcessor use, so the A/B isn't
# confounded by a model change.
MODEL_ID = "gemini-3.5-flash"


# ---------------------------------------------------------------------------
# Full-document transcription prompt (NEW — experiment-only).
# Produces the verbatim "full context" of a deed that the metadata extraction
# deliberately discards. Faithful transcription, no interpretation.
# ---------------------------------------------------------------------------
DEED_FULL_CONTEXT_PROMPT = """You are a faithful document transcription engine for Tamil Nadu land registration documents (sale deeds, settlement deeds, partition deeds, mortgage receipts, etc.).

TASK: Transcribe the ENTIRE document content as-is. Do NOT summarize, interpret, judge, or extract selected fields. Produce a complete, faithful rendering of everything the document says, page by page.

RULES:
1. Transcribe ALL text — Tamil and English — exactly as written. Preserve every name, relationship (s/o, w/o, d/o), date (handwritten AND typed), document number, survey/sub-division number, plot number, extent/area with its unit, boundaries, consideration/market value, stamp duty, and registration endorsements.
2. Keep the original reading order. Mark page breaks as "=== PAGE N ===".
3. For Tamil personal names and place names, give the Tamil text followed by an English transliteration in parentheses on first appearance.
4. Transcribe the SCHEDULE OF PROPERTY block in full (boundaries, extent, survey numbers).
5. Transcribe any list of SUPPORTING / IDENTITY DOCUMENTS (Aadhaar, PAN, Voter ID, Death Certificate, Legal Heir Certificate, POA references, etc.) exactly, including numbers where legible.
6. If a value is handwritten and a typed value also appears, transcribe BOTH and note which is handwritten.
7. Do NOT omit anything as "boilerplate". Endorsements, witness blocks, and SRO stamps are all part of the full context.
8. If text is illegible, write "[illegible]" rather than guessing.

OUTPUT: Plain text only — the full transcription. No JSON, no commentary, no leading/trailing notes.
"""


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
def _drain(gen):
    """
    Consume a progress-yielding generator (ECProcessor.process / extract_raw
    yield log lines and `return` the real payload via StopIteration.value).
    Prints each progress line and returns the generator's return value.
    """
    try:
        while True:
            msg = next(gen)
            print(f"      {msg}")
    except StopIteration as stop:
        return stop.value


def _resolve_deeds_dir(deeds_arg: str, scratch_dir: str) -> str:
    """
    Accept a directory of PDFs, a single deed .pdf, or a .zip; return a
    directory path. A single PDF is copied into a one-file scratch dir (so the
    matcher only ever sees that one deed). A zip is extracted (PDFs only,
    flattened) into scratch_dir.
    """
    if os.path.isdir(deeds_arg):
        return deeds_arg
    if os.path.isfile(deeds_arg) and deeds_arg.lower().endswith(".pdf"):
        out = os.path.join(scratch_dir, "single_deed")
        os.makedirs(out, exist_ok=True)
        shutil.copy2(deeds_arg, os.path.join(out, os.path.basename(deeds_arg)))
        print(f"[*] Single deed staged -> {out}")
        return out
    if zipfile.is_zipfile(deeds_arg):
        out = os.path.join(scratch_dir, "deeds_extracted")
        os.makedirs(out, exist_ok=True)
        count = 0
        with zipfile.ZipFile(deeds_arg, "r") as zf:
            for member in zf.infolist():
                if member.is_dir():
                    continue
                name = os.path.basename(member.filename)
                if not name.lower().endswith(".pdf"):
                    continue
                with zf.open(member) as src, open(os.path.join(out, name), "wb") as dst:
                    shutil.copyfileobj(src, dst)
                count += 1
        print(f"[*] Extracted {count} PDF(s) from zip → {out}")
        return out
    raise SystemExit(f"--deeds is neither a directory nor a zip: {deeds_arg}")


def _read_ec_raw_text(output_dir: str) -> str:
    """Read ec_raw_full.txt (full EC OCR), stripping the '# OCR_VERSION=N' header."""
    path = os.path.join(output_dir, "ec_raw_full.txt")
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    return re.sub(r"^#\s*OCR_VERSION=\d+\s*\n", "", raw, count=1)


def _parse_ec_chunks(raw_text: str):
    """
    Split ec_raw_full.txt on its '### EC_PAGE start=S end=E ###' markers
    (emitted per OCR chunk by ECProcessor.extract_raw).
    Returns [{"start": int, "end": int, "text": str}, ...].
    """
    pattern = re.compile(r"###\s*EC_PAGE\s+start=(\d+)\s+end=(\d+)\s*###")
    marks = list(pattern.finditer(raw_text))
    chunks = []
    for i, m in enumerate(marks):
        body_start = m.end()
        body_end = marks[i + 1].start() if i + 1 < len(marks) else len(raw_text)
        chunks.append(
            {
                "start": int(m.group(1)),
                "end": int(m.group(2)),
                "text": raw_text[body_start:body_end].strip(),
            }
        )
    return chunks


def _ec_context_for(ec_entry: dict, chunks: list, raw_text: str, mode: str) -> str:
    """
    Pick the EC full-context text for a transaction.

      mode="full" → the entire EC OCR text.
      mode="page" → only the chunk(s) whose page range overlaps the
                    transaction's [ec_page_start, ec_page_end]. Falls back to
                    the whole text when page info or markers are absent.
    """
    if mode == "full" or not chunks:
        return raw_text
    ps, pe = ec_entry.get("ec_page_start"), ec_entry.get("ec_page_end")
    if isinstance(ps, int) and isinstance(pe, int):
        selected = [c for c in chunks if not (c["end"] < ps or c["start"] > pe)]
        if selected:
            return "\n\n".join(c["text"] for c in selected)
    return raw_text  # fallback: no usable page info


def _build_full_context_prompt(
    ec_entry: dict, deed_metadata: str, deed_full: str, ec_full: str
) -> str:
    """
    Reuse the EXACT production validation prompt (same rules + same output
    schema), but enrich both sides with full context:
      • EC side   — inject the raw EC text as an extra `full_ec_context` field
                    so the JSON-dumped EC record carries the whole context.
      • Deed side — append the verbatim deed transcription beneath the metadata.
    Only the inputs change vs baseline — the rules/schema are identical, which
    is what makes the A/B attributable to context alone.
    """
    ec_aug = dict(ec_entry)
    ec_aug["full_ec_context"] = ec_full or "(EC full context unavailable)"
    deed_aug = (
        (deed_metadata or "").rstrip()
        + "\n\n--- FULL DEED DOCUMENT CONTEXT (verbatim transcription) ---\n"
        + (deed_full or "(deed full context unavailable)")
    )
    return construct_validation_prompt(ec_aug, deed_aug)


def _call_gemini_json(gemini: GeminiHelper, prompt: str) -> dict:
    """Send a text prompt, parse the first JSON object (mirrors Validator)."""
    resp = gemini.generate_from_text("", prompt)
    m = re.search(r"\{.*\}", resp or "", re.DOTALL)
    if not m:
        return {"error": "No JSON found", "raw_response": resp, "comparisons": [], "match": False}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"error": "Failed to parse JSON", "raw_response": resp, "comparisons": [], "match": False}


def _compute_diffs(baseline: dict, full_ctx: dict) -> list:
    """
    Where do the two approaches DISAGREE? Returns a list of
    {field, baseline, full_context} entries for the overall verdict and any
    per-field status that differs. Empty list ⇒ identical verdicts.
    """
    diffs = []
    b_match, f_match = bool(baseline.get("match")), bool(full_ctx.get("match"))
    if b_match != f_match:
        diffs.append({"field": "__overall_match__", "baseline": b_match, "full_context": f_match})

    def by_field(res):
        return {
            (c.get("field") or "?"): c
            for c in (res.get("comparisons") or [])
        }

    b_by, f_by = by_field(baseline), by_field(full_ctx)
    for field in sorted(set(b_by) | set(f_by)):
        b_status = (b_by.get(field) or {}).get("status")
        f_status = (f_by.get(field) or {}).get("status")
        if (b_status or "") != (f_status or ""):
            diffs.append({"field": field, "baseline": b_status, "full_context": f_status})
    return diffs


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------
def _write_markdown_report(report: dict, path: str) -> None:
    lines = []
    meta = report["run"]
    lines.append("# Full-context vs Metadata-only — EC↔Deed Validation Experiment\n")
    lines.append(f"- **Run:** {meta['timestamp']}")
    lines.append(f"- **EC:** `{meta['ec_pdf']}`")
    lines.append(f"- **Deeds:** `{meta['deeds']}`")
    lines.append(f"- **EC context mode:** `{meta['ec_context_mode']}`")
    lines.append(f"- **Model:** `{meta['model']}`")
    lines.append(f"- **Documents tested:** {meta['doc_count']}\n")

    docs = report["documents"]
    disagreements = [d for d in docs if d.get("diffs")]
    verdict_flips = [
        d for d in docs
        if any(x["field"] == "__overall_match__" for x in (d.get("diffs") or []))
    ]
    lines.append("## Summary\n")
    lines.append(f"- Documents where the two approaches **agree completely:** "
                 f"{len(docs) - len(disagreements)} / {len(docs)}")
    lines.append(f"- Documents with **any** field-status difference: {len(disagreements)} / {len(docs)}")
    lines.append(f"- Documents where the **overall match verdict flipped:** {len(verdict_flips)} / {len(docs)}\n")
    if verdict_flips:
        lines.append("### Overall verdict flips\n")
        lines.append("| Document | Baseline (metadata) | Full context |")
        lines.append("|---|---|---|")
        for d in verdict_flips:
            flip = next(x for x in d["diffs"] if x["field"] == "__overall_match__")
            lines.append(f"| {d['document_number']} | {flip['baseline']} | {flip['full_context']} |")
        lines.append("")

    lines.append("## Per-document detail\n")
    for d in docs:
        lines.append(f"### {d['document_number']}\n")
        if d.get("error"):
            lines.append(f"> ⚠ {d['error']}\n")
            continue
        b, f = d["baseline"], d["full_context"]
        lines.append(f"- Baseline match: **{b.get('match')}**  (trustability {b.get('trustability_score', 'N/A')})")
        lines.append(f"- Full-context match: **{f.get('match')}**  (trustability {f.get('trustability_score', 'N/A')})")
        if not d.get("diffs"):
            lines.append("- ✅ Both approaches produced identical verdicts on every field.\n")
            continue
        lines.append("\n| Field | Baseline status | Full-context status |")
        lines.append("|---|---|---|")
        for x in d["diffs"]:
            field = "**OVERALL MATCH**" if x["field"] == "__overall_match__" else x["field"]
            lines.append(f"| {field} | {x['baseline']} | {x['full_context']} |")
        lines.append("")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def run(ec_pdf: str, deeds: str, limit: int, out_dir: str, ec_context_mode: str) -> None:
    if not os.path.exists(ec_pdf):
        raise SystemExit(f"EC PDF not found: {ec_pdf}")
    os.makedirs(out_dir, exist_ok=True)
    scratch = os.path.join(out_dir, "_scratch")
    os.makedirs(scratch, exist_ok=True)

    deeds_dir = _resolve_deeds_dir(deeds, scratch)

    gemini = GeminiHelper(model_id=MODEL_ID)

    # 1. EC extraction (reuse production ECProcessor) → ec_final.json + ec_raw_full.txt
    print("[1/4] Extracting EC (reusing ECProcessor)...")
    ec_proc = ECProcessor(output_dir=out_dir, chunk_size=int(os.getenv("CHUNK_SIZE", 8)))
    ec_data = _drain(ec_proc.process(ec_pdf))
    if not isinstance(ec_data, list):
        ec_data = []
    ec_json_path = os.path.join(out_dir, "ec_final.json")
    ec_lookup = _build_ec_lookup(ec_data)
    ec_raw_text = _read_ec_raw_text(out_dir)
    ec_chunks = _parse_ec_chunks(ec_raw_text)
    print(f"      EC transactions: {len(ec_data)} | EC OCR chunks: {len(ec_chunks)}")

    # 2. Match deeds to EC rows (reuse production DocumentMatcher)
    print("[2/4] Matching deeds to EC rows (reusing DocumentMatcher)...")
    matcher = DocumentMatcher(
        docs_dir=deeds_dir,
        output_base=os.path.join(out_dir, "matched_docs"),
        keep_workspace=True,
    )
    match_limit = 0 if (limit is None or limit < 0) else limit
    matched_docs = matcher.load_and_match(ec_json_path, limit=match_limit)
    print(f"      Matched {len(matched_docs)} deed(s).")

    deed_proc = SaleDeedProcessor(output_dir=out_dir)

    # 3. Per-deed: extract metadata + full context, run BOTH comparisons
    print("[3/4] Running baseline + full-context comparisons per deed...")
    documents = []
    for idx, doc in enumerate(matched_docs, 1):
        doc_no = doc.get("document_number", "?")
        file_path = doc.get("file_path")
        print(f"   ({idx}/{len(matched_docs)}) {doc_no}")

        ec_entry = ec_lookup.get(doc_no)
        if not ec_entry:
            documents.append({"document_number": doc_no, "error": "No EC entry for this document number."})
            continue

        try:
            # Deed metadata — reuse production extraction (cached as *_metadata.txt).
            deed_metadata = deed_proc.process_file(file_path)

            # Deed full context — NEW verbatim transcription.
            print("        - transcribing full deed context...")
            deed_full = gemini.generate_from_file(
                file_path, DEED_FULL_CONTEXT_PROMPT, display_name=f"{doc_no} (full ctx)"
            )
            stem = os.path.splitext(os.path.basename(file_path))[0]
            with open(os.path.join(out_dir, f"{stem}_fullcontext.txt"), "w", encoding="utf-8") as fh:
                fh.write(deed_full or "")

            # EC full context — slice raw OCR text to the transaction's page(s).
            ec_full = _ec_context_for(ec_entry, ec_chunks, ec_raw_text, ec_context_mode)
            with open(os.path.join(out_dir, f"{stem}_ec_context.txt"), "w", encoding="utf-8") as fh:
                fh.write(ec_full or "")

            # BASELINE — exactly what production does today.
            print("        - baseline (metadata vs metadata)...")
            baseline_prompt = construct_validation_prompt(ec_entry, deed_metadata)
            baseline_result = _call_gemini_json(gemini, baseline_prompt)

            # FULL CONTEXT — same rules/schema, richer inputs.
            print("        - full-context (metadata + body vs metadata + body)...")
            fc_prompt = _build_full_context_prompt(ec_entry, deed_metadata, deed_full, ec_full)
            fc_result = _call_gemini_json(gemini, fc_prompt)

            diffs = _compute_diffs(baseline_result, fc_result)
            print(f"        -> baseline match={baseline_result.get('match')} | "
                  f"full-context match={fc_result.get('match')} | diffs={len(diffs)}")
            documents.append(
                {
                    "document_number": doc_no,
                    "file_path": file_path,
                    "baseline": baseline_result,
                    "full_context": fc_result,
                    "diffs": diffs,
                }
            )
        except Exception as exc:  # keep the run going; record the failure
            import traceback
            traceback.print_exc()
            documents.append({"document_number": doc_no, "error": f"{type(exc).__name__}: {exc}"})

    # 4. Write reports
    print("[4/4] Writing reports...")
    report = {
        "run": {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "ec_pdf": ec_pdf,
            "deeds": deeds,
            "ec_context_mode": ec_context_mode,
            "model": MODEL_ID,
            "doc_count": len(documents),
        },
        "documents": documents,
    }
    json_path = os.path.join(out_dir, "comparison_report.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    md_path = os.path.join(out_dir, "comparison_report.md")
    _write_markdown_report(report, md_path)

    flips = sum(
        1 for d in documents
        if any(x["field"] == "__overall_match__" for x in (d.get("diffs") or []))
    )
    print("\n=== DONE ===")
    print(f"  JSON report: {json_path}")
    print(f"  MD report:   {md_path}")
    print(f"  Documents:   {len(documents)} | overall-verdict flips: {flips}")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Experiment: full-context vs metadata-only EC-vs-Deed validation.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--ec", required=True, help="Path to the EC PDF.")
    parser.add_argument("--deeds", required=True, help="Directory of deed PDFs, a single deed .pdf, or a .zip of them.")
    parser.add_argument("--limit", type=int, default=0, help="Last-N transactions to test (0 = all).")
    parser.add_argument(
        "--out",
        default=os.path.join(SERVER_DIR, "experiments", "out", datetime.now().strftime("run_%Y%m%d_%H%M%S")),
        help="Output directory for artifacts and reports.",
    )
    parser.add_argument(
        "--ec-context",
        choices=["page", "full"],
        default="page",
        dest="ec_context_mode",
        help="EC full-context scope: 'page' (transaction's page(s)) or 'full' (entire EC).",
    )
    args = parser.parse_args(argv)
    run(args.ec, args.deeds, args.limit, args.out, args.ec_context_mode)


if __name__ == "__main__":
    main()
