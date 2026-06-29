"""Extract a concise verdict + issues + pros summary FROM a generated legal
opinion report. This module owns the opinion-summary feature end to end so the
analyze pipeline and the API can both reuse it."""

import json as _json
import os as _os
import re as _re
from datetime import datetime as _dt

VERDICT_SAFE = "Safe to Proceed"
VERDICT_CAUTION = "Proceed with Caution"
VERDICT_DO_NOT = "Do Not Proceed"
_VERDICTS = {VERDICT_SAFE, VERDICT_CAUTION, VERDICT_DO_NOT}


def normalize_severity(raw: str) -> str:
    """Coerce any model-emitted severity to the two-value enum. Unknown -> Minor."""
    return "Critical" if str(raw or "").strip().lower() == "critical" else "Minor"


def normalize_verdict(raw_verdict: str, issues: list) -> str:
    """Coerce the model's verdict to the enum and enforce guardrails:
    any Critical issue -> Do Not Proceed; any issue -> at least Caution.
    A 'Defective' report with no parsed issues is still Caution, not Safe."""
    text = str(raw_verdict or "").strip()
    # Start from an explicit enum match if present, else infer from wording.
    verdict = next((v for v in _VERDICTS if v.lower() == text.lower()), None)
    if verdict is None:
        low = text.lower()
        if "do not" in low:
            verdict = VERDICT_DO_NOT
        elif "caution" in low or "defective" in low:
            verdict = VERDICT_CAUTION
        elif "clear" in low or "marketable" in low or "safe" in low:
            verdict = VERDICT_SAFE
        else:
            verdict = VERDICT_CAUTION  # unknown wording -> conservative

    severities = {normalize_severity(i.get("severity")) for i in (issues or [])}
    if "Critical" in severities:
        return VERDICT_DO_NOT
    if severities and verdict == VERDICT_SAFE:
        return VERDICT_CAUTION
    return verdict


def compute_counts(issues: list, pros: list) -> dict:
    norm = [normalize_severity(i.get("severity")) for i in (issues or [])]
    return {
        "critical": sum(1 for s in norm if s == "Critical"),
        "minor": sum(1 for s in norm if s == "Minor"),
        "pros": len(pros or []),
    }


def _parse_first_json(text: str):
    m = _re.search(r"\{.*\}", text or "", _re.DOTALL)
    if not m:
        return None
    try:
        return _json.loads(m.group(0))
    except _json.JSONDecodeError:
        return None


def _fallback_summary(report_text: str, version: str) -> dict:
    """Deterministic fallback when extraction JSON is unusable: pull the FINAL
    VERDICT line so the card still renders meaningful content."""
    verdict_line = ""
    for line in (report_text or "").splitlines():
        if "VERDICT" in line.upper() or "Defective" in line or "Marketable" in line:
            verdict_line = line.strip()
            break
    verdict = normalize_verdict(verdict_line, [])
    return {
        "verdict": verdict,
        "issues": [],
        "pros": [],
        "counts": {"critical": 0, "minor": 0, "pros": 0},
        "prompt_version": version,
        "fallback": True,
    }


def extract_summary(report_text: str, gemini=None) -> dict:
    """Extract {verdict, issues, pros, counts} FROM a legal opinion report.
    `gemini` may be injected for tests; defaults to a real GeminiHelper."""
    from prompts.opinion_prompts import (
        OPINION_SUMMARY_EXTRACT_PROMPT, SUMMARY_PROMPT_VERSION,
    )
    if gemini is None:
        from common.gemini_helper import GeminiHelper
        gemini = GeminiHelper(model_id="gemini-3.5-flash")

    prompt = OPINION_SUMMARY_EXTRACT_PROMPT.replace("{report}", report_text or "")
    raw = gemini.generate_from_text("", prompt)
    parsed = _parse_first_json(raw)

    if not isinstance(parsed, dict):
        # Fallback: surface the report's verdict line verbatim.
        return _fallback_summary(report_text, SUMMARY_PROMPT_VERSION)

    issues = [
        {
            "text": str(i.get("text", "")).strip(),
            "severity": normalize_severity(i.get("severity")),
            "source_section": str(i.get("source_section", "")).strip(),
        }
        for i in (parsed.get("issues") or [])
        if str(i.get("text", "")).strip()
    ]
    pros = [
        {"text": str(p.get("text", "")).strip()}
        for p in (parsed.get("pros") or [])
        if str(p.get("text", "")).strip()
    ]
    verdict = normalize_verdict(parsed.get("verdict"), issues)
    return {
        "verdict": verdict,
        "issues": issues,
        "pros": pros,
        "counts": compute_counts(issues, pros),
        "prompt_version": SUMMARY_PROMPT_VERSION,
    }


class OpinionSummaryGenerator:
    """Owns: locate/read the legal opinion report, extract its summary, persist it."""

    def __init__(self, request_id: str, output_dir: "str | None" = None):
        self.request_id = request_id
        # Canonical location used across the codebase (handle_generate_report).
        self.base_dir = output_dir or _os.path.join("outputs", "validate", request_id)

    def report_md_path(self) -> str:
        return _os.path.join(self.base_dir, "legal", "legal_opinion_report.md")

    def summary_json_path(self) -> str:
        return _os.path.join(self.base_dir, "legal", "opinion_summary.json")

    def read_report(self) -> "str | None":
        path = self.report_md_path()
        if not _os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def build(self, gemini=None) -> dict:
        report = self.read_report()
        if not report:
            raise FileNotFoundError(f"Legal opinion report not found: {self.report_md_path()}")
        summary = extract_summary(report, gemini=gemini)
        summary["request_id"] = self.request_id
        summary["generated_at"] = _dt.now().isoformat(timespec="seconds")
        out_path = self.summary_json_path()
        _os.makedirs(_os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            _json.dump(summary, f, ensure_ascii=False, indent=2)
        return summary
