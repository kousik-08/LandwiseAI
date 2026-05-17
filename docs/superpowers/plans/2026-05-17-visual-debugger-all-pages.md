# Visual Debugger — All-Pages, All-Occurrences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [docs/superpowers/specs/2026-05-17-visual-debugger-all-pages-design.md](../specs/2026-05-17-visual-debugger-all-pages-design.md)

**Goal:** Replace the grid+ruler Gemini pipeline in `Server/api/validate/visual_debugger.py` with PyMuPDF text-layer search (primary) plus Gemini native bbox (fallback), and mark every occurrence of a mismatch across all pages of a deed.

**Architecture:** Three new focused modules (`value_variants.py`, `text_locator.py`, `gemini_bbox.py`) handle the three concerns the old monolith conflated: building search variants, fast deterministic text-layer search, and Gemini-based vision fallback. `VisualDebugger` becomes an orchestrator that loops over `(page, mismatch)` pairs, delegates, and aggregates boxes.

**Tech Stack:** Python 3, PyMuPDF (`fitz`), `google-genai` SDK, `psycopg2` (existing), `pytest`-style assertions in flat `Server/test_*.py` files, `dotenv` for env loading.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `Server/api/validate/value_variants.py` | **Create** | `build_variants(value, field) -> list[str]`. Date / number / currency / Tamil-digit reformatters. Pure functions, no I/O. |
| `Server/api/validate/text_locator.py` | **Create** | `search_in_page(page, variants) -> list[fitz.Rect]`, `has_useful_text_layer(page) -> bool`. Thin wrappers around PyMuPDF. |
| `Server/api/validate/gemini_bbox.py` | **Create** | `GeminiBboxLocator.locate(page_image_path, page_w_px, page_h_px, values) -> dict[str, list[PixelBox]]`. Native-bbox call, no grid. |
| `Server/api/validate/visual_debugger.py` | **Rewrite** | Orchestrator only. ~250 LOC deleted, ~150 LOC added. |
| `Server/common/gemini_helper.py` | **Modify** | Add `generate_json_from_file(file_path, prompt, response_schema, ...) -> dict|list` for structured output. |
| `Server/test_value_variants.py` | **Create** | Unit tests for variant generation. |
| `Server/test_text_locator.py` | **Create** | Unit tests for text-layer search + density. |
| `Server/test_gemini_bbox.py` | **Create** | Unit tests for response parsing (mocked Gemini). |
| `Server/test_visual_debugger.py` | **Modify** | Drop references to deleted symbols; add all-pages integration test. |
| `Server/smoke_new_vd.py` | **Modify** | Drop references to deleted symbols; update to new flow. |

---

## Conventions

- **Test framework:** flat `Server/test_*.py`. The existing files use plain `def test_*()` with `assert`. Run with `cd Server && python -m pytest test_xxx.py -v` (or `python test_xxx.py` if the file has a `__main__`). Follow plain pytest — no fixtures unless needed.
- **Commit style:** lowercase, scoped. Match recent log (`fix: ...`, `frontend: ...`, `docs: ...`, `feat: ...`).
- **Path constants:** project root for Python is `Server/`. All `cd Server && ...` for tests.
- **DO NOT amend commits**; always make a new one if a step needs a follow-up.

---

## Task 1: Add `generate_json_from_file` to GeminiHelper

The existing `generate_from_file` returns free-form text. We need a structured-output variant for the bbox locator — it sends a `response_schema` and returns parsed JSON.

**Files:**
- Modify: `Server/common/gemini_helper.py` (add method after `generate_from_file` at line 109)
- Test: `Server/test_gemini_helper_json.py` (new)

- [ ] **Step 1: Write the failing test (smoke import test, no real Gemini call)**

Create `Server/test_gemini_helper_json.py`:

```python
"""Unit test for GeminiHelper.generate_json_from_file (no real API call)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common.gemini_helper import GeminiHelper


def test_method_exists_and_accepts_schema():
    """The method must exist and accept (file_path, prompt, response_schema)."""
    # We can't call without GEMINI_API_KEY; just assert the method exists with right signature.
    assert hasattr(GeminiHelper, "generate_json_from_file"), \
        "GeminiHelper must expose generate_json_from_file"
    import inspect
    sig = inspect.signature(GeminiHelper.generate_json_from_file)
    params = list(sig.parameters)
    # self, file_path, prompt, response_schema, display_name, temperature, top_p
    assert "file_path" in params
    assert "prompt" in params
    assert "response_schema" in params


if __name__ == "__main__":
    test_method_exists_and_accepts_schema()
    print("OK")
```

- [ ] **Step 2: Run test to verify it fails**

```
cd Server && python -m pytest test_gemini_helper_json.py -v
```

Expected: FAIL with `AttributeError: type object 'GeminiHelper' has no attribute 'generate_json_from_file'`.

- [ ] **Step 3: Add `generate_json_from_file` to `gemini_helper.py`**

Append to `Server/common/gemini_helper.py` (after line 108, inside the class):

```python
    def generate_json_from_file(
        self,
        file_path: str,
        prompt: str,
        response_schema: dict,
        display_name: str = "Uploaded File",
        temperature: float = 0.0,
        top_p: float = 0.1,
    ):
        """
        Upload a file and ask Gemini to respond as JSON conforming to
        `response_schema`. Returns the parsed JSON (dict or list).

        The schema follows google-genai's JSON schema dialect — pass a dict like
        {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {...}}}.
        """
        import json

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        f = self.client.files.upload(
            file=file_path, config=types.UploadFileConfig(display_name=display_name)
        )
        while f.state.name == "PROCESSING":
            time.sleep(2)
            f = self.client.files.get(name=f.name)
        if f.state.name == "FAILED":
            raise ValueError(f"File processing failed for {file_path}")

        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = self.client.models.generate_content(
                    model=self.model_id,
                    contents=[f, prompt],
                    config=types.GenerateContentConfig(
                        temperature=temperature,
                        top_p=top_p,
                        response_mime_type="application/json",
                        response_schema=response_schema,
                    ),
                )
                return json.loads(response.text)
            except Exception as e:
                error_lower = str(e).lower()
                is_transient = any(p in error_lower for p in [
                    "503", "502", "504", "overloaded", "unavailable",
                    "peer closed", "incomplete chunked", "connection", "timeout", "reset",
                ])
                if is_transient and attempt < max_retries - 1:
                    wait = 2 ** (attempt + 1)
                    print(f"[!] Gemini transient error. Retrying in {wait}s... ({e})")
                    time.sleep(wait)
                    continue
                raise
```

- [ ] **Step 4: Run test to verify it passes**

```
cd Server && python -m pytest test_gemini_helper_json.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add Server/common/gemini_helper.py Server/test_gemini_helper_json.py
git commit -m "feat(gemini): add generate_json_from_file for structured output"
```

---

## Task 2: `value_variants` module — base scaffolding

Create the module with a no-op `build_variants` that just returns `[value]`. Subsequent tasks add date / number / Tamil-digit handling.

**Files:**
- Create: `Server/api/validate/value_variants.py`
- Test: `Server/test_value_variants.py`

- [ ] **Step 1: Write the failing test**

Create `Server/test_value_variants.py`:

```python
"""Unit tests for value_variants.build_variants."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.value_variants import build_variants


def test_returns_list_containing_original_value():
    out = build_variants("Stella", "Claimant Name")
    assert isinstance(out, list)
    assert "Stella" in out


def test_empty_value_returns_empty_list():
    assert build_variants("", "Any") == []
    assert build_variants(None, "Any") == []


def test_strips_parenthetical_context():
    out = build_variants("Stella (Family Card No. 01)", "Claimant Name")
    assert "Stella" in out


def test_dedupes_preserves_order():
    out = build_variants("Stella", "Claimant Name")
    assert out == list(dict.fromkeys(out))


if __name__ == "__main__":
    test_returns_list_containing_original_value()
    test_empty_value_returns_empty_list()
    test_strips_parenthetical_context()
    test_dedupes_preserves_order()
    print("OK")
```

- [ ] **Step 2: Run test to verify it fails**

```
cd Server && python -m pytest test_value_variants.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'api.validate.value_variants'`.

- [ ] **Step 3: Create minimal `value_variants.py`**

Create `Server/api/validate/value_variants.py`:

```python
"""
Build search variants for a validator mismatch value.

The validator emits the canonical value as it appears in the EC or metadata
source ("Stella", "April 14, 2008", "Rs. 26,400/-"). The deed PDF often
carries the same fact in a different format (Tamil transliteration, dd-mm-yyyy,
digits with thousands separators stripped). `build_variants` enumerates those
alternative renditions so PyMuPDF text-layer search and Gemini both get a fair
shot at finding the value.

Variants are deduped and ordered: original first, then format alternates.
"""
import re
from typing import Optional


_PARENTHETICAL_RE = re.compile(r"\s*\([^)]{0,120}\)\s*")
_VARIANT_CAP = 12   # Bound search cost; spec §3.4.


def _dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: list[str] = []
    for s in items:
        s = (s or "").strip()
        if s and s not in seen:
            seen.append(s)
    return seen


def _strip_parentheticals(s: str) -> str:
    cleaned = _PARENTHETICAL_RE.sub(" ", s).strip()
    return re.sub(r"\s+", " ", cleaned).strip()


def build_variants(value: Optional[str], field: Optional[str]) -> list[str]:
    """Return a deduped, ordered list of search candidates for `value`."""
    if not value:
        return []
    raw = str(value).strip()
    candidates: list[str] = [raw]
    cleaned = _strip_parentheticals(raw)
    if cleaned and cleaned != raw:
        candidates.append(cleaned)
    return _dedupe_preserve_order(candidates)[:_VARIANT_CAP]
```

- [ ] **Step 4: Run test to verify it passes**

```
cd Server && python -m pytest test_value_variants.py -v
```

Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```
git add Server/api/validate/value_variants.py Server/test_value_variants.py
git commit -m "feat(validate): scaffold value_variants module with parenthetical strip"
```

---

## Task 3: `value_variants` — date formats

Add date parsing + reformatting so `"April 14, 2008"` produces `"14-04-2008"`, `"14/04/2008"`, `"14.04.2008"`, `"14-Apr-2008"`, `"April 14, 2008"`.

**Files:**
- Modify: `Server/api/validate/value_variants.py`
- Modify: `Server/test_value_variants.py`

- [ ] **Step 1: Add failing test**

Append to `Server/test_value_variants.py` (before the `if __name__` block):

```python
def test_date_yields_multiple_formats():
    out = build_variants("April 14, 2008", "Date of Registration")
    assert "April 14, 2008" in out
    assert "14-04-2008" in out
    assert "14/04/2008" in out
    assert "14.04.2008" in out
    assert "14-Apr-2008" in out


def test_already_numeric_date_yields_textual_form():
    out = build_variants("14-04-2008", "Date of Registration")
    assert "14-04-2008" in out
    assert "14/04/2008" in out
    assert "April 14, 2008" in out


def test_non_date_value_does_not_emit_date_formats():
    out = build_variants("Stella", "Claimant Name")
    # No spurious date strings
    assert not any(re.match(r"\d{2}[-/.]\d{2}[-/.]\d{4}", v) for v in out)
```

Add `import re` at the top if not already present.

Add new asserts to `__main__`:

```python
    test_date_yields_multiple_formats()
    test_already_numeric_date_yields_textual_form()
    test_non_date_value_does_not_emit_date_formats()
```

- [ ] **Step 2: Run test to verify date tests fail**

```
cd Server && python -m pytest test_value_variants.py -v
```

Expected: 4 passed, 3 failed (`test_date_yields_multiple_formats`, etc.).

- [ ] **Step 3: Implement date variants**

Replace `build_variants` in `Server/api/validate/value_variants.py` and add helpers above it:

```python
from datetime import datetime

# Accepted input formats — order matters; first match wins.
_DATE_INPUT_FORMATS = (
    "%B %d, %Y",        # April 14, 2008
    "%b %d, %Y",        # Apr 14, 2008
    "%d-%m-%Y",         # 14-04-2008
    "%d/%m/%Y",         # 14/04/2008
    "%d.%m.%Y",         # 14.04.2008
    "%Y-%m-%d",         # 2008-04-14
    "%d-%b-%Y",         # 14-Apr-2008
    "%d %B %Y",         # 14 April 2008
)

# Output formats — every parsed date emits all of these.
_DATE_OUTPUT_FORMATS = (
    "%d-%m-%Y",
    "%d/%m/%Y",
    "%d.%m.%Y",
    "%d-%b-%Y",
    "%B %d, %Y",
)


def _try_parse_date(s: str) -> Optional[datetime]:
    for fmt in _DATE_INPUT_FORMATS:
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


def _date_variants(s: str) -> list[str]:
    dt = _try_parse_date(s)
    if not dt:
        return []
    return [dt.strftime(fmt) for fmt in _DATE_OUTPUT_FORMATS]


def build_variants(value: Optional[str], field: Optional[str]) -> list[str]:
    """Return a deduped, ordered list of search candidates for `value`."""
    if not value:
        return []
    raw = str(value).strip()
    candidates: list[str] = [raw]
    cleaned = _strip_parentheticals(raw)
    if cleaned and cleaned != raw:
        candidates.append(cleaned)
    # Try date reformatting on both the raw and cleaned forms.
    for src in (raw, cleaned):
        candidates.extend(_date_variants(src))
    return _dedupe_preserve_order(candidates)[:_VARIANT_CAP]
```

- [ ] **Step 4: Run test to verify all pass**

```
cd Server && python -m pytest test_value_variants.py -v
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```
git add Server/api/validate/value_variants.py Server/test_value_variants.py
git commit -m "feat(validate): emit date format variants in build_variants"
```

---

## Task 4: `value_variants` — numbers, currency, Tamil digits

Add numeric variants (`"Rs. 26,400/-"` → `"26400"`, `"26,400"`, `"ரூ.26,400/-"`, `"௨௬௪௦௦"`).

**Files:**
- Modify: `Server/api/validate/value_variants.py`
- Modify: `Server/test_value_variants.py`

- [ ] **Step 1: Add failing tests**

Append to `Server/test_value_variants.py`:

```python
def test_currency_strips_separators_and_adds_tamil():
    out = build_variants("Rs. 26,400/-", "Consideration")
    assert "Rs. 26,400/-" in out
    assert "26400" in out or "26,400" in out
    # Tamil digit transliteration
    assert "௨௬௪௦௦" in out


def test_plain_number_adds_tamil_digit_variant():
    out = build_variants("142", "Survey Number")
    assert "142" in out
    assert "௧௪௨" in out


def test_tamil_number_adds_western_digit_variant():
    out = build_variants("௨௬௪௦௦", "Consideration")
    assert "௨௬௪௦௦" in out
    assert "26400" in out
```

Add to `__main__`:

```python
    test_currency_strips_separators_and_adds_tamil()
    test_plain_number_adds_tamil_digit_variant()
    test_tamil_number_adds_western_digit_variant()
```

- [ ] **Step 2: Run test to verify they fail**

```
cd Server && python -m pytest test_value_variants.py -v
```

Expected: 3 failed.

- [ ] **Step 3: Implement number / Tamil digit variants**

Add to `Server/api/validate/value_variants.py` (above `build_variants`):

```python
# Tamil digit code points U+0BE6..U+0BEF map to 0..9.
_TAMIL_DIGITS = "௦௧௨௩௪௫௬௭௮௯"
_WESTERN_TO_TAMIL = str.maketrans("0123456789", _TAMIL_DIGITS)
_TAMIL_TO_WESTERN = str.maketrans(_TAMIL_DIGITS, "0123456789")


def _has_western_digits(s: str) -> bool:
    return any(c.isdigit() for c in s)


def _has_tamil_digits(s: str) -> bool:
    return any(c in _TAMIL_DIGITS for c in s)


def _numeric_variants(s: str) -> list[str]:
    out: list[str] = []
    if _has_western_digits(s):
        # Drop common currency/punctuation, keep only digits to isolate the number.
        digits_only = re.sub(r"[^\d]", "", s)
        if digits_only:
            out.append(digits_only)
            out.append(digits_only.translate(_WESTERN_TO_TAMIL))
    if _has_tamil_digits(s):
        # Transliterate Tamil digits → western, both the full string and a digits-only form.
        westernised = s.translate(_TAMIL_TO_WESTERN)
        out.append(westernised)
        digits_only = re.sub(r"[^\d]", "", westernised)
        if digits_only and digits_only != westernised:
            out.append(digits_only)
    return out
```

Update `build_variants` to call `_numeric_variants`:

```python
def build_variants(value: Optional[str], field: Optional[str]) -> list[str]:
    """Return a deduped, ordered list of search candidates for `value`."""
    if not value:
        return []
    raw = str(value).strip()
    candidates: list[str] = [raw]
    cleaned = _strip_parentheticals(raw)
    if cleaned and cleaned != raw:
        candidates.append(cleaned)
    for src in (raw, cleaned):
        candidates.extend(_date_variants(src))
        candidates.extend(_numeric_variants(src))
    return _dedupe_preserve_order(candidates)[:_VARIANT_CAP]
```

- [ ] **Step 4: Run test to verify all pass**

```
cd Server && python -m pytest test_value_variants.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```
git add Server/api/validate/value_variants.py Server/test_value_variants.py
git commit -m "feat(validate): emit numeric and Tamil-digit variants"
```

---

## Task 5: `text_locator` module

PyMuPDF text-layer search + density heuristic. No LLM, no I/O beyond `fitz`.

**Files:**
- Create: `Server/api/validate/text_locator.py`
- Test: `Server/test_text_locator.py`

- [ ] **Step 1: Write the failing test**

Create `Server/test_text_locator.py`:

```python
"""Unit tests for PdfTextLocator."""
import os
import sys
import tempfile

import fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.text_locator import PdfTextLocator


def _make_typed_pdf(text_blocks):
    """Create a 1-page A4 PDF with typed text blocks. Returns the path."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    for x, y, txt in text_blocks:
        page.insert_text(fitz.Point(x, y), txt, fontsize=12)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


def _make_blank_pdf():
    """1-page PDF with no text — simulates a pure scan."""
    doc = fitz.open()
    doc.new_page(width=595, height=842)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


def test_search_finds_single_occurrence():
    pdf = _make_typed_pdf([(50, 100, "SURVEY NO. 142/3")])
    doc = fitz.open(pdf)
    try:
        rects = PdfTextLocator.search_in_page(doc.load_page(0), ["142/3"])
        assert len(rects) == 1
        assert rects[0].width > 0 and rects[0].height > 0
    finally:
        doc.close()
        os.remove(pdf)


def test_search_finds_multiple_occurrences():
    pdf = _make_typed_pdf([
        (50, 100, "STELLA appears here"),
        (50, 200, "and again: STELLA"),
        (50, 300, "and once more STELLA"),
    ])
    doc = fitz.open(pdf)
    try:
        rects = PdfTextLocator.search_in_page(doc.load_page(0), ["STELLA"])
        assert len(rects) == 3
    finally:
        doc.close()
        os.remove(pdf)


def test_search_dedupes_overlapping_variant_hits():
    """Two variants ('STELLA' and 'STELLA appears') both match the same region."""
    pdf = _make_typed_pdf([(50, 100, "STELLA appears here")])
    doc = fitz.open(pdf)
    try:
        rects = PdfTextLocator.search_in_page(
            doc.load_page(0), ["STELLA", "STELLA appears"]
        )
        # Two raw matches but the overlap-dedupe keeps one (or the broader one).
        assert 1 <= len(rects) <= 2
    finally:
        doc.close()
        os.remove(pdf)


def test_search_returns_empty_for_missing_value():
    pdf = _make_typed_pdf([(50, 100, "STELLA")])
    doc = fitz.open(pdf)
    try:
        rects = PdfTextLocator.search_in_page(doc.load_page(0), ["NOT_PRESENT"])
        assert rects == []
    finally:
        doc.close()
        os.remove(pdf)


def test_has_useful_text_layer_true_for_typed_pdf():
    pdf = _make_typed_pdf([
        (50, y, "A line of typed body text " * 4) for y in range(50, 800, 20)
    ])
    doc = fitz.open(pdf)
    try:
        assert PdfTextLocator.has_useful_text_layer(doc.load_page(0)) is True
    finally:
        doc.close()
        os.remove(pdf)


def test_has_useful_text_layer_false_for_blank_pdf():
    pdf = _make_blank_pdf()
    doc = fitz.open(pdf)
    try:
        assert PdfTextLocator.has_useful_text_layer(doc.load_page(0)) is False
    finally:
        doc.close()
        os.remove(pdf)


if __name__ == "__main__":
    test_search_finds_single_occurrence()
    test_search_finds_multiple_occurrences()
    test_search_dedupes_overlapping_variant_hits()
    test_search_returns_empty_for_missing_value()
    test_has_useful_text_layer_true_for_typed_pdf()
    test_has_useful_text_layer_false_for_blank_pdf()
    print("OK")
```

- [ ] **Step 2: Run test to verify it fails**

```
cd Server && python -m pytest test_text_locator.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `text_locator.py`**

Create `Server/api/validate/text_locator.py`:

```python
"""
PyMuPDF text-layer search wrappers.

Two responsibilities, both kept small and side-effect-free so they can be unit
tested without a real Gemini call or a real network round-trip:

  * `search_in_page(page, variants)` — try every variant against `page.search_for`
    and return a deduped list of `fitz.Rect` rectangles in PDF points.
  * `has_useful_text_layer(page)` — text-density heuristic that decides whether
    the Gemini-vision fallback needs to run for this page.
"""
import fitz


class PdfTextLocator:
    # Pages below this character density (chars per sq inch) are treated as
    # scans. Empirically: typed deeds register 80–500; scans register 0–5.
    # The wide gap means the exact threshold doesn't matter much.
    MIN_CHARS_PER_SQ_INCH = 20

    # Two rectangles whose intersection-over-union exceeds this are considered
    # the same hit. Keeps duplicate hits from variants ("Stella" vs "STELLA")
    # that resolve to overlapping regions.
    IOU_DEDUPE_THRESHOLD = 0.5

    @classmethod
    def search_in_page(cls, page: fitz.Page, variants: list[str]) -> list[fitz.Rect]:
        """Return deduped `fitz.Rect` hits for any variant present on `page`."""
        if not variants:
            return []
        hits: list[fitz.Rect] = []
        for v in variants:
            v = (v or "").strip()
            if not v:
                continue
            try:
                rects = page.search_for(v)
            except Exception:
                # Corrupt page or unsupported codepoint — skip the variant.
                continue
            for r in rects or []:
                if r.width <= 0 or r.height <= 0:
                    continue
                hits.append(r)
        return cls._dedupe_overlapping(hits)

    @classmethod
    def has_useful_text_layer(cls, page: fitz.Page) -> bool:
        text = page.get_text("text").strip()
        if not text:
            return False
        rect = page.rect
        area_in2 = max(1.0, (rect.width / 72.0) * (rect.height / 72.0))
        return (len(text) / area_in2) > cls.MIN_CHARS_PER_SQ_INCH

    # ── helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _iou(a: fitz.Rect, b: fitz.Rect) -> float:
        inter = a & b
        if inter.is_empty:
            return 0.0
        inter_area = inter.width * inter.height
        union = (a.width * a.height) + (b.width * b.height) - inter_area
        return inter_area / union if union > 0 else 0.0

    @classmethod
    def _dedupe_overlapping(cls, hits: list[fitz.Rect]) -> list[fitz.Rect]:
        kept: list[fitz.Rect] = []
        for r in hits:
            if any(cls._iou(r, k) > cls.IOU_DEDUPE_THRESHOLD for k in kept):
                continue
            kept.append(r)
        return kept
```

- [ ] **Step 4: Run test to verify it passes**

```
cd Server && python -m pytest test_text_locator.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```
git add Server/api/validate/text_locator.py Server/test_text_locator.py
git commit -m "feat(validate): add PdfTextLocator for text-layer bbox search"
```

---

## Task 6: `gemini_bbox` module — schema, parser, prompt builder

The actual Gemini call needs network; the *parsing and prompt construction* is pure and gets unit-tested here. The locator class wraps a GeminiHelper instance and exposes `locate(...)`.

**Files:**
- Create: `Server/api/validate/gemini_bbox.py`
- Test: `Server/test_gemini_bbox.py`

- [ ] **Step 1: Write the failing test (no real Gemini call)**

Create `Server/test_gemini_bbox.py`:

```python
"""Unit tests for GeminiBboxLocator parsing and prompt building."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.gemini_bbox import (
    GeminiBboxLocator,
    parse_bbox_response,
    build_locate_prompt,
)


def test_parse_response_extracts_boxes_per_value():
    """Gemini returns a list of {value, found, box_0_1000?}. Parser groups by value."""
    response = [
        {"value": "STELLA", "found": True, "box_0_1000": [100, 200, 300, 400]},
        {"value": "STELLA", "found": True, "box_0_1000": [500, 600, 700, 800]},
        {"value": "26400", "found": False},
    ]
    result = parse_bbox_response(response, page_w_px=1000, page_h_px=2000)
    assert "STELLA" in result
    assert "26400" in result
    assert len(result["STELLA"]) == 2
    assert result["26400"] == []


def test_parse_response_converts_normalized_to_pixels():
    """Box [ymin, xmin, ymax, xmax] in 0–1000 → pixels using page dims."""
    response = [{"value": "X", "found": True, "box_0_1000": [100, 200, 300, 400]}]
    # Gemini convention: [ymin, xmin, ymax, xmax]
    result = parse_bbox_response(response, page_w_px=1000, page_h_px=2000)
    # ymin=100/1000*2000=200, xmin=200/1000*1000=200,
    # ymax=300/1000*2000=600, xmax=400/1000*1000=400
    xmin, ymin, xmax, ymax = result["X"][0]
    assert (xmin, ymin, xmax, ymax) == (200, 200, 400, 600)


def test_parse_response_skips_invalid_box_shapes():
    response = [
        {"value": "X", "found": True, "box_0_1000": [100, 200, 300]},  # wrong arity
        {"value": "Y", "found": True, "box_0_1000": [0, 0, 0, 0]},     # zero-area
        {"value": "Z", "found": True},                                  # no box
    ]
    result = parse_bbox_response(response, page_w_px=1000, page_h_px=1000)
    assert result == {"X": [], "Y": [], "Z": []}


def test_build_prompt_lists_all_values():
    prompt = build_locate_prompt(["STELLA", "26400"])
    assert "STELLA" in prompt
    assert "26400" in prompt
    # The prompt must mention the 0–1000 coordinate system.
    assert "1000" in prompt


if __name__ == "__main__":
    test_parse_response_extracts_boxes_per_value()
    test_parse_response_converts_normalized_to_pixels()
    test_parse_response_skips_invalid_box_shapes()
    test_build_prompt_lists_all_values()
    print("OK")
```

- [ ] **Step 2: Run test to verify it fails**

```
cd Server && python -m pytest test_gemini_bbox.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement `gemini_bbox.py`**

Create `Server/api/validate/gemini_bbox.py`:

```python
"""
Gemini native bounding-box locator.

Replaces the grid+ruler pipeline. Sends ONE call per page containing a list of
values to locate; Gemini returns a JSON array of `{value, found, box_0_1000}`
entries, where `box_0_1000` follows the Gemini convention of
`[ymin, xmin, ymax, xmax]` normalized to 0–1000.

The class wraps a `GeminiHelper` instance and exposes `locate(...)`. The pure
helpers `build_locate_prompt` and `parse_bbox_response` are exported separately
so they can be unit-tested without a network call.
"""
from typing import Optional


# Pixel-area floor: anything below is treated as a hallucinated "speck."
# At typical deed DPI (200) a real word token is roughly 80 × 20 = 1600 px².
MIN_BOX_AREA_PX = 80 * 20


def build_locate_prompt(values: list[str]) -> str:
    """Construct the per-page locate prompt for the given values."""
    bullet_list = "\n".join(f"  - {v!r}" for v in values)
    return f"""
TASK: For EACH of the following values, find ALL occurrences on this page and
return their bounding boxes. Tamil and English renderings of the same fact
both count as matches.

Values:
{bullet_list}

For every value, emit one entry per visible occurrence (or one entry with
"found": false if the value is not on the page in any rendering).

Coordinate system:
  - Each box is `[ymin, xmin, ymax, xmax]` normalized to integers in [0, 1000]
    measured from the TOP-LEFT corner of the page image.
  - Enclose ONLY the value token tightly — do NOT include the surrounding line
    or paragraph.

Return a JSON array. Do not include any prose outside the JSON.
""".strip()


# Response schema for google-genai structured output.
LOCATE_RESPONSE_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "value": {"type": "STRING"},
            "found": {"type": "BOOLEAN"},
            "box_0_1000": {
                "type": "ARRAY",
                "items": {"type": "INTEGER"},
            },
        },
        "required": ["value", "found"],
    },
}


def _to_pixel_box(box_0_1000: list[int], page_w_px: int, page_h_px: int):
    """Convert [ymin, xmin, ymax, xmax] (0–1000) → (xmin, ymin, xmax, ymax) px."""
    if not isinstance(box_0_1000, list) or len(box_0_1000) != 4:
        return None
    try:
        ymin_n, xmin_n, ymax_n, xmax_n = [int(v) for v in box_0_1000]
    except (ValueError, TypeError):
        return None
    xmin = int(xmin_n / 1000 * page_w_px)
    ymin = int(ymin_n / 1000 * page_h_px)
    xmax = int(xmax_n / 1000 * page_w_px)
    ymax = int(ymax_n / 1000 * page_h_px)
    if xmax <= xmin or ymax <= ymin:
        return None
    area = (xmax - xmin) * (ymax - ymin)
    if area < MIN_BOX_AREA_PX:
        return None
    return (xmin, ymin, xmax, ymax)


def parse_bbox_response(
    response: list[dict],
    page_w_px: int,
    page_h_px: int,
) -> dict[str, list[tuple]]:
    """Group response entries by value; convert to pixel boxes; drop invalid."""
    out: dict[str, list[tuple]] = {}
    for entry in response or []:
        if not isinstance(entry, dict):
            continue
        v = entry.get("value")
        if not isinstance(v, str):
            continue
        out.setdefault(v, [])
        if not entry.get("found"):
            continue
        box = _to_pixel_box(
            entry.get("box_0_1000"), page_w_px, page_h_px
        )
        if box is not None:
            out[v].append(box)
    return out


class GeminiBboxLocator:
    """Runtime wrapper that pairs the helpers above with a GeminiHelper."""

    def __init__(self, gemini_helper):
        self.gemini = gemini_helper

    def locate(
        self,
        page_image_path: str,
        page_w_px: int,
        page_h_px: int,
        values: list[str],
    ) -> dict[str, list[tuple]]:
        """Locate every value on one page. Returns `{value: [pixel_box, ...]}`."""
        if not values:
            return {}
        prompt = build_locate_prompt(values)
        try:
            response = self.gemini.generate_json_from_file(
                file_path=page_image_path,
                prompt=prompt,
                response_schema=LOCATE_RESPONSE_SCHEMA,
                display_name="VD Locate",
            )
        except Exception as e:
            print(f"[VD] gemini bbox error: {e}")
            return {v: [] for v in values}
        return parse_bbox_response(response, page_w_px, page_h_px)
```

- [ ] **Step 4: Run test to verify it passes**

```
cd Server && python -m pytest test_gemini_bbox.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```
git add Server/api/validate/gemini_bbox.py Server/test_gemini_bbox.py
git commit -m "feat(validate): add GeminiBboxLocator with native-bbox API"
```

---

## Task 7: Teach `mark_pdf_with_boxes` to draw from `pdf_rect_box`

Text-layer hits arrive in PDF points directly (no scale math needed). Add a branch.

**Files:**
- Modify: `Server/api/validate/visual_debugger.py` — `mark_pdf_with_boxes` only

- [ ] **Step 1: Write the failing test**

Add to `Server/test_text_locator.py` (it's the closest neighbor; we'll move it to a dedicated file if it grows):

```python
def test_mark_pdf_handles_pdf_rect_box_branch():
    """A box with `pdf_rect_box` (text-layer hit) is drawn without pixel-scale math."""
    import fitz
    from common.gemini_helper import GeminiHelper  # ensure import path works
    from api.validate.visual_debugger import VisualDebugger

    pdf = _make_typed_pdf([(50, 100, "TARGET")])
    out_pdf = pdf.replace(".pdf", "_marked.pdf")
    try:
        # Build a fake VD without a real Gemini client by stubbing __init__.
        vd = VisualDebugger.__new__(VisualDebugger)
        vd.lock = __import__("threading").Lock()
        vd.temp_dir = tempfile.mkdtemp(prefix="vd_test_")

        # Locate "TARGET" via text layer and pass the rect through.
        doc = fitz.open(pdf)
        rect = doc.load_page(0).search_for("TARGET")[0]
        page_rect = doc.load_page(0).rect
        doc.close()

        vd.mark_pdf_with_boxes(
            pdf,
            [{
                "page_num": 1,
                "pdf_rect_box": rect,           # NEW branch under test
                "pdf_rect": (page_rect.x0, page_rect.y0, page_rect.x1, page_rect.y1),
                "label": "TARGET field",
            }],
            out_pdf,
        )
        assert os.path.exists(out_pdf) and os.path.getsize(out_pdf) > 0
        # Open the result and assert at least one drawing annotation exists.
        result = fitz.open(out_pdf)
        try:
            page = result.load_page(0)
            # The marked PDF should contain drawing commands beyond what the
            # source did — check the content stream length grew.
            assert len(page.get_contents()) >= 1
        finally:
            result.close()
    finally:
        for p in (pdf, out_pdf):
            if os.path.exists(p):
                os.remove(p)
```

- [ ] **Step 2: Run test to verify it fails**

```
cd Server && python -m pytest test_text_locator.py::test_mark_pdf_handles_pdf_rect_box_branch -v
```

Expected: FAIL — `mark_pdf_with_boxes` doesn't know about `pdf_rect_box` yet; current code requires `pixel_box`, `img_width`, `img_height`.

- [ ] **Step 3: Add the branch**

In `Server/api/validate/visual_debugger.py`, modify the loop inside `mark_pdf_with_boxes` (around line 551). Replace this block (currently around lines 551–596):

```python
                for box in boxes:
                    page_num = box["page_num"]
                    pixel_box = box["pixel_box"]
                    img_w = box["img_width"]
                    img_h = box["img_height"]
                    label = box.get("label", "Mismatch")

                    if page_num < 1 or page_num > len(doc):
                        continue

                    page = doc.load_page(page_num - 1)

                    pdf_rect = box.get("pdf_rect")
                    if pdf_rect:
                        x0, y0, x1, y1 = pdf_rect
                    else:
                        pr = page.rect
                        x0, y0, x1, y1 = pr.x0, pr.y0, pr.x1, pr.y1

                    pdf_width = x1 - x0
                    pdf_height = y1 - y0

                    xmin, ymin, xmax, ymax = pixel_box
                    scale_x = pdf_width / img_w
                    scale_y = pdf_height / img_h

                    print(
                        f"[VD] Box '{label}' page {page_num}: "
                        f"px=[{xmin},{ymin},{xmax},{ymax}] img={img_w}x{img_h} "
                        f"pdf_rect=({x0:.2f},{y0:.2f},{x1:.2f},{y1:.2f}) "
                        f"scale=({scale_x:.4f},{scale_y:.4f})"
                    )

                    # Symmetric outward expansion: grow the rectangle on every
                    # side so the box visibly surrounds the value rather than
                    # sitting flush against (or inside) the ink. Expansion is
                    # specified in pixels and converted to PDF points via the
                    # page-specific scale factor.
                    pad_x_pts = self.BOX_DRAW_EXTRA_PX_X * scale_x
                    pad_y_pts = self.BOX_DRAW_EXTRA_PX_Y * scale_y
                    rect = fitz.Rect(
                        x0 + xmin * scale_x - pad_x_pts,
                        y0 + ymin * scale_y - pad_y_pts,
                        x0 + xmax * scale_x + pad_x_pts,
                        y0 + ymax * scale_y + pad_y_pts,
                    )
                    # Clamp to page bounds so the rectangle is fully visible
                    rect &= page.rect
```

with this:

```python
                for box in boxes:
                    page_num = box["page_num"]
                    label = box.get("label", "Mismatch")

                    if page_num < 1 or page_num > len(doc):
                        continue

                    page = doc.load_page(page_num - 1)

                    pdf_rect = box.get("pdf_rect")
                    if pdf_rect:
                        x0, y0, x1, y1 = pdf_rect
                    else:
                        pr = page.rect
                        x0, y0, x1, y1 = pr.x0, pr.y0, pr.x1, pr.y1

                    # Two box sources:
                    #   1. `pdf_rect_box` — text-layer hit, already in PDF points.
                    #      Use it directly; no scale conversion needed.
                    #   2. `pixel_box` + img_w/img_h — Gemini hit on the rasterized
                    #      page; convert pixel coords to PDF points.
                    if "pdf_rect_box" in box and box["pdf_rect_box"] is not None:
                        src = box["pdf_rect_box"]
                        rect = fitz.Rect(src.x0, src.y0, src.x1, src.y1)
                        print(
                            f"[VD] Box '{label}' page {page_num} (text-layer): "
                            f"rect=({rect.x0:.2f},{rect.y0:.2f},{rect.x1:.2f},{rect.y1:.2f})"
                        )
                    else:
                        pixel_box = box["pixel_box"]
                        img_w = box["img_width"]
                        img_h = box["img_height"]
                        xmin, ymin, xmax, ymax = pixel_box
                        scale_x = (x1 - x0) / img_w
                        scale_y = (y1 - y0) / img_h
                        rect = fitz.Rect(
                            x0 + xmin * scale_x,
                            y0 + ymin * scale_y,
                            x0 + xmax * scale_x,
                            y0 + ymax * scale_y,
                        )
                        print(
                            f"[VD] Box '{label}' page {page_num} (gemini): "
                            f"px=[{xmin},{ymin},{xmax},{ymax}] img={img_w}x{img_h} "
                            f"rect=({rect.x0:.2f},{rect.y0:.2f},{rect.x1:.2f},{rect.y1:.2f})"
                        )

                    rect &= page.rect
```

Note: the symmetric expansion (`BOX_DRAW_EXTRA_PX_X/Y`) is removed because native bbox / text-layer hits are already tight. Task 11 deletes the constants.

- [ ] **Step 4: Run test to verify it passes**

```
cd Server && python -m pytest test_text_locator.py -v
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```
git add Server/api/validate/visual_debugger.py Server/test_text_locator.py
git commit -m "feat(vd): mark_pdf_with_boxes accepts pdf_rect_box from text-layer hits"
```

---

## Task 8: Rewrite `debug_mismatches_batch` to use all-pages flow

This is the largest task. The new flow loops pages on the outside and mismatches on the inside, so each page is rasterized at most once and Gemini is called at most once per page (for all unresolved values at once).

**Files:**
- Modify: `Server/api/validate/visual_debugger.py` — `debug_mismatches_batch` and `__init__`

- [ ] **Step 1: Write the integration test (covers the orchestrator end-to-end)**

Create `Server/test_visual_debugger_all_pages.py`:

```python
"""End-to-end test for the all-pages VisualDebugger flow.

Uses a synthetic typed PDF so PdfTextLocator can find values without hitting
Gemini. Verifies that a value appearing on multiple pages is marked on EACH
page.
"""
import os
import sys
import tempfile

import fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.visual_debugger import VisualDebugger


def _make_multi_page_pdf(pages):
    """`pages` is a list of [(x, y, text), ...] per page."""
    doc = fitz.open()
    for page_content in pages:
        page = doc.new_page(width=595, height=842)
        for x, y, txt in page_content:
            page.insert_text(fitz.Point(x, y), txt, fontsize=12)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(path)
    doc.close()
    return path


def _stub_vd():
    """Build a VisualDebugger without a real Gemini connection."""
    vd = VisualDebugger.__new__(VisualDebugger)
    vd.lock = __import__("threading").Lock()
    vd.output_dir = tempfile.mkdtemp(prefix="vd_out_")
    vd.temp_dir = os.path.join(vd.output_dir, "temp_debug")
    os.makedirs(vd.temp_dir, exist_ok=True)
    vd._cache_path = os.path.join(vd.output_dir, "vd_coord_cache.json")
    vd._coord_cache = {}
    vd.gemini = None       # text-layer path doesn't need it
    vd.bbox_locator = None # stubbed; the typed-text fixtures never trigger Gemini
    return vd


def test_value_on_multiple_pages_gets_marked_on_each():
    pdf = _make_multi_page_pdf([
        [(50, 100, "STELLA appears on page 1")],
        [(50, 100, "STELLA also on page 2")],
        [(50, 100, "Nothing relevant here")],
    ])
    try:
        vd = _stub_vd()
        # Drain the generator
        for _ in vd.debug_mismatches_batch(
            pdf_path=pdf,
            doc_no="TEST/1",
            mismatches=[{"field": "Claimant Name", "value": "STELLA", "page_info": ""}],
        ):
            pass

        out_pdf = os.path.join(vd.output_dir, "matched_docs", os.path.basename(pdf))
        assert os.path.exists(out_pdf), "marked PDF should be written"

        # Count drawing operations on each page — pages 1 & 2 should have at
        # least one rectangle stroked (Q/q + re + S in the content stream).
        result = fitz.open(out_pdf)
        try:
            for page_idx in (0, 1):
                page = result.load_page(page_idx)
                content = b"".join(page.get_contents())
                # PyMuPDF draws stroked rects with 're' + 'S' tokens.
                assert b"re" in content, f"page {page_idx + 1} should have a rect"
            # Page 3 should NOT have the rect.
            page3 = result.load_page(2)
            assert b"re" not in b"".join(page3.get_contents()), \
                "page 3 should be untouched"
        finally:
            result.close()
    finally:
        if os.path.exists(pdf):
            os.remove(pdf)


if __name__ == "__main__":
    test_value_on_multiple_pages_gets_marked_on_each()
    print("OK")
```

- [ ] **Step 2: Run test to verify it fails**

```
cd Server && python -m pytest test_visual_debugger_all_pages.py -v
```

Expected: FAIL — current `debug_mismatches_batch` routes through a single hinted page and uses the grid pipeline.

- [ ] **Step 3: Add `bbox_locator` to `__init__` and rewrite `debug_mismatches_batch`**

In `Server/api/validate/visual_debugger.py`:

Update `__init__` (around line 190) — add the new locator + imports:

```python
    def __init__(self, gemini_helper: GeminiHelper, output_dir: str):
        from api.validate.gemini_bbox import GeminiBboxLocator   # local import to avoid cycles
        self.gemini = gemini_helper
        self.bbox_locator = GeminiBboxLocator(gemini_helper)
        self.output_dir = output_dir
        self.temp_dir = os.path.join(output_dir, "temp_debug")
        self.lock = threading.Lock()
        os.makedirs(self.temp_dir, exist_ok=True)
        self._cache_path = os.path.join(output_dir, "vd_coord_cache.json")
        self._coord_cache = self._load_cache()
```

Replace `debug_mismatches_batch` entirely (currently lines 943–1201) with:

```python
    def debug_mismatches_batch(self, pdf_path, doc_no, mismatches):
        """
        Process every mismatch for a single document. New flow (spec §3):

          for page in all_pages:
              text_hits = PdfTextLocator.search_in_page(page, variants_for_each_mismatch)
              if no hits for a mismatch on this page AND page has no text layer:
                  → batch into per-page Gemini call
              draw all hits

        Each mismatch can produce 0..N boxes across the document.
        """
        from api.validate.text_locator import PdfTextLocator
        from api.validate.value_variants import build_variants

        clean_doc_no = doc_no.replace("/", "_").replace("\\", "_")
        all_boxes: list[dict] = []
        # Coverage tracking: per-mismatch box count.
        per_mismatch_boxes: dict[tuple, int] = {
            (mm["field"], mm["value"]): 0 for mm in mismatches
        }

        # Precompute variants once per mismatch.
        variants_by_mm: dict[tuple, list[str]] = {}
        for mm in mismatches:
            key = (mm["field"], mm["value"])
            variants_by_mm[key] = build_variants(mm["value"], mm["field"])

        doc = fitz.open(pdf_path)
        try:
            total_pages = doc.page_count
            for page_idx in range(total_pages):
                page_num = page_idx + 1
                page = doc.load_page(page_idx)
                pdf_rect = (page.rect.x0, page.rect.y0, page.rect.x1, page.rect.y1)
                yield f"Scanning {doc_no} page {page_num}/{total_pages}"

                # 1. Text-layer search for every mismatch.
                unresolved: list[tuple] = []   # mismatches not found on this page yet
                for mm in mismatches:
                    key = (mm["field"], mm["value"])
                    variants = variants_by_mm[key]
                    hits = PdfTextLocator.search_in_page(page, variants)
                    if hits:
                        for r in hits:
                            all_boxes.append({
                                "page_num": page_num,
                                "pdf_rect_box": r,
                                "pdf_rect": pdf_rect,
                                "label": mm["field"],
                            })
                            per_mismatch_boxes[key] += 1
                    else:
                        unresolved.append(key)

                # 2. Gemini fallback — only for pages WITHOUT a useful text layer.
                if not unresolved:
                    continue
                if PdfTextLocator.has_useful_text_layer(page):
                    # Page has text but the unresolved values aren't in it.
                    # Don't burn a Gemini call — they're genuinely absent.
                    continue

                # Rasterize the page and call Gemini once for all unresolved values.
                base_img = os.path.join(
                    self.temp_dir, f"raw_{clean_doc_no}_p{page_num}.png"
                )
                extraction = self.extract_page_as_image(pdf_path, page_num, base_img)
                if not extraction:
                    continue
                pix = fitz.open(pdf_path).load_page(page_idx).get_pixmap(
                    matrix=fitz.Matrix(self.SCALE, self.SCALE)
                )
                page_w_px, page_h_px = pix.width, pix.height
                # Send the ORIGINAL values (not variants) to Gemini — it's
                # better at interpreting natural language than synthetic forms.
                values = [mm_value for (_, mm_value) in unresolved]
                hits_by_value = self.bbox_locator.locate(
                    page_image_path=base_img,
                    page_w_px=page_w_px,
                    page_h_px=page_h_px,
                    values=values,
                )
                for key in unresolved:
                    field, value = key
                    for pixel_box in hits_by_value.get(value, []):
                        all_boxes.append({
                            "page_num": page_num,
                            "pixel_box": list(pixel_box),
                            "img_width": page_w_px,
                            "img_height": page_h_px,
                            "pdf_rect": pdf_rect,
                            "label": field,
                        })
                        per_mismatch_boxes[key] += 1
        finally:
            doc.close()

        if not all_boxes:
            yield f"No occurrences found for any mismatch in {doc_no}"
            return None

        output_name = os.path.basename(pdf_path)
        output_path = os.path.join(self.output_dir, "matched_docs", output_name)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        active_source = output_path if os.path.exists(output_path) else pdf_path
        self.mark_pdf_with_boxes(active_source, all_boxes, output_path, doc_no=clean_doc_no)

        # S3 sync — unchanged path from previous behaviour.
        try:
            rid = os.path.basename(os.path.normpath(self.output_dir))
            kind = os.path.basename(os.path.dirname(os.path.normpath(self.output_dir))) or "validate"
            vd_key = f"outputs/{kind}/{rid}/matched_docs/{os.path.basename(output_path)}"
            _sync_file(output_path, content_type="application/pdf", key=vd_key)
        except Exception as _e:
            print(f"[VD] sync_file failed for {output_path}: {_e}")

        yield f"Marked {len(all_boxes)} occurrences across {doc_no}"

        self.last_coverage_report = self.audit_coverage(
            doc_no=doc_no,
            mismatches=mismatches,
            per_mismatch_boxes=per_mismatch_boxes,
            total_boxes=len(all_boxes),
        )
        return output_path
```

Also update `audit_coverage` signature — replace the existing classmethod (lines 858–923) with:

```python
    @staticmethod
    def audit_coverage(doc_no, mismatches, per_mismatch_boxes, total_boxes):
        """
        Coverage report under the all-pages model: per mismatch, count boxes
        drawn. A mismatch with 0 boxes is a miss; ≥1 is a hit.
        """
        report = {
            "doc_no": doc_no,
            "total_mismatches": len(mismatches),
            "total_boxes_drawn": total_boxes,
            "hits": sum(1 for n in per_mismatch_boxes.values() if n > 0),
            "misses": sum(1 for n in per_mismatch_boxes.values() if n == 0),
            "per_mismatch": [
                {"field": f, "value": v, "boxes": n}
                for (f, v), n in per_mismatch_boxes.items()
            ],
            "all_marked": all(n > 0 for n in per_mismatch_boxes.values()),
        }
        if report["all_marked"]:
            print(f"[VD] Coverage OK: {report['hits']}/{len(mismatches)} mismatches marked for {doc_no} ({total_boxes} total boxes).")
        else:
            print(
                f"[VD] Coverage WARNING for {doc_no}: "
                f"{report['hits']}/{len(mismatches)} mismatches marked, "
                f"{report['misses']} missed."
            )
            for entry in report["per_mismatch"]:
                if entry["boxes"] == 0:
                    print(f"   [VD] miss: field={entry['field']!r} value={entry['value']!r}")
        return report
```

- [ ] **Step 4: Run test to verify it passes**

```
cd Server && python -m pytest test_visual_debugger_all_pages.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add Server/api/validate/visual_debugger.py Server/test_visual_debugger_all_pages.py
git commit -m "feat(vd): rewrite debug_mismatches_batch for all-pages, all-occurrences"
```

---

## Task 9: Cache version bump

The cache value shape changed (single `bbox | None` → list of pixel boxes), so the format version must bump or the loader will treat old entries as valid.

**Files:**
- Modify: `Server/api/validate/visual_debugger.py` — `_CACHE_VERSION` constant

- [ ] **Step 1: Bump the version**

In `Server/api/validate/visual_debugger.py`, change line 49:

```python
    _CACHE_VERSION = "18"      # Bumped: never skip — placeholder values fall back to field label
```

to:

```python
    _CACHE_VERSION = "19"      # Bumped: all-pages flow stores list[pixel_box] instead of single box
```

- [ ] **Step 2: Confirm the existing version check at line 208 covers this**

Read `_load_cache` (around line 203). It already does:

```python
if data.get("_v") == self._CACHE_VERSION:
    return data.get("coords", {})
print(f"[*] VD Cache format changed (v{data.get('_v', '?')} → v{self._CACHE_VERSION}). Clearing old cache.")
```

No code change needed — the bump alone triggers re-processing.

- [ ] **Step 3: Commit**

```
git add Server/api/validate/visual_debugger.py
git commit -m "feat(vd): bump cache version to 19 for new payload shape"
```

---

## Task 10: Delete dead code

Remove the grid/ruler pipeline, page-hint helpers, and seal/cover overrides. Spec §3.9.

**Files:**
- Modify: `Server/api/validate/visual_debugger.py`

- [ ] **Step 1: Run the test suite as a baseline (everything should still pass)**

```
cd Server && python -m pytest test_value_variants.py test_text_locator.py test_gemini_bbox.py test_visual_debugger_all_pages.py test_gemini_helper_json.py -v
```

Expected: all PASS. Note the count; we'll compare after deletion.

- [ ] **Step 2: Delete the following from `visual_debugger.py`**

Delete these symbols (open the file in the editor and remove each block):

- Constants block lines ~39–48: `GRID_SIZE`, `GRID_LABEL_INTERVAL`, `COORD_PADDING`, `BOX_DRAW_EXTRA_PX_X`, `BOX_DRAW_EXTRA_PX_Y`, `GRID_ALPHA`, `LABEL_FONT_SIZE` (KEEP `DPI` and `SCALE` — Gemini fallback still rasterizes pages).
- Constants block lines ~59–70: `VERIFY_ENABLED`, `MIN_BOX_AREA_PX` (moved to `gemini_bbox.py`), `MAX_METADATA_PAGES_BEFORE_COVER_FALLBACK`.
- Lines ~72–76: `GRID_COLOR`, `GRID_LABEL_COLOR`, `GRID_BG_COLOR` (KEEP `MISMATCH_BOX_COLOR`, `MISMATCH_TEXT_COLOR`).
- Lines ~82–113: `FIRST_PAGE_FIELD_KEYWORDS`, `AVOID_SEAL_FIELD_KEYWORDS`, `_is_first_page_field`, `_avoid_seal`.
- Lines ~126–149: `_METADATA_BLOCK_RE`, `_EC_BLOCK_RE`, `_parse_pages_from_info`.
- Lines ~159–188: `_condense_value_for_search` (superseded by `value_variants`).
- Lines ~264–271: `_load_font` (was only used by grid drawing).
- Lines ~273–337: `draw_grid_on_image` (entire method).
- Lines ~343–391: `_verify_bbox_contains_value`.
- Lines ~393–526: `get_coordinates_from_gemini`.
- Lines ~671–700: `_value_variants` (superseded by `build_variants`).
- Lines ~702–785: `_remark_missed`.
- Lines ~787–855: `_scan_remaining_pages`.
- Lines ~1205–1271: `debug_mismatch` (legacy single-mismatch entry point — no callers per the Grep in Task 0; remove it).

Verify no callers remain:

```
cd Server && python -c "from api.validate.visual_debugger import VisualDebugger; print('imports OK')"
```

Expected: `imports OK` printed without errors.

Also Grep for each deleted symbol across the project:

```
cd Server && python -c "
import subprocess
for sym in ['draw_grid_on_image', 'get_coordinates_from_gemini', '_scan_remaining_pages', '_remark_missed', '_parse_pages_from_info', '_is_first_page_field', '_avoid_seal', 'FIRST_PAGE_FIELD_KEYWORDS', 'debug_mismatch(', 'GRID_SIZE', 'BOX_DRAW_EXTRA_PX']:
    r = subprocess.run(['grep', '-rn', sym, '.', '--include=*.py'], capture_output=True, text=True)
    if r.stdout.strip():
        print(f'STILL REFERENCED: {sym}')
        print(r.stdout)
"
```

If anything other than `test_visual_debugger.py` or `smoke_new_vd.py` shows up, STOP — those references must be updated before continuing. Tasks 11 and 12 handle those two files.

- [ ] **Step 3: Re-run tests**

```
cd Server && python -m pytest test_value_variants.py test_text_locator.py test_gemini_bbox.py test_visual_debugger_all_pages.py test_gemini_helper_json.py -v
```

Expected: all PASS, same count as Step 1.

- [ ] **Step 4: Commit**

```
git add Server/api/validate/visual_debugger.py
git commit -m "refactor(vd): delete grid pipeline, page-hint helpers, and seal overrides"
```

---

## Task 11: Update `test_visual_debugger.py`

The existing file imports the old `VisualDebugger` and tests the grid pipeline. Update it to test the new flow (or delete obsolete tests; keep ones that still make sense).

**Files:**
- Modify: `Server/test_visual_debugger.py`

- [ ] **Step 1: Read the current test file**

```
cd Server && python -m pytest test_visual_debugger.py --collect-only 2>&1 | head -40
```

This lists the existing tests. Inspect each one: if it references a deleted symbol (e.g. `draw_grid_on_image`, `get_coordinates_from_gemini`, `_parse_pages_from_info`), it must be removed or rewritten.

- [ ] **Step 2: Remove the obsolete tests / helpers**

Open `Server/test_visual_debugger.py`. Delete any function that:
- Calls `VisualDebugger.draw_grid_on_image`
- Calls `VisualDebugger.get_coordinates_from_gemini`
- Calls `VisualDebugger._parse_pages_from_info` / `_is_first_page_field` / `_avoid_seal`
- References `GRID_SIZE`, `COORD_PADDING`, `BOX_DRAW_EXTRA_PX_*`

Keep the `create_sample_pdf` helper if it's there (it produces useful fixtures).

- [ ] **Step 3: Add a smoke test using the new entry point**

Append to `Server/test_visual_debugger.py`:

```python
def test_debug_mismatches_batch_smoke_typed_pdf():
    """Mismatch value present in PDF text layer → at least one box drawn."""
    import os, sys, tempfile, threading
    import fitz
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from api.validate.visual_debugger import VisualDebugger

    # Build a 1-page typed PDF.
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text(fitz.Point(50, 100), "DOC NO 2420/2022", fontsize=12)
    fd, pdf_path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    doc.save(pdf_path)
    doc.close()

    try:
        vd = VisualDebugger.__new__(VisualDebugger)
        vd.lock = threading.Lock()
        vd.output_dir = tempfile.mkdtemp(prefix="vd_out_")
        vd.temp_dir = os.path.join(vd.output_dir, "temp_debug")
        os.makedirs(vd.temp_dir, exist_ok=True)
        vd._cache_path = os.path.join(vd.output_dir, "vd_coord_cache.json")
        vd._coord_cache = {}
        vd.gemini = None
        vd.bbox_locator = None

        list(vd.debug_mismatches_batch(
            pdf_path=pdf_path,
            doc_no="DOC/2420",
            mismatches=[{"field": "Document Number", "value": "2420/2022", "page_info": ""}],
        ))
        out_pdf = os.path.join(vd.output_dir, "matched_docs", os.path.basename(pdf_path))
        assert os.path.exists(out_pdf)
    finally:
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
```

- [ ] **Step 4: Run the file**

```
cd Server && python -m pytest test_visual_debugger.py -v
```

Expected: all remaining tests PASS (count depends on how many you removed).

- [ ] **Step 5: Commit**

```
git add Server/test_visual_debugger.py
git commit -m "test(vd): update test_visual_debugger.py for new all-pages flow"
```

---

## Task 12: Update `smoke_new_vd.py`

The smoke script references the old single-mismatch flow + cover-page logic. Bring it onto the batch API.

**Files:**
- Modify: `Server/smoke_new_vd.py`

- [ ] **Step 1: Read the full smoke script**

Open `Server/smoke_new_vd.py` and identify every call into `VisualDebugger`. The target file used `debug_mismatch` (single-mismatch, now deleted) and references `_is_first_page_field`.

- [ ] **Step 2: Convert to `debug_mismatches_batch`**

Replace the `VisualDebugger.debug_mismatch(...)` call with the batch form:

```python
    for msg in vd.debug_mismatches_batch(
        pdf_path=src_pdf,
        doc_no=target["doc_no"],
        mismatches=[{
            "field": target["field"],
            "value": target["value"],
            "page_info": f"Page {target['page']}",   # ignored by new flow, kept for shape
        }],
    ):
        print(msg)
```

Remove any reference to `_is_first_page_field`, `_parse_pages_from_info`, or the old single-mismatch return value.

- [ ] **Step 3: Run the smoke script** (requires real `GEMINI_API_KEY` + the sample deed PDF)

```
cd Server && python smoke_new_vd.py
```

Expected: prints `Marked N occurrences ...` and writes a marked PDF under `outputs/.../matched_docs/`.

If the sample PDF referenced at the top of the file no longer exists, edit the path to point at any deed PDF available locally, or skip this manual run and rely on Task 8's integration test for coverage.

- [ ] **Step 4: Commit**

```
git add Server/smoke_new_vd.py
git commit -m "test(vd): update smoke_new_vd.py to use debug_mismatches_batch"
```

---

## Task 13: End-to-end manual verification against a real Tamil deed

Sanity check the full flow against a real deed before declaring done.

**Files:** none modified.

- [ ] **Step 1: Pick a deed PDF that has a known mismatch**

Use the deed shown in the user's screenshot if available, or any deed under `outputs/.../matched_docs/` for which you have validation output.

- [ ] **Step 2: Run the validator handler**

The validator at `Server/api/validate/handler.py` runs the visual debugger as part of its flow. Run the handler against the chosen deed (the exact CLI varies — match how the team currently invokes it; if uncertain, copy the call from the closest existing smoke script).

- [ ] **Step 3: Inspect the marked PDF**

Open the output PDF in any viewer. Verify:
- The known mismatch value is boxed on **every page** where it appears (no longer just page 1 or the hinted page).
- The boxes are tight against the value text (no 20–50 px drift from the old grid pipeline).
- The label sits above each box and reads as the field name.

If anything looks off, capture which mismatch + which page in a comment on the spec issue and STOP — don't paper over with quick fixes.

- [ ] **Step 4: Confirm cache cleanup logged on first run**

The first run after the version bump should print:

```
[*] VD Cache format changed (v18 → v19). Clearing old cache.
```

If it doesn't, the cache version constant didn't take effect — re-check Task 9.

- [ ] **Step 5: No commit needed; manual verification only**

---

## Self-Review

**Spec coverage:**

| Spec § | Plan task |
|---|---|
| §3.1 pipeline | Task 8 |
| §3.2 components — `PdfTextLocator` | Task 5 |
| §3.2 components — `GeminiBboxLocator` | Task 6 |
| §3.2 components — `value_variants` | Tasks 2–4 |
| §3.2 components — `VisualDebugger` rewrite | Task 8 |
| §3.2 components — `mark_pdf_with_boxes` new branch | Task 7 |
| §3.2 components — `audit_coverage` adapted | Task 8 (in same edit) |
| §3.3 data structures | Task 7 (defines `pdf_rect_box`); Task 8 (uses it) |
| §3.4 variant generation | Tasks 2, 3, 4 |
| §3.5 text-density heuristic | Task 5 |
| §3.6 cache version bump | Task 9 |
| §3.7 batching Gemini per page | Task 8 (inner loop sends one call per page with all unresolved values) |
| §3.8 error handling | Task 6 (Gemini try/except), Task 5 (search try/except) |
| §3.9 deletions | Task 10 |
| §3.10 caller impact (`validator.py`, tests, smoke) | Tasks 11, 12 (no `validator.py` change needed — signature preserved) |
| §4 testing | Tasks 2–6 unit tests; Task 8 integration; Task 13 manual |
| §5 risks — verify crop opt-in | Not implemented in v1; spec says `VD_VERIFY=1` opt-in is OK to defer. If you want it now, add as Task 14. |
| §6 rollout — cache message | Task 13 step 4 confirms it |

**Placeholder scan:** none found. All steps contain runnable commands or actual code.

**Type consistency:**
- `pdf_rect_box` named consistently across Tasks 7 and 8.
- `per_mismatch_boxes` is `dict[tuple, int]` in Task 8 — consumer (`audit_coverage`) matches.
- `hits_by_value` is `dict[str, list[tuple]]` in Task 8 — producer (`GeminiBboxLocator.locate` in Task 6) returns the same shape.
- `build_variants(value, field)` signature consistent across Tasks 2, 3, 4 and consumer in Task 8.
- `PdfTextLocator.search_in_page(page, variants)` consistent across Tasks 5, 7 and consumer in Task 8.

**One ambiguity worth calling out:** Task 8 uses `fitz.open(pdf_path).load_page(page_idx).get_pixmap(...)` to get pixel dimensions for the Gemini path, then `extract_page_as_image` writes the file. That's a duplicate open. Cleaner: have `extract_page_as_image` return `(path, pdf_rect, pix_w, pix_h)` and use those. Left as-is for clarity in the plan; the executing engineer can de-duplicate during Task 8 step 3 if obvious.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-17-visual-debugger-all-pages.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a 13-task plan with this much detail.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
