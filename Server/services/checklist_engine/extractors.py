"""
Tier-C capability adapters — document & content extractors.

Two kinds:
  • CHEAP detectors (NRI, entity-type, OCR-confidence) read already-present
    data and run live inside the checklist fetch — no LLM, no latency.
  • LLM extractors (Patta, FMB, source-type) call Gemini and are EXPENSIVE, so
    they are never invoked on the checklist hot path. They expose:
        is_available(ctx)       -> bool   (is the input document uploaded?)
        compute_and_cache(ctx)  -> dict|None   (Gemini → persist aux artifact)
        cached(ctx)             -> dict|None   (read the persisted artifact)
    Providers ONLY read cached(...); compute_and_cache(...) is driven by
    run_extractions() after analysis (or the /aux-extract endpoint).

Contract: a missing/unreadable input yields None — never a fabricated result.
"""
import os

from prompts.aux_extraction_prompts import (
    PATTA_EXTRACTION_PROMPT,
    FMB_EXTRACTION_PROMPT,
    A_REGISTER_PROMPT,
    CRZ_CERT_PROMPT,
    DTCP_APPROVAL_PROMPT,
    DEATH_CERT_PROMPT,
    LEGAL_HEIR_PROMPT,
)


def _gemini():
    from common.gemini_helper import GeminiHelper
    return GeminiHelper()


class DocTypeClassifier:
    """
    Reads a document and detects its ACTUAL type, independent of how the user
    tagged it on upload. Used to catch wrong-slot uploads (e.g. an EC dropped
    into the Patta slot) and re-file the document under its real type.
    """
    SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "type": {"type": "STRING"},
            "confidence": {"type": "STRING"},
            "evidence": {"type": "STRING"},
        },
    }
    # detected canonical code -> human label (for the UI warning)
    LABELS = {
        "EC": "Encumbrance Certificate", "PATTA": "Patta / Chitta",
        "FMB": "FMB / survey sketch", "SALE_DEED": "Sale Deed",
        "A_REGISTER": "A-Register / Adangal", "CRZ_CERT": "CRZ Certificate",
        "DTCP_APPROVAL": "DTCP / CMDA Approval", "NOC": "Lender NOC",
        "COURT_DOC": "Court document", "POA": "Power of Attorney",
        "DEATH_CERTIFICATE": "Death Certificate", "LEGAL_HEIR": "Legal Heir Certificate",
        "BUILDING_PLAN": "Building Plan", "MISC": "unrecognised document",
    }

    @staticmethod
    def classify_file(path):
        from prompts.aux_extraction_prompts import DOC_CLASSIFY_PROMPT
        try:
            return _gemini().generate_json_from_file(
                path, DOC_CLASSIFY_PROMPT, DocTypeClassifier.SCHEMA, display_name="classify"
            )
        except Exception as e:
            print(f"[checklist-engine] doc classification failed: {e}")
            return None


# ════════════════════════ CHEAP, LIVE DETECTORS ════════════════════════

NRI_MARKERS = (
    "nri", "non-resident", "non resident", "u.s.a", " usa", "united states",
    "u.a.e", " uae", "dubai", "abu dhabi", "singapore", "australia", "canada",
    "united kingdom", "u.k.", "germany", "malaysia", "abroad", "overseas",
    "passport", "oci", "pio", "foreign national", "resident of ",
)

ENTITY_MARKERS = {
    "company": ("pvt ltd", "private limited", " limited", " ltd", "llp",
                "incorporated", " inc.", "corporation", "infrastructures",
                "developers", "promoters", "builders", "enterprises"),
    "huf": ("huf", "hindu undivided family", "kartha", "karta"),
    "trust": ("trust", "trustee", "foundation"),
    "society": ("society", "association", "samiti", "sangam", "sabha"),
}


class NRIDetector:
    """Heuristic NRI detection over EC party names/addresses. Cheap + live."""

    @staticmethod
    def is_available(ctx) -> bool:
        return bool(ctx.ec)

    @staticmethod
    def detect(ctx) -> dict:
        if not ctx.ec:
            return {"nri": None, "evidence": "no EC data"}
        from services.checklist_engine.context import _party_names
        text_parts = []
        for tx in ctx.ec:
            text_parts.extend(_party_names(tx, "buyers", "sellers", "claimants", "executants"))
            # addresses sometimes ride along on the party dicts
            for grp in ("buyers", "sellers", "claimants", "executants"):
                for p in (tx.get(grp) or []):
                    if isinstance(p, dict) and p.get("address"):
                        text_parts.append(str(p["address"]))
        text = (" ".join(text_parts)).lower()
        hits = sorted({m.strip() for m in NRI_MARKERS if m in text})
        if hits:
            return {"nri": True, "evidence": "markers: " + ", ".join(hits[:4])}
        return {"nri": False, "evidence": "no NRI markers in EC parties"}


class EntityTypeDetector:
    """Heuristic owner entity-type classification (individual/company/huf/...)."""

    @staticmethod
    def is_available(ctx) -> bool:
        return bool(ctx.ec)

    @staticmethod
    def detect(ctx) -> dict:
        names = ctx.current_owner_names() or []
        joined = (" ".join(names)).lower()
        for etype, markers in ENTITY_MARKERS.items():
            if any(m in joined for m in markers):
                return {"type": etype, "owner": ", ".join(names)}
        if names:
            return {"type": "individual", "owner": ", ".join(names)}
        return {"type": "unknown", "owner": ""}


class OCRConfidenceAdapter:
    """Reads the per-document extraction_confidence column once extraction emits it."""
    THRESHOLD = 70

    @staticmethod
    def is_available(ctx) -> bool:
        return any(getattr(d, "extraction_confidence", None) is not None for d in ctx.docs)

    @staticmethod
    def evaluate(ctx):
        vals = []
        for d in ctx.docs:
            c = getattr(d, "extraction_confidence", None)
            if c is None:
                continue
            try:
                vals.append(float(c))
            except (TypeError, ValueError):
                continue  # non-numeric confidence → ignore (do not crash)
        if not vals:
            return None
        return {
            "min": min(vals),
            "avg": sum(vals) / len(vals),
            "count": len(vals),
            "threshold": OCRConfidenceAdapter.THRESHOLD,
        }


# ════════════════════════ LLM EXTRACTORS (cached) ════════════════════════

class _LLMExtractor:
    DOC_TYPES = ()
    ARTIFACT = ""
    PROMPT = ""
    SCHEMA = {}

    @classmethod
    def is_available(cls, ctx) -> bool:
        return ctx.has_doc_type(*cls.DOC_TYPES)

    @classmethod
    def cached(cls, ctx):
        return ctx.read_aux(cls.ARTIFACT)

    @classmethod
    def compute_and_cache(cls, ctx):
        if not cls.is_available(ctx):
            return None
        doc = ctx.get_doc(*cls.DOC_TYPES)
        path = ctx.doc_file_path(doc)
        if not path:
            return None
        try:
            data = _gemini().generate_json_from_file(
                path, cls.PROMPT, cls.SCHEMA, display_name=cls.ARTIFACT
            )
        except Exception as e:
            print(f"[checklist-engine] {cls.ARTIFACT} extraction failed: {e}")
            return None
        ctx.write_aux(cls.ARTIFACT, data)
        return data


class PattaExtractor(_LLMExtractor):
    DOC_TYPES = ("PATTA",)
    ARTIFACT = "patta"
    PROMPT = PATTA_EXTRACTION_PROMPT
    SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "patta_number": {"type": "STRING"},
            "holder_names": {"type": "ARRAY", "items": {"type": "STRING"}},
            "survey_numbers": {"type": "ARRAY", "items": {"type": "STRING"}},
            "village": {"type": "STRING"},
            "taluk": {"type": "STRING"},
            "district": {"type": "STRING"},
            "total_extent": {"type": "STRING"},
            "is_joint": {"type": "BOOLEAN"},
        },
    }


class FMBExtractor(_LLMExtractor):
    DOC_TYPES = ("SURVEY_SKETCH", "FMB")
    ARTIFACT = "fmb"
    PROMPT = FMB_EXTRACTION_PROMPT
    SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "survey_numbers": {"type": "ARRAY", "items": {"type": "STRING"}},
            "village": {"type": "STRING"},
            "taluk": {"type": "STRING"},
            "district": {"type": "STRING"},
            "extent": {"type": "STRING"},
            "boundaries": {
                "type": "OBJECT",
                "properties": {
                    "north": {"type": "STRING"},
                    "south": {"type": "STRING"},
                    "east": {"type": "STRING"},
                    "west": {"type": "STRING"},
                },
            },
            "notes": {"type": "STRING"},
        },
    }


class ARegisterExtractor(_LLMExtractor):
    DOC_TYPES = ("A_REGISTER",)
    ARTIFACT = "a_register"
    PROMPT = A_REGISTER_PROMPT
    SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "survey_numbers": {"type": "ARRAY", "items": {"type": "STRING"}},
            "classification": {"type": "STRING"},
            "is_restricted": {"type": "BOOLEAN"},
            "evidence": {"type": "STRING"},
        },
    }


class CRZCertExtractor(_LLMExtractor):
    DOC_TYPES = ("CRZ_CERT",)
    ARTIFACT = "crz_cert"
    PROMPT = CRZ_CERT_PROMPT
    SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "in_crz": {"type": "BOOLEAN"},
            "zone": {"type": "STRING"},
            "authority": {"type": "STRING"},
            "evidence": {"type": "STRING"},
        },
    }


class DTCPApprovalExtractor(_LLMExtractor):
    DOC_TYPES = ("DTCP_APPROVAL",)
    ARTIFACT = "dtcp_approval"
    PROMPT = DTCP_APPROVAL_PROMPT
    SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "approved": {"type": "BOOLEAN"},
            "approval_no": {"type": "STRING"},
            "authority": {"type": "STRING"},
            "valid_upto": {"type": "STRING"},
            "evidence": {"type": "STRING"},
        },
    }


class DeathCertExtractor(_LLMExtractor):
    DOC_TYPES = ("DEATH_CERTIFICATE",)
    ARTIFACT = "death_cert"
    PROMPT = DEATH_CERT_PROMPT
    SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "deceased_name": {"type": "STRING"},
            "date_of_death": {"type": "STRING"},
            "place": {"type": "STRING"},
            "certificate_no": {"type": "STRING"},
        },
    }


class LegalHeirExtractor(_LLMExtractor):
    DOC_TYPES = ("LEGAL_HEIR",)
    ARTIFACT = "legal_heir"
    PROMPT = LEGAL_HEIR_PROMPT
    SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "deceased_name": {"type": "STRING"},
            "heirs": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {"type": "STRING"},
                        "relationship": {"type": "STRING"},
                    },
                },
            },
            "certificate_no": {"type": "STRING"},
            "authority": {"type": "STRING"},
        },
    }


class SourceTypeDetector:
    """
    Original-vs-certified detection across the parcel's key documents (EC + deeds).
    Cached as aux 'source_types' = {"docs": [{"id","type","source","evidence"}]}.
    """
    ARTIFACT = "source_types"
    MAX_DOCS = 6

    @staticmethod
    def is_available(ctx) -> bool:
        return bool(ctx.docs)

    @staticmethod
    def cached(ctx):
        return ctx.read_aux(SourceTypeDetector.ARTIFACT)

    @staticmethod
    def compute_and_cache(ctx):
        if not ctx.docs:
            return None
        from prompts.aux_extraction_prompts import SOURCE_TYPE_PROMPT
        schema = {
            "type": "OBJECT",
            "properties": {
                "source": {"type": "STRING"},
                "evidence": {"type": "STRING"},
            },
        }
        results = []
        g = _gemini()
        for d in ctx.docs[: SourceTypeDetector.MAX_DOCS]:
            path = ctx.doc_file_path(d)
            if not path:
                continue
            try:
                res = g.generate_json_from_file(
                    path, SOURCE_TYPE_PROMPT, schema, display_name="source-type"
                )
            except Exception as e:
                print(f"[checklist-engine] source-type failed for {d.id}: {e}")
                res = {"source": "unknown", "evidence": str(e)[:120]}
            results.append({
                "id": d.id,
                "type": (d.document_type or "").upper(),
                "source": (res or {}).get("source", "unknown"),
                "evidence": (res or {}).get("evidence", ""),
            })
        data = {"docs": results}
        ctx.write_aux(SourceTypeDetector.ARTIFACT, data)
        return data
