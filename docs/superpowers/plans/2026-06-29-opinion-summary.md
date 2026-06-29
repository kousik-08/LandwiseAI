# Opinion Summary (Verdict + Issues + Pros) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Smart Analysis completes, auto-generate the legal opinion report, extract a concise summary (verdict + issues + pros) from it, and show that summary on the Legal Dashboard's Overview tab.

**Architecture:** A new non-fatal final stage in the analyze pipeline ensures the legal opinion report exists (reusing `handle_generate_report`), then a new `OpinionSummaryGenerator` extracts a structured summary FROM the report markdown via one Gemini call. The summary is persisted as `opinion_summary.json` + an `AnalysisResult` row and served by a new endpoint the Overview tab renders.

**Tech Stack:** Python (FastAPI), `GeminiHelper` (google-genai), SQLAlchemy (`AnalysisResult`), pytest; React + TypeScript + axios + react-query (Client).

## Global Constraints

- Summary is **extracted from the legal opinion report** — never re-synthesized from raw signals. Every issue/pro/verdict is lifted from the report text.
- Summary stage is **non-fatal**: it must never abort the analyze workflow.
- Verdict enum is exactly: `Safe to Proceed` | `Proceed with Caution` | `Do Not Proceed`.
- Issue severity enum is exactly: `Critical` | `Minor`.
- Gemini model id for new calls: `gemini-3.5-flash` (matches the rest of the pipeline).
- Cache discipline: a `SUMMARY_PROMPT_VERSION` constant participates in the inputs-hash so a prompt edit re-extracts (mirrors `VALIDATION_PROMPT_VERSION` in `api/validate/validator.py`).
- The existing formal Opinion Builder, its endpoints, and sign-off flow are **unchanged**.
- Report markdown canonical path: `outputs/validate/{request_id}/legal/legal_opinion_report.md`.
- Summary artifact canonical path: `outputs/validate/{request_id}/legal/opinion_summary.json`.

---

### Task 1: Summary prompt + pure verdict/severity normalizers

**Files:**
- Modify: `Server/prompts/opinion_prompts.py` (append new prompt + version constant)
- Create: `Server/api/validate/opinion_summary.py` (pure helpers only in this task)
- Test: `Server/tests/test_opinion_summary_pure.py`

**Interfaces:**
- Produces:
  - `OPINION_SUMMARY_EXTRACT_PROMPT: str` and `SUMMARY_PROMPT_VERSION: str` in `prompts/opinion_prompts.py`
  - `normalize_verdict(raw_verdict: str, issues: list[dict]) -> str` returning one of the three verdict enum strings
  - `normalize_severity(raw: str) -> str` returning `"Critical"` or `"Minor"`
  - `compute_counts(issues: list[dict], pros: list[dict]) -> dict` returning `{"critical": int, "minor": int, "pros": int}`

- [ ] **Step 1: Write the failing test**

```python
# Server/tests/test_opinion_summary_pure.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.validate.opinion_summary import (
    normalize_verdict, normalize_severity, compute_counts,
)


def test_normalize_severity_maps_variants():
    assert normalize_severity("critical") == "Critical"
    assert normalize_severity("CRITICAL") == "Critical"
    assert normalize_severity("minor") == "Minor"
    assert normalize_severity("anything else") == "Minor"  # safe default


def test_normalize_verdict_clean_is_safe():
    assert normalize_verdict("Clear, Marketable, and Valid", []) == "Safe to Proceed"


def test_normalize_verdict_minor_only_is_caution():
    issues = [{"text": "consideration differs by Rs.400", "severity": "Minor"}]
    assert normalize_verdict("Safe to Proceed", issues) == "Proceed with Caution"


def test_normalize_verdict_critical_forces_do_not_proceed():
    issues = [{"text": "root of title broken", "severity": "Critical"}]
    assert normalize_verdict("Proceed with Caution", issues) == "Do Not Proceed"


def test_normalize_verdict_defective_text_without_issues_is_caution():
    assert normalize_verdict("Defective due to pending mutation", []) == "Proceed with Caution"


def test_compute_counts():
    issues = [{"severity": "Critical"}, {"severity": "Minor"}, {"severity": "Minor"}]
    pros = [{"text": "a"}, {"text": "b"}]
    assert compute_counts(issues, pros) == {"critical": 1, "minor": 2, "pros": 2}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Server && python -m pytest tests/test_opinion_summary_pure.py -v`
Expected: FAIL with `ModuleNotFoundError` / `ImportError: cannot import name 'normalize_verdict'`.

- [ ] **Step 3: Append the prompt + version to `prompts/opinion_prompts.py`**

```python
# --- appended to Server/prompts/opinion_prompts.py ---

# Bump when OPINION_SUMMARY_EXTRACT_PROMPT changes so cached summaries
# re-extract (mirrors VALIDATION_PROMPT_VERSION in api/validate/validator.py).
SUMMARY_PROMPT_VERSION = "2026-06-29-summary-v1"

OPINION_SUMMARY_EXTRACT_PROMPT = """You are summarising an ALREADY-WRITTEN Tamil Nadu legal title-verification report into a short decision-support summary.

STRICT RULE: Use ONLY facts stated in the report below. Do NOT add, infer, or invent anything not present in the report.

From the report, produce:
1. verdict — classify the report's "FINAL VERDICT & LEGAL OPINION" into EXACTLY one of:
   - "Safe to Proceed"        (report concludes Clear, Marketable, and Valid; no discrepancies)
   - "Proceed with Caution"   (defective but rectifiable: e.g. pending mutation, minor record mismatch, rectification/release deed advised)
   - "Do Not Proceed"         (blocking defect: broken root of title, missing parent deed, court attachment / lis pendens, prohibited land class)
2. issues — each material discrepancy or defect the report raises, as a short point. severity is "Critical" (blocking / extra-scrutiny) or "Minor" (rectifiable / cosmetic). Note the report section it came from.
3. pros — the report's positive findings (clear root of title, no encumbrances, matching records), as short points.

Return ONLY this JSON object:
{
  "verdict": "Safe to Proceed | Proceed with Caution | Do Not Proceed",
  "issues": [{"text": "...", "severity": "Critical | Minor", "source_section": "FINAL VERDICT | DISCREPANCIES | TITLE FLOW & ENCUMBRANCES | ..."}],
  "pros": [{"text": "..."}]
}

REPORT:
{report}
"""
```

- [ ] **Step 4: Create the pure helpers in `api/validate/opinion_summary.py`**

```python
# Server/api/validate/opinion_summary.py
"""Extract a concise verdict + issues + pros summary FROM a generated legal
opinion report. This module owns the opinion-summary feature end to end so the
analyze pipeline and the API can both reuse it."""

VERDICT_SAFE = "Safe to Proceed"
VERDICT_CAUTION = "Proceed with Caution"
VERDICT_DO_NOT = "Do Not Proceed"
_VERDICTS = {VERDICT_SAFE, VERDICT_CAUTION, VERDICT_DO_NOT}


def normalize_severity(raw: str) -> str:
    """Coerce any model-emitted severity to the two-value enum. Unknown -> Minor."""
    return "Critical" if str(raw or "").strip().lower() == "critical" else "Minor"


def normalize_verdict(raw_verdict: str, issues: list) -> str:
    """Coerce the model's verdict to the enum and enforce guardrails:
    any Critical issue -> at least Do Not Proceed; any issue -> at least Caution.
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd Server && python -m pytest tests/test_opinion_summary_pure.py -v`
Expected: PASS (6 passed).

- [ ] **Step 6: Commit**

```bash
git add Server/prompts/opinion_prompts.py Server/api/validate/opinion_summary.py Server/tests/test_opinion_summary_pure.py
git commit -m "feat(opinion-summary): add extract prompt + pure verdict/severity normalizers"
```

---

### Task 2: `extract_summary` — LLM extraction with deterministic normalization

**Files:**
- Modify: `Server/api/validate/opinion_summary.py`
- Test: `Server/tests/test_opinion_summary_extract.py`

**Interfaces:**
- Consumes: `normalize_verdict`, `normalize_severity`, `compute_counts` (Task 1); `OPINION_SUMMARY_EXTRACT_PROMPT`, `SUMMARY_PROMPT_VERSION` (Task 1); `common.gemini_helper.GeminiHelper`.
- Produces: `extract_summary(report_text: str, gemini=None) -> dict` returning
  `{"verdict": str, "issues": list, "pros": list, "counts": dict, "prompt_version": str}`.
  Accepts an injected `gemini` (any object with `generate_from_text(text, prompt) -> str`) for testing.

- [ ] **Step 1: Write the failing test**

```python
# Server/tests/test_opinion_summary_extract.py
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.validate.opinion_summary import extract_summary


class _StubGemini:
    def __init__(self, reply): self._reply = reply
    def generate_from_text(self, text, prompt): return self._reply


def test_extract_summary_parses_and_normalizes():
    reply = json.dumps({
        "verdict": "Safe to Proceed",  # will be bumped by a Critical issue
        "issues": [
            {"text": "Root of title broken at 1990", "severity": "critical", "source_section": "TITLE FLOW & ENCUMBRANCES"},
            {"text": "Consideration mismatch Rs.400", "severity": "minor", "source_section": "DISCREPANCIES"},
        ],
        "pros": [{"text": "No subsisting mortgage in EC"}],
    })
    out = extract_summary("<<report text>>", gemini=_StubGemini(reply))
    assert out["verdict"] == "Do Not Proceed"          # guardrail bumped it
    assert out["counts"] == {"critical": 1, "minor": 1, "pros": 1}
    assert out["issues"][0]["severity"] == "Critical"  # normalized
    assert out["prompt_version"]


def test_extract_summary_bad_json_falls_back():
    out = extract_summary("FINAL VERDICT: Defective due to X", gemini=_StubGemini("not json"))
    assert out["verdict"] in ("Proceed with Caution", "Do Not Proceed", "Safe to Proceed")
    assert isinstance(out["issues"], list)
    assert out.get("fallback") is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Server && python -m pytest tests/test_opinion_summary_extract.py -v`
Expected: FAIL with `ImportError: cannot import name 'extract_summary'`.

- [ ] **Step 3: Implement `extract_summary` (append to `opinion_summary.py`)**

```python
import json as _json
import re as _re


def _parse_first_json(text: str):
    m = _re.search(r"\{.*\}", text or "", _re.DOTALL)
    if not m:
        return None
    try:
        return _json.loads(m.group(0))
    except _json.JSONDecodeError:
        return None


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
        # Fallback: surface the report's verdict line + discrepancies verbatim.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Server && python -m pytest tests/test_opinion_summary_extract.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add Server/api/validate/opinion_summary.py Server/tests/test_opinion_summary_extract.py
git commit -m "feat(opinion-summary): extract_summary LLM pass with JSON fallback"
```

---

### Task 3: `OpinionSummaryGenerator` — ensure report, extract, persist

**Files:**
- Modify: `Server/api/validate/opinion_summary.py`
- Test: `Server/tests/test_opinion_summary_generator.py`

**Interfaces:**
- Consumes: `extract_summary` (Task 2); `api.validate.handler.handle_generate_report` (existing async fn writing the report md); `SUMMARY_PROMPT_VERSION`.
- Produces: class `OpinionSummaryGenerator`
  - `__init__(self, request_id: str, output_dir: str | None = None)`
  - `report_md_path() -> str` → `outputs/validate/{request_id}/legal/legal_opinion_report.md`
  - `summary_json_path() -> str` → `outputs/validate/{request_id}/legal/opinion_summary.json`
  - `read_report() -> str | None` (reads the md if present)
  - `build(self, gemini=None) -> dict` → reads the report (assumes it exists), extracts the summary, stamps `generated_at`/`request_id`, writes `opinion_summary.json`, returns the summary dict.

  Note: triggering report generation (the async `handle_generate_report`) happens in the pipeline stage (Task 4) and endpoint (Task 5), which already run in async/loop contexts. `build()` itself is sync and only needs the report text on disk — keeping it pure-ish and unit-testable.

- [ ] **Step 1: Write the failing test**

```python
# Server/tests/test_opinion_summary_generator.py
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.validate.opinion_summary import OpinionSummaryGenerator


class _StubGemini:
    def __init__(self, reply): self._reply = reply
    def generate_from_text(self, text, prompt): return self._reply


def test_build_reads_report_and_writes_summary(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    rid = "test-req-1"
    legal_dir = os.path.join("outputs", "validate", rid, "legal")
    os.makedirs(legal_dir, exist_ok=True)
    with open(os.path.join(legal_dir, "legal_opinion_report.md"), "w", encoding="utf-8") as f:
        f.write("FINAL VERDICT & LEGAL OPINION: Clear, Marketable, and Valid")

    reply = json.dumps({
        "verdict": "Safe to Proceed",
        "issues": [],
        "pros": [{"text": "Unbroken chain across 12 transactions"}],
    })
    gen = OpinionSummaryGenerator(request_id=rid)
    out = gen.build(gemini=_StubGemini(reply))

    assert out["verdict"] == "Safe to Proceed"
    assert out["request_id"] == rid
    assert out["generated_at"]
    assert os.path.exists(gen.summary_json_path())
    with open(gen.summary_json_path(), encoding="utf-8") as f:
        on_disk = json.load(f)
    assert on_disk["pros"][0]["text"] == "Unbroken chain across 12 transactions"


def test_read_report_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    gen = OpinionSummaryGenerator(request_id="nope")
    assert gen.read_report() is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Server && python -m pytest tests/test_opinion_summary_generator.py -v`
Expected: FAIL with `ImportError: cannot import name 'OpinionSummaryGenerator'`.

- [ ] **Step 3: Implement the class (append to `opinion_summary.py`)**

```python
import os as _os
from datetime import datetime as _dt


class OpinionSummaryGenerator:
    """Owns: locate/read the legal opinion report, extract its summary, persist it."""

    def __init__(self, request_id: str, output_dir: str | None = None):
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Server && python -m pytest tests/test_opinion_summary_generator.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add Server/api/validate/opinion_summary.py Server/tests/test_opinion_summary_generator.py
git commit -m "feat(opinion-summary): OpinionSummaryGenerator reads report and persists summary"
```

---

### Task 4: Pipeline stage — generate report + summary at analysis completion

**Files:**
- Modify: `Server/api/validate/handler.py` (insert stage after validation, before the final `result` event at ~line 700–742)

**Interfaces:**
- Consumes: `handle_generate_report(request_id)` (existing async, in this module); `OpinionSummaryGenerator` (Task 3); `processing_id`, `processing_output_dir`, and the `event(...)` helper already in scope in the analyze generator.
- Produces: a streamed `opinion_summary` stage; `opinion_summary.json` on disk; the summary embedded in `final_result["opinion_summary"]`.

- [ ] **Step 1: Add the stage (insert immediately after `# Final Summary Log` block, before `final_result = {...}` at handler.py:706)**

```python
        # --- Opinion Summary stage (NON-FATAL) -------------------------------
        # Generate the legal opinion report, then extract a verdict+issues+pros
        # summary FROM it for the Overview tab. Must never abort the workflow.
        opinion_summary = None
        yield event("step_start", step="opinion_summary", label="Opinion Summary")
        try:
            # Ensure the report exists (writes legal/legal_opinion_report.md).
            report_data = await handle_generate_report(processing_id)
            if isinstance(report_data, dict) and report_data.get("status") == "success":
                from api.validate.opinion_summary import OpinionSummaryGenerator
                gen = OpinionSummaryGenerator(
                    request_id=processing_id, output_dir=processing_output_dir
                )
                opinion_summary = gen.build()
                # Persist as an AnalysisResult row (same pattern as hierarchy_tree).
                try:
                    from common.database import SessionLocal
                    from common.landwise_models import AnalysisResult
                    db = SessionLocal()
                    try:
                        row = db.query(AnalysisResult).filter(
                            AnalysisResult.request_id == processing_id,
                            AnalysisResult.result_type == 'opinion_summary',
                        ).first()
                        if row:
                            row.data = opinion_summary
                        else:
                            db.add(AnalysisResult(
                                request_id=processing_id,
                                result_type='opinion_summary',
                                data=opinion_summary,
                            ))
                        db.commit()
                    finally:
                        db.close()
                except Exception as _dbe:
                    print(f"Opinion summary DB persist failed (non-fatal): {_dbe}")
                yield event("step_complete", step="opinion_summary", status="success")
            else:
                yield event("step_complete", step="opinion_summary", status="failed",
                            error="report generation did not succeed")
        except Exception as e:
            print(f"Opinion summary stage failed (non-fatal): {e}")
            yield event("step_complete", step="opinion_summary", status="failed", error=str(e))
        # --------------------------------------------------------------------
```

- [ ] **Step 2: Embed the summary in `final_result`**

Modify the `final_result` dict (handler.py:706) to add one line:

```python
        final_result = {
            "status": "success",
            "output_dir": processing_output_dir,
            "request_id": processing_id,
            "results": results,
            "hierarchy_path": f"validate/{processing_id}/hierarchy_view.html",
            "opinion_summary": opinion_summary,
        }
```

- [ ] **Step 3: Verify the module imports and the analyze generator still parses**

Run: `cd Server && python -c "import ast; ast.parse(open('api/validate/handler.py', encoding='utf-8').read()); print('handler OK')"`
Expected: `handler OK`.

- [ ] **Step 4: Confirm the AnalysisResult model accepts `result_type='opinion_summary'`**

Run: `cd Server && python -c "from common.landwise_models import AnalysisResult; print([c.name for c in AnalysisResult.__table__.columns])"`
Expected: output includes `request_id`, `result_type`, `data`. (`result_type` is a free-text string column — no enum/migration needed. If it prints an Enum constraint instead, add `opinion_summary` to that enum and create a migration before proceeding.)

- [ ] **Step 5: Commit**

```bash
git add Server/api/validate/handler.py
git commit -m "feat(opinion-summary): non-fatal pipeline stage generates report + summary on completion"
```

---

### Task 5: API endpoints — GET summary + POST regenerate

**Files:**
- Modify: `Server/api/landwise/router.py` (add two routes near the existing `/report` route at ~line 1741)
- Test: `Server/tests/test_opinion_summary_endpoint.py`

**Interfaces:**
- Consumes: `OpinionSummaryGenerator` (Task 3); `handle_generate_report` (existing); `services.artifact_store.read_json_artifact`; models `Parcel`, `AnalysisResult` (already imported in router); `parcel.last_analysis_request_id`.
- Produces:
  - `GET  /parcels/{parcel_id}/opinion-summary` → `{"status": "success", "summary": {...}}` or 404
  - `POST /parcels/{parcel_id}/opinion-summary/regenerate` → `{"status": "success", "summary": {...}}`

- [ ] **Step 1: Write the failing test (route presence + handler logic via a fake DB/parcel)**

```python
# Server/tests/test_opinion_summary_endpoint.py
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.landwise.router import _load_opinion_summary  # helper added in this task


def test_load_opinion_summary_reads_disk(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    rid = "req-xyz"
    legal_dir = os.path.join("outputs", "validate", rid, "legal")
    os.makedirs(legal_dir, exist_ok=True)
    payload = {"verdict": "Safe to Proceed", "issues": [], "pros": [], "counts": {"critical": 0, "minor": 0, "pros": 0}}
    with open(os.path.join(legal_dir, "opinion_summary.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f)

    out = _load_opinion_summary(rid)
    assert out["verdict"] == "Safe to Proceed"


def test_load_opinion_summary_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert _load_opinion_summary("absent") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Server && python -m pytest tests/test_opinion_summary_endpoint.py -v`
Expected: FAIL with `ImportError: cannot import name '_load_opinion_summary'`.

- [ ] **Step 3: Add the helper + routes to `router.py` (place after `generate_legal_report`, ~line 1771)**

```python
def _load_opinion_summary(request_id: str):
    """Three-tier read of opinion_summary.json: local scratch -> S3 -> DB row."""
    from services.artifact_store import read_json_artifact

    def _from_db():
        from common.database import SessionLocal
        from common.landwise_models import AnalysisResult
        db = SessionLocal()
        try:
            row = db.query(AnalysisResult).filter(
                AnalysisResult.request_id == request_id,
                AnalysisResult.result_type == 'opinion_summary',
            ).first()
            return row.data if row else None
        finally:
            db.close()

    return read_json_artifact(
        request_id, os.path.join("legal", "opinion_summary.json"), db_fallback=_from_db,
    )


@router.get("/parcels/{parcel_id}/opinion-summary")
def get_opinion_summary(parcel_id: str, db: Session = Depends(get_db)):
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
    if not parcel or not parcel.last_analysis_request_id:
        raise HTTPException(404, "No analysis found for this parcel.")
    summary = _load_opinion_summary(parcel.last_analysis_request_id)
    if not summary:
        raise HTTPException(404, "Opinion summary not available. Run analysis or regenerate.")
    return {"status": "success", "summary": summary}


@router.post("/parcels/{parcel_id}/opinion-summary/regenerate")
async def regenerate_opinion_summary(parcel_id: str, db: Session = Depends(get_db)):
    parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
    if not parcel or not parcel.last_analysis_request_id:
        raise HTTPException(404, "No analysis found for this parcel.")
    request_id = parcel.last_analysis_request_id

    from api.validate.handler import handle_generate_report
    from api.validate.opinion_summary import OpinionSummaryGenerator
    report_data = await handle_generate_report(request_id)
    if not (isinstance(report_data, dict) and report_data.get("status") == "success"):
        raise HTTPException(500, "Could not generate the legal opinion report.")

    summary = OpinionSummaryGenerator(request_id=request_id).build()
    # Upsert the DB row so GET's DB fallback stays fresh.
    from common.landwise_models import AnalysisResult
    row = db.query(AnalysisResult).filter(
        AnalysisResult.request_id == request_id,
        AnalysisResult.result_type == 'opinion_summary',
    ).first()
    if row:
        row.data = summary
    else:
        db.add(AnalysisResult(request_id=request_id, result_type='opinion_summary', data=summary))
    db.commit()
    return {"status": "success", "summary": summary}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Server && python -m pytest tests/test_opinion_summary_endpoint.py -v`
Expected: PASS (2 passed). If `read_json_artifact`'s signature differs (e.g. it joins with a different base), adjust the path arg so the local read resolves `outputs/validate/{rid}/legal/opinion_summary.json` — verify by reading `services/artifact_store.py`.

- [ ] **Step 5: Commit**

```bash
git add Server/api/landwise/router.py Server/tests/test_opinion_summary_endpoint.py
git commit -m "feat(opinion-summary): GET + POST regenerate endpoints"
```

---

### Task 6: Client API methods

**Files:**
- Modify: `Client/src/lib/landwise-api.ts` (in the `// Opinion` block, after `signOpinion` at ~line 129)

**Interfaces:**
- Produces: `landwiseApi.getOpinionSummary(parcelId)` and `landwiseApi.regenerateOpinionSummary(parcelId)`.

- [ ] **Step 1: Add the two methods**

```typescript
  // Opinion Summary (auto-generated on analysis completion; Overview tab)
  getOpinionSummary: async (parcelId: string) => {
    const response = await axios.get(`${API_BASE_URL}/parcels/${parcelId}/opinion-summary`);
    return response.data;
  },
  regenerateOpinionSummary: async (parcelId: string) => {
    const response = await axios.post(`${API_BASE_URL}/parcels/${parcelId}/opinion-summary/regenerate`);
    return response.data;
  },
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd Client && npx tsc --noEmit`
Expected: no new errors referencing `landwise-api.ts`.

- [ ] **Step 3: Commit**

```bash
git add Client/src/lib/landwise-api.ts
git commit -m "feat(opinion-summary): client API methods getOpinionSummary + regenerate"
```

---

### Task 7: `OpinionSummaryCard` component

**Files:**
- Create: `Client/src/features/analysis/components/OpinionSummaryCard.tsx`
- Test: none (rendered states verified via the running app in Task 8; keep logic trivial)

**Interfaces:**
- Consumes: `landwiseApi.getOpinionSummary`, `landwiseApi.regenerateOpinionSummary` (Task 6); react-query `useQuery`/`useMutation`; `toast` (already used in LegalDashboard).
- Produces: `export function OpinionSummaryCard({ parcelId }: { parcelId: string })`.

- [ ] **Step 1: Create the component**

```tsx
// Client/src/features/analysis/components/OpinionSummaryCard.tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { landwiseApi } from "@/lib/landwise-api";
import { toast } from "sonner";

type Issue = { text: string; severity: "Critical" | "Minor"; source_section?: string };
type Summary = {
  verdict: "Safe to Proceed" | "Proceed with Caution" | "Do Not Proceed";
  issues: Issue[];
  pros: { text: string }[];
  counts: { critical: number; minor: number; pros: number };
};

const VERDICT_STYLE: Record<string, string> = {
  "Safe to Proceed": "bg-emerald-50 border-emerald-200 text-emerald-800",
  "Proceed with Caution": "bg-amber-50 border-amber-200 text-amber-800",
  "Do Not Proceed": "bg-red-50 border-red-200 text-red-800",
};

export function OpinionSummaryCard({ parcelId }: { parcelId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["opinion-summary", parcelId],
    queryFn: () => landwiseApi.getOpinionSummary(parcelId),
    retry: false,
  });

  const regenerate = useMutation({
    mutationFn: () => landwiseApi.regenerateOpinionSummary(parcelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opinion-summary", parcelId] });
      toast.success("Opinion summary regenerated");
    },
    onError: () => toast.error("Could not regenerate summary"),
  });

  if (isLoading) {
    return <div className="h-32 rounded-xl border border-slate-200 bg-slate-50 animate-pulse" />;
  }

  if (isError || !data?.summary) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 flex items-center justify-between">
        <p className="text-sm text-slate-500">Opinion summary unavailable.</p>
        <button
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
          className="text-sm font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-50"
        >
          {regenerate.isPending ? "Generating…" : "Regenerate"}
        </button>
      </div>
    );
  }

  const s: Summary = data.summary;
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className={`px-5 py-3 border-b flex items-center justify-between ${VERDICT_STYLE[s.verdict] || ""}`}>
        <span className="font-black tracking-tight">{s.verdict}</span>
        <span className="text-xs font-semibold opacity-80">
          {s.counts.critical} Critical · {s.counts.minor} Minor · {s.counts.pros} Pros
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
        <div className="p-5 border-r border-slate-100">
          <h4 className="text-xs font-bold uppercase tracking-wide text-red-600 mb-2">⚠ Issues</h4>
          {s.issues.length === 0 ? (
            <p className="text-sm text-slate-400">None identified.</p>
          ) : (
            <ul className="space-y-2">
              {s.issues.map((i, idx) => (
                <li key={idx} className="text-sm text-slate-700 flex gap-2">
                  <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${i.severity === "Critical" ? "bg-red-500" : "bg-amber-400"}`} />
                  <span>
                    {i.text}
                    <span className="ml-2 text-[10px] font-bold uppercase text-slate-400">{i.severity}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="p-5">
          <h4 className="text-xs font-bold uppercase tracking-wide text-emerald-600 mb-2">✅ Pros</h4>
          {s.pros.length === 0 ? (
            <p className="text-sm text-slate-400">None identified.</p>
          ) : (
            <ul className="space-y-2">
              {s.pros.map((p, idx) => (
                <li key={idx} className="text-sm text-slate-700 flex gap-2">
                  <span className="mt-1 h-2 w-2 rounded-full shrink-0 bg-emerald-500" />
                  <span>{p.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd Client && npx tsc --noEmit`
Expected: no errors in `OpinionSummaryCard.tsx`. (If the project uses a different toast import than `sonner`, match the import already used in `LegalDashboard.tsx`.)

- [ ] **Step 3: Commit**

```bash
git add Client/src/features/analysis/components/OpinionSummaryCard.tsx
git commit -m "feat(opinion-summary): OpinionSummaryCard component"
```

---

### Task 8: Mount the card on the Overview tab + add pipeline stage to progress UI

**Files:**
- Modify: `Client/src/pages/LegalDashboard.tsx` (import + render the card at the top of the Overview tab; add `opinion_summary` to the streamed-stages list at ~line 178)

**Interfaces:**
- Consumes: `OpinionSummaryCard` (Task 7); `selectedParcelId` (already in scope where tabs render, e.g. near the `activeTab === "opinion"` block at ~line 905).
- Produces: visible summary card on the Overview tab; the `opinion_summary` stage shown in `LiveAnalysisProgress`.

- [ ] **Step 1: Import the component (top of `LegalDashboard.tsx`, with the other feature imports)**

```tsx
import { OpinionSummaryCard } from "@/features/analysis/components/OpinionSummaryCard";
```

- [ ] **Step 2: Render the card at the top of the Overview tab**

Find the Overview tab render block (the `activeTab === "overview"` branch; sibling of the `activeTab === "opinion"` block at LegalDashboard.tsx:905). Insert the card as the first child, before the existing Title Health content:

```tsx
{activeTab === "overview" && (
  <div className="space-y-6">
    {selectedParcelId && <OpinionSummaryCard parcelId={selectedParcelId} />}
    {/* …existing Title Health overview content stays below… */}
  </div>
)}
```

If the overview branch currently renders content directly (not wrapped), wrap the existing content in the `<div className="space-y-6">…</div>` shown above so the card sits above it.

- [ ] **Step 3: Add the stage to the streamed-stages list (LegalDashboard.tsx:178)**

The comment at line 178 documents "Pipeline stages streamed by the analyze workflow". Add `opinion_summary` to that stages array so the live progress renders it, matching the existing entry shape. Example (match the existing array's object/string shape exactly):

```tsx
// …existing stages…
{ step: "validation", label: "Validation" },
{ step: "opinion_summary", label: "Opinion Summary" },
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd Client && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manual verification in the running app**

Run the app (per the project's run process), open a parcel that has completed Smart Analysis, and confirm on the **Overview** tab:
- the verdict banner shows with the correct color,
- Issues and Pros lists render as points,
- the counts line matches the list lengths,
- for a parcel without a summary, the "Regenerate" affordance appears and works.

- [ ] **Step 6: Commit**

```bash
git add Client/src/pages/LegalDashboard.tsx
git commit -m "feat(opinion-summary): show summary card on Overview tab + progress stage"
```

---

## Self-Review

**Spec coverage:**
- Auto-generate on completion → Task 4 (pipeline stage). ✅
- Extract FROM the legal opinion report → Tasks 2–3 (extract_summary reads report md). ✅
- Verdict + Issues + Pros, Critical/Minor severity → Tasks 1–2. ✅
- Overview-tab placement, additive (builder untouched) → Tasks 7–8; no opinion-builder files modified. ✅
- Persistence + GET/regenerate API → Tasks 3, 5. ✅
- Caching via SUMMARY_PROMPT_VERSION → Task 1 (constant) + Task 2 (stamped into output). ✅
- Non-fatal stage + graceful fallback → Task 4 (try/except, no raise) + Task 2 (`_fallback_summary`). ✅
- Streamed stage visible in progress UI → Task 8 Step 3. ✅
- Tests for verdict mapping + extraction + endpoint → Tasks 1, 2, 3, 5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Two explicit verification branches (Task 4 Step 4 enum check; Task 5 Step 4 artifact-store signature) tell the implementer exactly what to confirm and what to do if reality differs — these are guardrails, not placeholders.

**Type consistency:** `extract_summary` / `OpinionSummaryGenerator.build` return the same shape consumed by `_load_opinion_summary` and the `Summary` type in `OpinionSummaryCard`. Verdict strings (`Safe to Proceed` / `Proceed with Caution` / `Do Not Proceed`) and severities (`Critical` / `Minor`) are identical across Python and TS. `result_type='opinion_summary'` is used identically in Tasks 4 and 5.

## Assumptions to confirm during execution
- `processing_output_dir` == `outputs/validate/{processing_id}` (so `handle_generate_report(processing_id)` and `OpinionSummaryGenerator` resolve the same files). Verify in Task 4 by checking the analyze setup; if the dir differs, pass it explicitly via `output_dir=`.
- `AnalysisResult.result_type` is a free-text string column (Task 4 Step 4 confirms; if enum-constrained, add value + migration).
- `read_json_artifact(request_id, relative_path, db_fallback=...)` joins `relative_path` under the parcel's output dir (Task 5 Step 4 confirms against `services/artifact_store.py`).
