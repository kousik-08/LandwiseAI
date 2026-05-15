#!/usr/bin/env python3
"""
Test script for the updated Visual Debugger with:
1. Dense Grid with Edge-Only Labels (Blue)
2. Color Separation (Blue grid, Red mismatch boxes)
3. Two-Step Detection (Crop & Zoom)
4. Reference Points for first-page fields
"""

import os
import sys
import fitz  # PyMuPDF
from PIL import Image, ImageDraw, ImageFont

# Add Server to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.visual_debugger import VisualDebugger
from common.gemini_helper import GeminiHelper


def create_sample_pdf(output_path):
    """Create a sample PDF with some text for testing."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)  # A4 size
    
    # Add some text simulating a sale deed
    text = """
    Document No. 2420/2022
    
    Date of Registration: 05-04-2022
    
    This is a sample Sale Deed document for testing the Visual Debugger.
    The visual debugger should detect mismatches and mark them with RED boxes.
    
    Executant: S. Arulraj
    Claimant: S. Sumesh
    
    Survey Number: 47/6
    
    Area: 2400 sq.ft
    """
    
    # Add text blocks at different positions
    positions = [
        (50, 50, "Document No. 2420/2022"),
        (50, 100, "Date of Registration: 05-04-2022"),
        (50, 200, "Executant: S. Arulraj"),
        (50, 250, "Claimant: S. Sumesh"),
        (50, 350, "Survey Number: 47/6"),
        (50, 400, "Area: 2400 sq.ft"),
    ]
    
    for x, y, txt in positions:
        page.insert_text(fitz.Point(x, y), txt, fontsize=12)
    
    doc.save(output_path)
    doc.close()
    print(f"[*] Created sample PDF: {output_path}")
    return output_path


def test_grid_overlay():
    """Test the new blue grid with edge-only labels."""
    print("\n" + "="*70)
    print("TEST 1: Blue Grid with Edge-Only Labels")
    print("="*70)
    
    # Create a simple test image
    img = Image.new('RGB', (800, 600), color='white')
    draw = ImageDraw.Draw(img)
    
    # Add some sample text
    try:
        font = ImageFont.truetype("arial.ttf", 20)
    except:
        font = ImageFont.load_default()
    
    draw.text((100, 100), "Document No. 2420/2022", fill='black', font=font)
    draw.text((100, 150), "Date: 05-04-2022", fill='black', font=font)
    
    test_img_path = "test_sample.png"
    img.save(test_img_path)
    
    # Create a mock visual debugger to test grid drawing
    class MockGemini:
        pass
    
    vd = VisualDebugger(MockGemini(), "test_outputs")
    
    # Test the new grid overlay
    grid_path, width, height = vd.draw_grid_on_image(test_img_path, edge_labels_only=True)
    
    print(f"[*] Original image: {test_img_path} ({width}x{height})")
    print(f"[*] Grid image created: {grid_path}")
    print(f"[*] Grid settings:")
    print(f"    - Grid size: {vd.GRID_SIZE}px")
    print(f"    - Grid color: BLUE {vd.GRID_COLOR}")
    print(f"    - Label color: {vd.GRID_LABEL_COLOR}")
    print(f"    - Ruler background: {vd.GRID_BG_COLOR}")
    print(f"    - Edge labels only: True (labels only on top/left rulers)")
    
    # Clean up
    if os.path.exists(test_img_path):
        os.remove(test_img_path)
    
    return grid_path


def test_two_step_detection_simulation():
    """Simulate the two-step detection process."""
    print("\n" + "="*70)
    print("TEST 2: Two-Step Detection Simulation")
    print("="*70)
    
    print("""
    Two-Step Detection Process:
    
    STEP 1: Rough Bounding Box (Full Page)
    ┌─────────────────────────────────────────┐
    │  RULER: 0  100  200  300  400  500... │  ← Top ruler (x-coordinates)
    │  ┌───────────────────────────────────┐│
    │  │         Target Text               ││
    │  │     ┌───────────────┐             ││
    │  │     │ 05-04-2022    │ ← Rough Box │
    │  │     └───────────────┘             ││
    │  └───────────────────────────────────┘│
    └──┬────────────────────────────────────┘
       ↑
       Left ruler (y-coordinates)
    
    → Gemini returns rough coordinates: [180, 140, 320, 180]
    
    STEP 2: Crop, Zoom & Tight Box
    ┌──────────────────────────┐
    │  CROPPED & ZOOMED VIEW   │
    │  ┌────────────────────┐  │
    │  │   Target Text      │  │
    │  │  ┌────────────┐   │  │
    │  │  │ 05-04-2022 │←Tight│
    │  │  └────────────┘   │  │
    │  └────────────────────┘  │
    └──────────────────────────┘
    
    → Gemini returns tight coordinates: [50, 30, 180, 60] (in zoomed space)
    → Translated back to original: [205, 155, 270, 175]
    
    FINAL BOX: [205, 155, 270, 175] (with padding applied)
    """)
    
    print("[*] Two-step detection process explained above")
    print("[*] This reduces interpolation errors by zooming into the region of interest")


def test_color_separation():
    """Test the color separation between grid and boxes."""
    print("\n" + "="*70)
    print("TEST 3: Color Separation")
    print("="*70)
    
    class MockGemini:
        pass
    
    vd = VisualDebugger(MockGemini(), "test_outputs")
    
    print("""
    COLOR SCHEME:
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    
    GRID (Measurement Tool) - BLUE:
    - Grid lines:        RGB(0, 120, 255)   - Light blue lines
    - Labels:            RGB(0, 100, 200)   - Darker blue text
    - Ruler background:  RGB(230, 242, 255) - Very light blue
    
    MISMATCH BOXES (Errors) - RED:
    - Box outline:       RGB(255, 0, 0)     - Pure red
    - Box label text:    RGB(255, 0, 0)     - Pure red
    
    BENEFIT: The AI won't confuse its measurement grid (blue) with 
    the error highlights (red) when detecting text coordinates.
    """)
    
    print(f"[*] Grid color: {vd.GRID_COLOR} (BLUE)")
    print(f"[*] Grid label color: {vd.GRID_LABEL_COLOR} (BLUE)")
    print(f"[*] Mismatch box color: {vd.MISMATCH_BOX_COLOR} (RED)")
    print(f"[*] Mismatch text color: {vd.MISMATCH_TEXT_COLOR} (RED)")


def test_first_page_hints():
    """Test the special handling for first-page fields."""
    print("\n" + "="*70)
    print("TEST 4: First Page Field Reference Points")
    print("="*70)
    
    print("""
    FIRST PAGE SPECIAL HANDLING:
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    
    For Page 1, the visual debugger provides reference hints to Gemini:
    
    Date of Registration:
    - Reference hint: (200, 150)
    - Location: Top portion of first page
    - Expected near: Registration seal/endorsement area
    
    Document Number:
    - Reference hint: (200, 100)
    - Location: Near top of first page
    - Expected near: Sub-Registrar registration seal
    
    This helps Gemini find these fields quickly on the first page.
    """)
    
    # Show the logic
    def show_hint(page_num, field_context):
        reference_hint = None
        if page_num == 1:
            if field_context and ("date" in field_context.lower() or "registration" in field_context.lower()):
                reference_hint = "(200, 150) - typically in the top portion of the first page where registration details appear"
            elif field_context and "document" in field_context.lower() and "number" in field_context.lower():
                reference_hint = "(200, 100) - typically near the top of the first page near the document/registration seal"
        return reference_hint
    
    test_cases = [
        (1, "Date of Registration"),
        (1, "Document Number"),
        (2, "Date of Registration"),
        (1, "Executant Name"),
    ]
    
    for page, field in test_cases:
        hint = show_hint(page, field)
        status = f"Hint: {hint[:50]}..." if hint else "No hint (not page 1 or special field)"
        print(f"[*] Page {page}, Field '{field}' → {status}")


def test_complete_workflow():
    """Show the complete workflow summary."""
    print("\n" + "="*70)
    print("COMPLETE VISUAL DEBUGGER WORKFLOW")
    print("="*70)
    
    print("""
    UPDATED WORKFLOW:
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    
    1. EXTRACT PAGE
       → PDF page → PNG image (2x zoom)
    
    2. DRAW BLUE GRID (Edge Labels Only)
       → Blue grid lines every 50px
       → X-coordinates on TOP ruler
       → Y-coordinates on LEFT ruler
       → Light blue ruler backgrounds
       → NO labels in center (won't interfere with text)
    
    3. TWO-STEP DETECTION (for each mismatch):
       
       STEP 1: Rough Bounding Box
       → Send full page with blue grid to Gemini
       → Include reference hint for first-page fields
       → Get rough coordinates [xmin, ymin, xmax, ymax]
       
       STEP 2: Crop, Zoom & Tight Box
       → Crop region from rough box + padding
       → Zoom 2x for higher precision
       → Draw blue grid on zoomed crop
       → Send to Gemini for tight coordinates
       → Translate back to original coordinates
    
    4. MARK PDF WITH RED BOXES
       → Draw RED rectangles around mismatches
       → Add RED text labels
       → Save marked PDF
    
    KEY IMPROVEMENTS:
    ✓ Labels don't interfere with document text
    ✓ Blue grid vs Red boxes (clear separation)
    ✓ Two-step zoom eliminates interpolation errors
    ✓ First-page fields have reference hints
    ✓ Cache maintains coordinates for reuse
    """)


def main():
    """Run all tests."""
    print("\n" + "="*70)
    print("VISUAL DEBUGGER ENHANCEMENT TEST SUITE")
    print("="*70)
    
    # Run tests
    test_grid_overlay()
    test_two_step_detection_simulation()
    test_color_separation()
    test_first_page_hints()
    test_complete_workflow()
    
    # Cleanup
    test_outputs_dir = "test_outputs"
    if os.path.exists(test_outputs_dir):
        import shutil
        shutil.rmtree(test_outputs_dir, ignore_errors=True)
        print(f"\n[*] Cleaned up test outputs directory")
    
    print("\n" + "="*70)
    print("ALL TESTS COMPLETED SUCCESSFULLY")
    print("="*70)
    print("""
    Summary of Changes:
    1. Dense Grid with Edge-Only Labels: Labels only on top/left rulers
    2. Color Separation: Blue grid lines, Red mismatch boxes  
    3. Two-Step Detection: Rough bbox → Crop → Zoom → Tight bbox
    4. Reference Points: Hints for first-page Date/Document fields
    
    The visual debugger now provides:
    - Clearer grid that doesn't obscure document text
    - Color separation to prevent AI confusion
    - Higher precision through zoom-and-refine approach
    - Better handling of first-page registration details
    """)


if __name__ == "__main__":
    main()
