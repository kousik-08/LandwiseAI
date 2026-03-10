import os
from common.gemini_helper import GeminiHelper
from prompts.sale_deed_prompts import SALE_DEED_PROMPT


class SaleDeedProcessor:
    """
    Processes matched sale deeds and extracts detailed Tamil metadata.
    """

    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.gemini = GeminiHelper(model_id="gemini-2.5-flash")
        os.makedirs(self.output_dir, exist_ok=True)

    def process_file(self, pdf_path: str) -> str:
        """
        Sends a single PDF to Gemini for processing.
        """
        filename = os.path.basename(pdf_path)
        
        output_filename = os.path.splitext(filename)[0] + "_metadata.txt"
        output_path = os.path.join(self.output_dir, output_filename)

        if os.path.exists(output_path):
             print(f"[*] Found existing metadata for {filename}. Skipping Gemini.")
             with open(output_path, "r", encoding="utf-8") as f:
                 return f.read()

        print(f"[*] Processing Sale Deed: {filename}")

        result = self.gemini.generate_from_file(
            pdf_path, SALE_DEED_PROMPT, display_name=filename
        )

        with open(output_path, "w", encoding="utf-8") as f:
            f.write(result)

        print(f"[OK] Extraction saved to {output_path}")
        return result

    def process_matched_list(self, matched_docs: list):
        """
        Processes a list of matched documents.
        """
        for doc in matched_docs:
            self.process_file(doc["file_path"])
