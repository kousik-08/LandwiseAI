# Full-context vs Metadata-only — EC↔Deed Validation Experiment

- **Run:** 2026-06-19T16:47:44
- **EC:** `C:\Users\FAI-In_Hand\Downloads\63\63\Survey_63.pdf`
- **Deeds:** `C:\Users\FAI-In_Hand\Downloads\63\63\Survey_No_63 (2)\Survey_No_63\10160_2011.pdf`
- **EC context mode:** `page`
- **Model:** `gemini-3.5-flash`
- **Documents tested:** 1

## Summary

- Documents where the two approaches **agree completely:** 0 / 1
- Documents with **any** field-status difference: 1 / 1
- Documents where the **overall match verdict flipped:** 1 / 1

### Overall verdict flips

| Document | Baseline (metadata) | Full context |
|---|---|---|
| 10160/2011 | True | False |

## Per-document detail

### 10160/2011

- Baseline match: **True**  (trustability 95)
- Full-context match: **False**  (trustability 85)

| Field | Baseline status | Full-context status |
|---|---|---|
| **OVERALL MATCH** | True | False |
| Executant Name & Kinship | MATCHED (LINKED) | MATCHED (PARTIAL) |
| Market Value & Consideration | MATCHED | NOT MATCHED |
| Square Feet / Extent | MATCHED (PARTIAL) | NOT MATCHED |
