# Visual Debugger Redesign — Native Bounding Box + Verification

**Date:** 2026-05-13
**Owner:** Visual Debugger module ([Server/api/validate/visual_debugger.py](../../../Server/api/validate/visual_debugger.py))
**Status:** Proposed (awaiting user approval)

---

## 1. Problem

The current visual debugger draws bounding boxes on document values that the validator flagged as `NOT MATCHED`. Deeds in this corpus mix three text renditions on the same page:

- **Typed** — machine-printed body text, table cells, printed registrar fields
- **Handwritten** — Tamil/English margin notes, signatures, endorsements
- **Sealed/stamped** — round registrar seals, date stamps, document-number stamps (often with curved text)

The current pipeline (Tesseract fast-path → blue grid overlay → Gemini ruler-interpolation → ink-trim) fails on the non-typed renditions and frequently produces drifted or fabricated boxes.

### 1.1 Observed failures

Validated against `outputs/validate/69a95897-…/temp_debug/marked_pages/`:

| Failure | Evidence |
|---|---|
| Box drifts 50–200 px off the actual value | Multiple marked pages show the red box adjacent to the value, not on it |
| Handwritten Tamil values missed entirely | Tesseract returns no tokens for handwriting; Gemini's ruler bbox lands at random page positions |
| Round-seal contents (date, doc no) not located | Curved/circular text breaks both Tesseract and Gemini's bbox interpolation |
| Box drawn even when value isn't on the page | Doc 254/2011: validator says metadata="234/2011" but only "254/2011" exists on the page; a tiny red box was still drawn near the registrar's seal |

### 1.2 Root cause

The grid+ruler scheme is a 2024-era workaround for LLMs that couldn't output coordinates. Gemini 2.5 (Flash and Pro) supports native bounding-box output: ask for `[ymin, xmin, ymax, xmax]` normalized to `0..1000` and the model returns it directly, trained on this format. Asking Gemini to *read its own ruler markings and interpolate* re-introduces the very inaccuracy the rulers were meant to eliminate.

Secondary cause: no verification step. The pipeline trusts the first bbox unconditionally, so when the model hallucinates (or the value genuinely isn't on the page), a misplaced box is drawn.

---

## 2. Goal

Reliably draw a red bounding box on a not-matched value regardless of whether it appears as typed, handwritten, or sealed text — and draw nothing (with a clear log) when the value cannot be located.

### 2.1 Non-goals

- Replacing the validator itself or changing what counts as `NOT MATCHED`
- Adding new OCR engines (PaddleOCR, EasyOCR, CRAFT) — see Section 7 "Alternatives considered"
- Re-rendering or modifying the original PDF beyond drawing rectangles + labels

---

## 3. High-level design

### 3.1 Pipeline

```
mismatch (field, value, page_info)
   │
   ├─► cache lookup ───────────────────► HIT: draw & done
   │
   ├─► Tesseract fast-path (raw PNG) ──► HIT: draw & done (typed only)
   │
   ├─► Gemini native-bbox call (raw PNG, NO grid)
   │     prompt asks for [ymin, xmin, ymax, xmax] in 0..1000
   │     plus rendition: typed | seal | handwritten | not_found
   │
   ├─► If not_found ────────────────────► log "value not located", draw nothing
   │
   ├─► Verification crop
   │     crop = page[bbox ± 20% margin]
   │     ask Gemini: "Does this crop contain '{value}'? yes/no/partial"
   │     no  ─► log + draw nothing
   │     partial ─► widen bbox by 30% and re-verify once
   │     yes ─► continue
   │
   ├─► Ink-snap to tight bounding rect (unchanged from today)
   │
   ├─► Map normalized 0..1000 → pixel grid → PDF points (unchanged math)
   │
   └─► Draw red rect + label "{field} ({rendition})" on PDF
```

### 3.2 What gets deleted

- `draw_grid_on_image` — ~150 lines of grid/ruler/halo Pillow code (no longer needed)
- Grid-related constants: `GRID_SIZE`, `GRID_LABEL_INTERVAL`, `GRID_ALPHA`, `INTERSECTION_FONT_SIZE`, `INTERSECTION_HALO_ALPHA`, `GRID_BG_COLOR`, etc.
- Grid image generation, lazy-grid caching in `page_image_cache["grid_img"]`
- Ruler-based prompt text in `get_grid_coordinates_from_gemini`
- The `intersection_labels` / `edge_labels_only` mode branches

### 3.3 What stays

- `extract_page_as_image` — raster at DPI=200 (unchanged)
- `find_value_with_tesseract` — fast path for typed values (unchanged; this is free and instant when it hits)
- `_trim_bbox_to_ink` — ink-snap post-processing (still useful)
- `mark_pdf_with_boxes` — PDF drawing (unchanged)
- Coordinate cache, page-image cache, batch entry point
- First-page field override (date / survey / executant / claimant on page 1)

### 3.4 What changes shape

- `get_grid_coordinates_from_gemini` → `get_bbox_from_gemini`
  - No grid input. Takes raw PNG path + value + field context.
  - Returns `{bbox: [xmin, ymin, xmax, ymax] in pixels, rendition: str, confidence: float}` or `None`.
  - Internally: prompts for normalized 0..1000 coords + rendition tag; converts to pixels using the PNG's known width/height; runs verification crop.
- Cache value extends from `[xmin,ymin,xmax,ymax]` to `{bbox, rendition, source}` so the rendition can be shown on the label without re-running detection. Cache version bumped to `"11"`.

---

## 4. Detailed contracts

### 4.1 Gemini native-bbox prompt (locator call)

The prompt asks for a single JSON object with normalized coordinates:

```
TASK: Locate the value "{value}" on this page of a Tamil land deed.

The value may appear as:
  (a) TYPED machine-printed text (body, table cells, registrar block)
  (b) Inside a round SEAL or STAMP impression
  (c) HANDWRITTEN endorsement or margin annotation

If it appears in multiple renditions, prefer typed > seal > handwritten.
If the value does not appear anywhere on the page, return "not_found".

Translation/format variants are valid hits:
  "April 14, 2008" ↔ "14-04-2008" ↔ "14-ந்தேதி … ஏப்ரல்"

Return ONE JSON object on a single line, no prose:
  {"bbox":[ymin,xmin,ymax,xmax],"rendition":"typed|seal|handwritten","confidence":0.0-1.0}
or
  {"bbox":null,"rendition":"not_found","confidence":0.0}

bbox values are normalized to 0..1000 (Gemini native format).
Tightly enclose ONLY the value tokens, not the surrounding sentence.
```

### 4.2 Verification prompt

```
The crop attached should contain the value "{value}".
Reply with one word: yes | partial | no
  yes      = value is fully visible inside the crop
  partial  = value is partly visible (cut off at an edge)
  no       = value is not in the crop
```

### 4.3 Coordinate conversion

```
ymin, xmin, ymax, xmax  = gemini_response.bbox          # 0..1000
W, H                    = png.size                       # pixels
pixel_xmin = round(xmin / 1000 * W)
pixel_ymin = round(ymin / 1000 * H)
pixel_xmax = round(xmax / 1000 * W)
pixel_ymax = round(ymax / 1000 * H)
```

This replaces the ruler-interpolation math. Pixel → PDF-points scaling in `mark_pdf_with_boxes` is unchanged.

### 4.4 Cache schema (v11)

```json
{
  "_v": "11",
  "coords": {
    "<md5>": {
      "bbox": [xmin, ymin, xmax, ymax],
      "rendition": "typed|seal|handwritten",
      "source": "tesseract|gemini|gemini-verified"
    }
  }
}
```

Old `coords` entries (raw lists) are ignored when the version bumps — the existing version-mismatch path in `_load_cache` already handles this.

---

## 5. Failure modes & handling

| Failure | Behaviour |
|---|---|
| Gemini returns malformed JSON | Retry once with `temperature=0`; if still bad, skip this mismatch and log |
| Gemini returns `not_found` | Don't draw; log `"value not located on page N"`; mismatch still appears in the validation JSON, just without a PDF marker |
| Verification returns `no` | Don't draw; log; this is a feature, not a bug — fixes the 254/2011 case |
| Verification returns `partial` | Widen bbox by 30% on each side, re-verify once; if still `partial`, draw the widened box and tag the label with "(approx)" |
| Tesseract finds the value | Skip Gemini entirely; cache and draw |
| Two values share the same bbox key in cache | Cache key already includes field+value+page+filename, so this doesn't collide |

---

## 6. Migration plan

The change is strictly internal to `VisualDebugger`. Callers (`Validator._finalize_with_visual_debug`) keep the same `debug_mismatches_batch` signature and generator semantics.

Rollout:

1. Implement `get_bbox_from_gemini` alongside the existing `get_grid_coordinates_from_gemini`.
2. Add `VD_USE_NATIVE_BBOX` env var, default `false` initially.
3. When env is `true`, the batch entry point routes through the new path; grid code is no longer invoked.
4. After one full validation run looks good on sample deeds (a Tamil-heavy one with seals + handwriting), flip default to `true`.
5. Delete grid code + old method in a follow-up commit.

`test_visual_debugger.py` is rewritten against the new pipeline; the four current tests (grid overlay, two-step simulation, color separation, first-page hints) are replaced with:

- bbox-locator returns valid pixel coords on a synthetic typed page
- verification crop correctly rejects a wrong-value bbox
- `not_found` from Gemini results in zero boxes drawn
- Tesseract fast-path still short-circuits Gemini for plain typed text

---

## 7. Alternatives considered

### 7.1 Approach B — Multi-engine OCR fusion (Tesseract + PaddleOCR + EasyOCR)

Rejected. Adds ~2 GB of model weights, slows cold-start, and the cases that fail today (handwritten Tamil and curved seal text) still fail in PaddleOCR and EasyOCR. Gemini still ends up being the fallback for the only cases that matter.

### 7.2 Approach C — Text-region proposal (CRAFT) + Gemini region classification

Most theoretically accurate but introduces a new ML dependency and ~3–5 s per page for region detection. The marginal accuracy gain over Approach A's verification step doesn't justify the install/runtime cost on a server already paying for Gemini. Worth revisiting only if Approach A's verification false-negative rate is unacceptable in production.

---

## 8. Risks

- **Gemini native-bbox accuracy on small targets**: a 4-digit document number occupies <1% of the page area; normalized 0..1000 has 1-unit resolution per axis, which is ~2 px at DPI 200 — fine in theory, but verify on a small-target sample early.
- **Verification call cost**: doubles Gemini spend per uncached mismatch. Mitigation: aggressive caching (already there) + Tesseract fast-path filters typed cases out before Gemini even sees them.
- **Backwards-compat removal**: deleting the grid code is irreversible without a revert. Mitigation: env-var gate above lets us flip back during the rollout window.

---

## 9. Open questions

None blocking. Implementation choices to confirm during planning:

- Verification crop margin (proposed 20%) — tune after first sample run.
- Whether to expose `rendition` to the frontend (label currently is just `field` — adding `"Date of Registration (seal)"` is nicer UX but requires a small UI change).
