"""
Per-check providers — one function per checklist item code → CheckResult.

Each provider is PURE and CHEAP: it reads only the CheckContext (persisted
analysis + uploaded-doc presence + cached extractor artifacts + env-gated
external sources). It never calls Gemini or makes a blocking HTTP request on
the checklist hot path. When the input it needs isn't there, it returns
pending(...) with an honest reason — never a fabricated pass.

CHECK_PROVIDERS maps the 24 checklist item codes to these functions.
"""
from services.checklist_engine.results import CheckResult as R
from services.checklist_engine.extractors import (
    NRIDetector, EntityTypeDetector, OCRConfidenceAdapter,
    PattaExtractor, FMBExtractor, SourceTypeDetector,
    ARegisterExtractor, CRZCertExtractor, DTCPApprovalExtractor,
    DeathCertExtractor, LegalHeirExtractor,
)
from services.checklist_engine.external_sources import (
    CRZSource, ForestSource, DTCPSource, ECourtsSource, ARegisterSource,
)


def _name_match(a: str, names) -> bool:
    a = (a or "").lower().strip()
    if not a:
        return False
    toks_a = {t for t in a.replace(".", " ").split() if len(t) > 2}
    for n in names:
        n = (n or "").lower().strip()
        toks_n = {t for t in n.replace(".", " ").split() if len(t) > 2}
        if a == n or (toks_a and toks_n and len(toks_a & toks_n) >= max(1, min(len(toks_a), len(toks_n)) // 2)):
            return True
    return False


# ──────────────────────────── PHASE 1: DOCUMENTS ────────────────────────────

def doc_01(ctx):
    """All required document types uploaded (EC, Patta, Sale Deeds)."""
    has_ec = ctx.has_doc_type("EC")
    has_deed = ctx.has_doc_type("SALE_DEED")
    has_patta = ctx.has_doc_type("PATTA")
    if not (has_ec and has_deed):
        miss = ", ".join(x for x, ok in (("EC", has_ec), ("Sale Deed", has_deed)) if not ok)
        return R.issue(f"Missing required type(s): {miss}.")
    if not has_patta:
        return R.issue("EC + Sale Deed present; Patta not uploaded.")
    return R.clear("EC, Sale Deed and Patta all uploaded.")


def doc_02(ctx):
    """EC covers minimum 30-year period."""
    span = ctx.ec_span()
    if not span:
        return R.pending("No EC dates extracted to measure the 30-year span.")
    if span >= 30:
        return R.clear(f"EC spans {span} years (>= 30).")
    return R.issue(f"EC spans only {span} years (< 30-year requirement).")


def doc_03(ctx):
    """All documents legible (OCR confidence >= 70%)."""
    if not OCRConfidenceAdapter.is_available(ctx):
        return R.pending("Per-document OCR confidence not produced yet — activates when extraction emits extraction_confidence.")
    ev = OCRConfidenceAdapter.evaluate(ctx)
    if ev is None:
        return R.pending("OCR confidence data unavailable to evaluate.")
    if ev["min"] >= ev["threshold"]:
        return R.clear(f"All {ev['count']} document(s) OCR confidence >= {ev['threshold']}% (min {ev['min']:.0f}%).")
    return R.issue(f"Lowest OCR confidence {ev['min']:.0f}% < {ev['threshold']}%.")


def doc_04(ctx):
    """Document source verified (original/certified copy)."""
    data = SourceTypeDetector.cached(ctx)
    if data is None:
        if not SourceTypeDetector.is_available(ctx):
            return R.pending("No documents available to verify source on.")
        return R.pending("Original/certified detection not run yet — trigger aux extraction (POST /parcels/{id}/aux-extract).")
    bad = [d for d in data.get("docs", []) if d.get("source") in ("photocopy", "unknown", None)]
    if not bad:
        return R.clear("All documents are original or certified copies.")
    return R.issue(f"{len(bad)} document(s) not confirmed original/certified.")


def doc_05(ctx):
    """Year coverage continuous (no gaps in EC) — uses 3-yr threshold."""
    if not ctx.ec:
        return R.pending("No EC data to check year continuity.")
    g = ctx.gaps(3)
    if not g:
        return R.clear("EC year-coverage continuous (no gap > 3 yrs).")
    largest = max(x.get("gap_years", 0) for x in g)
    return R.issue(f"{len(g)} gap(s) in EC coverage; largest {largest} yrs.")


def doc_06(ctx):
    """Sale Deed registration numbers verified against EC entries."""
    dd = ctx.document_details()
    if not dd:
        return R.pending("Run analysis to cross-check deed registration numbers against EC.")
    fails = [d for d in dd if d.get("match") is False]
    if not fails:
        return R.clear(f"All {len(dd)} deed registration number(s) matched EC entries.")
    return R.issue(f"{len(fails)} deed(s) did not match EC document numbers.")


def doc_07(ctx):
    """Power of Attorney present (if NRI owner detected)."""
    nri = NRIDetector.detect(ctx) if NRIDetector.is_available(ctx) else {"nri": None}
    if nri["nri"] is None:
        return R.pending("NRI status indeterminate (no EC parties) — manual review.")
    if nri["nri"] is False:
        return R.na("No NRI owner detected — PoA not required.")
    if ctx.has_doc_type("POA"):
        return R.clear("NRI owner detected and Power of Attorney is on file.")
    return R.issue("NRI owner detected but no Power of Attorney uploaded.")


# ──────────────────────────── PHASE 2: OWNERSHIP ────────────────────────────

def own_01(ctx):
    """
    Patta/Chitta cross-validated against the EC for the parcel's survey:
      • survey  — the Patta's survey number(s) include the parcel survey (e.g. 63/2)
      • holder  — the Patta holder matches the current owner of THAT survey's chain
      • extent  — the Patta extent matches the EC extent for that survey
    Reports every dimension; any failure → issue.
    """
    patta = PattaExtractor.cached(ctx)
    if patta is None:
        if not PattaExtractor.is_available(ctx):
            return R.pending("Requires a Patta upload to cross-check against the EC/deed.")
        return R.pending("Patta uploaded but not extracted yet — trigger aux extraction.")

    target = ctx.parcel_survey()
    if not target:
        return R.pending("Parcel survey number not set — run Smart Analysis (or set the survey) to cross-check the Patta.")

    ok, bad = [], []
    # 1) survey number
    p_surveys = [str(s) for s in (patta.get("survey_numbers") or [])]
    sm = ctx.survey_in(p_surveys, target)
    if sm is True:
        ok.append(f"survey {target}")
    elif sm is False:
        bad.append(f"survey mismatch (Patta: {', '.join(p_surveys) or '—'} vs parcel {target})")

    # 2) holder vs the current owner of THIS survey's chain
    holders = patta.get("holder_names") or []
    if not holders:
        return R.pending("Patta uploaded but the holder name could not be read — check the scan quality.")
    owners = ctx.current_owner_for_survey(target) or ctx.current_owner_names()
    if not owners:
        return R.pending(f"Patta holder ({'; '.join(holders)}) read — run Smart Analysis to cross-check against the owner of survey {target}.")
    holder_ok = any(_name_match(h, owners) for h in holders)
    if holder_ok:
        ok.append("holder")
    else:
        bad.append(f"holder mismatch (Patta: {'; '.join(holders)} vs owner: {', '.join(owners)})")

    # 3) extent
    em = ctx.extent_match(patta.get("total_extent"), ctx.ec_extent_for_survey(target))
    if em is True:
        ok.append("extent")
    elif em is False:
        bad.append(f"extent mismatch (Patta: {patta.get('total_extent')} vs EC: {ctx.ec_extent_for_survey(target)})")

    if bad:
        return R.issue("Patta cross-check failed — " + "; ".join(bad) + ".")
    # Honest clear: holder must match AND at least one of survey/extent must be
    # positively confirmed — never holder-alone when survey & extent are unknown.
    if holder_ok and (sm is True or em is True):
        return R.clear(f"Patta verified against EC for {target}: {', '.join(ok)} matched.")
    return R.pending(
        f"Patta holder matches the owner, but its survey number/extent could not be cross-checked against survey {target} "
        f"— confirm the Patta states survey {target} and its extent.")


def own_02(ctx):
    """Ownership chain unbroken for 30 years."""
    span = ctx.ec_span()
    if not span:
        return R.pending("No EC dates to assess a 30-year unbroken chain.")
    g5 = ctx.gaps(5)
    if span >= 30 and not g5:
        return R.clear(f"Chain covers {span} yrs with no gap > 5 yrs.")
    reasons = []
    if span < 30:
        reasons.append(f"span {span} yrs < 30")
    if g5:
        reasons.append(f"{len(g5)} gap(s) > 5 yrs")
    return R.issue("Chain not confirmed unbroken for 30 yrs: " + "; ".join(reasons) + ".")


def own_03(ctx):
    """No ownership gap exceeding 5 years."""
    if not ctx.ec:
        return R.pending("No EC data to check ownership gaps.")
    g = ctx.gaps(5)
    if not g:
        return R.clear("No ownership gap > 5 yrs.")
    largest = max(x.get("gap_years", 0) for x in g)
    return R.issue(f"{len(g)} gap(s) > 5 yrs; largest {largest} yrs.")


def own_04(ctx):
    """HUF/Company ownership documentation adequate."""
    ent = EntityTypeDetector.detect(ctx) if EntityTypeDetector.is_available(ctx) else {"type": "unknown"}
    t = ent.get("type")
    if t == "individual":
        return R.na("Owner is an individual — entity documentation not applicable.")
    if t == "unknown":
        return R.pending("Owner entity type indeterminate — manual review.")
    return R.pending(f"Owner appears to be a {t.upper()} — constitution/board-resolution/authorisation docs require manual verification.")


def own_05(ctx):
    """NRI compliance verified (FEMA/RBI regulations)."""
    nri = NRIDetector.detect(ctx) if NRIDetector.is_available(ctx) else {"nri": None}
    if nri["nri"] is None:
        return R.pending("NRI status indeterminate — manual review.")
    if nri["nri"] is False:
        return R.na("No NRI owner detected — FEMA/RBI compliance not applicable.")
    return R.pending("NRI owner detected — FEMA/RBI compliance requires manual verification (not automated).")


def own_06(ctx):
    """Death Certificate verifies the title-holder is deceased (succession matters)."""
    if not ctx.is_inheritance_matter():
        return R.na("Not an inheritance matter — Death Certificate not required.")
    dc = DeathCertExtractor.cached(ctx)
    if dc is None:
        if not DeathCertExtractor.is_available(ctx):
            return R.pending("Inheritance matter — upload the Death Certificate of the title-holder.")
        return R.pending("Death Certificate uploaded but not extracted yet — trigger aux extraction.")
    deceased = (dc.get("deceased_name") or "").strip()
    if not deceased:
        return R.pending("Could not read the deceased's name from the Death Certificate.")
    chain = ctx.chain_party_names()
    if not chain:
        return R.pending(f"Death of '{deceased}' recorded; no EC parties to cross-check against.")
    if _name_match(deceased, chain):
        return R.clear(f"Death Certificate confirms title-holder '{deceased}' is deceased.")
    return R.issue(f"Deceased '{deceased}' is not found in the property's title chain — confirm it is the correct title-holder.")


def own_07(ctx):
    """Legal Heir Certificate — the current seller must be among the listed heirs."""
    if not ctx.is_inheritance_matter():
        return R.na("Not an inheritance matter — Legal Heir Certificate not required.")
    lh = LegalHeirExtractor.cached(ctx)
    if lh is None:
        if not LegalHeirExtractor.is_available(ctx):
            return R.pending("Inheritance matter — upload the Legal Heir Certificate.")
        return R.pending("Legal Heir Certificate uploaded but not extracted yet — trigger aux extraction.")
    heirs = [(h.get("name") if isinstance(h, dict) else str(h)) for h in (lh.get("heirs") or [])]
    heirs = [h for h in heirs if h]
    if not heirs:
        return R.pending("Could not read the heir list from the Legal Heir Certificate.")
    owners = ctx.current_owner_names()
    if not owners:
        return R.pending(f"{len(heirs)} heir(s) listed; could not resolve the current seller to cross-check.")
    if any(_name_match(o, heirs) for o in owners):
        note = f" {len(heirs)} heir(s) on record — confirm all co-heirs consent to the sale." if len(heirs) > 1 else ""
        return R.clear(f"Seller is a listed legal heir.{note}")
    return R.issue(f"Current seller ({', '.join(owners)}) is NOT among the {len(heirs)} listed legal heir(s) — undisclosed-heir / wrong-executant risk.")


def own_08(ctx):
    """Patta mutated into the heir(s)' name before sale (succession matters)."""
    if not ctx.is_inheritance_matter():
        return R.na("Not an inheritance matter — heir mutation not required.")
    if ctx.has_doc_type("MUTATION") or ctx.has_doc_type("PATTA"):
        return R.pending("Confirm the Patta has been mutated to the heir(s) before sale (manual check).")
    return R.issue("No mutation / Patta evidence that the heir(s) hold the revenue title — heirs must mutate the Patta before selling.")


# ─────────────────────────── PHASE 3: ENCUMBRANCES ──────────────────────────

def enc_01(ctx):
    """All mortgages identified from EC entries."""
    if not ctx.ec:
        return R.pending("No EC data to identify mortgages.")
    m = ctx.mortgages()
    if m:
        return R.clear(f"{len(m)} mortgage/charge entr{'y' if len(m) == 1 else 'ies'} identified from EC.")
    return R.clear("No mortgage entries found in EC.")


def enc_02(ctx):
    """Active mortgages have NOC obtained from lender."""
    if not ctx.ec:
        return R.pending("No EC data to assess mortgages/NOC.")
    m = ctx.mortgages()
    if not m:
        return R.na("No mortgages found — lender NOC not applicable.")
    if ctx.has_doc_type("NOC"):
        return R.pending(f"{len(m)} mortgage(s) and an NOC document is uploaded — confirm it discharges each lien (manual).")
    return R.issue(f"{len(m)} mortgage(s) found; no lender NOC uploaded.")


def enc_03(ctx):
    """All liens and attachments confirmed discharged."""
    if not ctx.ec:
        return R.pending("No EC data to assess liens/attachments.")
    liened = [tx for tx in ctx.ec if any(k in (tx.get("nature_of_document") or tx.get("nature") or "").lower()
                                          for k in ("attachment", "lien", "charge"))]
    if not liened:
        return R.na("No liens or attachments recorded in EC.")
    return R.pending(f"{len(liened)} lien/attachment entr{'y' if len(liened) == 1 else 'ies'} found — release/discharge must be confirmed against release deeds (manual).")


def enc_04(ctx):
    """No court orders blocking property transfer."""
    lp = ctx.lis_pendens()
    if lp:
        return R.issue(f"{len(lp)} court / lis-pendens entr{'y' if len(lp) == 1 else 'ies'} found — review before transfer.")
    # optional augmentation via eCourts when configured
    if ECourtsSource.is_configured():
        res = ECourtsSource.lookup(survey_no=ctx.primary_survey(), names=ctx.current_owner_names())
        if res and res.get("cases"):
            return R.issue(f"{len(res['cases'])} pending court case(s) found via eCourts.")
    if not ctx.ec and not ctx.risk:
        return R.pending("No EC/risk data to check court orders.")
    return R.clear("No court orders / attachments found in EC.")


def enc_05(ctx):
    """Easement rights documented and acceptable."""
    if not ctx.ec:
        return R.pending("No EC data to check easements.")
    eas = ctx.easements()
    if not eas:
        return R.na("No easements recorded in EC.")
    return R.pending(f"{len(eas)} easement(s) recorded — acceptability is a human judgment.")


# ──────────────────────────── PHASE 4: COMPLIANCE ───────────────────────────

def cmp_01(ctx):
    """No forest or wetland classification on survey number.

    Source precedence: the revenue 'A-Register' classification is authoritative,
    so it is consulted first; the forest/wetland GIS layer is a fallback only when
    A-Register is not configured. At most ONE external call is made per evaluation.
    """
    sn = ctx.primary_survey()
    # 1) uploaded A-Register extract (AI-suggested, human confirms)
    ar = ARegisterExtractor.cached(ctx)
    if ar is not None:
        target = ctx.parcel_survey()
        sm = ctx.survey_in([str(s) for s in (ar.get("survey_numbers") or [])], target)
        if sm is False:
            return R.issue(f"A-Register is for survey {ar.get('survey_numbers')}, not the parcel survey {target}.")
        cls = ar.get("classification") or "(unspecified)"
        restricted = ar.get("is_restricted")
        if restricted is None:
            restricted = any(k in str(cls).lower() for k in ("poramboke", "tharisu", "forest", "wetland", "reserved"))
        # A restricted classification is a red flag regardless of survey confirmation.
        if restricted:
            return R.issue(f"A-Register classification '{cls}' is restricted.")
        if sm is None:
            return R.pending(f"A-Register classification '{cls}' is not restricted, but its survey could not be matched to {target} — confirm it is for this parcel.")
        return R.clear(f"A-Register classification '{cls}' is not forest/wetland (survey {target} ✓).")
    # 2) configured external source
    if ARegisterSource.is_configured():
        r = ARegisterSource.lookup(survey_no=sn)
        if r is None:
            return R.pending("A-Register source returned no data for this survey.")
        cls = (r.get("classification") or "").lower()
        if any(k in cls for k in ("poramboke", "tharisu", "forest", "wetland", "reserved")):
            return R.issue(f"A-Register classification '{r.get('classification')}' is restricted.")
        return R.clear(f"A-Register classification '{r.get('classification')}' is not forest/wetland.")
    if ForestSource.is_configured():
        r = ForestSource.lookup(survey_no=sn)
        if r is None:
            return R.pending("Forest-GIS source returned no data for this survey.")
        return R.issue("Survey falls within a forest/wetland layer.") if r.get("is_forest") else R.clear("Survey not in forest/wetland layer.")
    # 3) nothing connected
    if ARegisterExtractor.is_available(ctx):
        return R.pending("A-Register uploaded but not extracted yet — trigger aux extraction.")
    return R.pending("Upload an A-Register/Adangal extract, or connect AREGISTER_API_URL / FOREST_DATA_URL.")


def cmp_02(ctx):
    """Not in Coastal Regulation Zone (CRZ)."""
    # 1) uploaded CRZ certificate (AI-suggested, human confirms)
    cz = CRZCertExtractor.cached(ctx)
    if cz is not None:
        if cz.get("in_crz") is True:
            return R.issue(f"CRZ certificate indicates the land is WITHIN CRZ ({cz.get('zone') or 'zone unspecified'}).")
        if cz.get("in_crz") is False:
            return R.clear("CRZ certificate indicates the land is outside CRZ.")
        return R.pending("CRZ certificate uploaded but CRZ status unclear — manual review.")
    # 2) configured external source
    if CRZSource.is_configured():
        r = CRZSource.lookup(survey_no=ctx.primary_survey())
        if r is None:
            return R.pending("CRZ source returned no data for this survey.")
        return R.issue(f"Within CRZ ({r.get('zone') or 'zone unspecified'}).") if r.get("in_crz") else R.clear("Outside CRZ.")
    # 3) nothing connected
    if CRZCertExtractor.is_available(ctx):
        return R.pending("CRZ certificate uploaded but not extracted yet — trigger aux extraction.")
    return R.pending("Upload a CRZ certificate, or connect CRZ_DATA_URL.")


def cmp_03(ctx):
    """Land use conversion approved (DTCP/CMDA, if applicable)."""
    # 1) uploaded DTCP/CMDA approval (AI-suggested, human confirms)
    dt = DTCPApprovalExtractor.cached(ctx)
    if dt is not None:
        if dt.get("approved") is True:
            return R.clear(f"DTCP/CMDA approval on file ({dt.get('approval_no') or dt.get('authority') or 'approved'}).")
        if dt.get("approved") is False:
            return R.issue("Uploaded DTCP/CMDA document shows no valid layout approval.")
        return R.pending("DTCP/CMDA document uploaded but approval status unclear — manual review.")
    # 2) configured external source
    if DTCPSource.is_configured():
        r = DTCPSource.lookup(survey_no=ctx.primary_survey())
        if r is None:
            return R.pending("DTCP/CMDA source returned no data.")
        return R.clear(f"Layout has DTCP/CMDA approval ({r.get('approval_no') or 'approved'}).") if r.get("approved") else R.issue("No DTCP/CMDA layout approval found.")
    # 3) nothing connected
    if DTCPApprovalExtractor.is_available(ctx):
        return R.pending("DTCP/CMDA document uploaded but not extracted yet — trigger aux extraction.")
    return R.pending("Upload a DTCP/CMDA approval, or connect DTCP_API_URL.")


def cmp_04(ctx):
    """Revenue records match survey plan / FMB sketch."""
    fmb = FMBExtractor.cached(ctx)
    if fmb is None:
        if not FMBExtractor.is_available(ctx):
            return R.pending("Requires an FMB / survey-sketch upload to match boundaries.")
        return R.pending("FMB uploaded but not extracted yet — trigger aux extraction.")
    sn = str(ctx.primary_survey() or "").strip()
    if not sn:
        return R.pending("Parcel survey number not available — run Smart Analysis to cross-check the FMB.")
    fmb_surveys = [str(s).strip() for s in (fmb.get("survey_numbers") or [])]
    if not fmb_surveys:
        return R.pending("FMB uploaded but its survey number could not be read — check the scan quality.")

    from services.checklist_engine.context import _survey_base
    if not any(s == sn or _survey_base(s) == _survey_base(sn) for s in fmb_surveys):
        return R.issue(f"FMB survey number(s) {fmb_surveys} do not match parcel survey {sn}.")
    # extent cross-check: FMB measured extent vs the EC extent for this survey
    em = ctx.extent_match(fmb.get("extent"), ctx.ec_extent_for_survey(sn))
    if em is False:
        return R.issue(f"FMB extent ({fmb.get('extent')}) does not match the EC extent ({ctx.ec_extent_for_survey(sn)}) for survey {sn}.")
    extent_note = " (extent ✓)" if em is True else " (extent not verified)"
    return R.clear(f"FMB matches revenue survey {sn}{extent_note}.")


# ─────────────────────────── PHASE 5: FINAL REVIEW ──────────────────────────

def fin_01(ctx):
    """All risk flags actioned (accepted / dismissed / escalated)."""
    rows = ctx.risk_flag_rows()
    if rows is None:
        return R.pending("Risk flags unavailable — run analysis.")
    if not rows:
        return R.clear("No risk flags raised.")
    # RiskFlag.action column: pending | accepted | dismissed | escalated.
    open_ = [f for f in rows if (getattr(f, "action", None) or "pending") == "pending"]
    if not open_:
        return R.clear(f"All {len(rows)} risk flag(s) actioned.")
    return R.issue(f"{len(open_)} of {len(rows)} risk flag(s) still open.")


def fin_02(ctx):
    """Legacy 'Site Manager queries' item — role merged into Legal Advisor."""
    return R.na("Legacy item — the 'Site Manager' role was merged into Legal Advisor; not applicable.")


def fin_03(ctx):
    """Consistency check passed or discrepancies noted."""
    dd = ctx.document_details()
    if not dd:
        return R.pending("Run analysis to compute the consistency check.")
    fails = [d for d in dd if d.get("status") == "FAIL" or d.get("match") is False]
    if fails:
        return R.issue(f"{len(fails)} document(s) failed validation — discrepancies must be justified.")
    return R.clear(f"All {len(dd)} document(s) passed validation — consistent.")


# ─────────────────────────────── REGISTRY ───────────────────────────────────

CHECK_PROVIDERS = {
    "CHK-DOC-01": doc_01, "CHK-DOC-02": doc_02, "CHK-DOC-03": doc_03,
    "CHK-DOC-04": doc_04, "CHK-DOC-05": doc_05, "CHK-DOC-06": doc_06,
    "CHK-DOC-07": doc_07,
    "CHK-OWN-01": own_01, "CHK-OWN-02": own_02, "CHK-OWN-03": own_03,
    "CHK-OWN-04": own_04, "CHK-OWN-05": own_05,
    "CHK-OWN-06": own_06, "CHK-OWN-07": own_07, "CHK-OWN-08": own_08,
    "CHK-ENC-01": enc_01, "CHK-ENC-02": enc_02, "CHK-ENC-03": enc_03,
    "CHK-ENC-04": enc_04, "CHK-ENC-05": enc_05,
    "CHK-CMP-01": cmp_01, "CHK-CMP-02": cmp_02, "CHK-CMP-03": cmp_03,
    "CHK-CMP-04": cmp_04,
    "CHK-FIN-01": fin_01, "CHK-FIN-02": fin_02, "CHK-FIN-03": fin_03,
}
