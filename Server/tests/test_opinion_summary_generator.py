import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.validate.opinion_summary import OpinionSummaryGenerator


class _StubGemini:
    def __init__(self, reply): self._reply = reply
    def generate_from_text(self, text, prompt): return self._reply


def test_build_reads_report_and_writes_summary(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    rid = "test-req-1"
    legal_dir = os.path.join("outputs", "validate", rid, "legal")
    os.makedirs(legal_dir, exist_ok=True)
    with open(os.path.join(legal_dir, "legal_opinion_report.md"), "w", encoding="utf-8") as f:
        f.write("FINAL VERDICT & LEGAL OPINION: Clear, Marketable, and Valid")

    reply = json.dumps({
        "verdict": "Safe to Proceed",
        "issues": [],
        "pros": [{"text": "Unbroken chain across 12 transactions"}],
    })
    gen = OpinionSummaryGenerator(request_id=rid)
    out = gen.build(gemini=_StubGemini(reply))

    assert out["verdict"] == "Safe to Proceed"
    assert out["request_id"] == rid
    assert out["generated_at"]
    assert os.path.exists(gen.summary_json_path())
    with open(gen.summary_json_path(), encoding="utf-8") as f:
        on_disk = json.load(f)
    assert on_disk["pros"][0]["text"] == "Unbroken chain across 12 transactions"


def test_read_report_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    gen = OpinionSummaryGenerator(request_id="nope")
    assert gen.read_report() is None
