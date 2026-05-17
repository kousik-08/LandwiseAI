# Visual Debugger — All-Pages, All-Occurrences Bounding Boxes

**Date:** 2026-05-17
**Owner:** Visual Debugger module ([Server/api/validate/visual_debugger.py](../../../Server/api/validate/visual_debugger.py))
**Status:** Approved — ready for implementation plan
**Supersedes (partially):** [2026-05-13-visual-debugger-native-bbox-design.md](2026-05-13-visual-debugger-native-bbox-design.md) — that spec proposed switching to Gemini native bbox but left the single-hinted-page model intact. This spec adds two things on top: PyMuPDF text-layer search as the primary locator, and marking every occurrence across all pages.

---

## 1. Problem

The current pipeline ([visual_debugger.py:393](../../../Server/api/validate/visual_debugger.py)) has two distinct failures:

1. **Boxes land in the wrong spot.** The pipeline rasterizes a page to PNG, overlays a blue ruler grid, and asks Gemini to *read its own ruler ticks* and return pixel coordinates. Reading-rulers-from-a-rendered-image is intrinsically noisy: the model interpolates between tick marks visually, and boxes routinely drift 20–50 px from the actual ink. Worse, when the text layer is already present in the PDF, the pipeline still goes through this lossy rendering step for no reason.
2. **Only one page gets marked.** Each mismatch is routed to a single page via `_parse_pages_from_info`, with fallback scans only if the hinted page misses. Values that legitimately appear in multiple places (e.g. survey number on cover + body, document number in body + registrar block) get marked once or not at all.

### 1.1 Observed evidence

The current code carries an extensive workaround stack — `FIRST_PAGE_FIELD_KEYWORDS`, `AVOID_SEAL_FIELD_KEYWORDS`, `MAX_METADATA_PAGES_BEFORE_COVER_FALLBACK`, `_remark_missed`, `_scan_remaining_pages`, plus the `BOX_DRAW_EXTRA_PX_X/Y` symmetric expansion at `mark_pdf_with_boxes` — all of which exist to compensate for the same root cause: a single noisy locator that doesn't know about the text layer and only sees one page at a time.

### 1.2 Root cause

- **Wrong primitive for typed text.** PyMuPDF's `page.search_for(text)` returns pixel-exact `fitz.Rect` rectangles for any token present in the PDF text layer — free, deterministic, no LLM. The current code never tries it.
- **Wrong API for vision.** Gemini 2.5 has a native bounding-box mode (`[ymin, xmin, ymax, xmax]` normalized to 0–1000), trained for this purpose. The grid-and-ruler scheme is a 2024-era workaround for models that couldn't output coordinates.
- **Wrong unit of work.** "One mismatch → one box" assumes the validator knows where the value canonically lives. It often doesn't.

---

## 2. Goal

For each mismatch `{field, value, page_info}`, draw a red box around **every occurrence** of the value across every page of the deed, with pixel-exact coordinates when the PDF has a text layer and Gemini native-bbox as fallback for scanned pages.

### 2.1 Non-goals

- Changing what the validator emits as a mismatch.
- Modifying the frontend PDF viewer ([Client/src/features/analysis/components/PdfAnnotator.tsx](../../../Client/src/features/analysis/components/PdfAnnotator.tsx)) — it just renders whatever marked PDF the backend produces.
- Re-rendering the underlying PDF beyond drawing rectangles + labels.
- Building a new OCR layer (PaddleOCR / EasyOCR / Tesseract). The hybrid text-layer + native-bbox path covers the corpus.

---

## 3. Design

### 3.1 Pipeline

```
for each mismatch (field, value):
    variants = build_variants(value, field)
    boxes = []
    for page in all_pages:
        # 1. Text layer — exact, deterministic, free
        hits = PdfTextLocator.search_in_page(page, variants)
        if hits:
            boxes += hits
            continue
        # 2. Page is scanned or value reformatted — fall back to Gemini
        if not PdfTextLocator.has_useful_text_layer(page):
            boxes += GeminiBboxLocator.locate(page, value, variants)
    emit one Box per hit (same field label)

mark_pdf_with_boxes(all_boxes)   # existing, unchanged
```

Key properties:
- **All pages are scanned for every mismatch.** No page-hint resolution.
- **Cheap path runs first.** Text-layer search is sub-millisecond; Gemini is only called on pages that genuinely lack a text layer.
- **Multiple boxes per mismatch are normal.** A survey number that appears on three pages produces three boxes.

The loop above is the conceptual model. The implementation actually iterates `for page in all_pages` on the outside and `for mismatch in mismatches` inside, so a page's rasterization and (if needed) Gemini call are shared across all mismatches on that page (see §3.7). The observable output — set of boxes per mismatch — is identical.

`PdfTextLocator.search_in_page` tries each variant in turn against `page.search_for`, unions the resulting `fitz.Rect` lists, and dedupes overlapping rects (any rect whose IoU with an already-kept rect exceeds 0.5 is dropped).

### 3.2 Components

| Module | Role | File |
|---|---|---|
| `PdfTextLocator` | `search_in_page(page, variants) -> list[fitz.Rect]` (wraps `page.search_for`, dedupes overlapping rects). `has_useful_text_layer(page) -> bool` (text-density heuristic). | New: `Server/api/validate/text_locator.py` |
| `GeminiBboxLocator` | `locate(page_image_path, value, variants) -> list[PixelBox]`. Uses Gemini structured output with normalized `[ymin, xmin, ymax, xmax]` in 0–1000. No grid, no rulers, no verification crop. | New: `Server/api/validate/gemini_bbox.py` |
| `value_variants` | `build_variants(value, field) -> list[str]`. Date / number / currency reformatters + Tamil↔English digit mapping. Calls existing `_value_variants` for the base splitting logic. | New: `Server/api/validate/value_variants.py` |
| `VisualDebugger` | Orchestrator: loops pages, delegates to locators, collects boxes. | Rewritten in place: `Server/api/validate/visual_debugger.py` |
| `mark_pdf_with_boxes` | Already accepts N boxes/page with collision-aware labels. | Unchanged |
| `audit_coverage` | Adapted to count *unique mismatches with ≥1 box drawn* instead of per-page coverage. | Light edit |

### 3.3 Data structures

```python
# PixelBox: pixel coords on the rasterized page PNG (Gemini path only)
PixelBox = tuple[int, int, int, int]   # (xmin, ymin, xmax, ymax)

# Box dict emitted to mark_pdf_with_boxes (existing shape, unchanged)
Box = {
    "page_num": int,           # 1-indexed
    "pixel_box": list[int],    # for Gemini hits; converted to PDF pts at draw time
    "pdf_rect_box": fitz.Rect, # for text-layer hits; drawn directly in PDF pts
    "img_width": int,          # raster width when applicable
    "img_height": int,
    "pdf_rect": tuple,         # page rect in PDF pts
    "label": str,              # field name
}
```

`mark_pdf_with_boxes` learns one new branch: if `pdf_rect_box` is present, use it directly; otherwise convert `pixel_box` via the existing scale-factor math.

### 3.4 Variant generation

For each `(value, field)`, generate:

- The raw value, plus existing `_value_variants` splits (parenthetical removal, comma-splits, slash-splits).
- **Dates** (if `dateutil.parser` can parse): emit `dd-mm-yyyy`, `dd/mm/yyyy`, `dd.mm.yyyy`, `dd-Mon-yyyy`, `Month dd, yyyy`. Single-pass, deterministic order.
- **Numbers/currency** (if value contains digits): strip thousands separators, add Tamil digit transliteration (`26400` → `௨௬௪௦௦`), prepend `Rs.` / `ரூ.`.
- **Names** (default): pass through — `page.search_for` handles Tamil substrings.

Dedupe; preserve order; cap at 12 variants per value to bound search cost.

### 3.5 `has_useful_text_layer` heuristic

```python
def has_useful_text_layer(page) -> bool:
    chars = len(page.get_text("text").strip())
    area_in2 = (page.rect.width / 72) * (page.rect.height / 72)
    return chars / max(area_in2, 1) > 20      # chars per sq inch
```

Empirically: typed deed pages register 80–500 chars/in²; scanned-image pages register 0–5. The 20 threshold gives a wide safety margin.

### 3.6 Cache

Existing `vd_coord_cache.json` keyed `(pdf, page, field, value)` → `bbox | None`.

New shape: same key (still using the original `value`, not the variant) → `{"hits": [bbox, ...], "source": "text"|"gemini"|"none"}`. Empty list means "searched, nothing found."

Bump `_CACHE_VERSION` from `"18"` to `"19"`. The existing version check at [visual_debugger.py:208](../../../Server/api/validate/visual_debugger.py) automatically clears the old cache on first read.

### 3.7 Concurrency

Current code processes pages sequentially within a mismatch. With all-pages-for-all-mismatches the work grows roughly N×M where N=pages, M=mismatches. Mitigations, in order:

1. **Text-layer first** drops 90% of Gemini calls on typed deeds.
2. **Per-page Gemini call is shared across mismatches.** Build a `pages_needing_gemini` set; for each such page, batch all unresolved variants into one prompt that asks for boxes for any/all of them. (Gemini structured output supports an array of `{label, box}` results.) This collapses M Gemini calls per page down to 1.
3. No threading. Keeps the existing `self.lock` semantics around `mark_pdf_with_boxes`.

### 3.8 Error handling

- A variant fails to parse as a date → skip that format, no log.
- Gemini call fails on a page → log `[VD] gemini error on page N: <err>`, treat as "no hits on this page," continue.
- Value not found on any page → `audit_coverage` reports it (existing channel); no box drawn. Same observable behavior as today's worst case.
- PyMuPDF `search_for` raises (rare; corrupt page) → log + skip page, continue.

### 3.9 Deletions

From [visual_debugger.py](../../../Server/api/validate/visual_debugger.py) (~250 lines, low risk because none of the deleted symbols are exported):

- `draw_grid_on_image` and all `GRID_*` / `LABEL_FONT_SIZE` constants
- `BOX_DRAW_EXTRA_PX_X`, `BOX_DRAW_EXTRA_PX_Y`, `COORD_PADDING` (native bbox is tight enough)
- `_verify_bbox_contains_value` and the `VD_VERIFY` env var
- `get_coordinates_from_gemini` (replaced by `GeminiBboxLocator`)
- `_parse_pages_from_info`, `_METADATA_BLOCK_RE`, `_EC_BLOCK_RE`
- `FIRST_PAGE_FIELD_KEYWORDS`, `AVOID_SEAL_FIELD_KEYWORDS`, `_is_first_page_field`, `_avoid_seal`
- `MAX_METADATA_PAGES_BEFORE_COVER_FALLBACK`
- `_scan_remaining_pages`, `_remark_missed`

`extract_page_as_image` and the `DPI` / `SCALE` constants stay — Gemini fallback still needs a rasterized page.

### 3.10 Caller impact

- [validator.py:381](../../../Server/api/validate/validator.py) calls `debug_mismatches_batch(pdf_path, doc_no, mismatches)` as a generator. Signature unchanged; still yields progress strings.
- [Server/test_visual_debugger.py](../../../Server/test_visual_debugger.py) and [Server/smoke_new_vd.py](../../../Server/smoke_new_vd.py) — review for now-deleted symbols (`draw_grid_on_image`, `get_coordinates_from_gemini`, etc.) and update.
- S3 sync at [visual_debugger.py:1150](../../../Server/api/validate/visual_debugger.py) — same output path, same payload.
- Frontend: no change.

---

## 4. Testing

Project has `Server/test_visual_debugger.py`. Add:

- **Unit — variants:** `build_variants("April 14, 2008", "Date of registration")` includes `14-04-2008`, `14/04/2008`, `14-Apr-2008`.
- **Unit — variants:** `build_variants("Rs. 26,400/-", "Consideration")` includes `26400` and `௨௬௪௦௦`.
- **Unit — text locator:** on a 1-page typed PDF fixture containing "SURVEY NO. 142/3", `PdfTextLocator.search_in_page(page, ["142/3"])` returns one non-empty `fitz.Rect`.
- **Unit — text-density heuristic:** typed-fixture page returns `True`; image-only fixture page returns `False`.
- **Integration:** 3-page sample deed with a survey number on pages 1 & 2 → `debug_mismatches_batch` produces a marked PDF with 2 boxes for that mismatch.
- **Cache version bump:** loading an `_v: "18"` cache file logs the format-changed message and returns `{}`.

No new test framework. Existing tests use plain `pytest`-style assertions; follow that.

---

## 5. Risks and open questions

| Risk | Mitigation |
|---|---|
| PyMuPDF's `search_for` does substring matching that can mis-segment Tamil combining marks. | Variant generation strips diacritics where possible; for stubborn cases the Gemini fallback still fires because the text-layer search returns nothing. |
| Native-bbox accuracy on Tamil scans is unproven on this corpus. | Keep the previous spec's verification crop available as `VD_VERIFY=1` opt-in for the Gemini path only. |
| Multi-occurrence may produce visual noise when a value (e.g. doc number) appears 6+ times. | `mark_pdf_with_boxes` already has label collision avoidance; no extra work needed. If feedback says it's noisy, add a per-mismatch cap (e.g. first 4 occurrences). Out of scope for v1. |
| Per-page batched Gemini prompt is more complex than per-mismatch prompts; structured-output schema must be exact. | Follow Gemini structured output docs; one shared schema file; unit-test the JSON parser. |

### Open questions (deferred — flag during implementation if they bite)

- Does the deed corpus actually have meaningful text layers on most files, or are they mostly scans? If mostly scans, the text-layer-first optimization is moot and we essentially have approach B from brainstorming. Worth measuring on the first 20 deeds processed after rollout.
- Should the existing `_coord_cache` migrate values rather than be invalidated on the version bump? Current behavior throws everything away; that's fine for a one-time rollout but burns API budget. If the rollout is staged, write a one-shot migration script.

---

## 6. Rollout

- Behind no flag; the change is a straight replacement. Old marked PDFs in S3 remain valid (the schema is identical).
- Bump `_CACHE_VERSION` triggers a one-time re-process on the next run for each output directory — expected, signaled by the existing log line at [visual_debugger.py:210](../../../Server/api/validate/visual_debugger.py).
- Watch the new `[VD] gemini error on page N` log line during the first week to catch quota or schema issues.
