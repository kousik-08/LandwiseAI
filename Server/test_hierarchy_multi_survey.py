"""Tests for header-driven multi-survey hierarchy rooting.

Covers the case where an EC declares multiple primary survey numbers (incl.
part-surveys with no plain "mother" like 96/4BPART), plus the legacy fallback
when no primaries are declared.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.validate.hierarchy_generator import HierarchyGenerator


def _gen():
    """HierarchyGenerator without a real Gemini connection."""
    g = HierarchyGenerator.__new__(HierarchyGenerator)
    g.output_dir = ""
    g.node_counter = 0
    g.temp_tx_counter = 0
    g.gemini = None
    return g


def _tx(doc, sn, primaries, date="01-01-2020"):
    return {
        "document_number": doc, "date": date,
        "sellers": ["S"], "buyers": ["B"],
        "survey_number": sn, "nature_of_document": "Sale Deed",
        "property_type": "Agricultural Land", "property_extent": "1 acre",
        "primary_surveys": primaries,
    }


def _by_sn(roots):
    return {r["survey_number"]: r for r in roots}


def _docs(node):
    out = {t["document_number"] for t in node["transactions"]}
    for c in node["children"].values():
        out |= _docs(c)
    return out


def test_two_part_primaries_two_roots_no_empty_mother():
    g = _gen()
    primaries = ["96/4BPART", "97/4BPART"]
    roots = g.build_hierarchy_programmatically([
        _tx("100/2020", "96/4BPART", primaries),
        _tx("101/2020", "97/4BPART", primaries),
    ])
    by = _by_sn(roots)
    assert set(by) == {"96/4BPART", "97/4BPART"}, f"expected two part-roots, got {list(by)}"
    assert "96" not in by and "97" not in by, "must NOT synthesize empty mother roots"
    assert by["96/4BPART"]["transactions"], "document sits directly on the part-primary"
    assert _docs(by["96/4BPART"]) == {"100/2020"}
    assert _docs(by["97/4BPART"]) == {"101/2020"}


def test_part_case_and_spacing_variants_unify():
    g = _gen()
    primaries = ["96/4BPART"]
    roots = g.build_hierarchy_programmatically([
        _tx("100/2020", "96/4Bpart", primaries),    # lowercase
        _tx("101/2021", "96/4B PART", primaries),   # spaced
    ])
    assert len(roots) == 1, f"variants must collapse to one root, got {len(roots)}"
    assert _docs(roots[0]) == {"100/2020", "101/2021"}


def test_normal_mother_with_subdivisions_nests_under_one_root():
    g = _gen()
    primaries = ["222"]
    roots = g.build_hierarchy_programmatically([
        _tx("100/2019", "222/6A", primaries),
        _tx("101/2020", "222/6B", primaries),
    ])
    assert len(roots) == 1
    root = roots[0]
    assert g._normalize_sn(root["survey_number"]) == "222"
    assert set(root["children"].keys()) == {"222/6A", "222/6B"}
    assert _docs(root) == {"100/2019", "101/2020"}


def test_single_primary_one_flow():
    g = _gen()
    roots = g.build_hierarchy_programmatically([_tx("100/2020", "45", ["45"])])
    assert len(roots) == 1
    assert _docs(roots[0]) == {"100/2020"}


def test_unmatched_survey_goes_to_fallback_not_dropped_or_merged():
    g = _gen()
    primaries = ["96/4BPART"]
    roots = g.build_hierarchy_programmatically([
        _tx("100/2020", "96/4BPART", primaries),
        _tx("200/2020", "500/1", primaries),  # survey under no declared primary
    ])
    all_docs = set()
    for r in roots:
        all_docs |= _docs(r)
    assert all_docs == {"100/2020", "200/2020"}, "no document may be dropped"
    by = _by_sn(roots)
    assert _docs(by["96/4BPART"]) == {"100/2020"}, "unrelated deed must not merge into the primary"


def test_no_primaries_falls_back_to_legacy_and_still_builds():
    g = _gen()
    # No 'primary_surveys' key at all -> legacy prefix-based path must still work.
    roots = g.build_hierarchy_programmatically([
        {"document_number": "100/2020", "date": "01-01-2020", "sellers": ["S"],
         "buyers": ["B"], "survey_number": "45", "nature_of_document": "Sale Deed",
         "property_type": "Agricultural Land", "property_extent": "1 acre"},
    ])
    assert roots, "legacy path should still produce a hierarchy"
    all_docs = set()
    for r in roots:
        all_docs |= _docs(r)
    assert "100/2020" in all_docs


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK {name}")
    print("ALL OK")
