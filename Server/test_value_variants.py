"""Unit tests for value_variants.build_variants."""
import os
import re
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
    assert not any(re.match(r"\d{2}[-/.]\d{2}[-/.]\d{4}", v) for v in out)


def test_currency_strips_separators_and_adds_tamil():
    out = build_variants("Rs. 26,400/-", "Consideration")
    assert "Rs. 26,400/-" in out
    assert "26400" in out or "26,400" in out
    assert "௨௬௪௦௦" in out  # Tamil 26400


def test_plain_number_adds_tamil_digit_variant():
    out = build_variants("142", "Survey Number")
    assert "142" in out
    assert "௧௪௨" in out  # Tamil 142


def test_tamil_number_adds_western_digit_variant():
    out = build_variants("௨௬௪௦௦", "Consideration")
    assert "௨௬௪௦௦" in out
    assert "26400" in out


if __name__ == "__main__":
    test_returns_list_containing_original_value()
    test_empty_value_returns_empty_list()
    test_strips_parenthetical_context()
    test_dedupes_preserves_order()
    test_date_yields_multiple_formats()
    test_already_numeric_date_yields_textual_form()
    test_non_date_value_does_not_emit_date_formats()
    test_currency_strips_separators_and_adds_tamil()
    test_plain_number_adds_tamil_digit_variant()
    test_tamil_number_adds_western_digit_variant()
    print("OK")
