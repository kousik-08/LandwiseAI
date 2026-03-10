"""
Prompt for raw extraction of transactions from Encumbrance Certificates (EC)
"""

RAW_PROMPT = """
Extract Encumbrance Certificate transactions as PLAIN TEXT.

STRICT RULES:
- Read ALL pages in this input
- Do NOT summarize or skip transactions
- Preserve numbering and order
- Output must include EVERY document number

LOOKING FOR VALUES:
- Find 'கைமாற்றுத் தொகை' (Consideration Amount).
- Find 'சந்தை மதிப்பு' (Government Market Value).

FORMAT:
--- TRANSACTION START ---
Document No:
Date:
Sellers:
Buyers:
Survey No:
Nature of the land:
Nature of Document:
Extent:
Consideration:
Market Value:
--- TRANSACTION END ---
"""
