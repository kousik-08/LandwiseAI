
import os
import fitz  # PyMuPDF
import json
import re
from typing import Dict, Any
from common.gemini_helper import GeminiHelper
from prompts.supporting_prompts import SUPPORTING_DOC_VERIFICATION_PROMPT

class SupportingVerifier:
    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.gemini = GeminiHelper(model_id="gemini-2.5-flash") # Use flash for vision

    def verify(self, deed_metadata: Dict[str, Any], supporting_pdf_path: str) -> Dict[str, Any]:
        """
        Verifies a supporting PDF against deed metadata.
        """
        if not os.path.exists(supporting_pdf_path):
            return {"verified": False, "reason": "Supporting PDF not found"}

        temp_img = None
        try:
            # 1. Extract first page of supporting PDF as image for Gemini
            doc = fitz.open(supporting_pdf_path)
            if len(doc) == 0:
                return {"verified": False, "reason": "PDF is empty"}
            
            page = doc.load_page(0)
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            
            temp_img = os.path.join(self.output_dir, "temp_supporting_verify.png")
            pix.save(temp_img)
            doc.close()

            # 2. Prepare prompt
            metadata_str = json.dumps(deed_metadata, indent=2, ensure_ascii=False)
            prompt = SUPPORTING_DOC_VERIFICATION_PROMPT.format(deed_metadata=metadata_str)

            # 3. Query Gemini with image
            response_text = self.gemini.generate_from_file(temp_img, prompt)
            
            # 4. Parse response
            json_match = re.search(r"\{.*\}", response_text, re.DOTALL)
            if json_match:
                return json.loads(json_match.group(0))
            else:
                return {
                    "verified": False, 
                    "reason": "Failed to parse verification results",
                    "raw": response_text
                }

        except Exception as e:
            print(f"[!] Error in SupportingVerifier: {e}")
            return {"verified": False, "reason": str(e)}
        finally:
            if os.path.exists(temp_img):
                try: os.remove(temp_img)
                except: pass
