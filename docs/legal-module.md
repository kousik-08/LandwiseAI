# LandwiseAI — Legal Module Specification

> Tamil Nadu land-title due-diligence engine. This document maps the **real lawyer checklist** to **what LandwiseAI automates**, the **logic** behind each check, the **documents / cross-document comparisons** involved, and the **phase-by-phase** flow.
>
> _Last updated: 2026-06-25. Grounded in source — file:line references are to the current codebase._

---

## 0. TL;DR — AI vs Manual (canonical reference)

Three honest buckets. The middle bucket is genuinely AI — it just needs the input document/source before it can decide.

### ✅ Done by AI — fully automated (runs on Smart Analysis, no human input)
| Check | What the AI does | Source |
|---|---|---|
| Deed ↔ EC validation | Cross-checks each Sale Deed vs its EC entry | `prompts/validation_prompts.py` |
| All deeds registered/traceable (DOC-06) | Each deed's reg. number appears in EC | validation `document_details` |
| Supporting documents present (DOC-01) | EC + Sale Deed (+ Patta) uploaded? | `checklist_engine/providers.py` `doc_01` |
| EC covers 30 years (DOC-02) | Computes EC date span, flags < 30 yr | `providers.py` `doc_02` |
| Year coverage continuous (DOC-05) | Gaps > 3 yr between EC entries | `risk_score_engine.py:101` |
| Owner matches EC executant/claimant | Current owner from EC chain | `api/validate/handler.py` (~3725) |
| Chain unbroken 30 yrs (OWN-02) | Span + party-overlap test | `providers.py` `own_02` |
| No gap > 5 yrs (OWN-03) | Gap detection at 5-yr threshold | `providers.py` `own_03` |
| Survey number match | Survey consistent deed ↔ EC | `validation_prompts.py` |
| Extent / area match | Extent consistent (states value, never sums) | `validation_prompts.py` |
| Mortgages identified (ENC-01) | EC nature keyword scan | `providers.py` `enc_01` |
| No court orders / lis-pendens (ENC-04) | Lis-pendens keyword detection | `risk_score_engine.py:19` |
| Risk score + grade + summary | Weighted score, flags, AI summary | `risk_score_engine.py` |

### 🟡 AI-assisted — auto-verifies once the input is provided (upload a doc / connect a source)
| Check | Activates when… | Then AI… | Source |
|---|---|---|---|
| Owner ↔ Patta holder (OWN-01) | Patta uploaded | extracts holder, compares | `extractors.py` `PattaExtractor` |
| Revenue ↔ FMB (CMP-04) | FMB/sketch uploaded | extracts survey/boundary, compares | `FMBExtractor` |
| Document source original/certified (DOC-04) | any doc | reads stamps/seals | `SourceTypeDetector` |
| PoA present if NRI (DOC-07) | EC parties / deed | NRI heuristic + PoA presence | `NRIDetector` |
| No forest/wetland (CMP-01) | A-Register uploaded / GIS connected | reads classification | `ARegisterExtractor` / `ForestSource` |
| Not in CRZ (CMP-02) | CRZ cert uploaded / map connected | reads CRZ status | `CRZCertExtractor` / `CRZSource` |
| Land-use / DTCP approval (CMP-03) | DTCP doc uploaded / portal connected | reads approval | `DTCPApprovalExtractor` / `DTCPSource` |
| Active mortgages have NOC (ENC-02) | NOC uploaded | flags mortgage w/o NOC | `providers.py` `enc_02` |
| Death Certificate verified (OWN-06) | inheritance + Death Cert uploaded | extracts deceased → confirms it's the prior title-holder in the EC chain | `DeathCertExtractor` |
| Legal Heir Certificate (OWN-07) | inheritance + Heir Cert uploaded | extracts heirs → confirms the **seller is a listed heir** (catches wrong-executant / undisclosed-heir) | `LegalHeirExtractor` |
| Heir mutation (OWN-08) | inheritance matter | Patta mutated to heir(s) before sale | `providers.py` `own_08` |

_Until the input arrives, these report `pending: requires X` — never a fabricated pass._

### 👤 Manual — human (lawyer) verification required
| Check | Why manual |
|---|---|
| Documents legible / OCR ≥ 70% (DOC-03) | Pipeline doesn't emit a real OCR-confidence number yet |
| HUF/Company documentation adequate (OWN-04) | Entity authority is a legal judgment |
| NRI FEMA/RBI compliance (OWN-05) | We detect NRI; FEMA/TDS/RBI compliance is human |
| Liens/attachments discharged (ENC-03) | Discharge detected best-effort; human confirms |
| Easement rights acceptable (ENC-05) | "Acceptable" is a human call |
| Risk flags actioned (FIN-01) | Lawyer accepts/dismisses/resolves each flag |
| Consistency / sign-off (FIN-03) | Final advocate certification |
| Boundaries consistent across docs | No boundary-comparison logic yet |
| ~~Site Manager queries (FIN-02)~~ | Legacy → N/A (role merged into Legal Advisor) |

**Tally:** ~13 fully automated · ~8 AI-assisted (on input) · ~8 manual.

---

## 1. What checklist a TN property lawyer actually runs

A Tamil Nadu title lawyer works a 5-stage due-diligence checklist before certifying marketability. LandwiseAI models it as **27 items across 5 phases** (incl. the succession checks OWN-06/07/08) (`Server/services/checklist_service.py:13–47`):

| Phase | Lawyer verifies | Records |
|---|---|---|
| **1. Documents / Title** | Root (parent) deed; latest sale deed; **30-yr EC** (13-yr is insufficient); legible/certified | Parent Deed, Sale Deed, EC 30-yr, Patta, Chitta, Adangal/A-Register, FMB |
| **2. Ownership** | Owner = Patta holder; **unbroken 30-yr chain**; no gap > 5 yr; HUF/company authority; NRI/FEMA | EC chain, Patta, entity docs, PoA |
| **3. Encumbrances** | Mortgages found; active mortgages discharged (NOC); liens cleared; **no lis-pendens**; easements | EC, bank closure/NOC, court search |
| **4. Compliance** | **Forest/wetland** (poramboke/tharisu); **CRZ**; **DTCP/CMDA**; revenue ↔ **FMB** | A-Register, GIS/CRZ, DTCP, FMB |
| **5. Final Review** | Risk flags actioned; consistency; advocate sign-off | — |

**TN-specific showstoppers** a lawyer additionally screens (appear in `opinion_prompts.py` + the scenario model): **Assigned/D-patta** (alienation barred), **Panchami** (non-transferable), **land-ceiling** surplus, **government-acquisition** notification (Sec.4(1)/11), **PoA-sale** fraud. These are the "No-Go" categories.

---

## 2. What we automate

Two checklists exist — keep them distinct:

- **Backend 27-item review checklist** (`checklist_service.py:13–47`) — the formal 5-phase sign-off; gated. (Includes succession checks OWN-06/07/08, which resolve to N/A for non-inheritance matters.)
- **Frontend 20-item "Checks to Run" picker** (`Client/src/lib/landwise-checks.ts:44–74`) — what the user selects before analysis. Only **6 ids are field-mapped** to per-document verdicts: `deed_validation, area_extent, survey_match, owner_match_ec, supporting_docs, all_registered`. Others render parcel-level.

Automation tiers (implemented in `Server/services/checklist_engine/`):

| Tier | Coverage | Mechanism |
|---|---|---|
| **A — automated now** | DOC-01/02/05/06, OWN-02/03, ENC-01/04 + the 6 picker AI checks | from EC extraction + validation + risk, no extra input |
| **C — upload-driven** | OWN-01 (Patta), CMP-04 (FMB), DOC-04 (source), DOC-07 (NRI), CMP-01 (A-Register) | Gemini extracts the uploaded doc → suggests verdict (cached as `aux/*.json`) |
| **B — external data** | CMP-01/02/03 (forest/CRZ/DTCP), eCourts | env-gated adapters; honest `pending` until source connected |
| **Manual** | DOC-03, OWN-04/05, ENC-02/03/05, FIN-01/03 | lawyer judgment |

---

## 3. Features we provide

Workspace tabs (`Client/src/pages/LegalDashboard.tsx`) + engines:

- **Title Health Score (Overview)** — 0–100 readiness score + AI risk summary + workflow-phase progress.
- **Document Analysis** — per-document Deed↔EC verification panel.
- **Timeline** — chronological ownership-chain search.
- **Ownership Audit** — per-deed **Executant → Claimant**, per-plot chains, partition/total extent.
- **Risk Score** — encumbrance risk engine (grade A–F, factors, flags).
- **Verification Checklist** — 24-item checklist, **auto-populated** + per-check **document uploads** (the engine added in this work).
- **Legal Opinion** — AI-drafted advisory verdict (gated).
- **Notes Hub** + **Document Repository** — annotations + PDF vault.
- **Smart Analysis** — the streaming pipeline producing all of the above.

---

## 4. The logic behind each

| Logic | What it does | Source |
|---|---|---|
| **Extraction** | Gemini OCR → structured JSON per document | `ec_processor.py:317` `parse_to_json`, `prompts/ec_prompts.py`, `prompts/sale_deed_prompts.py` |
| **Matching** | Each Sale Deed matched to its EC transaction (primarily by Document Number) | `api/validate/matcher.py` |
| **Validation** | Field-by-field Deed↔EC comparison → MATCHED/NOT MATCHED + `trustability_score` | `prompts/validation_prompts.py` |
| **Chain** | Sort EC transfers by date; current owner = latest buyer; **BROKEN_CHAIN** when a seller never appears as a prior buyer (party-overlap, no time threshold) | `api/validate/handler.py` (~3654–3789) |
| **Risk** | Keyword detection + gap detection (> 3 yr) + trustability → weighted score with hard caps → grade + verdict | `api/validate/risk_score_engine.py` |
| **Checklist auto-population** | Maps real signals → AI-suggested verdict (`clear`/`issue`/`na`) or honest `pending`; never overrides a human verdict | `checklist_engine/engine.py` `run()` |

**Risk scoring** (`risk_score_engine.py`): score = 55% document-completeness + 45% risk-health, with hard caps (critical → ≤45, high → ≤62, −4 per missing mandatory doc); grade A–F. Flags emitted: `encumbrance_gaps`, `lis_pendens`, `restricted_lands`, `scrutiny_docs`; metadata: `gap_count`, `avg_trustability`, `document_details[]`.

---

## 5. Documents + cross-document comparisons per logic

| Comparison | Doc A | Doc B | Rule |
|---|---|---|---|
| **Deed ↔ EC** (core) | Sale Deed | EC entry | **Document Number** (exact; mismatch = fail), Date, Survey/Sub-division, **Extent/Sq-ft** (stated value, no summing), **Executant↔Claimant**, Nature, **PoA → MATCHED (LINKED)** |
| **Owner ↔ Patta** (OWN-01) | EC chain (current owner) | Patta | Holder-name match |
| **Survey ↔ FMB** (CMP-04) | Parcel survey no. | FMB sketch | Survey/boundary consistency |
| **Classification ↔ A-Register** (CMP-01) | Survey no. | A-Register/Adangal | Flag poramboke/tharisu/forest/reserved |
| **Chain continuity** (DOC-05/OWN-02/03) | EC transactions (internal) | — | Span ≥ 30; no gap > 3/5 yr; unbroken party overlap |
| **Mortgages / court** (ENC-01/04) | EC nature field | — | Keyword detection |
| **NOC ↔ mortgage** (ENC-02) | Lender NOC | EC mortgage entry | NOC discharges the charge |
| **Doc-number registry** (DOC-06) | Each deed | EC document list | All deeds traceable in EC |

---

## 6. Phase-by-phase plan

**(a) Smart Analysis pipeline** (`api/landwise/router.py:1333` `analyze_parcel` → `api/validate/handler.py` `handle_validate`):

```
Document Ingestion → EC Extraction (Gemini OCR→JSON) → Document Matching (deed↔EC)
→ Sale Deed Extraction → Hierarchy/Chain Generation → Validation (cross-checks)
→ Risk Analysis (score + flags) → Opinion Draft
```

**(b) Legal review gate** (`gatekeeper.py:20` `PHASE_ORDER`) — each phase unlocks only when prior-phase mandatory items are `clear`/`na` (`is_phase_unlocked` @103):

```
Phase 1 Documents → 2 Ownership → 3 Encumbrances → 4 Compliance → 5 Final Review → sign opinion
```

**Completion score** (`gatekeeper.py:230–336`, 20 pts/phase): Doc Ingestion (EC+deed=20/either=10) · Extraction (20×ratio) · Chain Verification (analysis+validation=20/analysis-only=10) · Risk (20/0) · Opinion (20×accepted-ratio).

**Parcel status machine** (`gatekeeper.py:23–51`): opinion locked → completed; escalated flag → flagged; all mandatory clear/na → verified; has docs → in_review; else pending.

**Opinion gating** (`gatekeeper.py:183–219`): drafting unlocks once `last_analysis_request_id` is set (or Phase 1 done); **signing** needs verdict set + all 5 sections accepted + not locked.

---

## 7. Forward plan

1. **Tier-C extraction in the pipeline** — run Patta/FMB/NRI/entity extraction in the analysis finalizer (not only on manual upload).
2. **Tier-B integrations** — connect real CRZ / forest-GIS / DTCP / eCourts / A-Register sources (cache results on the parcel to avoid per-fetch latency).
3. **Real OCR confidence** — emit per-field confidence so DOC-03 becomes automated.
4. **Scenario-driven document derivation** — `cond(matter)` model so the checklist adapts to the matter type instead of a fixed 24 items.
5. **Surface analysis errors** — the pipeline currently swallows mid-stream failures into a silent "0 matched"; make failures visible.
