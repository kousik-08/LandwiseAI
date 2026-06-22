# Score Tab — Tabbed Redesign

**Date:** 2026-06-19
**File touched:** `Client/src/features/analysis/components/RiskScoreCard.tsx` (single file)

## Problem

The Score ("risks") tab renders `RiskScoreCard`, whose top **Hero Card** (gauge +
Docs Passed / Avg Trust / Scrutiny stats + AI Risk Assessment + Legal
Recommendation) duplicates the Title Health Score already shown on the **Overview**
tab. Below the hero, five+ sections are stacked as vertical collapsibles, making the
tab long and the score info redundant.

## Goal

Remove the duplicate Hero Card and turn the remaining sections into a horizontal
**tab bar** so the user clicks to reveal one section at a time, keeping everything
within the main screen.

## Decisions (confirmed with user)

- **Tabs:** all sections become tabs — Documents Needing Attention, Risk Flags,
  Score Factor Breakdown, Document Breakdown, Gap Analysis, Detailed Assessment.
  "Document Types" chips remain a small footer (not a tab).
- **Empty tabs:** hidden — only tabs with data appear.
- **Default tab:** "Documents Needing Attention" if present, else first available.
- **Dead code:** delete now-unused `GaugeDial`, `HeroStat`, `useCountUp`,
  `GRADE_CONFIG`, `CollapsibleSection`, and orphaned imports.

## Approach

1. Delete the Hero Card JSX (the gauge/score/AI-assessment block) and its
   helper components + grade config that only it used.
2. Build a `tabs` array at render time; each entry: `key`, `label`, `icon`,
   accent color, optional count badge, `available` boolean, and a `render()` for
   its panel. Filter to `available` tabs.
3. `activeTab` state initialized to the first available of
   `[attention, factors, ...]` with "attention" preferred; an effect keeps it
   valid if the available set changes.
4. Tab bar: pill/underline style matching the existing slate/indigo aesthetic,
   horizontally scrollable on narrow screens. Active tab shows its accent.
5. Panel area renders the selected section, reusing existing pieces verbatim
   (`FactorBar`, `FlagSection`, `DocumentDetailTable`, `GapVisualization`,
   failed-docs list, detailed-assessment block) with an `AnimatePresence`
   crossfade on switch. Document Breakdown table keeps its horizontal scroll.
6. "Document Types" chips render below the tab panel.

## Out of scope

- No backend / data-shape changes.
- `RisksTab` wrapper heading in `LegalDashboard.tsx` unchanged.
- Overview tab unchanged.
