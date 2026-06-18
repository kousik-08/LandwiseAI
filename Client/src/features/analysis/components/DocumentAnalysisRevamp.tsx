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
import React, { useMemo, useState, useCallback, useEffect } from "react";
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
    Circle,
    ListChecks,
} from "lucide-react";
import PdfAnnotator from "./PdfAnnotator";
import { API_BASE_URL } from "@/lib/api";
import { LANDWISE_CHECKS, getSelectedChecks, type LandwiseCheck } from "@/lib/landwise-checks";

interface Comparison {
    field: string;
    ec_value: string;
    metadata_value: string;
    status: string;
    reason: string;
    page_number?: string;
}

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

type FilterMode = "all" | "review" | "matched";

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
    const [selectedDocNo, setSelectedDocNo] = useState<string | null>(
        results.length > 0 ? results[0].document_number : null,
    );
    const [searchQuery, setSearchQuery] = useState("");
    const [filterMode, setFilterMode] = useState<FilterMode>("all");
    const [scrollToPage, setScrollToPage] = useState<{ page: number; timestamp: number } | undefined>(undefined);
    // PDF preview source: the marked DEED or the marked EC.
    const [pdfView, setPdfView] = useState<"deed" | "ec">("deed");
    // Per-document marked-EC state, fetched on demand (the EC scan is slow).
    // docNo -> { status: "loading" | "done" | "error", url?, reason?, page?, ts? }
    // `page` is the EC page the value was boxed on, so the viewer can jump
    // straight to it; `ts` makes the scroll fire once when the mark completes.
    const [ecMark, setEcMark] = useState<Record<string, { status: string; url?: string; reason?: string; page?: number; ts?: number }>>({});

    // Reset to the deed view whenever the selected document changes.
    useEffect(() => { setPdfView("deed"); }, [selectedDocNo]);

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
        const trustScores = results
            .map(r => r.validation_result?.trustability_score)
            .filter((s): s is number => typeof s === "number");
        const avgTrust = trustScores.length
            ? Math.round(trustScores.reduce((sum, s) => sum + s, 0) / trustScores.length)
            : null;
        return { total, matched, review, avgTrust };
    }, [results]);

    // Filter the list by mode + search query.
    const filteredResults = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return results.filter(r => {
            if (filterMode === "matched" && !r.match) return false;
            if (filterMode === "review" && r.match) return false;
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

    const handlePageJump = useCallback((page: number) => {
        setScrollToPage({ page, timestamp: Date.now() });
    }, []);

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
                setEcMark((prev) => ({ ...prev, [docNo]: { status: "done", url: getPdfUrl(data.url), page, ts: Date.now() } }));
            } else {
                setEcMark((prev) => ({ ...prev, [docNo]: { status: "error", reason: data?.reason || "Could not mark the EC." } }));
            }
        } catch {
            setEcMark((prev) => ({ ...prev, [docNo]: { status: "error", reason: "Failed to mark the EC. Please try again." } }));
        }
    }, [ecMark, requestId, parcelId]);

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

            {/* 3-COLUMN BODY */}
            <div className="flex-1 min-h-0 flex">
                {/* LEFT: DOC LIST */}
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
                        <div className="flex items-center gap-1 mt-2 bg-slate-100 p-0.5 rounded-lg">
                            {([
                                { id: "all" as FilterMode, label: "All", count: stats.total },
                                { id: "review" as FilterMode, label: "Review", count: stats.review },
                                { id: "matched" as FilterMode, label: "Matched", count: stats.matched },
                            ]).map(opt => (
                                <button
                                    key={opt.id}
                                    onClick={() => setFilterMode(opt.id)}
                                    className={cn(
                                        "flex-1 flex items-center justify-center gap-1 h-6 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all",
                                        filterMode === opt.id
                                            ? "bg-white text-slate-900 shadow-sm"
                                            : "text-slate-500 hover:text-slate-700",
                                    )}
                                >
                                    <span>{opt.label}</span>
                                    <span className={cn(
                                        "text-[8px] font-bold rounded px-1",
                                        filterMode === opt.id ? "bg-indigo-100 text-indigo-700" : "bg-slate-200 text-slate-600",
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

                {/* MIDDLE: DETAILS */}
                <section className="flex-1 min-w-0 border-r border-slate-200 overflow-y-auto custom-scrollbar bg-white">
                    {selectedResult ? (
                        <DetailsPanel
                            result={selectedResult}
                            onMapClick={onOpenInMap}
                            onPageJump={handlePageJump}
                            parcelId={parcelId}
                        />
                    ) : (
                        <div className="p-8 text-center text-sm text-slate-400">Select a document to view its analysis.</div>
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
                                        {!selectedResult.match && (
                                            <div className="flex items-center rounded-md border border-slate-200 overflow-hidden ml-1 shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={() => setPdfView("deed")}
                                                    className={cn("px-2 h-5 text-[9px] font-bold uppercase tracking-wide transition-colors", pdfView === "deed" ? "bg-primary text-white" : "bg-white text-slate-500 hover:text-primary")}
                                                >
                                                    Deed
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { setPdfView("ec"); if (!selectedResult.ec_file_path) loadEcMark(selectedResult); }}
                                                    className={cn("px-2 h-5 text-[9px] font-bold uppercase tracking-wide transition-colors", pdfView === "ec" ? "bg-primary text-white" : "bg-white text-slate-500 hover:text-primary")}
                                                    title="Mark this document's mismatched values on the EC"
                                                >
                                                    EC
                                                </button>
                                            </div>
                                        )}
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
                                    {pdfView === "deed" ? (
                                        <PdfAnnotator
                                            url={url}
                                            docId={selectedResult.document_number}
                                            parcelId={parcelId}
                                            scrollToPage={scrollToPage}
                                        />
                                    ) : (() => {
                                        // Prefer the EC marked during analysis (no on-demand call);
                                        // fall back to the on-demand result for older parcels.
                                        const preMarked = selectedResult.ec_file_path
                                            ? getPdfUrl(selectedResult.ec_file_path)
                                            : null;
                                        if (preMarked) {
                                            return (
                                                <PdfAnnotator
                                                    url={preMarked}
                                                    docId={`EC_${selectedResult.document_number}`}
                                                    parcelId={parcelId}
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
                                    })()}
                                </div>
                            </>
                        );
                    })()}
                </aside>
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

const STATUS_META: Record<CheckStatus, { label: string; chip: string; icon: React.ReactNode; rank: number }> = {
    issue:    { label: "Issue",      chip: "bg-rose-500 text-white",                          icon: <AlertCircle className="w-3 h-3" />,  rank: 0 },
    verified: { label: "Verified",   chip: "bg-emerald-500 text-white",                       icon: <CheckCircle2 className="w-3 h-3" />, rank: 1 },
    na:       { label: "Not on doc", chip: "bg-slate-200 text-slate-600",                     icon: <Circle className="w-3 h-3" />,       rank: 2 },
    parcel:   { label: "AI · parcel",chip: "bg-indigo-100 text-indigo-700 border border-indigo-200", icon: <ShieldCheck className="w-3 h-3" />, rank: 3 },
    manual:   { label: "Verify offline", chip: "bg-slate-100 text-slate-500 border border-slate-200", icon: <Circle className="w-3 h-3" />, rank: 4 },
};

function ChecklistVerification({ result, parcelId }: { result: ResultItem; parcelId?: string }) {
    const [open, setOpen] = useState(true);
    const items = useMemo(() => {
        const ids = new Set(getSelectedChecks(parcelId));
        return LANDWISE_CHECKS
            .filter((c) => ids.has(c.id))
            .map((c) => ({ check: c, status: deriveCheckStatus(c, result) }))
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
                    <span className="text-slate-400">· {items.length} selected</span>
                </span>
                <ChevronDown className={cn("w-3.5 h-3.5 text-slate-400 ml-auto transition-transform", open && "rotate-180")} />
            </button>
            {open && (
                <ul className="divide-y divide-slate-50">
                    {items.map(({ check, status }) => {
                        const meta = STATUS_META[status];
                        return (
                            <li key={check.id} className="flex items-center gap-2 px-3 py-1.5">
                                <span className={cn(
                                    "text-sm font-medium flex-1 min-w-0 truncate",
                                    status === "issue" ? "text-rose-900" : status === "verified" ? "text-slate-800" : "text-slate-500",
                                )} title={check.label}>
                                    {check.label}
                                </span>
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
    parcelId,
}: {
    result: ResultItem;
    onMapClick?: (docNo: string) => void;
    onPageJump: (page: number) => void;
    parcelId?: string;
}) {
    const vr = result.validation_result;
    const fieldCount = vr?.comparisons?.length || 0;
    const matchCount = coerceMatchCount(vr?.match_count, vr?.comparisons);
    const trust = vr?.trustability_score;

    return (
        <div className="px-4 py-3 space-y-3">
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
            <ChecklistVerification result={result} parcelId={parcelId} />

            {/* Comparison cards */}
            <div className="space-y-2">
                {(vr?.comparisons || []).map((c, idx) => {
                    const matched = isCleanMatch(c.status);
                    const pageMatch = c.page_number ? String(c.page_number).match(/\d+/) : null;
                    const pg = pageMatch ? parseInt(pageMatch[0]) : null;
                    return (
                        <div
                            key={`${c.field}-${idx}`}
                            className={cn(
                                "rounded-lg border p-3 transition-all",
                                matched
                                    ? "bg-emerald-50/40 border-emerald-200"
                                    : "bg-rose-50/40 border-rose-200",
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
                                            onClick={() => onPageJump(pg)}
                                            className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-[9px] font-bold text-slate-600 uppercase tracking-wider transition-all"
                                            title={`Jump to page ${pg}`}
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
