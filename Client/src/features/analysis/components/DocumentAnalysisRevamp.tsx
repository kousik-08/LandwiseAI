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
    ArrowLeft,
    ChevronRight,
    Eye,
    Columns2,
    X,
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

type FilterMode = "all" | "review" | "matched" | "mismatched";
type ViewMode = "list" | "detail";

// One field-level mismatch, flattened across every validated document. Drives
// the "Mismatched" filter (the Mismatch Issues Hub relocated from Overview).
interface MismatchIssue {
    docNo: string;
    field: string;
    status: string;
    reason: string;
    page?: string | number;
    ec_value?: string;
    metadata_value?: string;
}

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
    // Master-detail: the doc list and the per-doc detail are two views of the
    // same tab. Start on the list; a row click opens the detail.
    const [viewMode, setViewMode] = useState<ViewMode>("list");
    const [searchQuery, setSearchQuery] = useState("");
    const [filterMode, setFilterMode] = useState<FilterMode>("all");
    const [scrollToPage, setScrollToPage] = useState<{ page: number; timestamp: number } | undefined>(undefined);
    // Full-width Deed-vs-EC comparison view (mismatched docs only).
    const [compareMode, setCompareMode] = useState(false);
    // Per-document marked-EC state, fetched on demand (the EC scan is slow).
    // docNo -> { status: "loading" | "done" | "error", url?, reason?, page?, ts? }
    // `page` is the EC page the value was boxed on, so the viewer can jump
    // straight to it; `ts` makes the scroll fire once when the mark completes.
    const [ecMark, setEcMark] = useState<Record<string, { status: string; url?: string; reason?: string; page?: number; ts?: number }>>({});

    // Exit the comparison view whenever the selected document changes.
    useEffect(() => { setCompareMode(false); }, [selectedDocNo]);

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
            setViewMode("detail");
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

    // Flatten every non-MATCHED comparison across all docs — the Mismatch
    // Issues Hub that used to live on the Overview tab, now surfaced by the
    // "Mismatched" filter below.
    const mismatchIssues = useMemo<MismatchIssue[]>(() => {
        const list: MismatchIssue[] = [];
        results.forEach(r => {
            const comps = r.validation_result?.comparisons || [];
            comps.forEach(c => {
                const status = String(c?.status || "").toUpperCase();
                const clean = status.includes("MATCHED") && !status.includes("NOT");
                if (clean) return;
                list.push({
                    docNo: r.document_number,
                    field: c.field,
                    status: c.status,
                    reason: c.reason,
                    page: c.page_number,
                    ec_value: c.ec_value,
                    metadata_value: c.metadata_value,
                });
            });
        });
        return list;
    }, [results]);

    const mismatchDocCount = useMemo(
        () => new Set(mismatchIssues.map(i => i.docNo)).size,
        [mismatchIssues],
    );

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
        setViewMode("detail");
    }, []);

    // Opening a specific mismatch jumps straight to that doc's detail with the
    // marked deed PDF scrolled to the cited page.
    const handleMismatchClick = useCallback((issue: MismatchIssue) => {
        setSelectedDocNo(issue.docNo);
        const m = issue.page !== undefined && issue.page !== null
            ? String(issue.page).match(/\d+/)
            : null;
        setScrollToPage(m ? { page: parseInt(m[0]), timestamp: Date.now() } : undefined);
        setViewMode("detail");
    }, []);

    const handleBackToList = useCallback(() => {
        setViewMode("list");
        setScrollToPage(undefined);
        setCompareMode(false);
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

            {/* BODY: master list ⇄ per-document detail */}
            <div className="flex-1 min-h-0 flex flex-col">
                {viewMode === "list" ? (
                    /* ── LIST VIEW ───────────────────────────────────────── */
                    <>
                        {/* Toolbar: search + filter tabs (All / Review / Matched / Mismatched) */}
                        <div className="shrink-0 px-4 py-3 border-b border-slate-200 bg-white flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="relative w-full sm:max-w-xs">
                                <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    placeholder="Search doc no..."
                                    className="w-full h-8 pl-8 pr-2 rounded-lg bg-slate-50 hover:bg-white focus:bg-white border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 text-xs font-medium placeholder:text-slate-400 outline-none transition-all"
                                />
                            </div>
                            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg w-full sm:w-auto">
                                {([
                                    { id: "all" as FilterMode, label: "All", count: stats.total },
                                    { id: "review" as FilterMode, label: "Review", count: stats.review },
                                    { id: "matched" as FilterMode, label: "Matched", count: stats.matched },
                                    { id: "mismatched" as FilterMode, label: "Mismatched", count: mismatchDocCount },
                                ]).map(opt => {
                                    const isActive = filterMode === opt.id;
                                    const isMismatch = opt.id === "mismatched";
                                    return (
                                        <button
                                            key={opt.id}
                                            onClick={() => setFilterMode(opt.id)}
                                            className={cn(
                                                "flex-1 sm:flex-none flex items-center justify-center gap-1.5 h-7 px-3 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all active:scale-[0.97]",
                                                isActive
                                                    ? isMismatch
                                                        ? "bg-rose-600 text-white shadow-sm"
                                                        : "bg-white text-slate-900 shadow-sm"
                                                    : "text-slate-500 hover:text-slate-700",
                                            )}
                                        >
                                            <span>{opt.label}</span>
                                            <span className={cn(
                                                "text-[9px] font-bold rounded px-1 tabular-nums",
                                                isActive
                                                    ? isMismatch ? "bg-white/25 text-white" : "bg-indigo-100 text-indigo-700"
                                                    : isMismatch ? "bg-rose-100 text-rose-700" : "bg-slate-200 text-slate-600",
                                            )}>
                                                {opt.count}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Content: document cards, or relocated mismatch-issue cards */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 bg-slate-50/40">
                            {filterMode === "mismatched" ? (
                                (() => {
                                    const q = searchQuery.trim().toLowerCase();
                                    const visible = mismatchIssues.filter(
                                        i => !q || i.docNo.toLowerCase().includes(q) || (i.field || "").toLowerCase().includes(q),
                                    );
                                    if (visible.length === 0) {
                                        return (
                                            <div className="flex flex-col items-center justify-center py-20 text-center text-slate-400">
                                                <CheckCircle2 className="w-10 h-10 text-emerald-300 mb-3" />
                                                <p className="text-sm font-bold text-slate-600">No mismatches</p>
                                                <p className="text-xs mt-1">Every checked field matched between the EC and the deeds.</p>
                                            </div>
                                        );
                                    }
                                    return (
                                        <>
                                            <div className="flex items-center gap-2 mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-rose-700">
                                                <AlertCircle className="w-3.5 h-3.5" />
                                                {visible.length} issue{visible.length !== 1 ? "s" : ""} across {new Set(visible.map(i => i.docNo)).size} document{new Set(visible.map(i => i.docNo)).size !== 1 ? "s" : ""}
                                                <span className="text-slate-400 font-medium normal-case tracking-normal">— click any card to open the marked PDF at the cited page</span>
                                            </div>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                                {visible.map((issue, idx) => (
                                                    <MismatchCard
                                                        key={`${issue.docNo}-${issue.field}-${idx}`}
                                                        issue={issue}
                                                        onClick={() => handleMismatchClick(issue)}
                                                    />
                                                ))}
                                            </div>
                                        </>
                                    );
                                })()
                            ) : filteredResults.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-20 text-center text-slate-400">
                                    <FileText className="w-10 h-10 text-slate-300 mb-3" />
                                    <p className="text-sm font-bold text-slate-600">No documents match this filter.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                    {filteredResults.map(r => (
                                        <DocCard
                                            key={r.document_number}
                                            result={r}
                                            onClick={() => handleDocClick(r.document_number)}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    /* ── DETAIL VIEW ─────────────────────────────────────── */
                    <>
                        {/* Back bar */}
                        <div className="shrink-0 px-4 py-2.5 border-b border-slate-200 bg-white flex items-center gap-3">
                            <button
                                type="button"
                                onClick={handleBackToList}
                                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 text-slate-600 hover:text-slate-900 text-xs font-bold transition-all active:scale-[0.97]"
                            >
                                <ArrowLeft className="w-3.5 h-3.5" />
                                Back
                            </button>
                            {selectedResult && (
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-sm font-bold text-slate-900 tabular-nums truncate">
                                        {selectedResult.document_number}
                                    </span>
                                    <Badge className={cn(
                                        "text-[9px] font-bold px-1.5 py-0 h-4",
                                        selectedResult.match ? "bg-emerald-500 text-white" : "bg-amber-500 text-white",
                                    )}>
                                        {selectedResult.match ? "MATCHED" : "REVIEW"}
                                    </Badge>
                                </div>
                            )}
                        </div>

                        {compareMode && selectedResult ? (
                            /* ── FULL-WIDTH DEED vs EC COMPARISON ──────────── */
                            <div className="flex-1 min-h-0 flex flex-col bg-slate-100">
                                <div className="shrink-0 px-3 py-2 border-b border-slate-200 bg-white flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-xs font-bold text-slate-900 tabular-nums truncate">
                                            {selectedResult.document_number}
                                        </span>
                                        <Badge className="text-[9px] font-bold px-1.5 py-0 h-4 bg-amber-500 text-white">
                                            REVIEW
                                        </Badge>
                                        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 ml-1 hidden sm:inline">
                                            Deed vs EC comparison
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setCompareMode(false)}
                                        className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 text-slate-600 hover:text-slate-900 text-[9px] font-bold uppercase tracking-wider transition-all"
                                        title="Exit comparison and return to the field details"
                                    >
                                        <X className="w-3 h-3" />
                                        Exit Compare
                                    </button>
                                </div>
                                <div className="flex-1 min-h-0 flex">
                                    {/* DEED */}
                                    <div className="flex-1 min-w-0 flex flex-col border-r border-slate-300">
                                        <div className="shrink-0 px-3 py-1.5 bg-white border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                                            Deed
                                        </div>
                                        <div className="flex-1 min-h-0 bg-slate-900 relative">
                                            {(() => {
                                                const deedUrl = getPdfUrl(selectedResult.file_path);
                                                return deedUrl ? (
                                                    <PdfAnnotator
                                                        url={deedUrl}
                                                        docId={selectedResult.document_number}
                                                        parcelId={parcelId}
                                                        scrollToPage={scrollToPage}
                                                    />
                                                ) : (
                                                    <div className="h-full flex items-center justify-center text-xs text-white/50 italic px-6 text-center">
                                                        No PDF artifact recorded for this document.
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    </div>
                                    {/* EC */}
                                    <div className="flex-1 min-w-0 flex flex-col">
                                        <div className="shrink-0 px-3 py-1.5 bg-white border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                                            EC
                                        </div>
                                        <div className="flex-1 min-h-0 bg-slate-900 relative">
                                            <EcPdfPane
                                                result={selectedResult}
                                                parcelId={parcelId}
                                                mark={ecMark[selectedResult.document_number]}
                                                onRetry={() => loadEcMark(selectedResult)}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : (
                        <div className="flex-1 min-h-0 flex">
                            {/* DETAILS */}
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

                            {/* PDF PREVIEW */}
                            <aside className="w-[42%] min-w-[360px] shrink-0 flex flex-col bg-slate-100">
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
                                            <button
                                                type="button"
                                                onClick={() => { setCompareMode(true); if (!selectedResult.ec_file_path) loadEcMark(selectedResult); }}
                                                className="inline-flex items-center gap-1 h-5 px-2 ml-1 shrink-0 rounded-md bg-primary text-white text-[9px] font-bold uppercase tracking-wide hover:bg-primary/90 transition-colors"
                                                title="Compare the deed and EC side by side"
                                            >
                                                <Columns2 className="w-3 h-3" />
                                                Compare
                                            </button>
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
                                    <PdfAnnotator
                                        url={url}
                                        docId={selectedResult.document_number}
                                        parcelId={parcelId}
                                        scrollToPage={scrollToPage}
                                    />
                                </div>
                            </>
                        );
                    })()}
                            </aside>
                        </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/**
 * Renders the marked EC for a document inside the comparison view. Prefers the
 * EC marked during analysis (no extra call); otherwise falls back to the
 * on-demand mark state (loading / done / error+retry) for older parcels.
 */
function EcPdfPane({
    result,
    parcelId,
    mark,
    onRetry,
}: {
    result: ResultItem;
    parcelId: string;
    mark?: { status: string; url?: string; reason?: string };
    onRetry: () => void;
}) {
    const preMarked = result.ec_file_path ? getPdfUrl(result.ec_file_path) : null;
    if (preMarked) {
        return (
            <PdfAnnotator
                url={preMarked}
                docId={`EC_${result.document_number}`}
                parcelId={parcelId}
            />
        );
    }
    if (!mark || mark.status === "loading") {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-white/70 text-center px-6">
                <Loader2 className="w-6 h-6 animate-spin" />
                <p className="text-xs font-medium max-w-[260px]">
                    Marking the EC — scanning pages for the mismatched values. This can take a moment.
                </p>
            </div>
        );
    }
    if (mark.status === "done" && mark.url) {
        return (
            <PdfAnnotator
                url={mark.url}
                docId={`EC_${result.document_number}`}
                parcelId={parcelId}
            />
        );
    }
    return (
        <div className="h-full flex flex-col items-center justify-center gap-2 text-white/60 text-center px-6">
            <p className="text-xs italic max-w-[280px]">{mark.reason || "Could not mark the EC."}</p>
            <button
                type="button"
                onClick={onRetry}
                className="text-[10px] font-bold uppercase tracking-wide text-indigo-300 hover:text-indigo-200"
            >
                Retry
            </button>
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

/**
 * DocCard — a single document tile in the list view. Click opens the detail.
 * A left accent bar + status dot reads match health at a glance; the corner
 * chevron signals it's a drill-in.
 */
function DocCard({ result, onClick }: { result: ResultItem; onClick: () => void }) {
    const fieldCount = result.validation_result?.comparisons?.length || 0;
    const matchCount = coerceMatchCount(result.validation_result?.match_count, result.validation_result?.comparisons);
    const pct = fieldCount > 0 ? Math.round((matchCount / fieldCount) * 100) : 0;
    const matched = result.match;
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "group relative text-left rounded-xl border bg-white p-3 pl-4 transition-all duration-200 overflow-hidden",
                "hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 active:translate-y-0",
                matched ? "border-slate-200 hover:border-emerald-300" : "border-slate-200 hover:border-amber-300",
            )}
        >
            <span className={cn("absolute inset-y-0 left-0 w-1", matched ? "bg-emerald-500" : "bg-amber-500")} />
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", matched ? "bg-emerald-500" : "bg-rose-500")} />
                    <span className="text-sm font-bold text-slate-900 tabular-nums truncate">{result.document_number}</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 group-hover:translate-x-0.5 transition-all shrink-0" />
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
                <Badge className={cn(
                    "text-[9px] font-bold px-1.5 py-0 h-4",
                    matched ? "bg-emerald-500 text-white" : "bg-amber-500 text-white",
                )}>
                    {matched ? "MATCHED" : "REVIEW"}
                </Badge>
                <span className={cn("text-xs font-extrabold tabular-nums", matched ? "text-emerald-600" : "text-amber-600")}>
                    {pct}%
                </span>
            </div>
            <div className="mt-1.5 text-[10px] font-medium text-slate-400 tabular-nums">
                {matchCount} / {fieldCount} fields matched
            </div>
        </button>
    );
}

/**
 * MismatchCard — one field-level mismatch in the "Mismatched" filter (the
 * relocated Mismatch Issues Hub). Click jumps to that doc's marked PDF.
 */
function MismatchCard({ issue, onClick }: { issue: MismatchIssue; onClick: () => void }) {
    const pageMatch = issue.page !== undefined && issue.page !== null ? String(issue.page).match(/\d+/) : null;
    const pageLabel = pageMatch ? pageMatch[0] : null;
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "group relative text-left rounded-xl border bg-white p-3 pl-4 transition-all duration-200 overflow-hidden",
                "hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 active:translate-y-0",
                "border-slate-200 hover:border-rose-300",
            )}
        >
            {/* Left accent bar — mirrors DocCard */}
            <span className="absolute inset-y-0 left-0 w-1 bg-rose-500" />

            {/* Header: dot + doc-no + chevron */}
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-rose-500" />
                    <span className="text-sm font-bold text-slate-900 tabular-nums truncate">{issue.docNo}</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 group-hover:translate-x-0.5 transition-all shrink-0" />
            </div>

            {/* Mismatched field */}
            <div className="mt-2.5 text-[11px] font-bold text-slate-800 truncate" title={issue.field}>
                {issue.field}
            </div>

            {/* EC vs Deed values */}
            {(issue.ec_value || issue.metadata_value) && (
                <div className="mt-1.5 space-y-0.5 bg-slate-50/70 rounded-md p-1.5 border border-slate-100">
                    <div className="grid grid-cols-[40px_1fr] gap-1 items-baseline">
                        <span className="text-[8px] font-bold uppercase tracking-wider text-rose-700 text-right">EC:</span>
                        <span className="text-[9px] font-mono text-slate-800 break-all line-clamp-2" title={String(issue.ec_value || "—")}>
                            {issue.ec_value || "—"}
                        </span>
                    </div>
                    <div className="grid grid-cols-[40px_1fr] gap-1 items-baseline">
                        <span className="text-[8px] font-bold uppercase tracking-wider text-rose-700 text-right">Deed:</span>
                        <span className="text-[9px] font-mono text-slate-800 break-all line-clamp-2" title={String(issue.metadata_value || "—")}>
                            {issue.metadata_value || "—"}
                        </span>
                    </div>
                </div>
            )}

            {/* Reason */}
            {issue.reason && (
                <div className="mt-1.5 text-[9px] text-slate-500 italic line-clamp-2" title={issue.reason}>
                    {issue.reason}
                </div>
            )}

            {/* Footer: status badge + page — mirrors DocCard's badge row */}
            <div className="mt-3 flex items-center justify-between gap-2">
                <Badge className="text-[9px] font-bold px-1.5 py-0 h-4 bg-rose-500 text-white uppercase whitespace-nowrap">
                    {issue.status}
                </Badge>
                {pageLabel && (
                    <span className="text-[10px] font-medium text-slate-400 tabular-nums">
                        Page {pageLabel}
                    </span>
                )}
            </div>
        </button>
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
