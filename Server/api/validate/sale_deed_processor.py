import json
import os
import re
from common.gemini_helper import GeminiHelper
from prompts.sale_deed_prompts import SALE_DEED_PROMPT


# Fields that EVERY real extraction emits (in the strict output format the
# prompt enforces). If a returned blob is missing more than half of these,
# Gemini almost certainly garbled the run (repetitive-loop output, truncated
# stream, or auth/quota error masquerading as text).
_REQUIRED_FIELD_MARKERS = (
    "Document Number",
    "Date of Registration",
    "Executant",
    "Claimant",
    "Survey Number",
    "Square Feet / Extent",
    "Market Value",
)


def _looks_corrupted(text: str) -> tuple[bool, str]:
    """
    Heuristic: returns (is_corrupted, reason).

    Detects the three failure modes we've actually observed in production:
      1. Very short response (Gemini returned a token-limit truncation).
      2. Repetitive-loop output (same short sentence/phrase repeated many
         times — a known failure of the file-API when the PDF rasterized
         poorly).
      3. Missing more than half of the required output fields (prompt
         scaffold collapsed; the response is prose rather than the strict
         format).
    """
    if not text or len(text.strip()) < 200:
        return True, f"response too short ({len(text or '')} chars)"

    # Repetitive-loop detector: look for any 60-char window repeated ≥6×.
    # Real extractions are highly heterogeneous; this never matches a
    # clean run but reliably catches the "Missing / Corrupted text" loop.
    stripped = re.sub(r"\s+", " ", text).strip()
    for window_len in (60, 80, 120):
        seen: dict[str, int] = {}
        for i in range(0, max(0, len(stripped) - window_len), 8):
            chunk = stripped[i : i + window_len]
            seen[chunk] = seen.get(chunk, 0) + 1
            if seen[chunk] >= 6:
                return True, f"repetitive loop detected (window={window_len})"

    # Field-coverage check: must hit at least half of the required slots.
    hits = sum(1 for marker in _REQUIRED_FIELD_MARKERS if marker.lower() in text.lower())
    if hits < len(_REQUIRED_FIELD_MARKERS) // 2:
        return True, f"only {hits}/{len(_REQUIRED_FIELD_MARKERS)} required fields present"

    return False, ""


class SaleDeedProcessor:
    """
    Processes matched sale deeds and extracts detailed Tamil metadata.
    """

    # Bump when SALE_DEED_PROMPT changes. The sidecar `<stem>_metadata.meta.json`
    # carries this marker — a mismatch forces a fresh Gemini run instead of
    # silently reusing extractions captured under an older prompt. Without
    # this, prompt fixes never reach existing parcels because the cached
    # *_metadata.txt silently wins.
    #
    # The metadata file content itself stays plain — no in-file header — so
    # downstream readers (validator.py, handler.py) keep working unchanged.
    #
    # v1: original Beta prompt (no sidecar — treated as v0 on disk).
    # v2: added handwritten-date cross-verification + POA agent/principal
    #     surfacing so deeds signed by a POA agent expose both the agent
    #     and the principals to the matcher.
    # v3: Date of Registration must be the EXECUTION date (front-page
    #     handwritten + body narrative), NOT the back-page SRO completion
    #     endorsement. Plus model upgrade to gemini-3.5-flash.
    # v4: universalized — Date / POA / multi-name rules reframed as
    #     "apply to every deed", expanded Tamil POA trigger vocabulary,
    #     date-triangulation self-check + general deed self-check before
    #     emit. Rule body is now document-agnostic.
    # v5: two new precision rules:
    #     - Document Number: cross-instance verification + ambiguous-digit
    #       recovery (handwritten 2-vs-7, 1-vs-7, 0-vs-6 etc. resolved by
    #       comparing the two stamped instances on the same deed).
    #     - POA principals: explicit "no cross-deed contamination" rule —
    #       principal names must come from THIS deed's body, not from a
    #       similar-looking deed earlier in the batch or from a memorized
    #       "typical Tamil Nadu POA pattern" learned during pre-training.
    # v6: three precision rules added after the next round of failures:
    #     - Tamil compound-unit convention: "ஏக்கர் X.YY சென்ட்டு" is acres,
    #       not cents (fixes 2.27 Acres misread as 2.27 Cents on 2708/2012).
    #     - Metric cross-check: when hectare and a legacy unit are both
    #       given, the ha↔acre conversion must hold (sanity-check the unit).
    #     - Both-handwritten-vote-wrong guard for doc numbers: when ALL
    #       handwritten instances appear to read the same wrong digit
    #       (flat-top "7" → "2" is the classic), use the year portion to
    #       anchor + emit alternate readings as a tie-breaker.
    # v7: three rule REVERSALS / refinements after user feedback:
    #     - Extent: the v6 "ஏக்கர் prefix means acres" was WRONG. The
    #       UNIVERSAL rule is TRAILING-UNIT-WINS — the unit token
    #       immediately AFTER the number is the actual unit; any prefix
    #       word (ஏக்கர் label, parent-tract qualifier) is ignored.
    #       Fixes 0.64 Cents misread as 0.64 Acres on 4637/2013.
    #     - Date of Registration: handwritten front-page date is now the
    #       AUTHORITATIVE source (not co-equal with body narrative). Body
    #       narrative is FALLBACK only. Fixes 06-Jul-2011 misread as
    #       06-Jun-2011 on 5405/2011 where body said ஜூன் (June) but
    #       handwritten + EC both said July.
    #     - Document Number: handwritten / stamped corner serial wins over
    #       any typed body-text mention. Body text mentions are almost
    #       always parent-doc references and using them silently swaps THIS
    #       deed's number. Fixes 1561/2012 misread as 156/2012.
    # v8: handwritten-date rule restructured with explicit STEP 1 / STEP 2
    #     ordering + a worked-example trap labelled "MUST NOT emit". The
    #     v7 phrasing wasn't strong enough; 5405/2011 still extracted the
    #     body's ஜூன் (June) date. v8 forces the LLM to look at the
    #     handwritten corner BEFORE any body text.
    #     ALSO: added corruption detection + 2 automatic retries with a
    #     final "EXTRACTION FAILED" marker. Replaces the silent
    #     "Missing / Corrupted text" loop output that surfaced on
    #     7755/2011 as a fake NOT MATCHED row.
    _PROMPT_VERSION = 8

    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.gemini = GeminiHelper(model_id="gemini-3.5-flash")
        os.makedirs(self.output_dir, exist_ok=True)

    def _sidecar_path(self, output_path: str) -> str:
        return output_path.replace("_metadata.txt", "_metadata.meta.json")

    def _read_sidecar_version(self, output_path: str) -> int:
        sidecar = self._sidecar_path(output_path)
        if not os.path.exists(sidecar):
            return 0  # legacy cache, no version recorded
        try:
            with open(sidecar, "r", encoding="utf-8") as f:
                return int(json.load(f).get("prompt_version", 0))
        except (OSError, ValueError, json.JSONDecodeError):
            return 0

    def _write_sidecar(self, output_path: str) -> None:
        sidecar = self._sidecar_path(output_path)
        with open(sidecar, "w", encoding="utf-8") as f:
            json.dump({"prompt_version": self._PROMPT_VERSION}, f)

    def process_file(self, pdf_path: str) -> str:
        """
        Sends a single PDF to Gemini for processing.
        """
        filename = os.path.basename(pdf_path)
        output_filename = os.path.splitext(filename)[0] + "_metadata.txt"
        output_path = os.path.join(self.output_dir, output_filename)

        if os.path.exists(output_path):
            cached_v = self._read_sidecar_version(output_path)
            if cached_v == self._PROMPT_VERSION:
                print(f"[*] Found existing metadata (v{cached_v}) for {filename}. Skipping Gemini.")
                with open(output_path, "r", encoding="utf-8") as f:
                    return f.read()
            print(
                f"[*] Stale metadata for {filename} (cached v{cached_v}, "
                f"current v{self._PROMPT_VERSION}). Re-extracting."
            )

        print(f"[*] Processing Sale Deed: {filename}")

        # Retry-on-corruption: when Gemini garbles a deed (repetitive-loop
        # output, truncated, or prose-fallback), the validator otherwise
        # writes "Missing / Corrupted text" into the comparison panel and
        # the parcel reads as NOT MATCHED for fields that were perfectly
        # extractable on a clean run. Up to 2 retries is enough in
        # practice — the same PDF re-uploaded usually re-rasterizes
        # without the loop.
        result = ""
        max_attempts = 3
        last_reason = ""
        for attempt in range(1, max_attempts + 1):
            try:
                result = self.gemini.generate_from_file(
                    pdf_path, SALE_DEED_PROMPT, display_name=filename
                )
            except Exception as e:
                last_reason = f"Gemini error: {e}"
                print(f"[!] Sale-deed Gemini call failed (attempt {attempt}/{max_attempts}): {e}")
                if attempt == max_attempts:
                    break
                continue

            corrupted, reason = _looks_corrupted(result)
            if not corrupted:
                break  # clean output, done

            last_reason = reason
            print(
                f"[!] Sale-deed extraction looked corrupted on attempt "
                f"{attempt}/{max_attempts} for {filename} ({reason}). "
                f"{'Retrying.' if attempt < max_attempts else 'Giving up; writing failure marker.'}"
            )

        # Final-attempt result still corrupted: don't poison the matcher
        # with loop garbage. Write an explicit failure marker so the
        # validator and UI can surface "Extraction failed" rather than a
        # misleading "values don't match" diff.
        final_corrupted, final_reason = _looks_corrupted(result)
        if final_corrupted:
            result = (
                "Nature of the Document: EXTRACTION FAILED\n"
                "Document Number: EXTRACTION FAILED\n"
                "Date of Registration: EXTRACTION FAILED\n"
                "Executant Name: EXTRACTION FAILED\n"
                "Claimant Name: EXTRACTION FAILED\n"
                "Survey Number: EXTRACTION FAILED\n"
                "Square Feet / Extent: EXTRACTION FAILED\n"
                "Market Value / Consideration: EXTRACTION FAILED\n"
                f"\n# Extraction failed after {max_attempts} attempts: "
                f"{final_reason or last_reason}\n"
                "# Re-upload the PDF or re-trigger analyze to retry.\n"
            )

        with open(output_path, "w", encoding="utf-8") as f:
            f.write(result)
        self._write_sidecar(output_path)

        print(f"[OK] Extraction saved to {output_path}")
        return result

    def process_matched_list(self, matched_docs: list):
        """
        Processes a list of matched documents.
        """
        for doc in matched_docs:
            self.process_file(doc["file_path"])
