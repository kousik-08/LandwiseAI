"""
Risk Score Engine for LandwiseAI.

Computes a deterministic "Title Health Score" (0-100) + A/B/C/D/F grade
from existing validated data (no new LLM call required for scoring itself).
An optional AI summary is generated via Gemini.
"""

import os
import json
import re
from typing import Optional, List, Dict, Any
from common.gemini_helper import GeminiHelper
from prompts.risk_score_prompt import RISK_SCORE_AI_SUMMARY_PROMPT, RISK_SCORE_DETAILED_PROMPT
from common.database import SessionLocal
from common.models import RiskScore


# ── Lis Pendens / Court Attachment detection keywords ────────────────────────
LIS_PENDENS_KEYWORDS = [
    "court attachment", "attachment", "injunction", "lis pendens",
    "os no", "ep no", "execution petition", "original suit",
    "வழக்கு", "கோர்ட்", "இணைப்பு", "தடை"
]

# ── Panchami / Restricted Land detection keywords ────────────────────────────
RESTRICTED_LAND_KEYWORDS = [
    "panchami", "government assigned", "assigned land", "non-alienation",
    "conditional assignment", "assignment patta", "பஞ்சமி", "ஒதுக்கீடு",
    "bhoodan", "temple land", "wakf", "hrcee", "hr&ce"
]

# ── Document natures that require extra scrutiny ─────────────────────────────
SCRUTINY_NATURES = ["partition", "settlement", "பாக", "செட்டில்மெண்ட்"]


def _flatten_hierarchy_transactions(hierarchy_data: List[Dict]) -> List[Dict]:
    """Recursively collects all transactions from a hierarchy tree."""
    txs = []
    def _traverse(nodes):
        for node in nodes:
            txs.extend(node.get("transactions", []))
            children = node.get("children", {})
            child_list = list(children.values()) if isinstance(children, dict) else children
            if child_list:
                _traverse(child_list)
    _traverse(hierarchy_data)
    return txs


def _detect_lis_pendens(transactions: List[Dict]) -> List[Dict]:
    """Returns transactions that look like court attachments / lis pendens."""
    flagged = []
    for tx in transactions:
        nature = (tx.get("nature") or tx.get("nature_of_document") or "").lower()
        if any(kw in nature for kw in LIS_PENDENS_KEYWORDS):
            flagged.append({
                "doc_no": tx.get("document_number", "N/A"),
                "nature": nature,
                "date": tx.get("date", "N/A"),
                "survey_number": tx.get("survey_number", "N/A"),
            })
    return flagged


def _detect_restricted_lands(transactions: List[Dict]) -> List[Dict]:
    """Returns transactions associated with government-restricted / Panchami lands."""
    flagged = []
    for tx in transactions:
        nature = (tx.get("nature") or tx.get("nature_of_document") or "").lower()
        prop_type = (tx.get("property_type") or tx.get("nature_of_land") or "").lower()
        combined = nature + " " + prop_type
        if any(kw in combined for kw in RESTRICTED_LAND_KEYWORDS):
            flagged.append({
                "doc_no": tx.get("document_number", "N/A"),
                "nature": nature,
                "date": tx.get("date", "N/A"),
                "survey_number": tx.get("survey_number", "N/A"),
            })
    return flagged


def _parse_year(date_str: str) -> Optional[int]:
    """Extract year from various date formats."""
    if not date_str:
        return None
    # Support DD-Mon-YYYY (e.g. 05-Apr-2022), DD/MM/YYYY, YYYY-MM-DD
    patterns = [
        r"(\d{4})$",                     # ends with YYYY
        r"(\d{4})-\d{2}-\d{2}",          # YYYY-MM-DD
        r"\d{2}/\d{2}/(\d{4})",          # DD/MM/YYYY
        r"\d{2}-\w{3}-(\d{4})",           # DD-Mon-YYYY
    ]
    for p in patterns:
        m = re.search(p, str(date_str))
        if m:
            return int(m.group(1))
    return None


def _detect_encumbrance_gaps(transactions: List[Dict], gap_threshold_years: int = 3) -> List[Dict]:
    """
    Identifies silent year gaps between consecutive transactions.
    Returns a list of gap descriptors: {start_date, end_date, gap_years}.
    """
    years = []
    for tx in transactions:
        yr = _parse_year(tx.get("date", ""))
        if yr:
            years.append(yr)

    if len(years) < 2:
        return []

    years.sort()
    gaps = []
    for i in range(len(years) - 1):
        diff = years[i + 1] - years[i]
        if diff > gap_threshold_years:
            gaps.append({
                "start_year": years[i],
                "end_year": years[i + 1],
                "gap_years": diff,
                "risk": "HIGH" if diff >= 12 else "MEDIUM"
            })
    return gaps


def _grade_from_score(score: float) -> str:
    if score >= 85: return "A"
    if score >= 70: return "B"
    if score >= 55: return "C"
    if score >= 40: return "D"
    return "F"


def _recommendation_from_grade(grade: str) -> str:
    return {
        "A": "Safe to proceed with standard due diligence.",
        "B": "Generally safe — review flagged items before finalizing.",
        "C": "Moderate risk detected — seek legal counsel before proceeding.",
        "D": "High risk — do NOT proceed without resolving all flagged issues.",
        "F": "Critical title defects found — consult a property lawyer immediately.",
    }.get(grade, "Seek legal advice.")


def _is_field_matched(status: str) -> bool:
    """
    True for any positive-match status the validator emits:
      MATCHED, MATCHED (LINKED), MATCHED (SUPPLEMENTAL),
      MATCHED (PARTIAL), MATCHED (PARTIAL/OVERLAP), MATCHED (REASONABLE).
    Critically, returns False for "NOT MATCHED" — `"MATCHED" in status`
    is a substring trap because it matches "NOT MATCHED" too.
    """
    s = (status or "").strip().upper()
    return s.startswith("MATCHED")


def _field_match_ratio(validation_result: Dict) -> float:
    """
    Returns the fraction of fields that came back MATCHED on this doc
    (any positive MATCHED status). Used for partial credit so an 8/9 deed
    that only fails on one field doesn't earn 0 trust just because `match`
    is boolean.

    Falls back to the boolean `match` flag if the validator didn't emit
    a per-field comparisons array.
    """
    if not isinstance(validation_result, dict):
        return 0.0
    comparisons = validation_result.get("comparisons") or []
    if not comparisons:
        return 1.0 if validation_result.get("match") else 0.0
    matched = sum(1 for c in comparisons if _is_field_matched(c.get("status")))
    return matched / len(comparisons)


def compute_risk_score(
    validation_results: List[Dict],
    hierarchy_data: List[Dict],
    request_id: str,
    generate_ai_summary: bool = True
) -> Dict[str, Any]:
    """
    Master scoring function.

    Scoring Model (100 points total):
    - Validation Pass Rate: 28 pts (partial credit per field-match ratio)
    - Average Trustability Score: 17 pts (scaled by field-match ratio)
    - Encumbrance Gap Penalty: -6 per gap (max -30)
    - Extra Scrutiny Documents Penalty: -7 per doc (max -25)
    - Lis Pendens / Court Attachment: -25 per hit (max -40)
    - Panchami / Restricted Land: -30 per hit (max -40)

    Base starts at 55 (so a perfectly clean parcel reaches 100).
    """
    total_docs = len(validation_results)
    passed_docs = sum(1 for r in validation_results if r.get("match"))
    failed_docs = total_docs - passed_docs

    # Per-doc field-match ratios drive both validation and trust credit.
    # This is what fixes "8/9 fields matched but the score acts like 0/9":
    # under the old all-or-nothing rule, a single critical mismatch (e.g.,
    # doc number 2714 misread as 2214) zeroed the entire deed's contribution
    # to both score_pass and score_trust, even though every other field
    # cross-verified cleanly.
    field_ratios = [_field_match_ratio(r.get("validation_result")) for r in validation_results]

    # ── 1. Validation Pass Rate (0–28) ──────────────────────────────────────
    # Empty parcel → 0.0 (was 1.0, which made empty parcels read as "100%
    # passed" and silently graded B without any actual evidence of clean
    # title — legally indefensible).
    pass_rate = (sum(field_ratios) / total_docs) if total_docs > 0 else 0.0
    score_pass = round(pass_rate * 28, 1)

    # ── 2. Average Trustability Score (0–17) ────────────────────────────────
    # Display stat: average OCR/extraction confidence across all docs
    # (regardless of pass/fail) — useful telemetry for the user.
    trust_scores_all = [
        r.get("validation_result", {}).get("trustability_score", 0)
        for r in validation_results
        if isinstance(r.get("validation_result", {}).get("trustability_score"), (int, float))
    ]
    avg_trust = (sum(trust_scores_all) / len(trust_scores_all)) if trust_scores_all else 75.0

    # Aggregate contribution to risk score: now scaled by each doc's
    # field-match ratio. A passed deed earns its full trustability; an
    # 8/9 deed earns 8/9ths of its trustability; a fully failed deed
    # still earns 0. This stays consistent with the per-document
    # breakdown shown to legal advisors while no longer punishing deeds
    # whose minor field mismatches are clearly OCR errors.
    if total_docs > 0:
        weighted_trust = 0.0
        for r, ratio in zip(validation_results, field_ratios):
            trust = r.get("validation_result", {}).get("trustability_score", 0)
            if isinstance(trust, (int, float)):
                weighted_trust += trust * ratio
        score_trust = round((weighted_trust / 100) * (17 / total_docs), 1)
    else:
        score_trust = 0.0

    # ── Collect all transactions for deeper analysis ─────────────────────────
    all_txs = _flatten_hierarchy_transactions(hierarchy_data)

    # ── 3. Encumbrance Gap Penalties ─────────────────────────────────────────
    gaps = _detect_encumbrance_gaps(all_txs, gap_threshold_years=3)
    gap_penalty = min(len(gaps) * 6, 30)  # cap at -30

    # ── 4. Extra Scrutiny Penalties ──────────────────────────────────────────
    scrutiny_docs = [
        r for r in validation_results
        if r.get("validation_result", {}).get("requires_extra_scrutiny")
    ]
    # Also detect from nature keywords in transactions
    scrutiny_natures = []
    for tx in all_txs:
        nat = (tx.get("nature") or tx.get("nature_of_document") or "").lower()
        if any(kw in nat for kw in SCRUTINY_NATURES):
            scrutiny_natures.append(tx)
    total_scrutiny_count = max(len(scrutiny_docs), len(scrutiny_natures))
    scrutiny_penalty = min(total_scrutiny_count * 7, 25)  # cap at -25

    # ── 5. Lis Pendens / Court Attachments ───────────────────────────────────
    lis_pendens_hits = _detect_lis_pendens(all_txs)
    lis_pendens_penalty = min(len(lis_pendens_hits) * 25, 40)  # cap at -40

    # ── 6. Restricted / Panchami Lands ───────────────────────────────────────
    restricted_hits = _detect_restricted_lands(all_txs)
    restricted_penalty = min(len(restricted_hits) * 30, 40)  # cap at -40

    # ── Final Score Calculation ──────────────────────────────────────────────
    # Base 55 (was 45). With score_pass_max=28 + score_trust_max=17, the
    # ceiling is now 100 (was 90), so a perfectly clean parcel can actually
    # reach a top score. The previous 90 cap silently held scores below
    # 100 even when everything passed.
    base = 55.0
    raw_score = (
        base
        + score_pass
        + score_trust
        - gap_penalty
        - scrutiny_penalty
        - lis_pendens_penalty
        - restricted_penalty
    )
    score = max(0.0, min(100.0, round(raw_score, 1)))
    grade = _grade_from_score(score)

    # ── Factor Breakdown (for frontend display) ──────────────────────────────
    # sorted() — set iteration order varies between processes when PYTHONHASHSEED
    # is randomized, which leaks into the AI prompt and downstream cache keys.
    nature_types = sorted({
        (tx.get("nature") or tx.get("nature_of_document") or "Unknown").title()
        for tx in all_txs
        if tx.get("nature") or tx.get("nature_of_document")
    })

    factors = [
        {
            "label": "Document Validation Pass Rate",
            "contribution": score_pass,
            "max": 28,
            "polarity": "positive",
            "detail": f"{passed_docs}/{total_docs} documents passed validation",
            "value_display": f"{round(pass_rate * 100)}%"
        },
        {
            "label": "Average Trustability Score",
            "contribution": score_trust,
            "max": 17,
            "polarity": "positive",
            "detail": f"Trust credit on {passed_docs} validated deed(s) only — failed docs earn 0",
            "value_display": f"{round(avg_trust)}/100"
        },
        {
            "label": "Encumbrance Gap Penalty",
            "contribution": -gap_penalty,
            "max": 30,
            "polarity": "negative",
            "detail": f"{len(gaps)} silent period(s) detected (>3 year gaps in EC chain)",
            "value_display": f"{len(gaps)} gaps"
        },
        {
            "label": "Extra Scrutiny Documents",
            "contribution": -scrutiny_penalty,
            "max": 25,
            "polarity": "negative",
            "detail": f"{total_scrutiny_count} partition/settlement deed(s) requiring legal heir verification",
            "value_display": f"{total_scrutiny_count} docs"
        },
        {
            "label": "Lis Pendens / Court Attachments",
            "contribution": -lis_pendens_penalty,
            "max": 40,
            "polarity": "negative",
            "detail": f"{len(lis_pendens_hits)} court attachment/lis pendens entry(ies) in EC",
            "value_display": f"{len(lis_pendens_hits)} found"
        },
        {
            "label": "Panchami / Restricted Land",
            "contribution": -restricted_penalty,
            "max": 40,
            "polarity": "negative",
            "detail": f"{len(restricted_hits)} restricted land entry(ies) detected",
            "value_display": f"{len(restricted_hits)} found"
        },
    ]

    # ── AI Summary Generation (optional) ────────────────────────────────────
    ai_summary = None
    if generate_ai_summary:
        try:
            gemini = GeminiHelper(model_id="gemini-3.5-flash")
            prompt = RISK_SCORE_AI_SUMMARY_PROMPT.format(
                total_docs=total_docs,
                passed_docs=passed_docs,
                failed_docs=failed_docs,
                avg_trust=round(avg_trust, 1),
                scrutiny_docs=total_scrutiny_count,
                lis_pendens=len(lis_pendens_hits),
                restricted_land=len(restricted_hits),
                gap_count=len(gaps),
                nature_types=", ".join(nature_types[:10]) if nature_types else "N/A",
                score=score,
                grade=grade,
            )
            ai_summary = gemini.generate_from_text("", prompt)
        except Exception as e:
            print(f"[!] AI summary generation failed (non-critical): {e}")
            ai_summary = None

    if not ai_summary:
        ai_summary = _recommendation_from_grade(grade)

    # ── Build Document-Level Details for Detailed View ──────────────────────
    # Calculate per-document contributions (28 pts max divided proportionally)
    points_per_doc = 28 / total_docs if total_docs > 0 else 0
    trust_points_per_doc = 17 / total_docs if total_docs > 0 else 0
    
    document_details = []
    
    # If validation results exist, use them for detailed breakdown
    if validation_results:
        for r in validation_results:
            doc_no = r.get("document_number", "N/A")
            nature = r.get("nature", "Unknown")
            match = r.get("match", False)
            trust = r.get("validation_result", {}).get("trustability_score", 0)
            scrutiny = r.get("validation_result", {}).get("requires_extra_scrutiny", False)
            scrutiny_reason = r.get("validation_result", {}).get("scrutiny_reason", "")
            mismatch_reason = r.get("validation_result", {}).get("mismatch_reason", "")
            
            # Calculate this document's contribution to the score.
            # Both validation and trust points are now scaled by the
            # field-match ratio (e.g., 8/9 matched → 8/9 of the credit
            # the deed would earn if it had passed cleanly). A fully
            # failed deed (0 fields matched) still earns 0; a perfect
            # deed earns full points.
            field_ratio = _field_match_ratio(r.get("validation_result"))
            doc_validation_points = round(points_per_doc * field_ratio, 1)
            doc_trust_points = round(
                trust_points_per_doc * (trust / 100) * field_ratio, 1
            )

            # Penalties per document
            doc_penalty = 0
            if scrutiny:
                doc_penalty -= 7  # Per scrutiny document

            # Extract specific mismatches from the validator's per-field
            # comparisons array. The previous version read a
            # `field_mismatches` dict that the validator never emits —
            # dead code. The comparisons array (Document Number / Date /
            # Executant Name / etc.) is the real source.
            mismatches = []
            if not match:
                if mismatch_reason:
                    mismatches.append(mismatch_reason)
                comparisons = r.get("validation_result", {}).get("comparisons") or []
                for c in comparisons:
                    if _is_field_matched(c.get("status")):
                        continue
                    field = c.get("field", "Unknown field")
                    reason = (c.get("reason") or "").strip()
                    ec_val = (c.get("ec_value") or "").strip()
                    md_val = (c.get("metadata_value") or "").strip()
                    detail_parts = []
                    if reason:
                        detail_parts.append(reason)
                    if ec_val and md_val:
                        detail_parts.append(f"EC='{ec_val}' vs Deed='{md_val}'")
                    detail = " — ".join(detail_parts) if detail_parts else "mismatch"
                    mismatches.append(f"{field}: {detail}")

            # Build trustability breakdown. Now exposes the field-match
            # ratio so the user can see WHY an 8/9 deed earns partial
            # credit instead of zero.
            comparisons_count = len(r.get("validation_result", {}).get("comparisons") or [])
            matched_count = round(field_ratio * comparisons_count) if comparisons_count else int(match)
            ratio_pct = round(field_ratio * 100)
            if comparisons_count:
                trust_calc = (
                    f"({trust}/100) × {round(trust_points_per_doc, 1)} pts × "
                    f"{matched_count}/{comparisons_count} fields matched "
                    f"({ratio_pct}%) = {doc_trust_points} pts"
                )
            elif match:
                trust_calc = f"({trust}/100) × {round(trust_points_per_doc, 1)} pts = {doc_trust_points} pts"
            else:
                trust_calc = f"No comparisons emitted by validator (raw OCR score: {trust})"
            trust_breakdown = {
                "raw_score": trust,
                "max_possible": 100,
                "points_earned": doc_trust_points,
                "field_match_ratio": round(field_ratio, 3),
                "fields_matched": matched_count,
                "fields_total": comparisons_count,
                "calculation": trust_calc,
            }
            
            document_details.append({
                "doc_no": doc_no,
                "nature": nature,
                "match": match,
                "trustability_score": trust,
                "trustability_breakdown": trust_breakdown,
                "validation_points": doc_validation_points,
                "total_doc_contribution": round(doc_validation_points + doc_trust_points + doc_penalty, 1),
                "requires_scrutiny": scrutiny,
                "scrutiny_penalty": -7 if scrutiny else 0,
                "scrutiny_reason": scrutiny_reason,
                "mismatches": mismatches,
                "status": "PASS" if match and not scrutiny else ("SCRUTINY" if scrutiny else "FAIL")
            })
    else:
        # Fallback: build from hierarchy transactions when validation results are empty
        for tx in all_txs:
            doc_no = tx.get("document_number", "N/A")
            nature = tx.get("nature", "Unknown")
            
            # Check for flags in this transaction
            combined = f"{nature} {tx.get('description', '')}".lower()
            is_restricted = any(kw in combined for kw in RESTRICTED_LAND_KEYWORDS)
            is_lis_pendens = any(kw in combined for kw in LIS_PENDENS_KEYWORDS)
            is_scrutiny = any(n in nature.lower() for n in SCRUTINY_NATURES)
            
            status = "PASS"
            if is_lis_pendens or is_restricted:
                status = "FAIL"
            elif is_scrutiny:
                status = "SCRUTINY"
            
            # Default trustability for hierarchy-only docs
            trust = 75.0 if status == "PASS" else 40.0
            
            document_details.append({
                "doc_no": doc_no,
                "nature": nature,
                "match": status == "PASS",
                "trustability_score": trust,
                "trustability_breakdown": {
                    "raw_score": trust,
                    "max_possible": 100,
                    "points_earned": 0,
                    "calculation": "Validation not run - estimated from hierarchy"
                },
                "validation_points": 0,
                "total_doc_contribution": 0,
                "requires_scrutiny": is_scrutiny,
                "scrutiny_penalty": -7 if is_scrutiny else 0,
                "scrutiny_reason": "Partition/Settlement deed (requires heir verification)" if is_scrutiny else "",
                "mismatches": [],
                "status": status
            })
    
    # Sort by trustability score (lowest first = most concerning)
    document_details.sort(key=lambda x: (x["match"], x["trustability_score"]))
    
    # Build gap details with document references
    gap_details = []
    for gap in gaps:
        # Find documents around this gap
        start_yr = gap["start_year"]
        end_yr = gap["end_year"]
        gap_docs = []
        for tx in all_txs:
            tx_yr = _parse_year(tx.get("date", ""))
            if tx_yr and (abs(tx_yr - start_yr) <= 1 or abs(tx_yr - end_yr) <= 1):
                gap_docs.append(tx.get("document_number", "N/A"))
        gap_details.append({
            **gap,
            "adjacent_documents": gap_docs[:3]  # Limit to 3
        })
    
    return {
        "score": score,
        "grade": grade,
        "recommendation": _recommendation_from_grade(grade),
        "ai_summary": ai_summary,
        "ai_detailed_summary": None,  # Will be populated if detailed analysis requested
        "factors": factors,
        "metadata": {
            "total_docs": total_docs,
            "passed_docs": passed_docs,
            "failed_docs": failed_docs,
            "avg_trustability": round(avg_trust, 1),
            "scrutiny_doc_count": total_scrutiny_count,
            "lis_pendens_count": len(lis_pendens_hits),
            "restricted_land_count": len(restricted_hits),
            "gap_count": len(gaps),
            "nature_types": nature_types,
        },
        "flags": {
            "lis_pendens": lis_pendens_hits,
            "restricted_lands": restricted_hits,
            "encumbrance_gaps": gaps,
            "scrutiny_docs": [
                {
                    "doc_no": r.get("document_number"),
                    "reason": r.get("validation_result", {}).get("scrutiny_reason", "Partition/Settlement deed")
                }
                for r in scrutiny_docs
            ],
        },
        "document_details": document_details,
        "gap_details": gap_details,
        "request_id": request_id,
    }


async def handle_get_risk_score(request_id: str, force: bool = False) -> Dict[str, Any]:
    """
    Main handler for /api/v1/get-risk-score/{request_id}.

    Read path (cheap, no LLM):
      1. parcels.risk_score_data — JSONB cache of the previously computed
         result, keyed by last_analysis_request_id.
      2. outputs/validate/<request_id>/risk_score.json — file fallback if
         the parcel row hasn't been migrated yet or this is a legacy
         (non-Landwise) request.

    Compute path (only when no cached row, no cached file, or force=True):
      Reads results.json + hierarchy_tree.json, calls compute_risk_score
      (which makes the Gemini summary call), then persists to DB and file.
    """
    from fastapi import HTTPException
    from common.landwise_models import Parcel
    from common.storage_sync import read_json, write_json

    # Canonical S3 key prefix for this run's artifacts.
    s3_prefix = f"outputs/validate/{request_id}"
    risk_key = f"{s3_prefix}/risk_score.json"

    # ── 1. DB cache lookup (Landwise parcel row) ─────────────────────────
    if not force:
        db = SessionLocal()
        try:
            parcel = (
                db.query(Parcel)
                .filter(Parcel.last_analysis_request_id == request_id)
                .first()
            )
            if parcel and parcel.risk_score_data:
                print(f"[~] Risk score cache hit (DB) for request {request_id}")
                return {"status": "success", "data": parcel.risk_score_data, "cached": "db"}
        except Exception as e:
            print(f"[!] DB cache lookup failed (non-fatal): {e}")
        finally:
            db.close()

        # ── 2. Storage cache fallback ─────────────────────────────────────
        cached = read_json(risk_key, default=None)
        if cached is not None:
            print(f"[~] Risk score cache hit (storage) for request {request_id}")
            return {"status": "success", "data": cached, "cached": "storage"}

    # ── 3. Compute path (LLM call) — read inputs straight from storage ──
    validation_results = read_json(f"{s3_prefix}/results.json", default=None) or []

    # Fallback: nested "results" in final_result.json
    if not validation_results:
        final_data = read_json(f"{s3_prefix}/final_result.json", default=None)
        if isinstance(final_data, dict):
            validation_results = final_data.get("results", []) or []

    # Load hierarchy data
    hierarchy_data = read_json(f"{s3_prefix}/hierarchy_tree.json", default=None) or []

    if not validation_results and not hierarchy_data:
        raise HTTPException(
            status_code=404,
            detail="No validation or hierarchy data found for this request. Please complete validation first."
        )

    print(f"[*] Computing risk score (LLM call) for request {request_id}")
    result = compute_risk_score(
        validation_results=validation_results,
        hierarchy_data=hierarchy_data,
        request_id=request_id,
        generate_ai_summary=True
    )

    # ── 4. Persist to DB (full JSON + summary stats) ─────────────────────
    db = SessionLocal()
    try:
        from datetime import datetime, timezone
        parcel = (
            db.query(Parcel)
            .filter(Parcel.last_analysis_request_id == request_id)
            .first()
        )
        if parcel:
            meta = result.get("metadata", {})
            parcel.risk_score = int(result.get("score", 0))
            parcel.total_docs_count = meta.get("total_docs", 0)
            parcel.passed_docs_count = meta.get("passed_docs", 0)
            parcel.avg_trustability_score = meta.get("avg_trustability", 0)
            parcel.scrutiny_docs_count = meta.get("scrutiny_doc_count", 0)
            # Full computed result so subsequent GETs skip the LLM call.
            parcel.risk_score_data = result
            parcel.risk_score_computed_at = datetime.now(timezone.utc)
            db.add(parcel)
            print(f"[+] Cached full risk score on parcel for request {request_id}")

        # Legacy RiskScore table (best-effort, skipped if FK fails for Landwise requests)
        try:
            existing = db.query(RiskScore).filter(RiskScore.request_id == request_id).first()
            if existing:
                existing.score = result.get("score")
                existing.grade = result.get("grade")
                existing.recommendation = result.get("recommendation")
                existing.ai_summary = result.get("ai_summary")
                existing.factors = result.get("factors")
                existing.metadata_json = result.get("metadata")
                existing.flags = result.get("flags")
                db.add(existing)
            else:
                risk_obj = RiskScore(
                    request_id=request_id,
                    score=result.get("score"),
                    grade=result.get("grade"),
                    recommendation=result.get("recommendation"),
                    ai_summary=result.get("ai_summary"),
                    factors=result.get("factors"),
                    metadata_json=result.get("metadata"),
                    flags=result.get("flags")
                )
                db.add(risk_obj)
            print(f"[+] Persisted risk score to legacy table for request {request_id}")
        except Exception as risk_e:
            # FK constraint may fail for Landwise workflow - this is expected, don't rollback parcel update
            print(f"[*] Skipped legacy risk_scores table (expected for Landwise workflow): {risk_e}")

        db.commit()
    except Exception as e:
        db.rollback()
        print(f"[!] Failed to persist risk score or parcel stats to DB: {e}")
    finally:
        db.close()

    # ── 5. Storage cache (fallback for environments without DB row) ──────
    try:
        write_json(risk_key, result)
    except Exception as e:
        print(f"[!] Failed to cache risk score to storage: {e}")

    return {"status": "success", "data": result, "cached": "fresh"}
