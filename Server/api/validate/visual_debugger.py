import os
import re
import fitz  # PyMuPDF
from PIL import Image, ImageDraw, ImageFont
from common.gemini_helper import GeminiHelper
import threading

class VisualDebugger:
    """
    Handles marking discrepancies in PDFs using Gemini-assisted coordinate extraction.
    """

    def __init__(self, gemini_helper: GeminiHelper, output_dir: str):
        self.gemini = gemini_helper
        self.output_dir = output_dir
        self.temp_dir = os.path.join(output_dir, "temp_debug")
        self.lock = threading.Lock()
        os.makedirs(self.temp_dir, exist_ok=True)

    def extract_page_as_image(self, pdf_path, page_num, output_image_path):
        """
        Extracts a specific page from a PDF and saves it as an image.
        """
        doc = fitz.open(pdf_path)
        if page_num < 1:
            print(f"[*] Page {page_num} corrected to 1")
            page_num = 1
        if page_num > len(doc):
            print(f"[!] Error: Page {page_num} out of range for {pdf_path}")
            return None

        page = doc.load_page(page_num - 1)
        # Using matrix (2,2) for 2x zoom to ensure text is readable for the LLM
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
        pix.save(output_image_path)
        doc.close()
        return output_image_path

    def draw_grid_on_image(self, image_path, grid_size=50):
        """
        Draws a 50px grid (for higher precision) and labels every intersection point (x, y)
        on the image for better LLM coordinate precision.
        """
        with Image.open(image_path) as img:
            img = img.convert("RGB")
            draw = ImageDraw.Draw(img)
            width, height = img.size

            font = ImageFont.load_default()

            # Draw lines and labels
            for x in range(0, width, grid_size):
                draw.line([(x, 0), (x, height)], fill=(220, 220, 220), width=1)
            for y in range(0, height, grid_size):
                draw.line([(0, y), (width, y)], fill=(220, 220, 220), width=1)

            for x in range(0, width, grid_size):
                for y in range(0, height, grid_size):
                    # Label every 100px to avoid clutter, but keep grid at 50px
                    if x % 100 == 0 and y % 100 == 0:
                        label = f"({x},{y})"
                        draw.text((x + 2, y + 2), label, fill="red", font=font)

            grid_image_path = image_path.replace(".png", "_grid.png")
            img.save(grid_image_path)
            return grid_image_path, width, height

    def get_grid_coordinates_from_gemini(self, grid_image_path, search_text, field_context=None):
        """
        Asks Gemini for coordinates based on the pixel grid.
        """
        context_str = f" for the field '{field_context}'" if field_context else ""
        prompt = f"""
        Find the exact location of the information: "{search_text}"{context_str}.
        
        Analyze the document image. The grid lines are spaced exactly 50 pixels apart.
        Even if the text is blurry or formatted slightly differently (e.g. "1200 + 1200 = 2400"), identify the specific segment that represents this value.
        
        Using the coordinate labels provided at the grid intersections, provide the 
        bounding box [top, left, bottom, right] as absolute pixel coordinates that TIGHTLY and ACCURATELY encloses only this text.
        
        Return ONLY the list: [ymin, xmin, ymax, xmax]
        """
        try:
            # Note: generate_from_file uploads the file internally
            response_text = self.gemini.generate_from_file(
                grid_image_path, prompt, display_name="Grid Analysis"
            )
            match = re.search(r"\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]", response_text)
            if match:
                coords = [int(x) for x in match.groups()]
                print(f"[*] Visual Intelligence: Found coords {coords} for '{search_text}'")
                # Tightened offsets for better precision
                return [coords[0] - 30, coords[1] - 40, coords[2] + 25, coords[3] + 40]
            else:
                print(f"[!] Visual Intelligence: Gemini failed to find coordinates for '{search_text}'. Response: {response_text[:100]}...")
        except Exception as e:
            print(f"[!] Error in Gemini grid analysis: {e}")
        return None

    def mark_pdf_with_box(
        self, pdf_path, page_num, pixel_box, img_width, img_height, output_pdf_path, **kwargs
    ):
        """
        Draws the red box directly onto the PDF page.
        """
        with self.lock:
            # Close existing doc if open (PyMuPDF usually handles this but safety first)
            doc = fitz.open(pdf_path)
            page = doc.load_page(page_num - 1)

            pdf_width = page.rect.width
            pdf_height = page.rect.height

            ymin, xmin, ymax, xmax = pixel_box

            scale_x = pdf_width / img_width
            scale_y = pdf_height / img_height

            rect = fitz.Rect(xmin * scale_x, ymin * scale_y, xmax * scale_x, ymax * scale_y)
            page.draw_rect(rect, color=(1, 0, 0), width=2)
            
            # Add a small label above the box
            label = kwargs.get("label", "Mismatch")
            text_point = fitz.Point(xmin * scale_x, (ymin * scale_y) - 5)
            page.insert_text(text_point, label, color=(1, 0, 0), fontsize=10)

            if pdf_path == output_pdf_path:
                # Safe in-place update to avoid issues with open file
                temp_path = str(output_pdf_path) + ".tmp"
                doc.save(temp_path)
                doc.close()
                os.replace(temp_path, output_pdf_path)
            else:
                doc.save(output_pdf_path)
                doc.close()

    def debug_mismatch(self, pdf_path, doc_no, field, mismatch_value, page_info):
        """
        Orchestrates the visualization of a single mismatch.
        Yields progress messages.
        Returns the output path (via StopIteration).
        """
        page_match = re.search(r"Page\s*(\d+)", page_info)
        if not page_match:
            return None

        page_num = int(page_match.group(1))
        if page_num < 1:
            print(f"[*] Warning: LLM provided 0-indexed page {page_num}. Correcting to 1.")
            page_num = 1

        # Sanitize doc_no for filename
        clean_doc_no = doc_no.replace("/", "_").replace("\\", "_")

        # 1. Extract Page
        base_img = os.path.join(self.temp_dir, f"raw_{clean_doc_no}_p{page_num}.png")
        if not self.extract_page_as_image(pdf_path, page_num, base_img):
            return None

        # 2. Draw Grid
        yield f"Creating grid for {doc_no} (Page {page_num})"
        grid_img, img_w, img_h = self.draw_grid_on_image(base_img)

        # 3. Get Coords
        yield f"Checking with Gemini for mismatched field: {field}"
        pixel_box = self.get_grid_coordinates_from_gemini(grid_img, mismatch_value, field_context=field)

        if pixel_box:
            # 4. Mark PDF directly in the matched_docs directory with original name
            output_name = os.path.basename(pdf_path)
            output_path = os.path.join(self.output_dir, "matched_docs", output_name)

            # Ensure directory exists just in case
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            
            # If the output file already exists (from a previous mismatch marking), use it as the source
            # to ensure we accumulate boxes instead of overwriting with only the last one.
            active_source = output_path if os.path.exists(output_path) else pdf_path

            self.mark_pdf_with_box(
                active_source, page_num, pixel_box, img_w, img_h, output_path, label=field
            )
            return output_path

        return None
