# Timeline Interactive Ownership Flow — Redesign

Date: 2026-06-19
Status: Approved, implementing

## Goal
Improve the Timeline ("Smart Lineage Explorer" / "Interactive Ownership Flow") page:
1. Redesign every graph node as a premium glass card.
2. Make Ask AI consistent with the rest of the app (global floating launcher) and node-context aware.
3. Replace the draggable floating PDF popup with a right-side split-screen document panel; show the summary + notes as a card popup anchored below the clicked node.

## A. Premium glass-card nodes
File: `Client/src/features/hierarchy/components/ReactFlowHierarchy.tsx` (`HierarchyNode`).
- Frosted-glass card, gradient border, rounded corners.
- Left accent strip + nature-type icon, hue per nature (Sale, Mortgage, Conveyance, Deposit of Title Deeds, default).
- Typography: nature label chip on top, Doc No bold, `S.No · date` muted, executant/claimant truncated.
- Matched = green ring/glow, mismatch = red ring/glow (from existing validation classes).
- Keep expand/collapse pill + child count and hover tooltip (restyled to match glass aesthetic).

## B. Ask AI consistency + node context
File: `Client/src/features/timeline/components/SurveyTimeline.tsx`, `Client/src/components/AppShell.tsx`.
- Remove Timeline's local toolbar "Ask AI" button and local `OverallChat` instance.
- Publish Timeline context via `useAskAi().setAskAiContext({ requestId, parcelId, docNumbers, screenLabel, screenSummary })` so the global bottom-right launcher appears here.
- Clicking a node sets the active document context (`setAskAiActiveDoc` / mention) so the global chatbot answers about that node.

## C. Document details: split screen with Summary toggle
File: `Client/src/features/timeline/components/SurveyTimeline.tsx`.
- On node click the layout splits: graph on the left (`col-span-8`), a docked panel on the right (`col-span-4`) showing the deed **PDF** by default (`PdfAnnotator`).
- The panel header carries `[Match] [Summary] [full screen] [close]`. The **Summary** button flips the same panel to a full-panel deed summary (metadata + validation breakdown + collaborative **notes** + support-doc verifier); in summary view the button becomes **Document** to flip back. No floating cards — a single right panel toggled by `showSummary`.
- Page-link jumps drive the docked `PdfAnnotator` via `scrollToPage`. Retired: the old `col-span-3` tabbed panel, the draggable PDF window, and the floating summary card; chatbot duty moved to the global Ask AI.

Net layout when a doc is open: `[ Ownership Flow graph (left) | Document PDF ⇄ Summary (right split) ]`, with the global Ask AI launcher bottom-right.

## Scope note
The redesign targets the **Property Lineage Search** view (the "Interactive Ownership Flow"). The secondary **Master Network Overview** (global graph) still focuses a clicked node into the global Ask AI, but the docked PDF + summary-popup currently render only in the search view. Extending the docked preview to the master view is a follow-up.
