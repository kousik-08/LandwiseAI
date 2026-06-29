"""
CheckContext — bundles every signal a checklist provider might need, loaded
lazily and CHEAPLY. Providers read from this context only; they never call
Gemini or external HTTP on the hot path (the checklist fetch). The expensive
Gemini extractions are run separately and cached as artifacts (read via
read_aux / written via write_aux).

Signal sources:
  • parcel.risk_score_data  — persisted risk output (gaps, lis-pendens, doc matches)
  • ec_final.json artifact  — the full EC transaction list (chain, dates, parties)
  • LandwiseDocument rows    — which document types are uploaded + OCR confidence
  • aux/<name>.json artifacts — cached Tier-C extractor output (Patta, FMB, source-type)
"""
import os
import re
import json
import tempfile


# Canonical document-type tokens. The frontend/upload form sends varied strings
# (e.g. 'patta_chitta', 'field_measurement_book', 'encumbrance_certificate'); this
# map collapses every alias to ONE canonical token so checks fire regardless of
# the exact label the uploader chose.
_CANON = {
    "EC": "EC", "ENCUMBRANCE_CERTIFICATE": "EC", "ENCUMBRANCE_CERT": "EC",
    "SALE_DEED": "SALE_DEED", "DEED": "SALE_DEED",
    "PATTA": "PATTA", "PATTA_CHITTA": "PATTA", "CHITTA": "PATTA", "PATTA_CHITTA_EXTRACT": "PATTA",
    "FMB": "FMB", "FIELD_MEASUREMENT_BOOK": "FMB", "SURVEY_SKETCH": "FMB", "FMB_MAP": "FMB", "FORM_14": "FMB",
    "POA": "POA", "POWER_OF_ATTORNEY": "POA",
    "NOC": "NOC", "NO_OBJECTION_CERTIFICATE": "NOC", "LENDER_NOC": "NOC",
    "CRZ_CERT": "CRZ_CERT", "CRZ_CERTIFICATE": "CRZ_CERT", "CRZ": "CRZ_CERT",
    "DTCP_APPROVAL": "DTCP_APPROVAL", "DTCP": "DTCP_APPROVAL", "CMDA": "DTCP_APPROVAL",
    "CMDA_APPROVAL": "DTCP_APPROVAL", "LAYOUT_APPROVAL": "DTCP_APPROVAL",
    "A_REGISTER": "A_REGISTER", "A_REGISTER_EXTRACT": "A_REGISTER", "AREGISTER": "A_REGISTER",
    "ADANGAL": "A_REGISTER", "CHITTA_ADANGAL": "A_REGISTER",
    "COURT_DOC": "COURT_DOC", "COURT_SEARCH": "COURT_DOC", "COURT_ORDER": "COURT_DOC", "ECOURTS": "COURT_DOC",
    "DEATH_CERTIFICATE": "DEATH_CERTIFICATE", "DEATH_CERT": "DEATH_CERTIFICATE",
    "LEGAL_HEIR_CERTIFICATE": "LEGAL_HEIR", "LEGAL_HEIR": "LEGAL_HEIR", "HEIR_CERTIFICATE": "LEGAL_HEIR",
    "LEGAL_HEIRSHIP": "LEGAL_HEIR", "VARISU": "LEGAL_HEIR",
    "FAMILY_TREE": "FAMILY_TREE", "GENEALOGY": "FAMILY_TREE",
    "MUTATION": "MUTATION", "PATTA_TRANSFER": "MUTATION",
    "PARENT_DOCUMENT": "PARENT", "PARENT": "PARENT",
    "GIFT_DEED": "GIFT_DEED", "WILL": "WILL", "PARTITION_DEED": "PARTITION_DEED",
    "BUILDING_PLAN": "BUILDING_PLAN", "MISC": "MISC", "OTHER": "MISC",
}


def canon_type(raw) -> str:
    t = (raw or "").upper().strip()
    return _CANON.get(t, t)


def _nature(tx) -> str:
    return str(tx.get("nature_of_document") or tx.get("nature") or "").lower()


def _party_names(tx, *groups) -> list:
    out = []
    for g in groups:
        for p in (tx.get(g) or []):
            if isinstance(p, dict):
                out.append(p.get("name") or "")
            else:
                out.append(str(p))
    return [n for n in out if n]


def _survey_base(s) -> str:
    """Main survey number, ignoring sub-division. Handles '/', '-' and letter
    suffixes: '63/2', '63-2', '63A', '96/4B2', '96-4B2' all -> '63'/'96'."""
    s = str(s or "").strip()
    m = re.match(r"(\d+)", s)
    return m.group(1) if m else s.split("/")[0].split("-")[0].strip()


# Extent unit -> square-feet factor. Sorted longest-first so a fallback substring
# check never matches a shorter unit before its longer form.
_EXTENT_TO_SQFT = sorted([
    ("square metre", 10.7639), ("sq.metre", 10.7639), ("sq metre", 10.7639), ("sq.m", 10.7639), ("sqm", 10.7639),
    ("square feet", 1.0), ("sq.ft", 1.0), ("sq ft", 1.0), ("sqft", 1.0), ("sft", 1.0),
    ("hectares", 107639.0), ("hectare", 107639.0),
    ("grounds", 2400.0), ("ground", 2400.0),
    ("cents", 435.6), ("cent", 435.6),
    ("acres", 43560.0), ("acre", 43560.0),
], key=lambda kv: -len(kv[0]))
_UNIT_FACTORS = dict(_EXTENT_TO_SQFT)


def parse_extent_sqft(text):
    """
    Convert an extent string to square-feet, SUMMING every number+unit pair so
    compound TN extents work: '1 acre 50 cents' -> 43560 + 21780 = 65340.
    Returns None when no number+unit can be read (a bare number is NOT guessed).
    """
    if not text:
        return None
    s = str(text).lower()
    total, found = 0.0, False
    for m in re.finditer(r"(\d+(?:\.\d+)?)\s*([a-z][a-z.]*)", s):
        num = float(m.group(1))
        unit = m.group(2).strip(" .")
        factor = _UNIT_FACTORS.get(unit)
        if factor is None:  # token may carry a longer known unit as a prefix
            for u, f in _EXTENT_TO_SQFT:
                if unit.startswith(u):
                    factor = f
                    break
        if factor is not None:
            total += num * factor
            found = True
    if found:
        return total
    # fallback: a single number with a unit word somewhere in the string
    m = re.search(r"(\d+(?:\.\d+)?)", s)
    if not m:
        return None
    val = float(m.group(1))
    for u, f in _EXTENT_TO_SQFT:
        if u in s:
            return val * f
    return None  # a bare number with no recognised unit — don't guess


class CheckContext:
    def __init__(self, parcel, db):
        self.parcel = parcel
        self.db = db
        self.parcel_id = parcel.id
        self.request_id = getattr(parcel, "last_analysis_request_id", None)
        self.risk = getattr(parcel, "risk_score_data", None) or {}
        self._ec = None
        self._docs = None

    # ───────────────────────── documents ─────────────────────────
    @property
    def docs(self) -> list:
        if self._docs is None:
            from common.landwise_models import LandwiseDocument
            self._docs = (
                self.db.query(LandwiseDocument)
                .filter(
                    LandwiseDocument.parcel_id == self.parcel_id,
                    LandwiseDocument.deleted_at.is_(None),
                )
                .all()
            )
        return self._docs

    def doc_types(self) -> set:
        """Canonical document-type tokens present on this parcel."""
        return {canon_type(d.document_type) for d in self.docs}

    def has_doc_type(self, *types) -> bool:
        present = self.doc_types()
        return any(canon_type(t) in present for t in types)

    def get_doc(self, *types):
        want = {canon_type(t) for t in types}
        for d in self.docs:
            if canon_type(d.document_type) in want:
                return d
        return None

    def doc_file_path(self, doc):
        """
        Local file path for a document — materializing from the storage backend
        (S3) or DB bytes as needed. Mirrors the analyze pipeline's _materialize so
        document extraction works on every STORAGE_BACKEND (local or s3).
        """
        if doc is None:
            return None
        key = getattr(doc, "storage_key", None)
        target = os.path.join(tempfile.gettempdir(), f"lw_doc_{doc.id}.pdf")

        # 1) already a local absolute path on disk (legacy/local backend)
        if key and os.path.isabs(key) and os.path.exists(key):
            return key
        if os.path.exists(target):
            return target

        # 2) storage backend (S3) holds the bytes under storage_key
        if key:
            try:
                from common.storage import get_storage
                storage = get_storage()
                if storage.exists(key):
                    storage.download_to(key, target)
                    return target
            except Exception as e:
                print(f"[checklist-engine] storage download failed for {key}: {e}")

        # 3) last resort: DB-stored bytes
        blob = getattr(doc, "file_content", None)
        if blob:
            try:
                with open(target, "wb") as f:
                    f.write(blob)
                return target
            except Exception as e:
                print(f"[checklist-engine] doc_file_path materialize failed for {getattr(doc, 'id', '?')}: {e}")
                return None

        print(f"[checklist-engine] could not materialize document {getattr(doc, 'id', '?')} (no local path, storage miss, no DB bytes)")
        return None

    # ───────────────────────── EC analysis ─────────────────────────
    @property
    def ec(self) -> list:
        if self._ec is None:
            self._ec = []
            if self.request_id:
                try:
                    from services.artifact_store import read_json_artifact
                    data = read_json_artifact(self.request_id, "ec_final.json")
                    if isinstance(data, list):
                        self._ec = data
                except Exception:
                    self._ec = []
        return self._ec

    @property
    def has_analysis(self) -> bool:
        return bool(self.request_id)

    def ec_years(self) -> list:
        from api.validate.risk_score_engine import _parse_year
        return [y for tx in self.ec if (y := _parse_year(tx.get("date", "")))]

    def ec_span(self) -> int:
        ys = self.ec_years()
        return (max(ys) - min(ys)) if len(ys) >= 2 else 0

    def gaps(self, threshold_years: int) -> list:
        """Year gaps > threshold. Prefer persisted risk flags, else compute from EC."""
        flags = (self.risk.get("flags") or {}).get("encumbrance_gaps")
        if isinstance(flags, list) and flags:
            return [g for g in flags if isinstance(g, dict) and (g.get("gap_years") or 0) > threshold_years]
        if not self.ec:
            return []
        from api.validate.risk_score_engine import _detect_encumbrance_gaps
        return _detect_encumbrance_gaps(self.ec, gap_threshold_years=threshold_years)

    def lis_pendens(self) -> list:
        flags = (self.risk.get("flags") or {}).get("lis_pendens") or []
        if flags:
            return flags
        # fall back to EC nature scan
        kw = ("court", "attachment", "lis pendens", "injunction", "stay order", "decree", "acquisition")
        return [tx for tx in self.ec if any(k in _nature(tx) for k in kw)]

    def mortgages(self) -> list:
        kw = ("mortgage", "loan", "charge", "hypothec", "அடமான")
        return [tx for tx in self.ec if any(k in _nature(tx) for k in kw)]

    def easements(self) -> list:
        return [tx for tx in self.ec if "easement" in _nature(tx)]

    def document_details(self) -> list:
        return self.risk.get("document_details") or []

    def primary_survey(self):
        sn = getattr(self.parcel, "survey_number", None)
        if sn:
            return sn
        for tx in self.ec:
            if tx.get("survey_number"):
                return tx.get("survey_number")
        return None

    def current_owner_names(self) -> list:
        """Best-effort current owner = buyer(s) of the latest-dated transfer."""
        from api.validate.risk_score_engine import _parse_year
        dated = []
        for tx in self.ec:
            y = _parse_year(tx.get("date", ""))
            buyers = _party_names(tx, "buyers", "claimants")
            if y and y > 1000 and buyers:  # guard against malformed year 0
                dated.append((y, buyers))
        if not dated:
            return []
        dated.sort(key=lambda x: x[0])
        return dated[-1][1]

    # ───────────── survey-scoped cross-validation helpers ─────────────
    def parcel_survey(self):
        """The parcel's target survey (e.g. '63/2')."""
        return self.primary_survey()

    def survey_in(self, doc_surveys, target):
        """True/False whether `target` survey is among `doc_surveys` (base match);
        None when undeterminable (no target or no doc surveys)."""
        if not target or not doc_surveys:
            return None
        tbase = _survey_base(target)
        for s in doc_surveys:
            s = str(s).strip()
            if s == str(target).strip() or _survey_base(s) == tbase:
                return True
        return False

    def current_owner_for_survey(self, target):
        """Latest buyer for `target` survey. EXACT sub-division match preferred;
        falls back to the base survey only when there is NO exact match (so 63/1
        never returns 63/3's owner just because 63/3 has a later transaction)."""
        if not target:
            return []
        from api.validate.risk_score_engine import _parse_year
        tbase = _survey_base(target)
        exact, base = [], []
        for tx in self.ec:
            sn = str(tx.get("survey_number") or "")
            y = _parse_year(tx.get("date", ""))
            buyers = _party_names(tx, "buyers", "claimants")
            if not (y and y > 1000 and buyers):
                continue
            if sn == str(target):
                exact.append((y, buyers))
            elif _survey_base(sn) == tbase:
                base.append((y, buyers))
        pool = exact or base
        if not pool:
            return []
        pool.sort(key=lambda x: x[0])
        return pool[-1][1]

    def ec_extent_for_survey(self, target):
        """EC property_extent of the latest transaction for `target` survey
        (EXACT sub-division preferred, base survey only as fallback)."""
        if not target:
            return None
        from api.validate.risk_score_engine import _parse_year
        tbase = _survey_base(target)
        exact_best, exact_y, base_best, base_y = None, -1, None, -1
        for tx in self.ec:
            sn = str(tx.get("survey_number") or "")
            ext = tx.get("property_extent")
            if not ext:
                continue
            y = _parse_year(tx.get("date", "")) or 0
            if sn == str(target):
                if y >= exact_y:
                    exact_y, exact_best = y, ext
            elif _survey_base(sn) == tbase:
                if y >= base_y:
                    base_y, base_best = y, ext
        return exact_best if exact_best is not None else base_best

    @staticmethod
    def extent_match(a, b, tol=0.08):
        """True if two extents agree within `tol`; False if they differ; None if unparseable.
        Distinguishes a real 0.0 from an unparseable None, and avoids ZeroDivisionError."""
        sa, sb = parse_extent_sqft(a), parse_extent_sqft(b)
        if sa is None or sb is None:
            return None
        if sa == 0 and sb == 0:
            return True
        if sa == 0 or sb == 0:
            return False
        return abs(sa - sb) / max(sa, sb) <= tol

    def chain_party_names(self) -> list:
        """Every distinct party name across the EC chain (sellers + buyers)."""
        seen, out = set(), []
        for tx in self.ec:
            for n in _party_names(tx, "sellers", "buyers", "claimants", "executants"):
                k = n.lower().strip()
                if k and k not in seen:
                    seen.add(k)
                    out.append(n)
        return out

    def is_inheritance_matter(self) -> bool:
        """True if this is a succession matter — a succession document is uploaded
        OR the EC chain shows an inheritance-type transfer."""
        if self.has_doc_type("DEATH_CERTIFICATE", "LEGAL_HEIR", "FAMILY_TREE"):
            return True
        kw = ("legal heir", "inheritance", "succession", "intestate", "வாரிசு", "legal heirship")
        return any(any(k in _nature(tx) for k in kw) for tx in self.ec)

    def risk_flag_rows(self):
        """RiskFlag rows for this parcel, or None if the model/query is unavailable."""
        try:
            from common.landwise_models import RiskFlag
            return self.db.query(RiskFlag).filter(RiskFlag.parcel_id == self.parcel_id).all()
        except Exception:
            return None

    # ───────────── cached aux extractor artifacts (Tier C) ─────────────
    # Scoped to the PARCEL (not a specific analysis run) so document extractions
    # work even before Smart Analysis has run, and persist across runs.
    def _aux_scope(self) -> str:
        return f"aux-parcel-{self.parcel_id}"

    def read_aux(self, name: str):
        try:
            from services.artifact_store import read_json_artifact
            return read_json_artifact(self._aux_scope(), f"{name}.json")
        except Exception:
            return None

    def write_aux(self, name: str, data) -> bool:
        try:
            from services.artifact_store import _local_path
            path = _local_path(self._aux_scope(), f"{name}.json")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            print(f"[checklist-engine] write_aux({name}) failed: {e}")
            return False
