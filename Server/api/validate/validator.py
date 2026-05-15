import json
import os
import re
import hashlib
from typing import List, Dict
from common.gemini_helper import GeminiHelper
from prompts.validation_prompts import construct_validation_prompt
from api.validate.visual_debugger import VisualDebugger


def _build_ec_lookup(ec_data: List[Dict]) -> Dict:
    """
    Build a doc_number → entry lookup that MERGES duplicate document_numbers.

    EC parsing produces one row per survey number, so the same `document_number`
    can appear multiple times with different `survey_number` values. A plain
    dict comprehension `{e["document_number"]: e for e in ec_data}` keeps only
    the last one, and which survey wins depends on iteration order — that
    silently flips the survey-number comparison between runs.

    Here we merge: the resulting entry's `survey_number` becomes a sorted,
    deduplicated, comma-separated string of every survey that shared the
    document_number, so the LLM sees the full set and matches deterministically.
    """
    lookup: Dict[str, Dict] = {}
    for entry in ec_data:
        doc_no = entry.get("document_number")
        if not doc_no:
            continue
        if doc_no not in lookup:
            lookup[doc_no] = dict(entry)
            continue
        existing = lookup[doc_no]
        # Merge survey_number into a sorted unique CSV.
        surveys = set()
        for src in (existing.get("survey_number"), entry.get("survey_number")):
            if not src:
                continue
            for piece in re.split(r"[,;]+", str(src)):
                p = piece.strip()
                if p:
                    surveys.add(p)
        if surveys:
            existing["survey_number"] = ", ".join(sorted(surveys))
    return lookup


def _inputs_hash(ec_entry: Dict, metadata_content: str) -> str:
    """
    Fingerprint the exact inputs that go into the LLM prompt. Used to invalidate
    the per-document validation cache when either side changes — without this
    the cache key is just the filename and a re-extracted EC entry with
    different field values will return the stale prior validation result.
    """
    payload = json.dumps(ec_entry or {}, sort_keys=True, ensure_ascii=False) + "\x00" + (metadata_content or "")
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


class Validator:
    """
    Validates extracted metadata against EC records using Gemini.
    """

    def __init__(
        self,
        output_dir: str,
    ):
        self.output_dir = output_dir
        # Initialize Gemini Helper (defaults to gemini-2.5-flash-lite)
        self.gemini = GeminiHelper(model_id="gemini-2.5-flash-lite")
        # Visual Debugger uses a slightly more capable model for vision tasks
        self.visual_debugger = VisualDebugger(
            GeminiHelper(model_id="gemini-2.5-flash"), output_dir
        )

    def query_gemini(self, prompt: str) -> str:
        """
        Sends a prompt to Gemini.
        """
        try:
            # We pass empty text as the first arg since the full prompt includes everything
            return self.gemini.generate_from_text("", prompt)
        except Exception as e:
            print(f"[!] Error contacting Gemini: {e}")
            return "{}"

    def validate(
        self,
        matched_docs: List[Dict[str, str]],
        ec_json_path: str,
        visual_debug: bool = False,
    ):
        """
        Compares EC JSON data with extracted metadata for matched documents.
        Yields progress messages.
        Returns the evaluation results.
        """
        if not os.path.exists(ec_json_path):
            print(f"[!] EC JSON not found at {ec_json_path}")
            return []

        with open(ec_json_path, "r", encoding="utf-8") as f:
            ec_data = json.load(f)

        # Create a lookup for EC data
        ec_lookup = _build_ec_lookup(ec_data)

        results = []

        for doc in matched_docs:
            doc_no = doc["document_number"]
            yield f"[*] Validating {doc_no}..."
            
            res = self.validate_single_doc(doc, ec_json_path, visual_debug=visual_debug, ec_lookup=ec_lookup)
            if res:
                results.append(res)
                match_status = res.get("match", False)
                yield f"   > Match: {match_status}"
        
        return results

    def validate_single_doc(
        self,
        doc: Dict[str, str],
        ec_json_path: str,
        visual_debug: bool = False,
        ec_lookup: Dict = None,
    ) -> Dict:
        """
        Validates a single document.
        """
        if ec_lookup is None:
            if not os.path.exists(ec_json_path):
                print(f"[!] EC JSON not found at {ec_json_path}")
                return {}
            with open(ec_json_path, "r", encoding="utf-8") as f:
                ec_data = json.load(f)
            ec_lookup = _build_ec_lookup(ec_data)

        doc_no = doc["document_number"]
        # file_path is the location in the workspace (tmp/...)
        file_path = doc["file_path"]

        # Find EC Entry
        ec_entry = ec_lookup.get(doc_no)
        if not ec_entry:
            print(f"[!] EC Entry not found for {doc_no}")
            return {
                "document_number": doc_no,
                "match": False,
                "status": "NOT_FOUND",
                "reason": f"Document number {doc_no} not found in EC records.",
                "comparisons": [],
                "match_count": 0
            }

        # Find Metadata File
        filename = os.path.basename(file_path)
        meta_filename = os.path.splitext(filename)[0] + "_metadata.txt"
        meta_path = os.path.join(self.output_dir, meta_filename)

        if not os.path.exists(meta_path):
            print(f"[!] Metadata file not found: {meta_path}")
            return {
                "document_number": doc_no,
                "match": False,
                "status": "ERROR",
                "reason": f"Metadata file not found for {doc_no}.",
                "validation_result": {
                    "comparisons": [],
                    "match_count": 0,
                    "reason_for_failure": "Processing error"
                }
            }

        with open(meta_path, "r", encoding="utf-8") as f:
            metadata_content = f.read()

        # Fingerprint of the actual prompt inputs — invalidates the cache when
        # either the EC entry or the extracted metadata changes between runs.
        current_inputs_hash = _inputs_hash(ec_entry, metadata_content)

        # CACHE OPTIMIZATION: Check if result already exists.
        # The cached file historically stored only the raw `validation_data` (the
        # LLM JSON), so older entries are missing the wrapper fields the
        # frontend needs (document_number, file_path, match). We detect that
        # shape and re-wrap, and we also short-circuit only when no further
        # work (visual debugging) is required.
        base_name = os.path.splitext(os.path.basename(file_path))[0]
        cache_path = os.path.join(self.output_dir, f"{base_name}_validation.json")
        marked_pdf_path_check = os.path.join(self.output_dir, "matched_docs", os.path.basename(file_path))
        marked_pdf_exists = os.path.exists(marked_pdf_path_check)

        if os.path.exists(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    cached_raw = json.load(f)

                # If the cache was written with a different inputs_hash, the EC
                # entry or the extracted metadata.txt has changed since — drop
                # the cache and re-validate. Caches written before this field
                # existed are treated as legacy and always re-validated to
                # avoid serving a stale mismatch.
                cached_hash = cached_raw.get("inputs_hash") if isinstance(cached_raw, dict) else None
                if cached_hash != current_inputs_hash:
                    print(f"[*] Cache invalid (inputs changed) for {doc_no}; re-validating.")
                    raise ValueError("cache-stale")

                # Detect legacy cache shape (raw validation_data) vs full result wrapper.
                if "validation_result" in cached_raw and "document_number" in cached_raw:
                    cached_validation_data = cached_raw.get("validation_result", {})
                    cached_result = cached_raw
                else:
                    cached_validation_data = cached_raw
                    cached_result = None

                # Decide if we still need to do visual debug work. Use the
                # same loose mismatch test as below so cached results with
                # statuses like "NOT MATCHED (CRITICAL)" still trigger a
                # visual debug pass when the marked PDF is missing.
                def _is_mismatch_str(s: str) -> bool:
                    s = (s or "").upper()
                    return "NOT MATCHED" in s or "NOT_MATCHED" in s or ("NOT" in s and "MATCH" in s)

                has_unmatched = any(
                    _is_mismatch_str(c.get("status"))
                    for c in cached_validation_data.get("comparisons", [])
                )
                needs_visual_debug = visual_debug and has_unmatched and not marked_pdf_exists

                if cached_result is not None and not needs_visual_debug:
                    print(f"[*] Reusing cached validation (full) for {doc_no}...")
                    return cached_result

                if not needs_visual_debug:
                    # Legacy cache: rebuild the wrapper fields that the API/UI expect
                    # so the frontend can locate the (already annotated) PDF.
                    print(f"[*] Reusing cached validation (rewrapped) for {doc_no}...")
                    display_path = marked_pdf_path_check if marked_pdf_exists else file_path
                    p = display_path.replace('\\', '/')
                    if p.startswith("outputs/"):
                        relative_path = os.path.relpath(display_path, start="outputs")
                    elif p.startswith("inputs/"):
                        relative_path = "../input-files/" + os.path.relpath(display_path, start="inputs")
                    else:
                        relative_path = display_path
                    rebuilt = {
                        "document_number": doc_no,
                        "validation_result": cached_validation_data,
                        "match": cached_validation_data.get("match", False),
                        "file_path": relative_path,
                    }
                    # Persist the rewrapped form so subsequent reads are correct.
                    try:
                        with open(cache_path, "w", encoding="utf-8") as f:
                            json.dump(rebuilt, f, indent=2, ensure_ascii=False)
                    except Exception:
                        pass
                    return rebuilt

                # Otherwise fall through: we have cached LLM data but need to run
                # the visual debugger to produce the marked PDF, then return.
                print(f"[*] Cached validation found for {doc_no} but marked PDF missing - running visual debugger only.")
                validation_data = cached_validation_data
                match_status = validation_data.get("match", False)
                # Skip the LLM call entirely; jump to the visual-debug pass below.
                return self._finalize_with_visual_debug(
                    doc_no=doc_no,
                    file_path=file_path,
                    filename=filename,
                    validation_data=validation_data,
                    match_status=match_status,
                    visual_debug=True,
                    inputs_hash=current_inputs_hash,
                )
            except Exception as e:
                print(f"[!] Error reading cache: {e}. Re-validating...")

        # Construct Prompt
        prompt = construct_validation_prompt(ec_entry, metadata_content)

        # Call LLM
        print(f"[*] Validating {doc_no} via Gemini...")
        response_text = self.query_gemini(prompt)

        # Extract JSON from response
        json_match = re.search(r"\{.*\}", response_text, re.DOTALL)
        validation_data = {}
        if json_match:
            try:
                validation_data = json.loads(json_match.group(0))
            except json.JSONDecodeError:
                print(f"[!] Failed to parse JSON for {doc_no}")
                validation_data = {
                    "error": "Failed to parse JSON",
                    "raw_response": response_text,
                    "comparisons": [],
                    "match_count": 0
                }
        else:
            validation_data = {
                "error": "No JSON found",
                "raw_response": response_text,
                "comparisons": [],
                "match_count": 0
            }

        match_status = validation_data.get("match", False)
        print(f"   > Match: {match_status}")

        return self._finalize_with_visual_debug(
            doc_no=doc_no,
            file_path=file_path,
            filename=filename,
            validation_data=validation_data,
            match_status=match_status,
            visual_debug=visual_debug,
            inputs_hash=current_inputs_hash,
        )

    def _finalize_with_visual_debug(
        self,
        doc_no: str,
        file_path: str,
        filename: str,
        validation_data: Dict,
        match_status: bool,
        visual_debug: bool,
        inputs_hash: str = "",
    ) -> Dict:
        """
        Runs the visual debugger over any NOT-MATCHED comparisons (when enabled),
        computes the frontend-relative file path, persists the wrapped result, and
        returns it. Centralized so the cache path can reuse the same logic.
        """
        # Treat any status containing "NOT MATCHED" as a mismatch worth marking.
        # Gemini's prompt allows "NOT MATCHED", "NOT MATCHED (CRITICAL)", etc.,
        # and the frontend already uses `includes("NOT")` to flag them — the
        # backend must agree, otherwise the visual debugger silently skips
        # anything that isn't an exact-string "NOT MATCHED".
        def _is_mismatch(s: str) -> bool:
            s = (s or "").upper()
            return "NOT MATCHED" in s or "NOT_MATCHED" in s or ("NOT" in s and "MATCH" in s)

        mismatches_to_debug = []
        # Placeholder strings that aren't real content. We never SKIP on
        # these; instead we fall through to the next best search term.
        _PLACEHOLDER = {"", "...", "n/a", "na", "none", "null", "not found", "unknown"}

        def _is_placeholder(v):
            return not v or str(v).strip().lower() in _PLACEHOLDER

        for comparison in validation_data.get("comparisons", []):
            status = comparison.get("status", "")
            if not _is_mismatch(status):
                continue
            field = comparison.get("field")
            # Search-term selection order:
            #   1. metadata_value — what was extracted from the deed.
            #   2. ec_value       — what the EC says the deed should say.
            #   3. field          — the label itself, so Gemini at least
            #                       locates the section on the page.
            # Deeds always contain the value somewhere, so we NEVER skip.
            val = comparison.get("metadata_value")
            if _is_placeholder(val):
                val = comparison.get("ec_value")
            if _is_placeholder(val):
                val = field  # last resort — find the labelled section
            pg = comparison.get("page_number", "")
            if visual_debug:
                print(f"   [!] Issue detected in {field} ({status}).")
                mismatches_to_debug.append({"field": field, "value": val, "page_info": pg})
            else:
                print(f"   [!] Issue detected in {field} ({status}). Visual debug skipped.")

        coverage_report = None
        if mismatches_to_debug:
            print(f"   [*] Batch processing {len(mismatches_to_debug)} mismatches for {doc_no}...")
            try:
                # Drain the generator so the marked PDF is actually written to disk.
                for msg in self.visual_debugger.debug_mismatches_batch(
                    pdf_path=file_path,
                    doc_no=doc_no,
                    mismatches=mismatches_to_debug,
                ):
                    print(f"   [VD] {msg}")
                coverage_report = getattr(self.visual_debugger, "last_coverage_report", None)
            except Exception as ve:
                import traceback
                print(f"   [!] Visual Debugger batch failed for {doc_no}: {ve}")
                traceback.print_exc()

        output_name = os.path.basename(file_path)
        marked_pdf_path = os.path.join(self.output_dir, "matched_docs", output_name)
        display_path = marked_pdf_path if os.path.exists(marked_pdf_path) else file_path

        # Convert to a path the /files/{key} or /input-files/{key} endpoint
        # can resolve to an S3 presigned URL.
        #   - /files/{key} → outputs/{key} in the bucket
        #   - /input-files/{key} → inputs/{key} in the bucket
        # Local scratch under tmp/work/validate/<rid>/... mirrors S3 key
        # outputs/validate/<rid>/..., so we strip the tmp/work/ prefix.
        p = display_path.replace('\\', '/').lstrip('./')
        if p.startswith("tmp/work/"):
            # tmp/work/validate/<rid>/... -> validate/<rid>/... (served by /files)
            relative_path = p[len("tmp/work/"):]
        elif p.startswith("outputs/"):
            relative_path = p[len("outputs/"):]
        elif p.startswith("inputs/"):
            relative_path = "../input-files/" + p[len("inputs/"):]
        else:
            relative_path = p

        annotated = os.path.exists(marked_pdf_path)
        if visual_debug:
            if annotated:
                print(f"   [+] Visual debug: marked PDF written to {marked_pdf_path}")
            else:
                # Most common cause: every NOT-MATCHED comparison was missing
                # a usable page_number, so visual_debugger.debug_mismatches_batch
                # had nothing to draw. Surface the diagnostic instead of silently
                # serving an unannotated PDF.
                print(
                    f"   [!] Visual debug: NO marked PDF produced for {doc_no} "
                    f"({len(mismatches_to_debug)} mismatch(es) queued). "
                    f"Check that comparisons include a page_number Gemini could resolve."
                )

        result = {
            "document_number": doc_no,
            "validation_result": validation_data,
            "match": match_status,
            "file_path": relative_path,
            "annotated": annotated,
            "inputs_hash": inputs_hash,
            # Per-page audit of which mismatches actually got a bounding box
            # on the marked PDF. None when nothing was queued for visual
            # debugging. Useful for the UI to flag missed boxes.
            "vd_coverage": coverage_report,
        }

        # Persist the FULL wrapped result (not just validation_data) so that
        # subsequent cache hits can return the same shape the frontend expects.
        res_path = os.path.join(
            self.output_dir, os.path.splitext(filename)[0] + "_validation.json"
        )
        try:
            with open(res_path, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[!] Failed to persist validation cache: {e}")

        return result
