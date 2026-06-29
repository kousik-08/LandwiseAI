import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.landwise.router import _load_opinion_summary


def test_load_opinion_summary_reads_disk(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    rid = "req-xyz"
    legal_dir = os.path.join("outputs", "validate", rid, "legal")
    os.makedirs(legal_dir, exist_ok=True)
    payload = {"verdict": "Safe to Proceed", "issues": [], "pros": [],
               "counts": {"critical": 0, "minor": 0, "pros": 0}}
    with open(os.path.join(legal_dir, "opinion_summary.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f)

    out = _load_opinion_summary(rid)
    assert out["verdict"] == "Safe to Proceed"


def test_load_opinion_summary_missing_returns_none(monkeypatch):
    # Force all read tiers to miss without touching S3 / DB.
    import services.artifact_store as store
    monkeypatch.setattr(store, "read_json_artifact", lambda *a, **k: None)
    assert _load_opinion_summary("absent") is None
