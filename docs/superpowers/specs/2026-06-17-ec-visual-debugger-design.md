# EC Visual Debugger — cross-document mismatch locator (deed + EC)

Date: 2026-06-17
Status: awaiting user review

## Goal

In the **Document Analysis** section, let a user click a **mismatched** comparison
field and immediately see *where that value is on the deed* (a bounding box drawn
on the deed PDF) and *where the conflicting value is on the EC* (page number +
a short descriptive sentence). This makes deed↔EC verification fast.

Decisions already locked (via Q&A):
- **View mode:** interactive locate (click a field → locate it).
- **Box scope:** mismatched fields only.
- **EC marking:** page number + descriptive navigation (NO rendered box on the EC PDF).
- **Build order:** deed + EC together.

## Non-goals (explicit)
- No bounding box rendered on the EC PDF (EC side is page + descriptive text only).
- Matched fields are not located (mismatches only).
- We do NOT keep burning red boxes into the marked deed PDF for this feature —
  coordinates are returned to the client and drawn as a live overlay instead.
  (The existing marked-PDF behavior in the analyze pipeline is left untouched.)

## Architecture

### 1. Backend — capture EC page numbers (the one risky bit)

Today `ec_final.json` transactions carry no page number, so "where on the EC is
this value" cannot be answered. We add it at extraction time:

- `ECProcessor.extract_raw` already iterates the EC in page-range chunks. Emit a
  page marker before each chunk's text, e.g. `### EC_PAGE start=<s> end=<e> ###`,
  into `ec_raw_full.txt`.
- `parse_to_json` tracks the most recent marker and stamps each transaction with
  `ec_page_start` / `ec_page_end` (1-indexed).
- Bump `_OCR_VERSION` and `_PARSE_VERSION` so stale caches re-extract. **Cost: a
  one-time re-OCR per parcel** on next analyze — the system is explicitly designed
  for this (see the version-bump history comments in `ec_processor.py`).

Risk + mitigation: re-OCR cost is the main downside. It is bounded (once per
parcel) and consistent with how prompt changes already propagate. No on-disk
schema break — `ec_final.json` stays a list; we only add fields.

### 2. Backend — `POST /api/v1/visual-debug/locate`

Input (form/json): `request_id`, `doc_no`, `field`, `deed_value`, `deed_page`,
`ec_value`, `ec_page` (from the new EC page fields; optional).

Behavior:
- **Deed side:** reuse the existing VD locator (`SentenceContextLocator` →
  `ValuePinpointLocator`) on the deed PDF page to get a tight pixel box; return it
  **normalized to 0–1** against the page raster size, plus the page number. Reuse
  `vd_coord_cache.json`.
- **EC side:** run only the **sentence** locator on the EC PDF at `ec_page` for
  `ec_value` → return `{ page, sentence }` (descriptive navigation). If `ec_page`
  is unknown, fall back to scanning a small window of EC pages (capped) and report
  the best hit, else `found:false`.

Response:
```json
{
  "deed": { "found": true, "page": 8, "box": { "x0":0.41,"y0":0.55,"x1":0.63,"y1":0.58 } },
  "ec":   { "found": true, "page": 3, "sentence": "…Survey 46/3, extent 0.64…" }
}
```
Errors degrade to `found:false` (never 5xx) so the UI shows "couldn't locate".

### 3. Frontend — Document Analysis + PdfAnnotator

- `DocumentAnalysisRevamp`: add a **"Visual Debugger"** toggle in the PDF panel.
  When on, each mismatched comparison card gets a **"Locate"** action. Clicking it
  POSTs to `/visual-debug/locate`, then:
  - scrolls the deed PDF to `deed.page` and draws the box overlay;
  - shows **"On EC: page N — '…sentence…'"** inside the card.
- `PdfAnnotator`: accept an `externalHighlights` prop (already in the interface,
  unused) and render an `AreaHighlight` from a normalized box. The normalized
  box (0–1) is converted to the viewer's page viewport pixels at draw time, so it
  stays correct across zoom. This coordinate transform is the trickiest part and
  will need a runtime visual check.

## Data shapes

- `ec_final.json` transaction gains: `ec_page_start?: number`, `ec_page_end?: number`.
- Locate response as above (deed box normalized 0–1; EC = page + sentence).

## Risks / things to verify at runtime
1. **Overlay alignment** — normalized box → react-pdf-highlighter position must
   line up across zoom levels. Needs a visual check.
2. **EC re-OCR** — first analyze after this ships re-extracts EC (one-time).
3. **Locate latency** — each click is 1–3 Gemini calls (deed pinpoint + EC
   sentence); show a spinner on the card.

## Testing
- Backend: `smoke` the locate endpoint against an existing request with a known
  mismatch; assert `deed.box` within 0–1 and `ec.page`/`sentence` present.
- Frontend: typecheck; manual — toggle on, click a mismatch, confirm the deed box
  lands on the value and the EC page/sentence is shown.
