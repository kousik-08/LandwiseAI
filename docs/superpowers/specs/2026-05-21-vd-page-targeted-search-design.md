# Visual Debugger — Page-Targeted Sentence Search

**Date:** 2026-05-21
**Owner:** Visual Debugger module ([Server/api/validate/visual_debugger.py](../../../Server/api/validate/visual_debugger.py))
**Status:** Approved (Approach A)

## Problem

`VisualDebugger.debug_mismatches_batch` runs LLM call #1 (the sentence locator)
on **every page of the PDF for every mismatched value**:

```python
values = [mm["value"] for mm in mismatches]
for page_num in range(1, total_pages + 1):
    sentence_hits = self.sentence_locator.locate(..., values=values)
```

The validator already knows where each mismatch lives — it carries
`page_info` (the matcher's `page_number`, e.g. `"Page 2"`) on every mismatch
([validator.py:369-372](../../../Server/api/validate/validator.py#L369-L372)) —
but `debug_mismatches_batch` ignores it. The result is `N` sentence-LLM calls
for an `N`-page document even when all mismatches sit on one page. That is
wasted tokens and latency.

## Goal

Run LLM call #1 only on the page(s) a mismatch actually belongs to. LLM call #2
(pinpoint) already crops from the current page's raster, so it inherently runs
on the same page as call #1's hit — no change needed there. This satisfies
"search the sentence on the same page in both LLM calls".

## Non-Goals

- No change to the public signature `debug_mismatches_batch(pdf_path, doc_no, mismatches)`.
- No change to the validator or the matcher prompt.
- No "targeted page first, then fall back to other pages on a miss" retry logic
  (considered as Approach C, rejected: extra calls on misses, added complexity,
  and the matcher's page numbers are reliable enough).

## Approach (A)

Group mismatch values by their target page inside `debug_mismatches_batch`,
then scan only the pages that have at least one value to search.

### 1. Page parser

New static helper on `VisualDebugger`:

```python
@staticmethod
def _parse_pages(page_info: str, total_pages: int) -> list[int]:
    """Extract 1-indexed page numbers from a free-form page_info string.

    "Page 2"      -> [2]
    "Page 1 & 4"  -> [1, 4]
    "Pages 3, 5"  -> [3, 5]
    ""            -> []          # unscoped
    "Page 99"     -> []          # out of range filtered out

    Pages outside [1, total_pages] are dropped; result is deduped and
    ordered by first appearance.
    """
```

Implementation: `re.findall(r"\d+", str(page_info or ""))`, cast to int, keep
those in `[1, total_pages]`, dedupe preserving order.

### 2. Grouping in `debug_mismatches_batch`

Replace the global `values` list and the unconditional `range(1, total_pages+1)`
loop:

```python
values_by_page: dict[int, list[str]] = {}
unscoped_values: list[str] = []
for mm in mismatches:
    pages = self._parse_pages(mm.get("page_info", ""), total_pages)
    if pages:
        for p in pages:
            values_by_page.setdefault(p, []).append(mm["value"])
    else:
        unscoped_values.append(mm["value"])

if unscoped_values:
    pages_to_scan = range(1, total_pages + 1)   # fallback: search everywhere
else:
    pages_to_scan = sorted(values_by_page.keys())

for page_num in pages_to_scan:
    # dedupe, preserve order
    page_values = list(dict.fromkeys(
        values_by_page.get(page_num, []) + unscoped_values
    ))
    if not page_values:
        continue
    ... rasterize page ...
    sentence_hits = self.sentence_locator.locate(..., values=page_values)
    ... LLM call #2 unchanged ...
```

`field_by_value` and `per_mismatch_boxes` are still built from the full
`mismatches` list (unchanged), so the coverage audit and label lookup keep
working exactly as today.

### 3. Fallback (decided)

A mismatch whose `page_info` yields no parseable in-range page is **unscoped**
and searched on **every** page (current behavior preserved). This guarantees we
never lose a box that is found today; the token savings apply to the
page-scoped values.

### 4. Debug-dump accuracy

The per-page debug artefacts must reflect what was actually queried on that
page, not the global value list:

- `_dump_llm_input(... metadata={"values_queried": page_values, ...})`
- `_save_context_json(... values=page_values ...)`

## Data Flow

```
validator: comparison.page_number ("Page 2")
   -> mismatches_to_debug[i].page_info = "Page 2"
      -> _parse_pages("Page 2", total_pages) = [2]
         -> values_by_page = {2: ["47/5", ...]}
            -> sentence_locator.locate(page 2, ["47/5", ...])   # ONLY page 2
               -> pinpoint crop from page-2 raster              # same page
```

## Error Handling / Edge Cases

| Case | Behavior |
|------|----------|
| `page_info` empty / unparseable | unscoped → scanned on all pages |
| page number out of `[1, total_pages]` | dropped by `_parse_pages`; if it was the only page → value becomes unscoped (all pages) |
| `"Page 1 & 4"` (multi-page) | value queried on page 1 and page 4 |
| same value on two mismatches/pages | added under each page key; per-page dedupe prevents a double-query on a single page |
| no mismatches | unchanged early return (`"No mismatches queued"`) |

## Testing

Unit tests (extend `Server/test_visual_debugger.py`, stub locator — no real Gemini):

1. `_parse_pages`: `"Page 2"`→`[2]`, `"Page 1 & 4"`→`[1,4]`, `"Pages 3, 5"`→`[3,5]`,
   `""`→`[]`, `"Page 99"` with `total_pages=3`→`[]`, dedupe `"Page 2 and 2"`→`[2]`.
2. Page-scoping: 3-page PDF, one mismatch with `page_info="Page 2"`. Stub
   `sentence_locator.locate` to record `page_image_path`/values per call; assert it
   was invoked **once**, for page 2 only.
3. Fallback: mismatch with `page_info=""` on a 3-page PDF → locator invoked for
   all 3 pages.
4. Existing `test_debug_mismatches_batch_smoke_typed_pdf` stays green
   (1-page PDF, `page_info=""` → unscoped → page 1).

## Backward Compatibility

Signature unchanged. Callers passing `page_info=""` (existing tests) fall into
the unscoped/all-pages path = today's behavior. Validator already populates
`page_info`, so it benefits with no change.

## Net Effect

An `N`-page document with mismatches concentrated on `k` pages drops from `N`
sentence-LLM calls to `k` (when every mismatch is page-scoped). Unscoped
mismatches still cost a full scan, by design.
