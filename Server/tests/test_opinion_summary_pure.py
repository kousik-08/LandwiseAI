import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.validate.opinion_summary import (
    normalize_verdict, normalize_severity, compute_counts,
)


def test_normalize_severity_maps_variants():
    assert normalize_severity("critical") == "Critical"
    assert normalize_severity("CRITICAL") == "Critical"
    assert normalize_severity("minor") == "Minor"
    assert normalize_severity("anything else") == "Minor"  # safe default


def test_normalize_verdict_clean_is_safe():
    assert normalize_verdict("Clear, Marketable, and Valid", []) == "Safe to Proceed"


def test_normalize_verdict_minor_only_is_caution():
    issues = [{"text": "consideration differs by Rs.400", "severity": "Minor"}]
    assert normalize_verdict("Safe to Proceed", issues) == "Proceed with Caution"


def test_normalize_verdict_critical_forces_do_not_proceed():
    issues = [{"text": "root of title broken", "severity": "Critical"}]
    assert normalize_verdict("Proceed with Caution", issues) == "Do Not Proceed"


def test_normalize_verdict_defective_text_without_issues_is_caution():
    assert normalize_verdict("Defective due to pending mutation", []) == "Proceed with Caution"


def test_compute_counts():
    issues = [{"severity": "Critical"}, {"severity": "Minor"}, {"severity": "Minor"}]
    pros = [{"text": "a"}, {"text": "b"}]
    assert compute_counts(issues, pros) == {"critical": 1, "minor": 2, "pros": 2}
