# Full-context vs Metadata-only — EC↔Deed Validation Experiment

- **Run:** 2026-06-19T16:42:16
- **EC:** `C:\Users\FAI-In_Hand\Downloads\63\63\Survey_63.pdf`
- **Deeds:** `C:\Users\FAI-In_Hand\Downloads\63\63\Survey_No_63 (2)\Survey_No_63\10160_2011.pdf`
- **EC context mode:** `page`
- **Model:** `gemini-3.5-flash`
- **Documents tested:** 1

## Summary

- Documents where the two approaches **agree completely:** 0 / 1
- Documents with **any** field-status difference: 1 / 1
- Documents where the **overall match verdict flipped:** 0 / 1

## Per-document detail

### 10160/2011

- Baseline match: **True**  (trustability 95)
- Full-context match: **True**  (trustability 95)

| Field | Baseline status | Full-context status |
|---|---|---|
| Executant Name & Kinship | MATCHED (LINKED) | MATCHED (PARTIAL) |
| Market Value & Consideration | MATCHED (PARTIAL) | MATCHED (REASONABLE) |
| Square Feet / Extent | MATCHED | MATCHED (REASONABLE) |
