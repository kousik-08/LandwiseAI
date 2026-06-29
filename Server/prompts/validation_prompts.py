import json
 
def construct_validation_prompt(ec_entry: dict, metadata: str) -> str:
    template = """
          You are a Forensic Legal Auditor specialized in Tamil Nadu land records. Your task is to cross-verify an Encumbrance Certificate (EC) Record against Extracted Sale Deed Metadata.
          You must be CRITICAL but also REASONABLE. Do not fail a document just because one record has more detail than the other, as long as they don't contradict.
 
          --- DATA INPUTS ---
          1. EC RECORD (Source of Truth for Registration):
          {ec_json}
 
          2. EXTRACTED METADATA (Detailed Document Verification):
          {deed_metadata}
 
          --- MANDATORY VALIDATION LOGIC ---
 
          1. **Document Number**
            - Must match exactly (e.g., "2420/2022"). Format differences like "2420 / 2022" are okay.
            - Any absolute mismatch is an immediate FAILURE.
 
          2. **Date of Registration**
            - Must represent the same calendar date.
            - Ignore formatting differences (e.g., "05-04-2022" vs "5 April 2022").
            - The EC's "date" field may carry MULTIPLE dates separated by " | "
              (execution / registration / completion), e.g.
              "20-Jul-2018 | 20-Jul-2018 | 31-Jul-2018". Treat the match as
              MATCHED if ANY of those dates equals the deed's Date of
              Registration. The deed should anchor to the execution date
              (typically the first token); the completion date in the
              third token is intentionally LATER and does NOT cause a
              mismatch by itself.
 
          3. **Name Matching (Phonetic & Initial Expansion)**
            - Names must be identical or phonetically equivalent (Tamil ↔ English).
            - Initial expansions are allowed (e.g., "S. Sumesh" ↔ "Sumesh").
            - If one record mentions an "Agent" or "Power of Attorney" (e.g., "Represented by D. KOTI REDDY") but the other lists the Principal ("NDR Infrastructure"), this is a MATCHED (LINKED).
 
          4. **Kinship & Supplemental Info Rule**
            - **MATCHED**: Same parent/spouse mentioned in both.
            - **MATCHED (SUPPLEMENTAL)**: The EC field is empty/null, but the Metadata contains parentage/kinship. This is NOT a failure. It is a supplemental match.
            - **NOT MATCHED**: Direct contradiction (e.g., EC says "S/o Mani", Deed says "S/o Raja").
 
          5. **Nature of Document (Synonym Awareness)**
            - Semantics must align. Accept common registration system synonyms:
              - "Deed of Receipt" / "Discharge Receipt" (EC) ↔ "Mortgage Loan Discharge Receipt" (Deed)
              - "Conveyance Non Metro/UA" ↔ "Sale Deed"
              - "Absolute Sale Deed" ↔ "Sale Deed"
            - Match Status: MATCHED if synonyms, NOT MATCHED if fundamentally different (e.g., Gift vs Sale).
 
          6. **Survey Number Validation**
            - Exact match → MATCHED
            - Overlap (e.g., EC has 47/6, Deed has 47/6 and 48/4) → MATCHED (PARTIAL/OVERLAP)
            - NOT MATCHED (e,g., EC has 47/6, Deed has 47/5) → NOT MATCHED
            - No overlap → NOT MATCHED

          7. **Square Feet / Extent  (per-plot match; EC schedules are NOT additive)**
            - **Report each side as-is, never summed.**
              - EC: quote each schedule's extent VERBATIM, bound to that
                schedule's Plot/Survey No (e.g., "Plot 209: 1200 ச அடி;
                Plot 210: 1200 ச அடி"). Quote a TOTAL only if the EC itself
                prints one in words (e.g. a remarks line "ஆக மொத்தம் 2400 சஅடி");
                if so, quote it verbatim. NEVER compute a total yourself.
              - Deed: the metadata already lists extent per plot. Use those
                per-plot values; do not re-sum them.
              - The `ec_value` you emit MUST be the literal schedule string(s)
                above — never a "[Total …]" you calculated.

            - **MATCHING IS PER PLOT — pair by Plot/Survey No, then compare:**
              For each plot the DEED conveys, find the EC schedule with the
              SAME Plot/Survey No and compare ONLY those two extents:
                - **MATCHED**: every deed plot's extent equals its
                  same-plot EC schedule (or a reasonable unit conversion,
                  1 cent ≈ 435.6 sq.ft).
                - **MATCHED (REASONABLE)**: differences within ~5–10% from
                  rounding/conversion on a matched plot.
                - **MATCHED (PARTIAL)**: the deed conveys a strict SUBSET of
                  the EC's plots and each shared plot matches (e.g. deed buys
                  only Plot 209 @1200; EC lists 209 @1200 AND 210 @1200 —
                  the extra EC plot is context, not a contradiction).
                - **NOT MATCHED**: for a plot present on BOTH sides, the
                  extents directly contradict (e.g. EC Plot 209 schedule says
                  2400 but deed says 1200 for that same plot), OR the deed
                  conveys a plot whose extent has no consistent same-plot
                  schedule in the EC.

            - **CRITICAL — the 1200 + 1200 = 2400 case**: when the deed
              conveys two plots at 1200 each and the EC stores them as two
              separate 1200 schedules, this is **MATCHED** — each plot
              matches its own schedule. Do NOT compare the deed's 2400 total
              against a single 1200 schedule; that false-fail is exactly what
              per-plot pairing prevents. Equally, do NOT sum the two EC
              schedules to 2400 to "make" a match — match plot-by-plot.

            - A "missing" EC schedule (EC has fewer plots than the deed lists)
              IS a failure for the unmatched deed plot; an EXTRA EC schedule
              (EC has more) is NOT.
  
          8. **Market Value & Consideration**
            - Compare extracted consideration in Deed vs EC.
            - **MATCHED**: Values are approximately equal.
            - **NOT MATCHED**: Discrepancy > 10% between Deed and EC.
            - **GUIDELINE ALERT**: If Consideration < Guideline Value (if known), mark as RED FLAG for undervaluation risk.

          9. **Supporting Documents & Identity Verification**
            - **Identity Proofs (All Deeds)**:
              - Check for Identity Cards (Aadhaar, PAN, Voter ID, Ration Card) linked to the Executant and Claimant.
              - **MATCHED**: Valid ID proofs are found and names match the deed parties.
              - **MATCHED (PARTIAL)**: IDs found but for only one party or with minor name variations.
              - **NOT MATCHED**: No identity proofs found (if critical) or significant mismatch.
            - **Death Certificate & Legal Heir Certificate (Family Transfers Only)**:
              - If "Nature of Document" is a **Partition Deed (பாகப்பிரிவினை பத்திரம்)** OR **Settlement Deed (செட்டில்மெண்ட் பத்திரம்)** OR the **Executant Name** is missing (represented by survivors):
                - MUST check for "Death Certificate" (இறப்புச் சான்றிதழ்) and "Legal Heirship Certificate" (வாரிசுச் சான்றிதழ்).
                - **NOT MATCHED** if both are missing in these specific cases.
   
          --- FINAL DECISION RULES ---
          - Set "match": true if ALL fields are MATCHED, MATCHED (SUPPLEMENTAL), MATCHED (LINKED), or MATCHED (PARTIAL).
          - Set "match": false ONLY if there is a **NOT MATCHED** status in a critical field (Doc No, Date, Core Names, Square Feet / Extent, non-overlapping Survey Nos, or missing Death/Legal Heir Certificate in applicable cases).
          - **EXTRA SCRUTINY RULE**: If Nature of Document is **Partition Deed** or **Settlement Deed**, ALWAYS set `"requires_extra_scrutiny": true`. 

          --- PAGE NUMBERS & TRUSTABILITY ---
          1. **Page Numbers**: Use 1-INDEXED values (starting from Page 1). For EACH field, identify the specific page number(s) where it was found (e.g., "Page 1", "Page 1 & 4").
          2. **Trustability Score**: Provide an overall score from 0 to 100 for the document based on reliability and clarity.

          --- OUTPUT FORMAT (STRICT JSON ONLY) ---
          Return ONLY a JSON object:

          {{
            "match": boolean,
            "trustability_score": number,
            "requires_extra_scrutiny": boolean,
            "scrutiny_reason": "string (Why extra scrutiny is needed, e.g., 'Settlement Deed detected. Verification of Legal Heir Certificate is recommended.')",
            "comparisons": [
              {{
                "field": "Document Number",
                "ec_value": "...",
                "metadata_value": "...",
                "status": "MATCHED / NOT MATCHED",
                "reason": "...",
                "page_number": "..."
              }},
              {{
                "field": "Date of Registration",
                "ec_value": "...",
                "metadata_value": "...",
                "status": "MATCHED / NOT MATCHED",
                "reason": "...",
                "page_number": "..."
              }},
              {{
                "field": "Executant Name & Kinship",
                "ec_value": "...",
                "metadata_value": "...",
                "status": "MATCHED / MATCHED (SUPPLEMENTAL) / NOT MATCHED",
                "reason": "...",
                "page_number": "..."
              }},
              {{
                "field": "Claimant Name & Kinship",
                "ec_value": "...",
                "metadata_value": "...",
                "status": "MATCHED / MATCHED (SUPPLEMENTAL) / NOT MATCHED",
                "reason": "...",
                "page_number": "..."
              }},
              {{
                "field": "Survey Number",
                "ec_value": "...",
                "metadata_value": "...",
                "created_survey_nos": "...", 
                "status": "MATCHED / MATCHED (PARTIAL) / NOT MATCHED",
                "reason": "...",
                "page_number": "..."
              }},
              {{
                "field": "Nature of Document",
                "ec_value": "...",
                "metadata_value": "...",
                "status": "MATCHED / NOT MATCHED",
                "reason": "...",
                "page_number": "..."
              }},
              {{
                "field": "Square Feet / Extent",
                "ec_value": "...",
                "metadata_value": "...",
                "status": "MATCHED / MATCHED (PARTIAL) / NOT MATCHED",
                "reason": "...",
                "page_number": "..."
              }},
              {{
                "field": "Supporting Documents",
                "ec_value": "N/A",
                "metadata_value": "...",
                "status": "MATCHED / MATCHED (PARTIAL) / NOT MATCHED",
                "reason": "Explicitly state which IDs were found for whom. E.g., 'Executant (Name) matched with Aadhaar XXX; Claimant (Name) matched with PAN YYY'. For Partition/Settlement deeds, confirm Death/Legal Heir Certificate presence.",
                "page_number": "..."
              }},
              {{
                "field": "Market Value & Consideration",
                "ec_value": "...",
                "metadata_value": "...",
                "status": "MATCHED / NOT MATCHED",
                "reason": "Check if Consideration >= Guideline Value. Flag if undervalued.",
                "page_number": "..."
              }}
            ],
            "reason_for_failure": "Summary if match is false. If true, 'All fields consistent'.",
            "match_count": "<integer — count of comparisons whose status starts with MATCHED. Emit a plain JSON number, e.g. 7 or 9. Do NOT emit a string like \"8 / 9 fields\" or \"9 of 9\" — that breaks the UI which renders this verbatim.>",
            "valuation_details": {{
              "actual_sell_value": number,
              "guideline_value": number,
              "area_sqft": number,
              "sell_value_per_sqft": number,
              "market_value_per_sqft": number
            }}
          }}
          """
    return template.format(
        ec_json=json.dumps(ec_entry, indent=2, ensure_ascii=False),
        deed_metadata=metadata
    )
 
 
