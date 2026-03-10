import json
import os
import re
from typing import List, Dict
from common.gemini_helper import GeminiHelper
from prompts.validation_prompts import construct_validation_prompt
from api.validate.visual_debugger import VisualDebugger


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
        ec_lookup = {entry.get("document_number"): entry for entry in ec_data}

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
            ec_lookup = {entry.get("document_number"): entry for entry in ec_data}

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
                "reason": f"Document number {doc_no} not found in EC records."
            }

        # Find Metadata File
        filename = os.path.basename(file_path)
        meta_filename = os.path.splitext(filename)[0] + "_metadata.txt"
        meta_path = os.path.join(self.output_dir, meta_filename)

        if not os.path.exists(meta_path):
            print(f"[!] Metadata file not found: {meta_path}")
            return {}

        with open(meta_path, "r", encoding="utf-8") as f:
            metadata_content = f.read()

        # CACHE OPTIMIZATION: Check if result already exists
        base_name = os.path.splitext(os.path.basename(file_path))[0]
        cache_path = os.path.join(self.output_dir, f"{base_name}_validation.json")
        if os.path.exists(cache_path):
            print(f"[*] Reusing cached validation for {doc_no}...")
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    return json.load(f)
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
                }
        else:
            validation_data = {
                "error": "No JSON found",
                "raw_response": response_text,
            }

        match_status = validation_data.get("match", False)
        print(f"   > Match: {match_status}")

        # Trigger Visual Debugger if any field in comparisons is NOT MATCHED
        for comparison in validation_data.get("comparisons", []):
            status = comparison.get("status", "")
            if status == "NOT MATCHED":
                field = comparison.get("field")
                val = comparison.get("metadata_value")
                pg = comparison.get("page_number", "")

                if visual_debug:
                    print(f"   [!] Issue detected in {field} ({status}). Generating visual debug PDF...")
                    try:
                        # For parallel calls, we don't yield here as it's not a generator
                        # We just let it run
                        list(self.visual_debugger.debug_mismatch(
                            pdf_path=file_path,
                            doc_no=doc_no,
                            field=field,
                            mismatch_value=val,
                            page_info=pg,
                        ))
                    except Exception as ve:
                        print(f"   [!] Visual Debugger failed for {field}: {ve}")
                else:
                    print(f"   [!] Issue detected in {field} ({status}). Visual debug skipped.")

        # Determine final display path. 
        # If visual debug marked a PDF, use that one (in outputs/validate/ID/matched_docs/)
        output_name = os.path.basename(file_path)
        marked_pdf_path = os.path.join(self.output_dir, "matched_docs", output_name)
        
        display_path = marked_pdf_path if os.path.exists(marked_pdf_path) else file_path

        # Convert to a path relative to the server mounts for the frontend
        try:
            # Standardize separators for comparison
            p = display_path.replace('\\', '/')
            if p.startswith("outputs/"):
                relative_path = os.path.relpath(display_path, start="outputs")
            elif p.startswith("inputs/"):
                # Use our special mount point for input files
                relative_path = "../input-files/" + os.path.relpath(display_path, start="inputs")
            else:
                relative_path = display_path
        except ValueError:
            relative_path = display_path

        result = {
            "document_number": doc_no,
            "validation_result": validation_data,
            "match": match_status,
            "file_path": relative_path,
        }

        # Save individual result
        res_path = os.path.join(
            self.output_dir, os.path.splitext(filename)[0] + "_validation.json"
        )
        with open(res_path, "w", encoding="utf-8") as f:
            json.dump(validation_data, f, indent=2, ensure_ascii=False)
            
        return result

        return results
