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
from datetime import datetime
from typing import Optional


_PARENTHETICAL_RE = re.compile(r"\s*\([^)]{0,120}\)\s*")
_VARIANT_CAP = 12   # Bound search cost; spec §3.4.


# Tamil digit code points U+0BE6..U+0BEF map to 0..9.
_TAMIL_DIGITS = "௦௧௨௩௪௫௬௭௮௯"
_WESTERN_TO_TAMIL = str.maketrans("0123456789", _TAMIL_DIGITS)
_TAMIL_TO_WESTERN = str.maketrans(_TAMIL_DIGITS, "0123456789")


_DATE_INPUT_FORMATS = (
    "%B %d, %Y",        # April 14, 2008
    "%b %d, %Y",        # Apr 14, 2008
    "%d-%m-%Y",
    "%d/%m/%Y",
    "%d.%m.%Y",
    "%Y-%m-%d",
    "%d-%b-%Y",
    "%d %B %Y",
)

_DATE_OUTPUT_FORMATS = (
    "%d-%m-%Y",
    "%d/%m/%Y",
    "%d.%m.%Y",
    "%d-%b-%Y",
    "%B %d, %Y",
)


def _dedupe_preserve_order(items):
    seen = []
    for s in items:
        s = (s or "").strip()
        if s and s not in seen:
            seen.append(s)
    return seen


def _strip_parentheticals(s):
    cleaned = _PARENTHETICAL_RE.sub(" ", s).strip()
    return re.sub(r"\s+", " ", cleaned).strip()


def _try_parse_date(s):
    for fmt in _DATE_INPUT_FORMATS:
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


def _date_variants(s):
    dt = _try_parse_date(s)
    if not dt:
        return []
    return [dt.strftime(fmt) for fmt in _DATE_OUTPUT_FORMATS]


def _has_western_digits(s):
    return any(c.isdigit() for c in s)


def _has_tamil_digits(s):
    return any(c in _TAMIL_DIGITS for c in s)


def _numeric_variants(s):
    out = []
    if _has_western_digits(s):
        digits_only = re.sub(r"[^\d]", "", s)
        if digits_only:
            out.append(digits_only)
            out.append(digits_only.translate(_WESTERN_TO_TAMIL))
    if _has_tamil_digits(s):
        westernised = s.translate(_TAMIL_TO_WESTERN)
        out.append(westernised)
        digits_only = re.sub(r"[^\d]", "", westernised)
        if digits_only and digits_only != westernised:
            out.append(digits_only)
    return out


def build_variants(value, field):
    """Return a deduped, ordered list of search candidates for `value`."""
    if not value:
        return []
    raw = str(value).strip()
    candidates = [raw]
    cleaned = _strip_parentheticals(raw)
    if cleaned and cleaned != raw:
        candidates.append(cleaned)
    for src in (raw, cleaned):
        candidates.extend(_date_variants(src))
        candidates.extend(_numeric_variants(src))
    return _dedupe_preserve_order(candidates)[:_VARIANT_CAP]
