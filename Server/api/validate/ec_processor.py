import os
import re
import json
import fitz # PyMuPDF
from typing import List, Dict, Any
from pypdf import PdfReader
from common.gemini_helper import GeminiHelper
from prompts.ec_prompts import RAW_PROMPT
from prompts.ec_analysis_prompts import EC_ANALYSIS_PROMPT


class ECProcessor:
    """
    Handles extraction and parsing of Encumbrance Certificate (EC) data.
    """

    def __init__(self, output_dir: str = "outputs", chunk_size: int = 5):
        self.output_dir = output_dir
        self.chunk_size = chunk_size
        self.gemini = GeminiHelper(model_id="gemini-2.5-flash-lite")
        os.makedirs(self.output_dir, exist_ok=True)

    def _extract_field(self, block: str, field: str) -> str:
        m = re.search(rf"{field}\s*:\s*(.*)", block, re.IGNORECASE)
        return m.group(1).strip() if m else "N/A"

    def _split_names(self, text: str) -> List[str]:
        if not text or text.lower() in ["n/a", "none", "", "missing", "not available"]:
            return []
        if re.search(r"(?:^|\s|,)\d+\.", text):
            parts = re.split(r"(?:^|\s|,)\d+\.\s*", text)
        else:
            parts = [text]
        final_parts = []
        for p in parts:
            if not p.strip():
                continue
            sub_parts = re.split(r",|\band\b", p)
            for sp in sub_parts:
                name = sp.strip()
                if not name:
                    continue
                name = re.sub(r"\(\d+\)", "", name)
                name = re.sub(r"\.{2,}", ".", name)
                name = name.strip(" -.")
                if name:
                    final_parts.append(name)
        return final_parts

    def extract_raw(self, pdf_path: str):
        """
        Extracts raw text from PDF using Gemini in chunks.
        Yields progress messages.
        Returns the full raw text.
        """
        pages = []
        with fitz.open(pdf_path) as doc:
            for page in doc:
                pages.append(page.get_text() or "")
        raw_blocks = []

        print(f"[*] Starting EC extraction for: {pdf_path}")
        total_chunks = (len(pages) + self.chunk_size - 1) // self.chunk_size

        for i in range(0, len(pages), self.chunk_size):
            chunk_num = i // self.chunk_size + 1
            msg = f"Processing EC Chunk {chunk_num} / {total_chunks}..."
            print(f"    -> {msg}")
            yield msg

            chunk_text = "\n".join(pages[i : i + self.chunk_size])
            response = self.gemini.generate_from_text(chunk_text, RAW_PROMPT)
            raw_blocks.append(response)

        raw_text = "\n".join(raw_blocks)
        raw_cache = os.path.join(self.output_dir, "ec_raw_full.txt")
        with open(raw_cache, "w", encoding="utf-8") as f:
            f.write(raw_text)
        return raw_text

    def parse_to_json(self, raw_text: str) -> List[Dict[str, Any]]:
        """
        Parses raw text blocks into structured JSON.
        """
        blocks = re.findall(
            r"--- TRANSACTION START ---.*?--- TRANSACTION END ---", raw_text, flags=re.S
        )
        transactions: List[Dict[str, Any]] = []
        for block in blocks:
            # Base transaction structure for this EC entry
            base_tx: Dict[str, Any] = {
                "document_number": self._extract_field(block, "Document No"),
                "date": self._extract_field(block, "Date"),
                "nature_of_document": self._extract_field(
                    block, "Nature of Document"
                ),
                "property_type": self._extract_field(block, "Nature of the land"),
                "sellers": self._split_names(self._extract_field(block, "Sellers")),
                "buyers": self._split_names(self._extract_field(block, "Buyers")),
                "property_extent": self._extract_field(block, "Extent"),
                "consideration": self._extract_field(block, "Consideration"),
                "market_value": self._extract_field(block, "Market Value"),
            }

            # Survey number can contain multiple entries for the same document like "13, 13/2, 13/3A".
            survey_raw = self._extract_field(block, "Survey No")
            # Split by common delimiters, but keep full tokens including subdivision (e.g., "13/2").
            survey_parts = [
                s.strip()
                for s in re.split(r"[;,]", survey_raw)
                if s.strip()
            ] or [survey_raw]

            def normalize_sn(s: str) -> str:
                # Remove common noise like " - 3 ACRE", "(Part)", whitespace, etc.
                s = re.sub(r"\s*-\s*.*$", "", s) # Remove everything after hyphen
                s = re.sub(r"\(.*?\)", "", s)    # Remove parenthetical notes
                # Keep only alphanumeric and slash
                s = re.sub(r"[^a-zA-Z0-9/]", "", s)
                return s.strip()

            for sn_raw in survey_parts:
                sn = sn_raw.strip()
                normalized_sn = normalize_sn(sn)
                
                tx = base_tx.copy()
                tx["survey_number"] = normalized_sn
                tx["survey_raw"] = sn
                tx["involved_surveys"] = [normalize_sn(s) for s in survey_parts]

                # Optionally capture base survey and subdivision for downstream use
                if "/" in normalized_sn:
                    base, sub = normalized_sn.split("/", 1)
                    tx["survey_base"] = base.strip()
                    tx["sub_division"] = sub.strip()
                else:
                    tx["survey_base"] = normalized_sn.strip()
                    tx["sub_division"] = None

                transactions.append(tx)

        return transactions


    def analyze_historical_values(self, pdf_path: str):
        """
        Specialized extraction to calculate historical property values from EC.
        Yields progress messages.
        Returns the processed JSON data.
        """
        pages = []
        with fitz.open(pdf_path) as doc:
            for page in doc:
                pages.append(page.get_text() or "")
        
        all_analysis = []
        total_chunks = (len(pages) + self.chunk_size - 1) // self.chunk_size

        print(f"[*] Starting Historical Value Analysis for: {pdf_path}")

        for i in range(0, len(pages), self.chunk_size):
            chunk_num = i // self.chunk_size + 1
            msg = f"Analyzing EC Chunk {chunk_num} / {total_chunks}..."
            print(f"    -> {msg}")
            yield msg

            chunk_text = "\n".join(pages[i : i + self.chunk_size])
            # Use the specialized prompt
            prompt = EC_ANALYSIS_PROMPT.format(input_text=chunk_text)
            response = self.gemini.generate_from_text(chunk_text, prompt)
            
            try:
                # Clean the response in case Gemini adds markdown backticks
                json_str = response.strip()
                if json_str.startswith("```"):
                    json_str = re.sub(r"^```json\s*|\s*```$", "", json_str, flags=re.MULTILINE)
                
                chunk_data = json.loads(json_str)
                if isinstance(chunk_data, list):
                    all_analysis.extend(chunk_data)
            except Exception as e:
                print(f"[!] Error parsing chunk {chunk_num}: {e}")
                # Log the error but continue with other chunks
                continue

        # Save to output directory
        analysis_output_path = os.path.join(self.output_dir, "ec_historical_values.json")
        with open(analysis_output_path, "w", encoding="utf-8") as f:
            json.dump(all_analysis, f, ensure_ascii=False, indent=2)

        print(f"[+] Historical Value Analysis complete. Saved to {analysis_output_path}")
        return all_analysis

    def process(self, pdf_path: str, cache_path: str = None):
        """
        Full EC extraction process. Yields progress messages.
        Returns the final JSON data.
        """
        output_path = os.path.join(self.output_dir, "ec_final.json")

        # Check if final JSON already exists
        if os.path.exists(output_path):
            print(
                f"[*] Found existing EC data: {output_path}. Skipping Gemini extraction."
            )
            try:
                with open(output_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except json.JSONDecodeError:
                print("[!] Existing EC data is corrupt. Re-processing...")

        if cache_path and os.path.exists(cache_path):
            print(f"[*] Using cached EC raw data: {cache_path}")
            with open(cache_path, "r", encoding="utf-8") as f:
                raw_text = f.read()
        else:
            raw_text = yield from self.extract_raw(pdf_path)

        data = self.parse_to_json(raw_text)

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        print(f"[+] EC Processing complete. Saved to {output_path}")
        return data
