"""
checklist_engine — provider/adapter framework that auto-fills the legal-review
checklist from the AI analysis, document extractions (Tier C) and external data
sources (Tier B).

Public API:
    run(parcel_id, db)            → apply provider suggestions to the checklist
    run_extractions(parcel_id, db)→ run + cache the Tier-C Gemini extractors
    CHECK_PROVIDERS               → {item_code: provider} registry
"""
from services.checklist_engine.engine import run, run_extractions
from services.checklist_engine.providers import CHECK_PROVIDERS

__all__ = ["run", "run_extractions", "CHECK_PROVIDERS"]
