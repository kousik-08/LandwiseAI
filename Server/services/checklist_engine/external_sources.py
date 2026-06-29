"""
Tier-B capability adapters — external data sources (registry / GIS / courts).

Each source is DISABLED until its endpoint/credentials are configured via env
vars. While disabled, is_configured() is False and the bound checklist provider
returns an honest 'pending: requires <source>' — never a fabricated pass.

To turn one ON:
  1. Set the documented env var(s) (see .env.example) to your data provider.
  2. Implement / adjust the `_fetch(...)` body to match that provider's API and
     return the small normalized dict the provider expects.

The `_fetch` bodies below are real HTTP scaffolds against a generic JSON
endpoint. Replace them with the concrete government/commercial API you license.
No network call ever happens while a source is unconfigured.
"""
import os


def _http_get_json(url, params, timeout=8):
    """Minimal GET→JSON helper. Returns dict or None; never raises."""
    try:
        import requests  # lazy: only needed when a source is configured
    except Exception:
        print("[checklist-engine] 'requests' not installed; external lookup skipped")
        return None
    try:
        r = requests.get(url, params={k: v for k, v in params.items() if v is not None}, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[checklist-engine] external GET failed ({url}): {e}")
        return None


class _ExternalSource:
    ENV_VARS = ()
    LABEL = "external source"
    HOW_TO = "configure the required env var"

    @classmethod
    def is_configured(cls) -> bool:
        return all(os.getenv(v) for v in cls.ENV_VARS)

    @classmethod
    def requirement(cls) -> str:
        return f"Requires {cls.LABEL} ({cls.HOW_TO})."

    @classmethod
    def lookup(cls, **kwargs):
        if not cls.is_configured():
            return None
        return cls._fetch(**kwargs)

    @classmethod
    def _fetch(cls, **kwargs):  # pragma: no cover - provider-specific
        raise NotImplementedError


class CRZSource(_ExternalSource):
    ENV_VARS = ("CRZ_DATA_URL",)
    LABEL = "a CRZ coastal-zonation source"
    HOW_TO = "set CRZ_DATA_URL"

    @classmethod
    def _fetch(cls, survey_no=None, lat=None, lng=None):
        d = _http_get_json(os.getenv("CRZ_DATA_URL"), {"survey": survey_no, "lat": lat, "lng": lng})
        if d is None:
            return None
        return {"in_crz": bool(d.get("in_crz")), "zone": d.get("zone"), "raw": d}


class ForestSource(_ExternalSource):
    ENV_VARS = ("FOREST_DATA_URL",)
    LABEL = "a forest/wetland GIS layer"
    HOW_TO = "set FOREST_DATA_URL"

    @classmethod
    def _fetch(cls, survey_no=None, lat=None, lng=None):
        d = _http_get_json(os.getenv("FOREST_DATA_URL"), {"survey": survey_no, "lat": lat, "lng": lng})
        if d is None:
            return None
        return {"is_forest": bool(d.get("is_forest") or d.get("is_wetland")), "raw": d}


class DTCPSource(_ExternalSource):
    ENV_VARS = ("DTCP_API_URL",)
    LABEL = "a DTCP/CMDA layout-approval lookup"
    HOW_TO = "set DTCP_API_URL"

    @classmethod
    def _fetch(cls, survey_no=None, village=None):
        d = _http_get_json(os.getenv("DTCP_API_URL"), {"survey": survey_no, "village": village})
        if d is None:
            return None
        return {"approved": bool(d.get("approved")), "approval_no": d.get("approval_no"), "raw": d}


class ECourtsSource(_ExternalSource):
    ENV_VARS = ("ECOURTS_API_URL",)  # optional: ECOURTS_API_KEY
    LABEL = "an eCourts case-search source"
    HOW_TO = "set ECOURTS_API_URL"

    @classmethod
    def _fetch(cls, survey_no=None, names=None):
        params = {"survey": survey_no, "party": ",".join(names) if names else None}
        key = os.getenv("ECOURTS_API_KEY")
        if key:
            params["api_key"] = key
        d = _http_get_json(os.getenv("ECOURTS_API_URL"), params)
        if d is None:
            return None
        return {"cases": d.get("cases") or [], "raw": d}


class GuidelineValueSource(_ExternalSource):
    ENV_VARS = ("GUIDELINE_VALUE_API_URL",)
    LABEL = "a TNREGINET guideline-value source"
    HOW_TO = "set GUIDELINE_VALUE_API_URL"

    @classmethod
    def _fetch(cls, survey_no=None, village=None):
        d = _http_get_json(os.getenv("GUIDELINE_VALUE_API_URL"), {"survey": survey_no, "village": village})
        if d is None:
            return None
        return {"guideline_value": d.get("guideline_value"), "unit": d.get("unit"), "raw": d}


class ARegisterSource(_ExternalSource):
    ENV_VARS = ("AREGISTER_API_URL",)
    LABEL = "a revenue 'A-Register' classification source"
    HOW_TO = "set AREGISTER_API_URL"

    @classmethod
    def _fetch(cls, survey_no=None, village=None):
        d = _http_get_json(os.getenv("AREGISTER_API_URL"), {"survey": survey_no, "village": village})
        if d is None:
            return None
        return {"classification": d.get("classification"), "raw": d}
