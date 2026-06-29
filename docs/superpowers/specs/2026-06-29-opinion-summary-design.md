# Design Spec — Auto Opinion Summary (Verdict + Issues + Pros)

- **Date:** 2026-06-29
- **Owner:** Koushik AM
- **Status:** Approved design → ready for implementation planning
- **Module:** LandwiseAI Legal Advisor — Smart Analysis pipeline + Legal Dashboard (Overview tab)

## 1. Goal

When **Smart Analysis** finishes for a parcel, automatically generate a concise
**legal opinion summary** and show it on the frontend **Overview (Title Health)**
tab as:

- an overall **verdict** banner — *Safe to Proceed · Proceed with Caution · Do Not Proceed*
- a bulleted list of **Issues** (with severity)
- a bulleted list of **Pros**

This is **additive**. The existing manually-triggered 9-section formal Opinion
Builder and advocate sign-off flow are **unchanged** — the summary is a fast,
at-a-glance read produced for free at the end of analysis.

## 2. Non-goals

- Does **not** replace the formal `OPINION_REPORT_PROMPT` 9-section report.
- Does **not** add the summary to the Opinion tab (Overview-only for now).
- Does **not** introduce a new sign-off / liability step — the summary is
  decision-support, not a signed verdict.
- Bilingual (`<Bi>`) rendering of the summary is out of scope for v1 (future).

## 3. Approach — Extract the summary FROM the legal opinion report

The summary is a **distilled view of the generated legal opinion report** — the
report is the single source of truth. We do **not** independently re-collect
signals from validation/risk/hierarchy. Flow:

```
Smart Analysis completes
        │
        ▼
1) Generate the legal opinion report      ← existing OPINION_REPORT_PROMPT
   (hierarchy + validation_results + red_flags)   (reuse existing opinion logic)
        │  legal_opinion_report (markdown)
        ▼
2) Extract the summary FROM that report    ← OPINION_SUMMARY_EXTRACT_PROMPT (LLM)
   verdict  ← from the report's "FINAL VERDICT & LEGAL OPINION" section
   issues   ← from the report's "DISCREPANCIES" + any flagged defects
   pros     ← from the report's "Clear / Marketable / Valid" positive findings
        │
        ▼
opinion_summary.json + AnalysisResult(result_type='opinion_summary')
```

So the summary never contradicts the report: every issue/pro/verdict it shows is
**lifted from the report text**, just condensed into points.

### Verdict mapping
The report ends with a verdict line — *"Clear, Marketable, and Valid"* or
*"Defective due to [Reason]"*. The extractor maps it to the three-value enum:

- "Clear, Marketable, and Valid" (no discrepancies) → **Safe to Proceed**
- "Defective" with non-blocking / rectifiable discrepancies → **Proceed with Caution**
- "Defective" with blocking defects (e.g. broken root of title, missing parent
  deed, court attachment) → **Do Not Proceed**

The mapping rule lives in one place so the thresholds can be tuned.

### Severity vocabulary
- Issue severity: **Critical** | **Minor**, assigned by the extractor from how the
  report frames each discrepancy (blocking/critical-scrutiny → Critical;
  rectifiable/minor → Minor).

## 4. Source: the legal opinion report

The report is produced by the existing `OPINION_REPORT_PROMPT`
(`Server/prompts/opinion_prompts.py`) from `{hierarchy}`, `{validation_results}`,
`{red_flags}`. Its structure already contains everything the summary needs:

| Summary field | Report section it is extracted from |
|---|---|
| `verdict` | §"FINAL VERDICT & LEGAL OPINION" (Clear/Marketable/Valid vs Defective) |
| `issues` | §8 "DOCUMENTS CHECKLIST & DISCREPANCIES" + any defect/"Extra Scrutiny" notes |
| `pros` | Positive findings across §1–§7 (clear root of title, no encumbrances, matching records) |

Because the report is currently **manually triggered** (Opinion Builder), the new
final pipeline stage will **auto-generate the report** at analysis completion so
the summary can be extracted from it. The generated report is persisted and the
Opinion Builder can reuse it (the advocate no longer starts from a blank draft) —
a bonus, but the Builder UI/sign-off flow itself is unchanged.

## 5. Backend

### New unit: `OpinionSummaryGenerator`
- New file under `Server/api/validate/` (single responsibility; isolated and
  unit-testable).
- Public method: `process(output_dir, parcel_id) -> dict` returning the schema in
  §6. It:
  1. **Ensures the legal opinion report exists** — reuse the existing opinion
     generation logic (the handler at `handler.py:2840` /
     `OPINION_REPORT_PROMPT`). If a report artifact already exists for the parcel,
     reuse it; otherwise generate it.
  2. **Extracts the summary from the report** via `extract_summary(report_text)`,
     a single LLM call using `OPINION_SUMMARY_EXTRACT_PROMPT` that returns strict
     JSON (§6).
  3. `map_verdict(report_text / extracted)` applies the §3 verdict mapping —
     isolated and unit-testable.
- New prompt `OPINION_SUMMARY_EXTRACT_PROMPT` in
  `Server/prompts/opinion_prompts.py` — extraction-only ("summarise THIS report
  into verdict + issues + pros; do not introduce facts not in the report").

### Pipeline integration
- Add a stage in the analyze generator in
  `Server/api/validate/handler.py` immediately after the validation stage
  completes and `results.json` is persisted (~line 700), before the final
  `result` event:
  ```
  yield event("step_start", step="opinion_summary", label="Opinion Summary")
  try:
      gen = OpinionSummaryGenerator(output_dir=processing_output_dir)
      report = gen.ensure_report(...)        # generate/reuse legal opinion report
      summary = gen.extract_summary(report)  # distil verdict + issues + pros
      # persist report artifact (reusable by Opinion Builder) + opinion_summary.json + AnalysisResult
      yield event("step_complete", step="opinion_summary", status="success")
  except Exception as e:
      yield event("step_complete", step="opinion_summary", status="failed", error=str(e))
      # NON-FATAL: do not raise; workflow still completes
  ```
- Add `opinion_summary` to the streamed stage list so `LiveAnalysisProgress`
  shows it.

### Caching
- `SUMMARY_PROMPT_VERSION` constant + inputs-hash (mirrors
  `VALIDATION_PROMPT_VERSION` / `_inputs_hash` in `validator.py`). The inputs-hash
  covers the **legal opinion report text** + prompt version, so the summary is
  re-extracted only when the report changes or the extract prompt is edited.

### Persistence + API
- Artifact: `opinion_summary.json` in the parcel output dir.
- DB: `AnalysisResult(result_type='opinion_summary', data=...)` — same pattern as
  `hierarchy_tree`.
- `GET  /api/v1/landwise/parcels/{id}/opinion-summary` → returns the schema, with
  artifact + DB fallback (mirror `handle_get_global_hierarchy`).
- `POST /api/v1/landwise/parcels/{id}/opinion-summary/regenerate` → re-runs the
  generator (manual refresh).
- Client: `landwiseApi.getOpinionSummary(parcelId)` and
  `landwiseApi.regenerateOpinionSummary(parcelId)` in
  `Client/src/lib/landwise-api.ts`.

## 6. Output schema

```json
{
  "verdict": "Safe to Proceed | Proceed with Caution | Do Not Proceed",
  "issues": [
    { "text": "Seller name on Deed 10403/2011 not found in EC record",
      "severity": "Critical",
      "source_section": "DISCREPANCIES" }
  ],
  "pros": [
    { "text": "Ownership chain is unbroken across all 12 transactions" }
  ],
  "counts": { "critical": 0, "minor": 0, "pros": 0 },
  "generated_at": "2026-06-29T10:00:00",
  "prompt_version": "2026-06-29-summary-v1"
}
```

`source_section` = the legal opinion report section the point was lifted from
(e.g. `FINAL VERDICT`, `DISCREPANCIES`, `TITLE FLOW & ENCUMBRANCES`) — optional,
lets the UI later link a point back to the relevant part of the full report.

## 7. Frontend (Overview / Title Health tab)

- New component `OpinionSummaryCard` rendered at the **top of the Overview tab**
  in `Client/src/pages/LegalDashboard.tsx`.
- Layout:
  - **Verdict banner** — color-coded: green (Safe), amber (Caution), red (Do Not
    Proceed); shows the counts line (e.g. "2 Critical · 3 Minor · 7 Pros").
  - Two columns: **⚠ Issues** (severity chip + colored dot per item) and
    **✅ Pros** (bulleted).
- States:
  - analysis running / stage in progress → skeleton loader.
  - stage failed or no summary → muted "Summary unavailable" + **Regenerate**
    button (calls the regenerate endpoint).
  - success → the card.
- The formal **Opinion Builder is untouched**.

## 8. Error handling

- Summary stage is **non-fatal**: failure never aborts the analysis workflow
  (same posture as the S3-sync step).
- If the legal opinion report cannot be generated, the summary is skipped; the
  Overview card shows "Summary unavailable · Regenerate" (no faked verdict).
- LLM JSON parse failure on extraction → fall back to surfacing the report's
  verbatim "FINAL VERDICT" line + "DISCREPANCIES" section so the card still
  renders meaningful content with a link to the full report.

## 9. Testing

- **Verdict mapping:** unit-test `map_verdict` with fixture report texts —
  "Clear, Marketable, and Valid", "Defective" (rectifiable), "Defective"
  (blocking: broken root of title / court attachment) — assert the correct
  three-value verdict.
- **Extraction:** test `extract_summary` with a stubbed Gemini client returning
  canned JSON over a sample report; assert schema conformance and that the issues
  trace back to the report's DISCREPANCIES section (no invented facts).
- **Endpoint:** test `GET` returns artifact, DB fallback, and 404-free empty
  state.
- **Frontend:** render `OpinionSummaryCard` in each state (loading / failed /
  success across all three verdicts).

## 10. Open items / decisions captured

- Severity vocab fixed to **Critical / Minor** (confirmed).
- Placement: **Overview tab only** (confirmed).
- **Source = the legal opinion report** (confirmed): the summary is extracted
  from the generated report, not synthesized from raw signals. The report is
  auto-generated at analysis completion so the summary can be lifted from it.
- Verdict is **mapped from the report's final verdict line** to the three-value
  enum (deterministic mapping; the LLM only extracts the text).
- Bilingual summary deferred to a later iteration.

## 11. Notes

- Git is not initialized in this workspace, so this spec is saved to disk but not
  committed. Initialize git (or tell me to) if you want it version-controlled.
