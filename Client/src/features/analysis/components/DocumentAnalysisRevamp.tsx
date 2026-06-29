/**
 * DocumentAnalysisRevamp — three-column "forensic verification" layout
 * for the Document Analysis tab.
 *
 *   [Stats header: TOTAL / MATCHED / REVIEW / AVG TRUST + progress]
 *   ┌──────────────┬─────────────────────────┬───────────────────┐
 *   │ Doc list     │ Selected doc fields     │ Inline PDF        │
 *   │ + search     │ (always expanded)       │ (PdfAnnotator)    │
 *   │ + filter tabs│                         │                   │
 *   └──────────────┴─────────────────────────┴───────────────────┘
 *
 * Replaces the previous accordion-style `ValidationResults` view for this
 * tab. Reuses `ValidationResultItem`'s field rendering by inlining the
 * per-comparison cards directly — fewer wrappers, no accordion toggle.
 */
import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { coerceMatchCount } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
    Search as SearchIcon,
    MapPin,
    CheckCircle2,
    AlertCircle,
    ShieldCheck,
    FileText,
    ExternalLink,
    StickyNote,
    Loader2,
    ChevronDown,
    ChevronLeft,
    Circle,
    ListChecks,
    Columns2,
    X,
    ChevronUp,
    AlertTriangle,
} from "lucide-react";
import PdfAnnotator from "./PdfAnnotator";
import { useAskAi } from "@/components/AppShell";
import { API_BASE_URL } from "@/lib/api";
import { LANDWISE_CHECKS, getSelectedChecks, type LandwiseCheck } from "@/lib/landwise-checks";

// A located box on a marked PDF, normalized to [0,1] page coords (top-left
// origin). Produced by the server's visual debugger and handed to the viewer so
// a clicked field can spotlight its exact box. `field` is present on EC boxes
// (used to match them back to a comparison); deed boxes inherit their field
// from the comparison they hang off.
interface BoxRef {
    page: number;
    rect: [number, number, number, number];
    field?: string;
    value?: string;
}

interface Comparison {
    field: string;
    ec_value: string;
    metadata_value: string;
    status: string;
    reason: string;
    page_number?: string;
    // Normalized boxes drawn on the marked deed for this field (header/body/
    // sign-off repeats → several). Absent for parcels analyzed before boxes
    // were captured — those fall back to page-level navigation.
    bounding_boxes?: BoxRef[];
}

// Minimal react-pdf-highlighter highlight shape we synthesize for spotlights.
type SpotlightHighlight = {
    id: string;
    content: { text: string };
    position: { boundingRect: any; rects: any[]; pageNumber: number };
    comment: { text: string; emoji: string };
};
type Spotlight = {
    highlights: SpotlightHighlight[];
    focus?: { id: string; page?: number; timestamp: number };
};
// Spotlight a set of fields' boxes; falls back to a page jump when no box
// coords are available (older parcels).
type SpotlightFn = (fields: string[], deedBoxes: BoxRef[] | undefined, fallbackPage: number | null) => void;

// Pad (in normalized page units) added around a box so the glowing spotlight
// ring surrounds the value with a little breathing room, like the baked-in box.
const SPOT_PAD = 0.008;

// Convert a normalized BoxRef into a react-pdf-highlighter highlight. We store
// the rect in a 0..1 reference frame (width = height = 1); the library scales it
// to the live viewport, so it lands correctly at any zoom.
function boxToHighlight(box: BoxRef, id: string): SpotlightHighlight {
    const [a, b, c, d] = box.rect;
    const x1 = Math.max(0, Math.min(a, c) - SPOT_PAD);
    const y1 = Math.max(0, Math.min(b, d) - SPOT_PAD);
    const x2 = Math.min(1, Math.max(a, c) + SPOT_PAD);
    const y2 = Math.min(1, Math.max(b, d) + SPOT_PAD);
    const boundingRect = { x1, y1, x2, y2, width: 1, height: 1, pageNumber: box.page };
    return {
        id,
        content: { text: "" },
        position: { boundingRect, rects: [{ ...boundingRect }], pageNumber: box.page },
        comment: { text: "", emoji: "" },
    };
}

const EMPTY_SPOTLIGHT: Spotlight = { highlights: [] };

// Build a spotlight (overlay highlights + a focus target) from a set of boxes.
// `keyPrefix` keeps ids stable per field+pane so re-clicking the same field
// re-fires the flash (focus effect keys on id + timestamp).
function buildSpotlight(boxes: BoxRef[] | undefined, keyPrefix: string, ts: number): Spotlight {
    const valid = (boxes || []).filter(
        (b) => b && Array.isArray(b.rect) && b.rect.length === 4 && typeof b.page === "number",
    );
    if (valid.length === 0) return EMPTY_SPOTLIGHT;
    const highlights = valid.map((b, i) => boxToHighlight(b, `vd-spotlight-${keyPrefix}-${b.page}-${i}`));
    return { highlights, focus: { id: highlights[0].id, page: valid[0].page, timestamp: ts } };
}

const slugFields = (fields: string[]): string =>
    (fields.join("-").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "field");

// One mismatched field with its located boxes on each side. Drives the synced
// error navigator in compare mode.
type ErrorField = { field: string; deedBoxes: BoxRef[]; ecBoxes: BoxRef[] };

// Build the overlay set for ONE pane (deed or EC) in compare mode: every error
// field's boxes are rendered as clickable hit targets; the active field's boxes
// use the `vd-spotlight-` prefix (glowing) and become the focus/scroll target,
// the rest use `vd-box-` (transparent, clickable to cross-navigate). The error
// index is encoded in each id (`-e<idx>-`) so a click maps straight back to it.
function buildPaneOverlays(
    errorFields: ErrorField[],
    activeIdx: number,
    pane: "deed" | "ec",
    tick: number,
): Spotlight {
    const highlights: SpotlightHighlight[] = [];
    let focus: Spotlight["focus"];
    errorFields.forEach((ef, idx) => {
        const boxes = pane === "deed" ? ef.deedBoxes : ef.ecBoxes;
        const active = idx === activeIdx;
        boxes.forEach((box, i) => {
            if (!box || !Array.isArray(box.rect) || box.rect.length !== 4 || typeof box.page !== "number") return;
            const id = `${active ? "vd-spotlight" : "vd-box"}-${pane}-e${idx}-${box.page}-${i}`;
            highlights.push(boxToHighlight(box, id));
            if (active && !focus) focus = { id, page: box.page, timestamp: tick };
        });
    });
    return { highlights, focus };
}

// Parse the error index encoded in an overlay highlight id (`...-e<idx>-...`).
const errorIdxFromId = (id: string): number | null => {
    const m = /-e(\d+)-/.exec(id);
    return m ? parseInt(m[1], 10) : null;
};

interface ValidationResult {
    match: boolean;
    comparisons: Comparison[];
    reason_for_failure?: string;
    match_count: number | string;
    trustability_score?: number;
    requires_extra_scrutiny?: boolean;
    scrutiny_reason?: string;
}

interface ResultItem {
    document_number: string;
    validation_result: ValidationResult;
    match: boolean;
    file_path: string;
    // Pre-marked EC PDF for this document (boxes on the mismatched values),
    // produced during analysis. Absent for parcels analyzed before this change.
    ec_file_path?: string;
}

interface Props {
    results: ResultItem[];
    requestId?: string;
    parcelId?: string;
    onOpenInMap?: (docNo: string) => void;
    // When set/changed (e.g. from the Risk Score "Review" button), auto-select
    // this document on open.
    focusDocNo?: string;
}

type FilterMode = "all" | "review" | "matched" | "mismatched";

// A document is "mismatched" when at least one of its field comparisons came
// back as a real conflict (NOT MATCHED / MISMATCH) — distinct from "review",
// which is simply any document that isn't a clean overall match.
const hasFieldMismatch = (r: any): boolean => {
    const comps = r?.validation_result?.comparisons || [];
    return comps.some((c: any) => {
        const s = String(c?.status || "").toUpperCase();
        return (s.includes("NOT") && s.includes("MATCH")) || s.includes("MISMATCH");
    });
};

const getPdfUrl = (relPath: string | undefined): string | undefined => {
    if (!relPath) return undefined;
    if (relPath.startsWith("http")) return relPath;
    const cleaned = relPath.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "").replace(/^\/+/, "");
    return `${API_BASE_URL}/api/v1/landwise/documents/download-by-path?file_path=${encodeURIComponent(cleaned)}`;
};

const isCleanMatch = (status: string): boolean => {
    const s = status.toUpperCase();
    return s.includes("MATCHED") && !s.includes("NOT");
};

export function DocumentAnalysisRevamp({ results, requestId, parcelId, onOpenInMap, focusDocNo }: Props) {
    // Start with NO document selected — the details + PDF panels stay hidden
    // until the user explicitly clicks a document in the list.
    const [selectedDocNo, setSelectedDocNo] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [filterMode, setFilterMode] = useState<FilterMode>("all");
    const [scrollToPage, setScrollToPage] = useState<{ page: number; timestamp: number } | undefined>(undefined);
    // Side-by-side compare mode: when on, the DEED and EC PDFs fill the screen
    // and the details (checklist + comparison cards) drop below them.
    const [compareMode, setCompareMode] = useState(false);
    // Per-document marked-EC state, fetched on demand (the EC scan is slow).
    // docNo -> { status: "loading" | "done" | "error", url?, reason?, page?, ts? }
    // `page` is the EC page the value was boxed on, so the viewer can jump
    // straight to it; `ts` makes the scroll fire once when the mark completes.
    const [ecMark, setEcMark] = useState<Record<string, { status: string; url?: string; reason?: string; page?: number; ts?: number; boxes?: BoxRef[] }>>({});
    // Spotlight overlays for the DEED and EC viewers — the glowing box drawn on
    // top of the baked-in red boxes when a field card / checklist item is
    // clicked. Cleared whenever the selected document changes.
    const [deedSpot, setDeedSpot] = useState<Spotlight>(EMPTY_SPOTLIGHT);
    const [ecSpot, setEcSpot] = useState<Spotlight>(EMPTY_SPOTLIGHT);
    // Synced error navigator (compare mode): `activeErrorIdx` is the shared
    // pointer both panes track; `navTick` increments on every user nav/click so
    // the viewers re-scroll + flash even when the index lands on the same field.
    const [activeErrorIdx, setActiveErrorIdx] = useState<number>(0);
    const [navTick, setNavTick] = useState<number>(1);
    // Per-document boxes recovered from the MARKED pdfs (deed + EC). This is the
    // fallback that makes the spotlight / navigator work on documents analyzed
    // before per-field coordinates were captured inline — the marked PDFs are
    // read back on the server. docNo -> { deed: BoxRef[], ec: BoxRef[] }.
    const [markedBoxes, setMarkedBoxes] = useState<Record<string, { deed: BoxRef[]; ec: BoxRef[] }>>({});
    const requestedBoxesRef = useRef<Set<string>>(new Set());

    // Publish the open document to the shell-hosted Ask AI so it becomes
    // screen-aware: a question with no explicit @-mention focuses whatever
    // document is on screen (and the compare view labels itself "DEED vs EC").
    // Cleared on unmount / when no document is open.
    const { setAskAiActiveDoc } = useAskAi();
    useEffect(() => {
        if (selectedDocNo) {
            setAskAiActiveDoc({
                docNo: selectedDocNo,
                viewLabel: compareMode ? "Comparing DEED vs EC" : "Reviewing document",
            });
        } else {
            setAskAiActiveDoc(null);
        }
        return () => setAskAiActiveDoc(null);
    }, [selectedDocNo, compareMode, setAskAiActiveDoc]);

    // Leave compare mode whenever the selected document changes.
    useEffect(() => { setCompareMode(false); }, [selectedDocNo]);
    // Drop any active spotlight when switching documents.
    useEffect(() => { setDeedSpot(EMPTY_SPOTLIGHT); setEcSpot(EMPTY_SPOTLIGHT); }, [selectedDocNo]);
    // Reset the error pointer to the first error whenever the doc changes or we
    // enter/leave compare mode; bump the tick so the panes center on it.
    useEffect(() => { setActiveErrorIdx(0); setNavTick((t) => t + 1); }, [selectedDocNo, compareMode]);

    // Parent asked us to focus a specific document (e.g. a failed doc from the
    // Risk Score tab). Match leniently so "3765/2008" lands even if the caller
    // passed a slightly different separator form.
    useEffect(() => {
        if (!focusDocNo) return;
        const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
        const hit = results.find(r => norm(r.document_number) === norm(focusDocNo));
        if (hit) {
            setSelectedDocNo(hit.document_number);
            setScrollToPage(undefined);
        }
    }, [focusDocNo, results]);

    // Aggregate stats for the header strip.
    const stats = useMemo(() => {
        const total = results.length;
        const matched = results.filter(r => r.match).length;
        const review = total - matched;
        const mismatched = results.filter(hasFieldMismatch).length;
        const trustScores = results
            .map(r => r.validation_result?.trustability_score)
            .filter((s): s is number => typeof s === "number");
        const avgTrust = trustScores.length
            ? Math.round(trustScores.reduce((sum, s) => sum + s, 0) / trustScores.length)
            : null;
        return { total, matched, review, mismatched, avgTrust };
    }, [results]);

    // Filter the list by mode + search query.
    const filteredResults = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return results.filter(r => {
            if (filterMode === "matched" && !r.match) return false;
            if (filterMode === "review" && r.match) return false;
            if (filterMode === "mismatched" && !hasFieldMismatch(r)) return false;
            if (!q) return true;
            return r.document_number.toLowerCase().includes(q);
        });
    }, [results, searchQuery, filterMode]);

    const selectedResult = useMemo(
        () => results.find(r => r.document_number === selectedDocNo) || null,
        [results, selectedDocNo],
    );

    const handleDocClick = useCallback((docNo: string) => {
        setSelectedDocNo(docNo);
        setScrollToPage(undefined);
    }, []);

    // Return from the detail view back to the document list. When a document is
    // selected the list collapses to give the details + PDF the full width, so
    // "Back" is the way to re-open the list and pick another document.
    const handleBack = useCallback(() => {
        setSelectedDocNo(null);
        setScrollToPage(undefined);
    }, []);

    const handlePageJump = useCallback((page: number) => {
        setScrollToPage({ page, timestamp: Date.now() });
    }, []);

    // Recover per-field boxes from a document's marked deed + EC PDFs (read-only,
    // no LLM). Fetched once per doc; the result powers the spotlight/navigator
    // for documents that lack inline coordinates (analyzed before that change).
    const loadMarkedBoxes = useCallback(async (docNo: string) => {
        if (!docNo || !requestId || requestedBoxesRef.current.has(docNo)) return;
        requestedBoxesRef.current.add(docNo);
        try {
            const fd = new FormData();
            fd.append("request_id", requestId);
            fd.append("doc_no", docNo);
            const r = await fetch(`${API_BASE_URL}/api/v1/visual-debug/marked-boxes`, { method: "POST", body: fd });
            const data = await r.json();
            setMarkedBoxes((prev) => ({
                ...prev,
                [docNo]: {
                    deed: Array.isArray(data?.deed_boxes) ? data.deed_boxes : [],
                    ec: Array.isArray(data?.ec_boxes) ? data.ec_boxes : [],
                },
            }));
        } catch {
            // Leave the doc out of markedBoxes; the UI falls back to page jumps.
            requestedBoxesRef.current.delete(docNo);
        }
    }, [requestId]);

    // Fetch marked boxes as soon as a document is opened, so both the normal
    // spotlight and the compare navigator have coordinates ready.
    useEffect(() => {
        if (selectedDocNo) loadMarkedBoxes(selectedDocNo);
    }, [selectedDocNo, loadMarkedBoxes]);

    // Ordered list of mismatched fields that carry at least one located box on
    // the deed or the EC — the set the compare-mode navigator steps through.
    const errorFields = useMemo<ErrorField[]>(() => {
        if (!selectedResult) return [];
        const comps = selectedResult.validation_result?.comparisons || [];
        const ecBoxesAll = ecMark[selectedDocNo || ""]?.boxes || [];
        const mb = markedBoxes[selectedDocNo || ""] || { deed: [], ec: [] };
        const byField = (boxes: BoxRef[], fl: string) =>
            boxes.filter((b) => (b.field || "").trim().toLowerCase() === fl);
        return comps
            .filter((c) => !isCleanMatch(c.status))
            .map((c) => {
                const fl = (c.field || "").trim().toLowerCase();
                // Prefer inline coords (new parcels); fall back to the boxes
                // recovered from the marked PDF (older parcels).
                const deedBoxes = c.bounding_boxes && c.bounding_boxes.length
                    ? c.bounding_boxes
                    : byField(mb.deed, fl);
                const ecFromMark = byField(ecBoxesAll, fl);
                const ecBoxes = ecFromMark.length ? ecFromMark : byField(mb.ec, fl);
                return { field: c.field, deedBoxes, ecBoxes };
            })
            .filter((e) => e.deedBoxes.length > 0 || e.ecBoxes.length > 0);
    }, [selectedResult, ecMark, selectedDocNo, markedBoxes]);

    // Clamp the pointer in case the error list shrank (e.g. doc switch).
    const activeIdx = errorFields.length ? Math.min(activeErrorIdx, errorFields.length - 1) : 0;

    // Overlay sets per pane for compare mode (all boxes clickable, active glows).
    const compareDeedSpot = useMemo(
        () => (compareMode && errorFields.length ? buildPaneOverlays(errorFields, activeIdx, "deed", navTick) : EMPTY_SPOTLIGHT),
        [compareMode, errorFields, activeIdx, navTick],
    );
    const compareEcSpot = useMemo(
        () => (compareMode && errorFields.length ? buildPaneOverlays(errorFields, activeIdx, "ec", navTick) : EMPTY_SPOTLIGHT),
        [compareMode, errorFields, activeIdx, navTick],
    );
    // Compare mode drives the panes off the synced navigator; normal mode uses
    // the single-field spotlight from a card/checklist click.
    const effDeedSpot = compareMode ? compareDeedSpot : deedSpot;
    const effEcSpot = compareMode ? compareEcSpot : ecSpot;

    // Step the shared error pointer (wraps around) and re-center both panes.
    const stepError = useCallback((delta: number) => {
        setActiveErrorIdx((cur) => {
            const n = errorFields.length;
            if (n === 0) return cur;
            return (((cur + delta) % n) + n) % n;
        });
        setNavTick((t) => t + 1);
    }, [errorFields.length]);

    // Click on an overlay box → sync the pointer to that error so BOTH panes
    // move to it (deed click reveals the EC box and vice versa).
    const handleBoxClick = useCallback((id: string) => {
        const idx = errorIdxFromId(id);
        if (idx === null) return;
        setActiveErrorIdx(idx);
        setNavTick((t) => t + 1);
    }, []);

    // Once the EC finishes marking, re-center it on the active error.
    useEffect(() => {
        if (compareMode && ecMark[selectedDocNo || ""]?.status === "done") {
            setNavTick((t) => t + 1);
        }
    }, [compareMode, selectedDocNo, ecMark]);

    // Spotlight a field's box(es) on the deed (and the EC, when it's marked).
    // `fields` are the comparison field names involved — used to match EC boxes
    // back to the right value. `deedBoxes` are the deed-side boxes for those
    // fields. When no box is available (older parcels with no captured coords)
    // we fall back to today's page-level jump so the click still does something.
    const handleSpotlight = useCallback(
        (fields: string[], deedBoxes: BoxRef[] | undefined, fallbackPage: number | null) => {
            // In compare mode the panes are driven by the synced navigator — point
            // it at the clicked field so both viewers move together.
            if (compareMode) {
                const fieldSet = new Set(fields.map((f) => (f || "").trim().toLowerCase()));
                const idx = errorFields.findIndex((e) => fieldSet.has((e.field || "").trim().toLowerCase()));
                if (idx >= 0) {
                    setActiveErrorIdx(idx);
                    setNavTick((t) => t + 1);
                    return;
                }
                if (fallbackPage != null) handlePageJump(fallbackPage);
                return;
            }

            const ts = Date.now();
            const slug = slugFields(fields);
            const fieldSet = new Set(fields.map((f) => (f || "").trim().toLowerCase()));
            const mb = markedBoxes[selectedDocNo || ""] || { deed: [], ec: [] };
            const inField = (b: BoxRef) => fieldSet.has((b.field || "").trim().toLowerCase());

            // Prefer the boxes passed in (inline coords); fall back to the marked
            // PDF boxes for older parcels.
            const effDeedBoxes = deedBoxes && deedBoxes.length ? deedBoxes : mb.deed.filter(inField);
            const deed = buildSpotlight(effDeedBoxes, `deed-${slug}`, ts);
            setDeedSpot(deed);

            // EC boxes — from a fresh EC mark if available, else the marked-PDF read.
            const ecFromMark = (ecMark[selectedDocNo || ""]?.boxes || []).filter(inField);
            const ecBoxes = ecFromMark.length ? ecFromMark : mb.ec.filter(inField);
            const ec = buildSpotlight(ecBoxes, `ec-${slug}`, ts);
            setEcSpot(ec);

            // No deed box placed → keep the viewer useful by jumping to the page.
            if (deed.highlights.length === 0 && fallbackPage != null) {
                handlePageJump(fallbackPage);
            }
        },
        [compareMode, errorFields, ecMark, selectedDocNo, markedBoxes, handlePageJump],
    );

    // Lazily fetch a MARKED EC for the selected document: the backend scans the
    // EC for this deed's mismatched ec_values and boxes them. Cached per doc;
    // the scan is slow so we only run it when the user opens the EC view.
    const loadEcMark = useCallback(async (res: any) => {
        const docNo = res?.document_number;
        if (!docNo) return;
        const existing = ecMark[docNo];
        if (existing && (existing.status === "loading" || existing.status === "done")) return;

        const comps = res?.validation_result?.comparisons || [];
        const mismatches = comps
            .filter((c: any) => {
                const s = String(c?.status || "").toUpperCase();
                return (s.includes("NOT") && s.includes("MATCH")) || s.includes("MISMATCH");
            })
            .map((c: any) => ({ field: c.field, value: c.ec_value }))
            .filter((m: any) => m.value);

        if (mismatches.length === 0) {
            setEcMark((prev) => ({ ...prev, [docNo]: { status: "error", reason: "No EC-side mismatched values to mark for this document." } }));
            return;
        }

        setEcMark((prev) => ({ ...prev, [docNo]: { status: "loading" } }));
        try {
            const fd = new FormData();
            fd.append("request_id", requestId || "");
            fd.append("parcel_id", parcelId || "");
            fd.append("doc_no", docNo);
            fd.append("mismatches", JSON.stringify(mismatches));
            const r = await fetch(`${API_BASE_URL}/api/v1/visual-debug/mark-ec`, { method: "POST", body: fd });
            const data = await r.json();
            if (data?.url) {
                const page = typeof data.page === "number" && data.page > 0 ? data.page : undefined;
                const boxes: BoxRef[] = Array.isArray(data.boxes) ? data.boxes : [];
                setEcMark((prev) => ({ ...prev, [docNo]: { status: "done", url: getPdfUrl(data.url), page, ts: Date.now(), boxes } }));
            } else {
                setEcMark((prev) => ({ ...prev, [docNo]: { status: "error", reason: data?.reason || "Could not mark the EC." } }));
            }
        } catch {
            setEcMark((prev) => ({ ...prev, [docNo]: { status: "error", reason: "Failed to mark the EC. Please try again." } }));
        }
    }, [ecMark, requestId, parcelId]);

    // Render the DEED PDF for the selected doc (page-jump aware).
    const renderDeedPane = () => {
        if (!selectedResult) return null;
        const url = getPdfUrl(selectedResult.file_path);
        if (!url) {
            return (
                <div className="h-full flex items-center justify-center text-xs text-slate-400 italic px-6 text-center">
                    No DEED PDF artifact recorded for this document.
                </div>
            );
        }
        return (
            <PdfAnnotator
                url={url}
                docId={selectedResult.document_number}
                parcelId={parcelId}
                scrollToPage={scrollToPage}
                externalHighlights={effDeedSpot.highlights as any}
                focusHighlightId={effDeedSpot.focus}
                onHighlightClick={handleBoxClick}
            />
        );
    };

    // Render the EC PDF for the selected doc: prefer the EC marked during
    // analysis, else fall back to the on-demand marking flow (loading / error /
    // done). Used by the side-by-side compare view.
    const renderEcPane = () => {
        if (!selectedResult) return null;
        const preMarked = selectedResult.ec_file_path ? getPdfUrl(selectedResult.ec_file_path) : null;
        if (preMarked) {
            return (
                <PdfAnnotator
                    url={preMarked}
                    docId={`EC_${selectedResult.document_number}`}
                    parcelId={parcelId}
                    externalHighlights={effEcSpot.highlights as any}
                    focusHighlightId={effEcSpot.focus}
                    onHighlightClick={handleBoxClick}
                />
            );
        }
        const m = ecMark[selectedResult.document_number];
        if (!m || m.status === "loading") {
            return (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-white/70 text-center px-6">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    <p className="text-xs font-medium max-w-[260px]">
                        Marking the EC — scanning pages for the mismatched values. This can take a moment.
                    </p>
                </div>
            );
        }
        if (m.status === "done" && m.url) {
            return (
                <PdfAnnotator
                    url={m.url}
                    docId={`EC_${selectedResult.document_number}`}
                    parcelId={parcelId}
                    scrollToPage={m.page ? { page: m.page, timestamp: m.ts || 0 } : undefined}
                    externalHighlights={effEcSpot.highlights as any}
                    focusHighlightId={effEcSpot.focus}
                    onHighlightClick={handleBoxClick}
                />
            );
        }
        return (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-white/60 text-center px-6">
                <p className="text-xs italic max-w-[280px]">{m.reason || "Could not mark the EC."}</p>
                <button
                    type="button"
                    onClick={() => loadEcMark(selectedResult)}
                    className="text-[10px] font-bold uppercase tracking-wide text-indigo-300 hover:text-indigo-200"
                >
                    Retry
                </button>
            </div>
        );
    };

    // Empty state when the parcel hasn't been audited yet.
    if (!results || results.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center bg-white rounded-2xl border border-dashed border-slate-200">
                <FileText className="w-12 h-12 text-slate-300 mb-3" />
                <h3 className="text-base font-bold text-slate-700">No analysis results yet</h3>
                <p className="text-xs text-slate-500 mt-1">Run an analysis from the Overview tab to populate this view.</p>
            </div>
        );
    }

    const matchedPct = stats.total > 0 ? Math.round((stats.matched / stats.total) * 100) : 0;

    return (
        <div className="flex flex-col h-[calc(100vh-7rem)] bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            {/* STATS HEADER */}
            <div className="shrink-0 px-4 py-3 border-b border-slate-200 bg-slate-50/60 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-600 to-blue-600 flex items-center justify-center shadow-sm shadow-indigo-500/30 shrink-0">
                        <ShieldCheck className="w-4 h-4 text-white" strokeWidth={2.5} />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-sm font-display font-extrabold text-slate-900 leading-tight flex items-center gap-2">
                            Document Analysis
                            <span className="text-[8px] uppercase tracking-[0.18em] font-bold text-indigo-600 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5">
                                REQ
                            </span>
                        </h2>
                        <p className="text-[10px] text-slate-500 font-medium uppercase tracking-[0.14em]">
                            Forensic Verification
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                    <StatPill label="Total" value={stats.total} accent="indigo" />
                    <StatPill label="Matched" value={stats.matched} accent="emerald" />
                    <StatPill label="Review" value={stats.review} accent="amber" />
                    <StatPill
                        label="Avg Trust"
                        value={stats.avgTrust !== null ? `${stats.avgTrust}%` : "—"}
                        accent="violet"
                    />
                    <div className="flex flex-col items-end gap-1 min-w-[140px]">
                        <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500">
                            Progress
                        </div>
                        <div className="w-32 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all"
                                style={{ width: `${matchedPct}%` }}
                            />
                        </div>
                        <div className="text-[10px] font-bold text-slate-700">{matchedPct}%</div>
                    </div>
                </div>
            </div>

            {/* BODY — the doc list collapses once a document is selected, so the
                details + PDF expand to fill the freed space. "Back" re-opens it. */}
            <div className="flex-1 min-h-0 flex flex-col">
                {/* COMPARE MODE — DEED & EC side by side fill the screen; the
                    checklist + comparison cards drop below the documents. */}
                {compareMode && selectedResult && (
                    <div className="flex-1 min-h-0 flex flex-col">
                        <div className="shrink-0 px-3 py-2 border-b border-slate-200 bg-white flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <span className="text-xs font-bold text-slate-900 tabular-nums truncate">
                                    {selectedResult.document_number}
                                </span>
                                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-indigo-600">
                                    Compare · Deed vs EC
                                </span>
                            </div>
                            <button
                                type="button"
                                onClick={() => setCompareMode(false)}
                                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-[10px] font-bold uppercase tracking-wider transition-all"
                            >
                                <X className="w-3.5 h-3.5" />
                                Close compare
                            </button>
                        </div>
                        {/* Scroll container: the two PDFs fill the viewport, the
                            details sit below the fold (scroll down to reach them). */}
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar bg-slate-100">
                            <div className="h-full min-h-[520px] flex">
                                <div className="flex-1 min-w-0 flex flex-col border-r border-slate-300">
                                    <div className="shrink-0 px-3 py-1.5 bg-white border-b border-slate-200 flex items-center gap-2">
                                        <Badge className="bg-primary text-white text-[9px] font-bold px-1.5 py-0 h-4">DEED</Badge>
                                        <span className="text-[10px] text-slate-500 font-medium truncate">{selectedResult.document_number}</span>
                                        <ErrorNav
                                            index={activeIdx}
                                            total={errorFields.length}
                                            field={errorFields[activeIdx]?.field}
                                            onPrev={() => stepError(-1)}
                                            onNext={() => stepError(1)}
                                        />
                                    </div>
                                    <div className="flex-1 min-h-0 bg-slate-900 relative">{renderDeedPane()}</div>
                                </div>
                                <div className="flex-1 min-w-0 flex flex-col">
                                    <div className="shrink-0 px-3 py-1.5 bg-white border-b border-slate-200 flex items-center gap-2">
                                        <Badge className="bg-indigo-600 text-white text-[9px] font-bold px-1.5 py-0 h-4">EC</Badge>
                                        <span className="text-[10px] text-slate-500 font-medium truncate">Encumbrance Certificate</span>
                                        <ErrorNav
                                            index={activeIdx}
                                            total={errorFields.length}
                                            field={errorFields[activeIdx]?.field}
                                            onPrev={() => stepError(-1)}
                                            onNext={() => stepError(1)}
                                        />
                                    </div>
                                    <div className="flex-1 min-h-0 bg-slate-900 relative">{renderEcPane()}</div>
                                </div>
                            </div>
                            {/* Details below the documents */}
                            <div className="bg-white border-t border-slate-200">
                                <DetailsPanel
                                    result={selectedResult}
                                    onMapClick={onOpenInMap}
                                    onPageJump={handlePageJump}
                                    onSpotlight={handleSpotlight}
                                    parcelId={parcelId}
                                />
                            </div>
                        </div>
                    </div>
                )}

                {/* NORMAL 3-COLUMN BODY (unmounted while comparing) */}
                {!(compareMode && selectedResult) && (
                <div className="flex-1 min-h-0 flex">
                {/* LEFT: DOC LIST (hidden while a document is open) */}
                {!selectedResult && (
                <aside className="w-[260px] shrink-0 border-r border-slate-200 bg-slate-50/40 flex flex-col">
                    <div className="px-3 py-2.5 border-b border-slate-200 bg-white">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                                Documents ({results.length})
                            </span>
                            <Badge variant="outline" className="text-[8px] uppercase font-bold border-rose-200 bg-rose-50 text-rose-700 px-1.5 py-0 h-4">
                                Risk
                            </Badge>
                        </div>
                        <div className="relative">
                            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                placeholder="Search doc no..."
                                className="w-full h-8 pl-8 pr-2 rounded-lg bg-slate-50 hover:bg-white focus:bg-white border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 text-xs font-medium placeholder:text-slate-400 outline-none transition-all"
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-1 mt-2 bg-slate-100 p-0.5 rounded-lg">
                            {([
                                { id: "all" as FilterMode, label: "All", count: stats.total, accent: "indigo" },
                                { id: "review" as FilterMode, label: "Review", count: stats.review, accent: "indigo" },
                                { id: "matched" as FilterMode, label: "Matched", count: stats.matched, accent: "indigo" },
                                { id: "mismatched" as FilterMode, label: "Mismatched", count: stats.mismatched, accent: "rose" },
                            ]).map(opt => (
                                <button
                                    key={opt.id}
                                    onClick={() => setFilterMode(opt.id)}
                                    className={cn(
                                        "flex items-center justify-center gap-1 h-6 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all",
                                        filterMode === opt.id
                                            ? "bg-white text-slate-900 shadow-sm"
                                            : "text-slate-500 hover:text-slate-700",
                                    )}
                                >
                                    <span>{opt.label}</span>
                                    <span className={cn(
                                        "text-[8px] font-bold rounded px-1",
                                        filterMode === opt.id
                                            ? (opt.accent === "rose" ? "bg-rose-100 text-rose-700" : "bg-indigo-100 text-indigo-700")
                                            : "bg-slate-200 text-slate-600",
                                    )}>
                                        {opt.count}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                        {filteredResults.length === 0 ? (
                            <div className="px-3 py-6 text-center text-[11px] text-slate-400">
                                No documents match this filter.
                            </div>
                        ) : (
                            <ul className="py-1">
                                {filteredResults.map(r => {
                                    const isActive = r.document_number === selectedDocNo;
                                    const fieldCount = r.validation_result?.comparisons?.length || 0;
                                    const matchCount = coerceMatchCount(r.validation_result?.match_count, r.validation_result?.comparisons);
                                    const pct = fieldCount > 0 ? Math.round((matchCount / fieldCount) * 100) : 0;
                                    return (
                                        <li key={r.document_number}>
                                            <button
                                                type="button"
                                                onClick={() => handleDocClick(r.document_number)}
                                                className={cn(
                                                    "w-full px-3 py-2 flex items-center justify-between gap-2 text-left transition-all border-l-2",
                                                    isActive
                                                        ? "bg-slate-900 text-white border-indigo-500"
                                                        : "border-transparent text-slate-700 hover:bg-slate-100",
                                                )}
                                            >
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <span
                                                        className={cn(
                                                            "w-1.5 h-1.5 rounded-full shrink-0",
                                                            r.match ? "bg-emerald-500" : "bg-rose-500",
                                                        )}
                                                    />
                                                    <span className={cn("text-xs font-bold tabular-nums truncate", isActive && "text-white")}>
                                                        {r.document_number}
                                                    </span>
                                                </div>
                                                <span
                                                    className={cn(
                                                        "text-[10px] font-bold tabular-nums shrink-0",
                                                        isActive ? "text-indigo-200" : r.match ? "text-emerald-600" : "text-amber-600",
                                                    )}
                                                >
                                                    {pct}%
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </aside>
                )}

                {/* MIDDLE: DETAILS */}
                <section className="flex-1 min-w-0 border-r border-slate-200 overflow-y-auto custom-scrollbar bg-white">
                    {selectedResult ? (
                        <DetailsPanel
                            result={selectedResult}
                            onMapClick={onOpenInMap}
                            onPageJump={handlePageJump}
                            onSpotlight={handleSpotlight}
                            onBack={handleBack}
                            parcelId={parcelId}
                        />
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-center px-8 py-12">
                            <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mb-3">
                                <FileText className="w-6 h-6 text-slate-400" />
                            </div>
                            <h3 className="text-sm font-bold text-slate-700">Select a document</h3>
                            <p className="text-xs text-slate-400 mt-1 max-w-[260px]">
                                Click any document on the left to view its forensic analysis and PDF preview.
                            </p>
                        </div>
                    )}
                </section>

                {/* RIGHT: PDF PREVIEW */}
                <aside className="w-[40%] min-w-[360px] shrink-0 flex flex-col bg-slate-100">
                    {selectedResult && (() => {
                        const url = getPdfUrl(selectedResult.file_path);
                        if (!url) {
                            return (
                                <div className="flex-1 flex items-center justify-center text-xs text-slate-400 italic">
                                    No PDF artifact recorded for this document.
                                </div>
                            );
                        }
                        return (
                            <>
                                <div className="shrink-0 px-3 py-2 border-b border-slate-200 bg-white flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-xs font-bold text-slate-900 tabular-nums truncate">
                                            {selectedResult.document_number}
                                        </span>
                                        <Badge
                                            className={cn(
                                                "text-[9px] font-bold px-1.5 py-0 h-4",
                                                selectedResult.match
                                                    ? "bg-emerald-500 text-white"
                                                    : "bg-amber-500 text-white",
                                            )}
                                        >
                                            {selectedResult.match ? "MATCHED" : "REVIEW"}
                                        </Badge>
                                        {/* Compare replaces the old Deed/EC toggle — opens
                                            both documents side by side, loading the EC on
                                            demand when it wasn't marked during analysis. */}
                                        <button
                                            type="button"
                                            onClick={() => { setCompareMode(true); if (!selectedResult.ec_file_path) loadEcMark(selectedResult); }}
                                            className="inline-flex items-center gap-1 h-5 px-2 ml-1 rounded-md border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[9px] font-bold uppercase tracking-wide transition-colors shrink-0"
                                            title="Compare the DEED and EC side by side"
                                        >
                                            <Columns2 className="w-3 h-3" />
                                            Compare
                                        </button>
                                    </div>
                                    <button
                                        type="button"
                                        className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-700 text-[9px] font-bold uppercase tracking-wider transition-all"
                                        title="Open notes panel"
                                    >
                                        <StickyNote className="w-3 h-3" />
                                        Notes
                                    </button>
                                </div>
                                <div className="flex-1 min-h-0 bg-slate-900 relative">
                                    {renderDeedPane()}
                                </div>
                            </>
                        );
                    })()}
                </aside>
                </div>
                )}
            </div>
        </div>
    );
}

/**
 * Detail-panel for the selected doc: shows MATCH badge, MAP button,
 * "X/Y fields matched", trustability score, and a card for each comparison
 * (Document Number / Date of Registration / Executant Name & Kinship / …).
 */
// ── Per-document checklist verification ─────────────────────────────────────
// Maps a checklist id -> substrings of the validator's comparison field names
// (lower-cased). A check is "verified" when all its mapped fields matched on
// THIS document, "issue" when any mapped field mismatched, "na" when none of
// its fields are present on the document. Field names come from
// validation_prompts.py ("Survey Number", "Square Feet / Extent", ...).
const CHECK_FIELD_MAP: Record<string, string[]> = {
    area_extent: ["extent", "square feet"],
    survey_match: ["survey"],
    owner_match_ec: ["executant", "claimant"],
    supporting_docs: ["supporting"],
    all_registered: ["document number"],
};
// Checks judged against the document's OVERALL deed-vs-EC match, not one field.
const OVERALL_CHECK_IDS = new Set<string>(["deed_validation"]);

type CheckStatus = "issue" | "verified" | "na" | "parcel" | "manual";

function deriveCheckStatus(check: LandwiseCheck, result: ResultItem): CheckStatus {
    if (!check.automated) return "manual";
    const comps = result.validation_result?.comparisons || [];
    if (OVERALL_CHECK_IDS.has(check.id)) {
        // Whole deed-vs-EC verdict. A NOT_FOUND doc has no comparisons but is
        // still a failure, so judge purely on the overall match.
        return result.match ? "verified" : "issue";
    }
    const subs = CHECK_FIELD_MAP[check.id];
    if (!subs) return "parcel"; // AI check, but no per-document signal to judge it
    const relevant = comps.filter((c) => {
        const f = (c.field || "").toLowerCase();
        return subs.some((s) => f.includes(s));
    });
    if (relevant.length === 0) return "na";
    return relevant.every((c) => isCleanMatch(c.status)) ? "verified" : "issue";
}

// First source page that backs a checklist item, so clicking it can jump the
// document preview to where the evidence lives. Field-mapped checks use the
// page of their first relevant comparison; overall checks fall back to the
// first available comparison page.
function deriveCheckPage(check: LandwiseCheck, result: ResultItem): number | null {
    const comps = result.validation_result?.comparisons || [];
    const pageOf = (c: { page_number?: string }): number | null => {
        const m = c.page_number ? String(c.page_number).match(/\d+/) : null;
        return m ? parseInt(m[0]) : null;
    };
    if (OVERALL_CHECK_IDS.has(check.id)) {
        for (const c of comps) {
            const p = pageOf(c);
            if (p !== null) return p;
        }
        return null;
    }
    const subs = CHECK_FIELD_MAP[check.id];
    if (!subs) return null;
    for (const c of comps) {
        const f = (c.field || "").toLowerCase();
        if (subs.some((s) => f.includes(s))) {
            const p = pageOf(c);
            if (p !== null) return p;
        }
    }
    return null;
}

// Fields + located boxes backing a checklist item, so clicking it can spotlight
// the same boxes its mapped comparisons carry. Only mismatched comparisons hold
// boxes (the deed pass marks NOT-MATCHED values), so we gather from those.
function deriveCheckSpotlight(check: LandwiseCheck, result: ResultItem): { fields: string[]; boxes: BoxRef[] } {
    const comps = result.validation_result?.comparisons || [];
    let relevant: Comparison[];
    if (OVERALL_CHECK_IDS.has(check.id)) {
        relevant = comps;
    } else {
        const subs = CHECK_FIELD_MAP[check.id];
        if (!subs) return { fields: [], boxes: [] };
        relevant = comps.filter((c) => {
            const f = (c.field || "").toLowerCase();
            return subs.some((s) => f.includes(s));
        });
    }
    const mismatched = relevant.filter((c) => !isCleanMatch(c.status));
    const fields = mismatched.map((c) => c.field);
    const boxes: BoxRef[] = mismatched.flatMap((c) =>
        (c.bounding_boxes || []).map((b) => ({ ...b, field: c.field })),
    );
    return { fields, boxes };
}

const STATUS_META: Record<CheckStatus, { label: string; chip: string; icon: React.ReactNode; rank: number }> = {
    issue:    { label: "Issue",      chip: "bg-rose-500 text-white",                          icon: <AlertCircle className="w-3 h-3" />,  rank: 0 },
    verified: { label: "Verified",   chip: "bg-emerald-500 text-white",                       icon: <CheckCircle2 className="w-3 h-3" />, rank: 1 },
    na:       { label: "Not on doc", chip: "bg-slate-200 text-slate-600",                     icon: <Circle className="w-3 h-3" />,       rank: 2 },
    parcel:   { label: "AI · parcel",chip: "bg-indigo-100 text-indigo-700 border border-indigo-200", icon: <ShieldCheck className="w-3 h-3" />, rank: 3 },
    manual:   { label: "Verify offline", chip: "bg-slate-100 text-slate-500 border border-slate-200", icon: <Circle className="w-3 h-3" />, rank: 4 },
};

function ChecklistVerification({ result, parcelId, onPageJump, onSpotlight }: { result: ResultItem; parcelId?: string; onPageJump?: (page: number) => void; onSpotlight?: SpotlightFn }) {
    const [open, setOpen] = useState(true);
    const items = useMemo(() => {
        const ids = new Set(getSelectedChecks(parcelId));
        return LANDWISE_CHECKS
            .filter((c) => ids.has(c.id))
            .map((c) => ({ check: c, status: deriveCheckStatus(c, result), page: deriveCheckPage(c, result), spot: deriveCheckSpotlight(c, result) }))
            // Only show checks with a REAL per-document solution. Parcel-level
            // AI placeholders ("AI · parcel") and offline manual items carry no
            // verdict for this document, so they are dropped from the tab.
            .filter(({ status }) => status === "issue" || status === "verified" || status === "na")
            .sort((a, b) => STATUS_META[a.status].rank - STATUS_META[b.status].rank);
    }, [result, parcelId]);

    if (items.length === 0) return null;

    const issues = items.filter((i) => i.status === "issue").length;
    const verified = items.filter((i) => i.status === "verified").length;

    return (
        <div className="rounded-lg border border-slate-200 overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50/70 hover:bg-slate-100 transition-colors"
            >
                <ListChecks className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-700">Checklist Verification</span>
                <span className="ml-1 flex items-center gap-1.5 text-[10px] font-bold">
                    {issues > 0 && <span className="text-rose-600">{issues} issue{issues !== 1 ? "s" : ""}</span>}
                    {verified > 0 && <span className="text-emerald-600">{verified} verified</span>}
                    <span className="text-slate-400">· {items.length} checked</span>
                </span>
                <ChevronDown className={cn("w-3.5 h-3.5 text-slate-400 ml-auto transition-transform", open && "rotate-180")} />
            </button>
            {open && (
                <ul className="divide-y divide-slate-50">
                    {items.map(({ check, status, page, spot }) => {
                        const meta = STATUS_META[status];
                        const hasBoxes = spot.boxes.length > 0;
                        // Only failing checks are clickable — a verified check has
                        // no discrepancy to inspect on the page. Clickable when we
                        // can spotlight a box OR at least jump to its page.
                        const clickable = status === "issue" && (hasBoxes || page !== null) && (!!onSpotlight || !!onPageJump);
                        // Spotlight the check's boxes when available; else fall back
                        // to the page jump (older parcels carry no box coords).
                        const activate = () => {
                            if (onSpotlight && (hasBoxes || page !== null)) {
                                onSpotlight(spot.fields, spot.boxes, page);
                            } else if (onPageJump && page !== null) {
                                onPageJump(page);
                            }
                        };
                        return (
                            <li
                                key={check.id}
                                onClick={clickable ? activate : undefined}
                                role={clickable ? "button" : undefined}
                                tabIndex={clickable ? 0 : undefined}
                                onKeyDown={clickable ? (e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        activate();
                                    }
                                } : undefined}
                                title={clickable ? (hasBoxes ? `Spotlight ${check.label} on the document` : `Jump to page ${page}`) : check.label}
                                className={cn(
                                    "group flex items-center gap-2 px-3 py-1.5",
                                    clickable && "cursor-pointer hover:bg-indigo-50/60 transition-colors",
                                )}
                            >
                                <span className={cn(
                                    "text-sm font-medium flex-1 min-w-0 truncate",
                                    status === "issue" ? "text-rose-900" : status === "verified" ? "text-slate-800" : "text-slate-500",
                                    clickable && "group-hover:underline",
                                )}>
                                    {check.label}
                                </span>
                                {clickable && page !== null && (
                                    <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-indigo-500 shrink-0">
                                        <ExternalLink className="w-2.5 h-2.5" />
                                        Pg {page}
                                    </span>
                                )}
                                <span className="text-[8px] font-bold uppercase tracking-wide px-1 py-0 rounded border bg-slate-50 text-slate-400 border-slate-200 shrink-0">
                                    {check.automated ? "AI" : "Manual"}
                                </span>
                                <span className={cn(
                                    "inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 shrink-0",
                                    meta.chip,
                                )}>
                                    {meta.icon}
                                    {meta.label}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

function DetailsPanel({
    result,
    onMapClick,
    onPageJump,
    onSpotlight,
    onBack,
    parcelId,
}: {
    result: ResultItem;
    onMapClick?: (docNo: string) => void;
    onPageJump: (page: number) => void;
    onSpotlight?: SpotlightFn;
    onBack?: () => void;
    parcelId?: string;
}) {
    const vr = result.validation_result;
    const fieldCount = vr?.comparisons?.length || 0;
    const matchCount = coerceMatchCount(vr?.match_count, vr?.comparisons);
    const trust = vr?.trustability_score;

    return (
        <div className="px-4 py-3 space-y-3">
            {/* Back to the document list — only present when the list is collapsed. */}
            {onBack && (
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1 h-7 px-2 -ml-1 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 text-[11px] font-bold uppercase tracking-wider transition-all"
                >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Back to documents
                </button>
            )}

            {/* Header row */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base font-bold text-slate-900 tabular-nums">{result.document_number}</span>
                    <Badge
                        className={cn(
                            "text-[10px] font-bold px-2 py-0.5",
                            result.match
                                ? "bg-emerald-500 text-white"
                                : "bg-amber-500 text-white",
                        )}
                    >
                        {result.match ? "MATCH" : "REVIEW"}
                    </Badge>
                </div>
                {onMapClick && (
                    <button
                        type="button"
                        onClick={() => onMapClick(result.document_number)}
                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[10px] font-bold uppercase tracking-wider transition-all"
                    >
                        <MapPin className="w-3 h-3" />
                        Map
                    </button>
                )}
            </div>
            <div className="text-[11px] text-slate-500 font-medium">
                {matchCount} / {fieldCount} fields matched
            </div>

            {/* Trustability */}
            {typeof trust === "number" && (
                <div className="bg-emerald-50/60 border border-emerald-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                        <div className="min-w-0">
                            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-800">
                                Trustability Score
                            </div>
                            <div className="text-[10px] text-emerald-700/80 mt-0.5">
                                {trust >= 95 ? "Score is between 95-99, high confidence in data." : `Score is ${trust}%.`}
                            </div>
                        </div>
                    </div>
                    <Badge className={cn(
                        "shrink-0 text-[10px] font-bold whitespace-nowrap",
                        trust >= 95 ? "bg-emerald-500 text-white" : trust >= 80 ? "bg-amber-500 text-white" : "bg-rose-500 text-white",
                    )}>
                        {trust}% | {trust >= 95 ? "Trustable" : trust >= 80 ? "Verify" : "Risk"}
                    </Badge>
                </div>
            )}

            {/* Per-document checklist verification — every selected check,
                auto-derived for AI fields, manual ones flagged for offline. */}
            <ChecklistVerification result={result} parcelId={parcelId} onPageJump={onPageJump} onSpotlight={onSpotlight} />

            {/* Comparison cards */}
            <div className="space-y-2">
                {(vr?.comparisons || []).map((c, idx) => {
                    const matched = isCleanMatch(c.status);
                    const pageMatch = c.page_number ? String(c.page_number).match(/\d+/) : null;
                    const pg = pageMatch ? parseInt(pageMatch[0]) : null;
                    const boxes = c.bounding_boxes;
                    const hasBoxes = !!(boxes && boxes.length > 0);
                    // Only a NOT-MATCHED field has a discrepancy worth inspecting.
                    // Clickable when we can either spotlight its box or at least
                    // jump to its source page.
                    const cardClickable = !matched && (hasBoxes || pg !== null);
                    // Spotlight the box when we have coords; else fall back to a
                    // page jump (older parcels carry no box coordinates).
                    const activate = () => {
                        if (onSpotlight && (hasBoxes || pg !== null)) {
                            onSpotlight([c.field], boxes, pg);
                        } else if (pg !== null) {
                            onPageJump(pg);
                        }
                    };
                    return (
                        <div
                            key={`${c.field}-${idx}`}
                            onClick={cardClickable ? activate : undefined}
                            role={cardClickable ? "button" : undefined}
                            tabIndex={cardClickable ? 0 : undefined}
                            onKeyDown={cardClickable ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    activate();
                                }
                            } : undefined}
                            title={cardClickable ? (hasBoxes ? `Spotlight ${c.field} on the document` : `Jump to page ${pg}`) : undefined}
                            className={cn(
                                "rounded-lg border p-3 transition-all",
                                matched
                                    ? "bg-emerald-50/40 border-emerald-200"
                                    : "bg-rose-50/40 border-rose-200",
                                cardClickable && "cursor-pointer hover:border-rose-300 hover:bg-rose-50/70 hover:shadow-sm",
                            )}
                        >
                            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                                <h4 className={cn(
                                    "text-xs font-bold",
                                    matched ? "text-emerald-900" : "text-rose-900",
                                )}>
                                    {c.field}
                                </h4>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    {pg !== null && (
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); if (hasBoxes && onSpotlight) onSpotlight([c.field], boxes, pg); else onPageJump(pg); }}
                                            className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-[9px] font-bold text-slate-600 uppercase tracking-wider transition-all"
                                            title={hasBoxes ? `Spotlight ${c.field} on the document` : `Jump to page ${pg}`}
                                        >
                                            <ExternalLink className="w-2.5 h-2.5" />
                                            Source · Page {pg}
                                        </button>
                                    )}
                                    <Badge className={cn(
                                        "text-[9px] h-5 px-1.5 whitespace-nowrap",
                                        matched ? "bg-emerald-500 text-white" : "bg-rose-500 text-white",
                                    )}>
                                        {matched ? <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" /> : <AlertCircle className="w-2.5 h-2.5 mr-0.5" />}
                                        {c.status}
                                    </Badge>
                                </div>
                            </div>
                            <div className="space-y-1 text-[11px]">
                                <div className="flex items-baseline gap-1.5">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 w-20 shrink-0 text-right">
                                        EC Value:
                                    </span>
                                    <span className="font-mono font-semibold text-slate-800 break-all">{c.ec_value || "—"}</span>
                                </div>
                                <div className="flex items-baseline gap-1.5">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 w-20 shrink-0 text-right">
                                        Doc Value:
                                    </span>
                                    <span className="font-mono font-semibold text-slate-900 break-all">{c.metadata_value || "—"}</span>
                                </div>
                            </div>
                            {c.reason && (
                                <p className="text-[10px] italic text-slate-500 mt-2 pt-2 border-t border-black/5">
                                    {c.reason}
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Compact up/down error stepper shown in each compare pane header. Both panes
// render one; they drive the SAME shared pointer, so stepping either moves both
// the deed and the EC to the matching box at once.
function ErrorNav({
    index,
    total,
    field,
    onPrev,
    onNext,
}: {
    index: number;
    total: number;
    field?: string;
    onPrev: () => void;
    onNext: () => void;
}) {
    if (total <= 0) return null;
    return (
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-rose-600">
                <AlertTriangle className="w-3 h-3" />
                <span className="tabular-nums">{index + 1}/{total}</span>
            </span>
            {field && (
                <span className="hidden md:inline text-[10px] font-semibold text-slate-600 max-w-[140px] truncate" title={field}>
                    {field}
                </span>
            )}
            <div className="flex items-center rounded-md border border-slate-200 overflow-hidden">
                <button
                    type="button"
                    onClick={onPrev}
                    title="Previous error"
                    aria-label="Previous error"
                    className="h-6 w-6 flex items-center justify-center text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                >
                    <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <span className="w-px h-4 bg-slate-200" />
                <button
                    type="button"
                    onClick={onNext}
                    title="Next error"
                    aria-label="Next error"
                    className="h-6 w-6 flex items-center justify-center text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                >
                    <ChevronDown className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}

function StatPill({
    label,
    value,
    accent,
}: {
    label: string;
    value: number | string;
    accent: "indigo" | "emerald" | "amber" | "violet";
}) {
    const ACCENT = {
        indigo: "border-indigo-200 bg-indigo-50 text-indigo-800",
        emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
        amber: "border-amber-200 bg-amber-50 text-amber-800",
        violet: "border-violet-200 bg-violet-50 text-violet-800",
    }[accent];
    return (
        <div className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] font-bold uppercase tracking-wider", ACCENT)}>
            <span className="opacity-70">{label}</span>
            <span className="text-sm font-extrabold tabular-nums">{value}</span>
        </div>
    );
}

export default DocumentAnalysisRevamp;
