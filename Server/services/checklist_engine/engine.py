"""
Checklist engine — drives the provider registry against a parcel's checklist.

run(parcel_id, db)
    For every checklist item still 'pending' and not human-verified, call its
    provider and apply the suggestion. Write rules (AI suggests, human decides):
      • decisive verdict (clear/issue/escalated/na) → set verdict + note,
        tagged '[AI-suggested]'. (A negative 'issue' keeps the phase gate closed.)
      • 'pending' → leave the verdict pending, but record the honest reason note
        (only if the item has no note yet).
      • NEVER touches an item a human already set (verdict != 'pending' or
        verified_by present). Idempotent — safe to call on every checklist fetch.

run_extractions(parcel_id, db)
    Run the expensive Tier-C Gemini extractors for whatever documents are
    present and cache their artifacts, so the (cheap) providers can read them.
    No-op for any document that isn't uploaded. Call this AFTER analysis or via
    the /parcels/{id}/aux-extract endpoint — never on the checklist hot path.
"""
PREFIX = "[AI-suggested] "


def run(parcel_id: str, db) -> int:
    """Apply provider suggestions to the parcel's checklist. Returns #items changed."""
    from common.landwise_models import Parcel, ChecklistItem
    from services.checklist_engine.context import CheckContext
    from services.checklist_engine.providers import CHECK_PROVIDERS

    parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
    if not parcel:
        return 0
    # NOTE: runs even without a completed analysis — the providers handle missing
    # EC/risk data gracefully (pending), and upload-driven checks (Patta, FMB,
    # CRZ, death/heir certs…) must work as soon as their document is uploaded.

    ctx = CheckContext(parcel, db)
    items = db.query(ChecklistItem).filter(ChecklistItem.parcel_id == parcel_id).all()
    changed = 0

    for it in items:
        if it.verdict != "pending" or it.verified_by:
            continue  # never override a human verdict
        provider = CHECK_PROVIDERS.get(it.item_code)
        if not provider:
            continue
        try:
            res = provider(ctx)
        except Exception as e:
            print(f"[checklist-engine] provider {it.item_code} failed: {e}")
            continue
        if not res:
            continue
        if res.is_decisive:
            it.verdict = res.verdict
            it.lawyer_notes = PREFIX + res.note
            # NOTE: verified_at/verified_by are left untouched — they denote HUMAN
            # sign-off. An AI suggestion is marked only by the '[AI-suggested]' note,
            # so the UI never shows an unreviewed item as human-verified.
            changed += 1
        elif res.verdict == "pending" and not it.lawyer_notes:
            it.lawyer_notes = PREFIX + res.note
            changed += 1

    if changed:
        db.commit()
    return changed


# Supporting-doc types we classify (the per-check upload targets). We do NOT
# re-classify the bulk EC/Sale-Deed/parent docs that flow through analysis.
_CLASSIFY_TYPES = {
    "PATTA", "FMB", "A_REGISTER", "CRZ_CERT", "DTCP_APPROVAL", "NOC",
    "COURT_DOC", "POA", "DEATH_CERTIFICATE", "LEGAL_HEIR", "FAMILY_TREE",
    "MUTATION", "MISC",
}


def classify_and_route(ctx) -> list:
    """
    Detect the ACTUAL type of each uploaded supporting document and re-file
    mismatches under the correct type (e.g. an EC dropped into the Patta slot is
    re-tagged to EC). Classifies each doc once (cached), only for the supporting
    types above. Returns the docs classified THIS run for UI feedback.
    """
    from services.checklist_engine.context import canon_type
    from services.checklist_engine.extractors import DocTypeClassifier

    cache = ctx.read_aux("doc_classifications") or {}
    results, cache_changed, retagged_any = [], False, False
    LABELS = DocTypeClassifier.LABELS

    for d in ctx.docs:
        tagged = canon_type(d.document_type)
        cached = cache.get(d.id)

        # Already classified → report current state (no re-classify, no re-tag).
        if cached:
            detected = cached.get("detected") or "MISC"
            results.append({
                "id": d.id, "original": d.document_type, "original_canon": tagged,
                "detected": detected, "detected_label": LABELS.get(detected, detected),
                "confidence": cached.get("confidence", "low"), "retagged": False,
                "cached": True, "evidence": cached.get("evidence", ""),
            })
            continue

        # Only classify (Gemini) the supporting-slot uploads — not the bulk EC/deed docs.
        if tagged not in _CLASSIFY_TYPES:
            continue
        path = ctx.doc_file_path(d)
        if not path:
            continue
        res = DocTypeClassifier.classify_file(path)
        if not res:
            continue
        detected = canon_type(res.get("type") or "") or "MISC"
        conf = (res.get("confidence") or "low").lower()
        evidence = (res.get("evidence") or "")[:160]
        cache[d.id] = {"detected": detected, "confidence": conf, "evidence": evidence}
        cache_changed = True

        original = d.document_type
        retagged = False
        # Re-file only when confidently a DIFFERENT, recognised type.
        if detected not in ("MISC", "OTHER", "") and detected != tagged and conf in ("high", "medium"):
            d.document_type = detected
            retagged = True
            retagged_any = True
        results.append({
            "id": d.id, "original": original, "original_canon": tagged,
            "detected": detected, "detected_label": LABELS.get(detected, detected),
            "confidence": conf, "retagged": retagged, "cached": False, "evidence": evidence,
        })

    if cache_changed:
        ctx.write_aux("doc_classifications", cache)
    if retagged_any:
        ctx.db.commit()  # persist the re-tags
    return results


def run_extractions(parcel_id: str, db) -> dict:
    """Classify uploaded docs (re-routing mismatches), then run Tier-C extractors."""
    from common.landwise_models import Parcel
    from services.checklist_engine.context import CheckContext
    from services.checklist_engine.extractors import (
        PattaExtractor, FMBExtractor, SourceTypeDetector,
        ARegisterExtractor, CRZCertExtractor, DTCPApprovalExtractor,
        DeathCertExtractor, LegalHeirExtractor,
    )

    parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
    if not parcel:
        return {"error": "parcel not found"}

    ctx = CheckContext(parcel, db)
    # 1) detect actual doc types + re-file wrong-slot uploads (before extraction)
    classifications = classify_and_route(ctx)
    # 2) run extractors against the (now-corrected) document types
    summary = {}
    for ex in (PattaExtractor, FMBExtractor, ARegisterExtractor,
               CRZCertExtractor, DTCPApprovalExtractor,
               DeathCertExtractor, LegalHeirExtractor, SourceTypeDetector):
        name = ex.__name__
        try:
            if not ex.is_available(ctx):
                summary[name] = "skipped (document not uploaded)"
                continue
            summary[name] = "ok" if ex.compute_and_cache(ctx) else "failed"
        except Exception as e:
            summary[name] = f"error: {e}"
    return {"extractions": summary, "classifications": classifications}
