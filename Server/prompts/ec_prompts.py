
# ---------------------------------------------------------------------------
# EC RAW EXTRACTION PROMPT  (FIXED)
# ---------------------------------------------------------------------------
RAW_PROMPT = """
You are extracting EVERY transaction from an Encumbrance Certificate (EC) as
PLAIN TEXT. These rules are UNIVERSAL — they apply to every transaction in
every EC, regardless of layout, year, district, or registrar's office. Do not
treat any example below as document-specific: it is a teaching aid for a rule
that must hold on every transaction you emit.

STRICT RULES:
- Read ALL pages in this input
- Do NOT summarize, skip, merge, or invent transactions
- Preserve numbering and order
- Output must include EVERY document number that appears in the EC

═══════════════════════════════════════════════════════════════════════════
TRANSACTION-SCOPED VALUES — apply to EVERY transaction without exception
═══════════════════════════════════════════════════════════════════════════
A. Every field inside a TRANSACTION block must describe THAT transaction
   only. Cross-bleeding values from neighboring transactions is the single
   most common failure mode in EC extraction — treat it as forbidden.

B. SCHEDULE-BLOCK BINDING RULE (most important):
   An EC transaction is laid out as:
       [Transaction header row]   ← Document No, Date, Sellers, Buyers
       [Schedule N Details block] ← Property Type, Village, Survey No,
                                    Plot No, Property Extent, Boundary
                                    Details, Schedule Remarks
   The Schedule block ALWAYS belongs to the transaction header that
   appears IMMEDIATELY ABOVE it. It NEVER belongs to the next transaction
   below. This binding holds regardless of:
     • how the EC is paginated (the schedule may span a page break — it
       still belongs to the transaction whose header opened it),
     • how many schedules a transaction has (some have Schedule 1 only,
       some have Schedule 1 + Schedule 2 + Schedule A — all of them
       belong to the transaction header above the first schedule),
     • whether the schedule is rendered in a table, in prose, or in a
       column to the right of the header.

   Worked example (this is HOW the rule works; the actual numbers vary
   per document — apply the same logic to every pair of adjacent rows):
       [Row N]   Doc A/YYYY | sellers... | survey X
                 Schedule 1: Extent 1882 sq.ft, Plot 159, Survey X
                                ← belongs to Doc A/YYYY
       [Row N+1] Doc B/YYYY | sellers... | survey X
                 Schedule 1: Extent 1200 sq.ft, Plot 115, Survey X
                                ← belongs to Doc B/YYYY
   When you emit Doc B/YYYY's TRANSACTION block, its Extent / Plot No /
   Survey No / Boundary Details / Consideration / Market Value / PR Number
   MUST come from the schedule sitting below Doc B/YYYY's header — never
   from Doc A/YYYY's schedule above.

B1. PLOT↔EXTENT PAIRING ANCHOR (mechanical anti-cross-bleed — apply every time):
   Inside one schedule block, the Plot No and the Property Extent are a
   BONDED PAIR written in the SAME block. They travel together and can
   never be separated:
       • First, read the Plot No (மனை எண்) in this transaction's own
         schedule block.
       • Then read the Extent (விஸ்தீர்ணம் / சொத்தின் விஸ்தீர்ணம்) from the
         SAME block — the one that names that Plot No.
       • Emit that Plot's Extent. If you ever find yourself emitting an
         Extent whose Plot No differs from the Plot No in this
         transaction's schedule, you have cross-bled — STOP and re-bind.
   Concretely: if this transaction's schedule says "Plot 115", its Extent
   is whatever number sits beside Plot 115 — NOT the Extent that sat beside
   Plot 159 or Plot 151 in an earlier transaction.

B2. ANTI-SHIFT / OFF-BY-ONE RULE (the most common real-world failure):
   The dominant cross-bleed pattern is a ONE-ROW DOWNWARD SHIFT, in which a
   transaction is wrongly assigned the Extent (and/or Plot/Survey) of the
   transaction IMMEDIATELY BELOW it, and that error then ripples up the
   column row after row. It typically looks like this (WRONG):
       Row 41 → Doc 5548 | Plot 151 | Extent 1843   (correct)
       Row 42 → Doc 5550 | Plot 159 | Extent 1200   ← WRONG: took 6570's value
       Row 43 → Doc 6570 | Plot 115 | Extent 1200   (happens to also be 1200, masks the error)
   The CORRECT extraction keeps every Extent welded to its own Plot:
       Row 41 → Doc 5548 | Plot 151 | Extent 1843
       Row 42 → Doc 5550 | Plot 159 | Extent 1882
       Row 43 → Doc 6570 | Plot 115 | Extent 1200
   To prevent the shift: process the Extent column as Plot↔Extent pairs
   (rule B1), never as a free-floating list of numbers you assign in
   reading order. After emitting each block, re-confirm the Extent you
   chose is the one whose Plot No matches THIS transaction's schedule.

B3. ROW-NUMBER BOUNDARY (mechanical span-marker — the SINGLE most reliable cue):
   Every EC transaction in the registry tabular format carries a SERIAL
   NUMBER in the LEFTMOST column (Sr. No. / வ. எண்): 1, 2, 3, …, 51, etc.
   That number is the AUTHORITATIVE boundary marker for the transaction
   that owns it. The algorithm to apply, mechanically, for every row:

       1. Locate the row number N in the leftmost column.
       2. Locate the NEXT row number N+1 (could be on the same page or a
          continuation page).
       3. Every piece of text between row N's serial and row N+1's serial
          — Document No, Date, Sellers, Buyers, every Schedule N Details
          block, every "Consideration", "Market Value", "PR Number",
          "Document Remarks", "Boundary Details", "Schedule Remarks" —
          belongs to row N.
       4. The moment you see row N+1's serial, you have CROSSED the
          boundary. Stop collecting for N.

   The schedule block that immediately PRECEDES row N+1's serial number is
   STILL inside row N's span, because the serial N+1 hasn't appeared yet.
   This is non-intuitive in tabular layout (the schedule sits visually
   between two transactions) but it is the rule registries use.

   Worked example using the layout in this very EC:
       [Row 42, serial="42"] Doc 5550/2013  | 15-Jul-2013 | sellers... | buyer
                             Consideration: Rs. 1,41,200/-
                             Schedule 1 Details: Plot 159, Extent 1882 ச அடி
                             Boundary Details: ...                       ← all owned by row 42
       [Row 43, serial="43"] Doc 6570/2013  | 23-Aug-2013 | sellers... ← boundary crossed

   Therefore Doc 5550/2013's Extent is 1882 ச அடி (Plot 159), not 1200.
   Doc 6570/2013's Extent is whatever sits in ITS own schedule under row 43.

B4. EXTENT-VS-PLOT CROSS-CHECK (mandatory before emitting):
   For every transaction, write down (mentally) the (Plot No, Extent) pair
   from THIS row's schedule, then verify the pair is internally consistent:
     • Does the Schedule Remarks ("Schedule Remarks/சொத்து விவரம்...") prose
       at the bottom of THIS row's schedule contain the SAME extent number
       you're about to emit? (e.g., "ஆக 1882 ச அடிகள்" confirms 1882)
     • Does it reference the SAME plot number? (e.g., mentions "மனை எண் 159")
   If the Schedule Remarks prose at the bottom of this row's block says
   "1882 ச அடிகள்" but you're about to emit "1200", you've taken the value
   from the wrong row. STOP and re-bind.

C. PARENT-DOC CITATION RULE:
   When a row narrative cites a parent / earlier document
   (e.g., "under doc 1234/2008 originally 1882 sq.ft, now transferred
   1200 sq.ft"), the CURRENT transaction's Extent / Consideration /
   Market Value is the NOW-transferred value (1200), NOT the cited
   parent's historical value (1882). This applies to every transaction
   that mentions a parent doc.

D. MULTI-DATE COLUMN RULE — STRICT FORMAT:
   A transaction's date column may contain multiple dates
   (execution / registration / completion). Emit them on ONE SINGLE LINE
   inside the `Date:` field, separated EXACTLY by " | " (space-pipe-space),
   in the order they appear in the EC, with each token in DD-Mon-YYYY form.
   Do NOT use commas, newlines, semicolons, slashes, or any other separator.
   Do NOT drop dates. Do NOT collapse repeated dates.

   CORRECT:
       Date: 20-Jul-2018 | 20-Jul-2018 | 31-Jul-2018
   ALSO CORRECT (single date):
       Date: 23-Aug-2013
   WRONG (forbidden formats):
       Date: 20-Jul-2018, 20-Jul-2018, 31-Jul-2018       ← commas
       Date: 20-Jul-2018
             20-Jul-2018
             31-Jul-2018                                   ← newlines
       Date: 20/07/2018 | 20/07/2018 | 31/07/2018         ← wrong token form
       Date: 20-Jul-2018 (execution), 31-Jul-2018 (reg)   ← annotations

   The downstream matcher anchors sort order on the FIRST date in this
   list (the execution date). If you emit any other separator, the
   matcher cannot parse the list, every transaction collapses to
   "oldest", and the user's "last N transactions" returns the wrong
   slice of the EC. This rule is non-negotiable.

E. EXTENT UNIT FIDELITY:
   Preserve the exact unit and value as written: "1 ACRE, 21.0 CENTS,
   88.0 CENTS", "1882 ச அடி", "2.09 ஏக்கர்", "1200 சதுர அடி",
   "0.64 சென்ட் (Cents)", etc. Do not convert units, do not round, do not
   collapse a multi-part extent ("1 ACRE, 21.0 CENTS, 88.0 CENTS") into a
   single number, and NEVER substitute one unit for another (cents must
   stay cents, never become acres; sq.ft must stay sq.ft, never become
   cents). Emit the unit token exactly as it appears in the schedule.

F. SURVEY-NUMBER FIDELITY:
   Emit every survey number in the schedule, in order, as written
   ("63/3, 63/4" stays "63/3, 63/4" — never substituted with values
   from a neighboring transaction).

═══════════════════════════════════════════════════════════════════════════
SELLERS & BUYERS — NAMES, NOT JUST TITLES (applies to every transaction)
═══════════════════════════════════════════════════════════════════════════
G. Tamil EC rows commonly use generic role titles:
     'முதல்வர்' / 'முத.' / '(முக.)' / '(முத.)'  → first party / seller
     'அடுத்த தரப்பினர்'                       → second party / buyer
     'வாரிசுதாரர்'                            → heir / successor
     'பவர் ஏஜெண்ட்' / 'POA holder'             → power-of-attorney holder
   A title alone is NEVER enough. Always extract the actual person name(s)
   that the title refers to in the same row, and output BOTH together,
   e.g. "வஜ்ஜிரம் (முதல்வர்), ஜெகன்நாதன் (முதல்வர்)".

H. POWER-OF-ATTORNEY SURFACING:
   When a single signer (typical pattern: one name appears as agent for
   several principals from earlier rows) acts on behalf of one or more
   principals, surface BOTH sides explicitly:
     "K. சண்முகசுந்தரம் (POA agent for வஜ்ஜிரம், ஜெகன்நாதன், மாணிக்கம்)"
   Look for trigger words: 'பவர் ஏஜெண்ட்', 'வாரிசதார பவர்', 'சார்பாக',
   'அதிகாரம் பெற்ற', 'GPA', 'POA No.'

I. NEVER collapse multiple distinct sellers (or buyers) into a single
   placeholder. If the row lists four sellers, emit four names.

═══════════════════════════════════════════════════════════════════════════
PAGE NUMBER — where this transaction physically appears (applies to every one)
═══════════════════════════════════════════════════════════════════════════
J. PAGE ATTRIBUTION RULE:
   The input you are given is a set of consecutive pages, numbered 1, 2,
   3, … in the order they appear (page 1 = the FIRST page of this input).
   For every transaction, emit a `Page:` field = the page number of THIS
   INPUT on which the transaction's serial-number / Document No header row
   physically appears. This is the page where a reader's eye first lands on
   that transaction's row — NOT where its schedule continues, NOT the EC's
   printed page number, NOT a 'Page X of Y' footer. Just count the input
   pages: if the row is on the third page you were given, emit `Page: 3`.
   Emit exactly one integer. If genuinely unsure, emit the page where the
   Document No appears.

═══════════════════════════════════════════════════════════════════════════
LOOKING FOR VALUES (applies to every transaction)
═══════════════════════════════════════════════════════════════════════════
- Find 'கைமாற்றுத் தொகை' (Consideration Amount).
- Find 'சந்தை மதிப்பு' (Government Market Value).

═══════════════════════════════════════════════════════════════════════════
SELF-CHECK BEFORE EMITTING EACH TRANSACTION (mandatory)
═══════════════════════════════════════════════════════════════════════════
Before you finalize a TRANSACTION block, mentally verify:
  1. Does my Extent value come from the schedule DIRECTLY BELOW this
     transaction's header? (Not the schedule above, not the schedule of
     the next transaction.)
  2. Does my Survey No come from the same schedule as my Extent?
  3. Does my Plot No come from the same schedule as my Extent?
  4. PLOT↔EXTENT BOND CHECK: Is the Extent I am about to emit the one
     written beside THIS transaction's own Plot No? Name the Plot No, name
     the Extent, and confirm they came from the same schedule block. If the
     Plot No belongs to this doc but the Extent belongs to a different
     Plot, I have cross-bled — re-bind via rule B1.
  5. ANTI-SHIFT CHECK: Is my Extent IDENTICAL to the PREVIOUS transaction's
     Extent while the Plot Nos / doc numbers differ? If yes, I have likely
     done a one-row upward shift (rule B2) — re-read this doc's own
     schedule and the one below to confirm I have not slid the column.
  6. UNIT CHECK: Did I keep the exact unit as written (cents stays cents,
     sq.ft stays sq.ft, acre stays acre)? No conversions.
  7. Are my Sellers / Buyers actual names, not bare titles like 'முதல்வர்'?
  8. If a POA agent signs on behalf of principals, did I surface BOTH?
If any check fails, fix the value before emitting.

═══════════════════════════════════════════════════════════════════════════
FORMAT (one block per transaction, in EC order)
═══════════════════════════════════════════════════════════════════════════
--- TRANSACTION START ---
Page:
Document No:
Date:
Sellers:
Buyers:
Survey No:
Plot No:
Nature of the land:
Nature of Document:
Extent:
Consideration:
Market Value:
--- TRANSACTION END ---
"""


