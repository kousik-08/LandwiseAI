import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.validate.opinion_summary import extract_summary


class _StubGemini:
    def __init__(self, reply): self._reply = reply
    def generate_from_text(self, text, prompt): return self._reply


def test_extract_summary_parses_and_normalizes():
    reply = json.dumps({
        "verdict": "Safe to Proceed",  # will be bumped by a Critical issue
        "issues": [
            {"text": "Root of title broken at 1990", "severity": "critical", "source_section": "TITLE FLOW & ENCUMBRANCES"},
            {"text": "Consideration mismatch Rs.400", "severity": "minor", "source_section": "DISCREPANCIES"},
        ],
        "pros": [{"text": "No subsisting mortgage in EC"}],
    })
    out = extract_summary("<<report text>>", gemini=_StubGemini(reply))
    assert out["verdict"] == "Do Not Proceed"          # guardrail bumped it
    assert out["counts"] == {"critical": 1, "minor": 1, "pros": 1}
    assert out["issues"][0]["severity"] == "Critical"  # normalized
    assert out["prompt_version"]


def test_extract_summary_bad_json_falls_back():
    out = extract_summary("FINAL VERDICT: Defective due to X", gemini=_StubGemini("not json"))
    assert out["verdict"] in ("Proceed with Caution", "Do Not Proceed", "Safe to Proceed")
    assert isinstance(out["issues"], list)
    assert out.get("fallback") is True
