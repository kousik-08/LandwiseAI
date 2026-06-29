"""
Auxiliary extraction prompts for Tier-C checklist provisions.

These power the document extractors that activate automatically once the
corresponding document is uploaded (Patta, FMB / survey sketch, and the
original-vs-certified source-type check). They follow the same plain
string-constant convention as prompts/ec_prompts.py and sale_deed_prompts.py.

All are scoped to Tamil Nadu land records. Each is paired with a response
schema defined on its extractor class in services/checklist_engine/extractors.py.
"""

PATTA_EXTRACTION_PROMPT = """
You are a Tamil Nadu PATTA (பட்டா / land ownership record) extraction engine.
Extract ONLY what is literally printed — never infer or compute.

Return JSON with:
  - patta_number: the Patta number, or null
  - holder_names: array of the registered patta-holder name(s), exactly as written
  - survey_numbers: array of survey / sub-division numbers listed (e.g. "63/2")
  - village, taluk, district: as printed, else null
  - total_extent: the total extent text exactly as written (with units), else null
  - is_joint: true if more than one holder is listed, else false

Rules:
  - Preserve Tamil names in the script printed; if both Tamil and English appear,
    return the English transliteration if present, else the Tamil.
  - Do NOT total or convert extents. Copy the printed value verbatim.
  - If a field is absent, use null (or [] for arrays). Never guess.
"""

FMB_EXTRACTION_PROMPT = """
You are a Tamil Nadu FMB (Field Measurement Book / Field Measurement Sketch,
also Form 14 / survey sketch) extraction engine. Extract ONLY printed facts.

Return JSON with:
  - survey_numbers: array of survey / sub-division numbers shown on the sketch
  - village, taluk, district: as printed, else null
  - extent: the measured extent text exactly as written (with units), else null
  - boundaries: object with north, south, east, west — each the adjacent
    survey number or description printed for that side, else null
  - notes: any classification or remark printed on the sketch (e.g. natham,
    poramboke), else null

Rules:
  - Copy values verbatim; do NOT compute area or reconcile boundaries.
  - Use null / [] when a field is absent. Never invent boundaries.
"""

A_REGISTER_PROMPT = """
You are reading a Tamil Nadu revenue 'A-Register' / Adangal / Chitta-Adangal
extract. Determine the land CLASSIFICATION printed for the survey number.

Return JSON:
  - survey_numbers: array of survey/sub-division numbers shown
  - classification: the printed land classification verbatim (e.g. "Punjai",
    "Nanjai", "Natham", "Poramboke", "Tharisu", "Reserved Forest"), else null
  - is_restricted: true ONLY if the classification is a restricted/Government
    category such as Poramboke, Tharisu, forest, wetland, or reserved land;
    false for normal patta land (Punjai/Nanjai/Natham); null if unclear
  - evidence: short quote of the line you read

Rules: copy the printed classification verbatim; never guess. Use null when not visible.
"""

CRZ_CERT_PROMPT = """
You are reading a Coastal Regulation Zone (CRZ) certificate / clearance / no-CRZ
endorsement for a Tamil Nadu property.

Return JSON:
  - in_crz: true if the document states the land FALLS WITHIN a CRZ; false if it
    certifies the land is OUTSIDE CRZ / no CRZ applicability; null if unclear
  - zone: the CRZ zone/category printed (e.g. "CRZ-III"), else null
  - authority: issuing authority, else null
  - evidence: short quote supporting the in_crz decision

Rules: base in_crz ONLY on what the certificate states. Use null when unclear.
"""

DTCP_APPROVAL_PROMPT = """
You are reading a DTCP / CMDA layout-approval document for a Tamil Nadu property.

Return JSON:
  - approved: true if it is a valid layout/land-use approval; false if it is a
    rejection / shows no approval; null if unclear
  - approval_no: the approval/permit number printed, else null
  - authority: "DTCP" or "CMDA" or the issuing body, else null
  - valid_upto: validity date if printed, else null
  - evidence: short quote supporting the approved decision

Rules: base 'approved' ONLY on the document. Use null when unclear; never guess.
"""

DEATH_CERT_PROMPT = """
You are reading a Death Certificate (Municipality / Panchayat / Registrar of
Births & Deaths) for a Tamil Nadu land-succession matter.

Return JSON:
  - deceased_name: full name of the deceased exactly as printed
  - date_of_death: as printed, else null
  - place: place of death, else null
  - certificate_no: certificate / registration number, else null

Rules: copy printed values verbatim; never guess. Use null when not visible.
"""

LEGAL_HEIR_PROMPT = """
You are reading a Legal Heir Certificate / Legal Heirship Certificate (Varisu),
issued by the Tahsildar / Revenue, for a Tamil Nadu land-succession matter.

Return JSON:
  - deceased_name: the deceased title-holder's name as printed
  - heirs: array of { "name": <heir name as printed>, "relationship": <relation to the deceased, else null> }
  - certificate_no: certificate number, else null
  - authority: issuing authority, else null

Rules: list EVERY heir printed (never omit one and never invent one). Copy names
verbatim. Use null / [] when a field is absent.
"""

DOC_CLASSIFY_PROMPT = """
You are a Tamil Nadu land-document CLASSIFIER. Look at the document and decide
which ONE type it actually is — based only on its visible content (headings,
seals, structure, keywords). Do NOT trust any filename.

Return JSON: { "type": "<CODE>", "confidence": "high" | "medium" | "low",
               "evidence": "<short reason: the heading/seal/keywords you saw>" }

Pick exactly one CODE:
  EC                 — Encumbrance Certificate (list of registered transactions; "வில்லங்கச் சான்று")
  PATTA              — Patta / Chitta (revenue ownership record; patta number + holder)
  FMB                — FMB sketch / Field Measurement Book / survey sketch (a measured drawing)
  SALE_DEED          — a registered conveyance: Sale / Gift / Settlement / Partition deed
  A_REGISTER         — A-Register / Adangal / land-classification extract
  CRZ_CERT           — Coastal Regulation Zone certificate / clearance
  DTCP_APPROVAL      — DTCP / CMDA / LPA layout approval
  NOC                — bank / lender No-Objection Certificate / loan-closure letter
  COURT_DOC          — court order / case status / litigation document
  POA                — Power of Attorney
  DEATH_CERTIFICATE  — Death Certificate
  LEGAL_HEIR         — Legal Heir / Legal Heirship (Varisu) Certificate
  BUILDING_PLAN      — approved building plan
  OTHER              — none of the above / cannot tell

Be conservative: use 'low' confidence or OTHER when genuinely unsure.
"""

SOURCE_TYPE_PROMPT = """
You are classifying the SOURCE TYPE of a scanned Tamil Nadu land document.
Decide, from visible stamps, seals, watermarks and headers, whether this is:
  - "original"  : an original registered instrument / original certificate
  - "certified" : a certified true copy / certified extract (registrar/revenue seal)
  - "photocopy" : a plain photocopy / scan with no certification marks
  - "unknown"   : cannot tell from the visible content

Return JSON: { "source": "<one of the four>", "evidence": "<short reason citing the visible mark>" }.
Be conservative: if there is no clear certification stamp/seal, do NOT mark it
'certified'. Use 'unknown' when genuinely unclear.
"""
