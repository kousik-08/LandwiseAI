"""
Tamil → English translation/transliteration for displaying land-record data
bilingually in the web app.

Design:
  • Only strings containing Tamil characters are translated (English/numbers pass
    through untouched).
  • Names are TRANSLITERATED (நாவீன் → Naveen); terms are TRANSLATED
    (கிரயப் பத்திரம் → Sale Deed, புறம்போக்கு → Poramboke).
  • Results are cached to disk (translations are deterministic), so each distinct
    Tamil string costs at most one Gemini call ever.
"""
import os
import re
import json
import threading

_TAMIL = re.compile("[஀-௿]")  # Tamil unicode block
_LOCK = threading.Lock()
_CACHE = None
_CACHE_FILE = os.path.join("tmp", "translation_cache.json")

_PROMPT = """You translate Tamil text from Tamil Nadu land records into English.

For EACH input string:
  • If it is a PERSON or PLACE name → TRANSLITERATE to readable English
    (e.g. நாவீன் -> Naveen, பொன்மணி -> Ponmani, வேலூர் -> Vellore).
  • If it is a TERM / phrase (document type, land classification, relationship,
    status) → TRANSLATE its meaning
    (e.g. கிரயப் பத்திரம் -> Sale Deed, தானப் பத்திரம் -> Gift Deed,
     புறம்போக்கு -> Poramboke, நஞ்சை -> Nanjai (wetland), புஞ்சை -> Punjai (dryland),
     அடமானம் -> Mortgage, வாரிசு -> Legal heir).
  • Keep numbers, survey numbers and dates exactly as-is.

INPUT is a JSON array of strings. Return ONLY a JSON array of the SAME LENGTH,
where element i is the English of input i. No commentary, no markdown."""


def has_tamil(s) -> bool:
    return bool(s) and bool(_TAMIL.search(str(s)))


def _load():
    global _CACHE
    if _CACHE is None:
        try:
            with open(_CACHE_FILE, encoding="utf-8") as f:
                _CACHE = json.load(f)
        except Exception:
            _CACHE = {}
    return _CACHE


def _save():
    try:
        os.makedirs(os.path.dirname(_CACHE_FILE), exist_ok=True)
        with open(_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(_CACHE, f, ensure_ascii=False)
    except Exception as e:
        print(f"[translate] cache save failed: {e}")


def _parse_array(text):
    s = (text or "").strip()
    if s.startswith("```"):
        s = s.strip("`")
        i = s.find("[")
        if i >= 0:
            s = s[i:]
    try:
        return json.loads(s)
    except Exception:
        m = re.search(r"\[.*\]", s, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


def translate_batch(texts) -> dict:
    """Return {original_tamil: english} for every Tamil-containing string in `texts`."""
    if not texts:
        return {}
    with _LOCK:
        cache = _load()
        # unique, order-preserving, Tamil-only
        tamil = [t for t in dict.fromkeys(str(x) for x in texts) if has_tamil(t)]
        todo = [t for t in tamil if t not in cache]
        if todo:
            try:
                from common.gemini_helper import GeminiHelper
                out = GeminiHelper().generate_from_text(
                    json.dumps(todo, ensure_ascii=False), _PROMPT
                )
                arr = _parse_array(out)
                if isinstance(arr, list) and len(arr) == len(todo):
                    for t, en in zip(todo, arr):
                        cache[t] = str(en).strip()
                    _save()
                else:
                    print(f"[translate] length mismatch: got {len(arr) if isinstance(arr, list) else 'n/a'} for {len(todo)} inputs")
            except Exception as e:
                print(f"[translate] batch failed: {e}")
        return {t: cache[t] for t in tamil if t in cache}
