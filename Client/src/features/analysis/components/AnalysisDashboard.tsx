import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { landwiseApi } from "@/lib/landwise-api";
import {
  FileText,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Sparkles,
  FileSearch,
  Activity,
  TrendingUp,
  StickyNote,
  ArrowRight,
  MessageSquare,
  XCircle,
  MapPin,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { X, GripHorizontal } from "lucide-react";
import { createPortal } from "react-dom";
import PdfAnnotator from "./PdfAnnotator";
import { TrustabilityScore } from "./TrustabilityScore";
import { cn, coerceMatchCount } from "@/lib/utils";
import { getFileUrl } from "@/lib/api";

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
  reason_for_failure: string;
  match_count: number;
  trustability_score?: number;
  requires_extra_scrutiny?: boolean;
  scrutiny_reason?: string;
}

interface ResultItem {
  document_number: string;
  validation_result: ValidationResult;
  match: boolean;
  file_path: string;
}

interface RedFlag {
  type: string;
  severity: "HIGH" | "CRITICAL";
  message: string;
  doc?: string;
  docs?: string[];
}

interface ValidationResultsProps {
  results: ResultItem[];
  red_flags?: RedFlag[];
  hierarchyPath?: string | null;
  requestId?: string;
  /** Parcel UUID — when provided, PdfAnnotator persists notes to the server
   *  and the notes panel here can show them across page reloads. */
  parcelId?: string;
  onOpenInMap?: (docNo: string) => void;
}

export function ValidationResults({
  results,
  red_flags = [],
  requestId,
  parcelId,
  onOpenInMap,
}: ValidationResultsProps) {
  const [selectedDocument, setSelectedDocument] = useState<string | null>(
    results.length > 0 ? results[0].document_number : null,
  );
  // Drives PdfAnnotator's scroll-to-page when a citation chip is clicked.
  // The timestamp ensures clicking the same page twice still re-scrolls.
  const [scrollToPage, setScrollToPage] = useState<{ page: number; timestamp: number } | undefined>(
    undefined,
  );
  // Click on a note row → flash that highlight in the embedded PDF.
  const [focusHighlightId, setFocusHighlightId] = useState<{ id: string; page?: number; timestamp: number } | undefined>(
    undefined,
  );
  // Highlights for the currently-selected document, surfaced from
  // PdfAnnotator via onAnnotationChange so we can render the notes list
  // alongside the PDF without overlapping it.
  const [docNotes, setDocNotes] = useState<any[]>([]);
  // Floating draggable annotations panel — open/close state lives here so
  // the user can keep it open across doc selections while moving it around.
  const [notesPopupOpen, setNotesPopupOpen] = useState(false);
  const notesDragControls = useDragControls();

  // Prefetch all parcel-wide annotations into react-query the moment this
  // dashboard mounts. PdfAnnotator reads the same query key, so when the
  // user clicks into a deed the highlights render in lockstep with the PDF
  // instead of flashing in after a second fetch.
  useQuery({
    queryKey: ["annotations", parcelId],
    queryFn: () => landwiseApi.getAnnotations(parcelId!),
    enabled: !!parcelId,
    staleTime: 60_000,
  });

  // Auto-select first document when results stream in
  useEffect(() => {
    if (!selectedDocument && results.length > 0) {
      setSelectedDocument(results[0].document_number);
    }
  }, [results, selectedDocument]);

  // Reset notes + scroll state whenever the active document changes.
  useEffect(() => {
    setDocNotes([]);
    setScrollToPage(undefined);
    setFocusHighlightId(undefined);
  }, [selectedDocument]);

  if (!results) {
    return (
      <div className="p-4 text-red-500">
        Error: No results data available.
      </div>
    );
  }

  const selectedResult = results.find(
    (r) => r.document_number === selectedDocument,
  );
  const pdfUrl = getFileUrl(selectedResult?.file_path);

  // Group this doc's notes by page so the same page doesn't render multiple
  // headers — but they remain individually clickable for jumping.
  const notesByPage = useMemo(() => {
    const groups = new Map<number, any[]>();
    for (const n of docNotes) {
      const p = n.position?.pageNumber || 1;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(n);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
  }, [docNotes]);

  // Aggregate stats for the hero
  const totalDocs = results.length;
  const matchedDocs = results.filter((r) => r.match).length;
  const reviewDocs = totalDocs - matchedDocs;
  const matchRate = totalDocs > 0 ? Math.round((matchedDocs / totalDocs) * 100) : 0;
  const avgTrust =
    results.length > 0
      ? Math.round(
          results.reduce(
            (sum, r) => sum + (r.validation_result.trustability_score || 0),
            0,
          ) / results.length,
        )
      : 0;
  const totalCriticalFlags = red_flags.filter((f) => f.severity === "CRITICAL").length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="relative flex flex-col h-[calc(100vh-110px)] min-h-[520px] w-full rounded-xl overflow-hidden bg-white border border-slate-200 shadow-sm"
    >
      {/* Top gradient accent strip */}
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500 z-10" />

      {/* Compact single-row hero — title + inline stats + inline match-rate. */}
      <div className="relative px-3 sm:px-4 py-2 border-b border-slate-100 bg-white shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Title */}
          <div className="flex items-center gap-2 min-w-0 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600 flex items-center justify-center shadow-sm shadow-indigo-500/30 shrink-0">
              <FileSearch className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
            </div>
            <div className="min-w-0 leading-tight">
              <h2 className="text-sm font-display font-extrabold tracking-tight">
                <span className="text-slate-900">Document </span>
                <span className="text-gradient-primary">Analysis</span>
              </h2>
              <p className="text-[9px] text-slate-500 font-bold uppercase tracking-[0.14em] flex items-center gap-1">
                <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse-glow" />
                Forensic verification
                {requestId && (
                  <span className="hidden md:inline ml-1 font-mono normal-case tracking-tight text-slate-400">
                    REQ&middot;{requestId.slice(0, 6)}
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Inline mini-stats */}
          <div className="flex items-center gap-3 ml-auto shrink-0">
            <MiniStat label="Total" value={totalDocs} accent="text-indigo-700" />
            <MiniStat label="Matched" value={matchedDocs} accent="text-emerald-700" />
            <MiniStat
              label="Review"
              value={reviewDocs}
              accent={reviewDocs > 0 ? "text-amber-700" : "text-slate-500"}
            />
            <MiniStat label="Avg Trust" value={`${avgTrust}%`} accent="text-violet-700" />
            {totalDocs > 0 && (
              <div className="hidden md:flex items-center gap-1.5 w-32">
                <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full bg-gradient-to-r",
                      matchRate >= 90
                        ? "from-emerald-400 to-emerald-500"
                        : matchRate >= 70
                          ? "from-indigo-500 to-blue-500"
                          : matchRate >= 40
                            ? "from-amber-400 to-orange-500"
                            : "from-rose-400 to-red-500",
                    )}
                    style={{ width: `${matchRate}%` }}
                  />
                </div>
                <span className="text-[10px] font-display font-extrabold text-slate-900 tabular-nums shrink-0">
                  {matchRate}%
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden relative flex flex-col">
        {/* DOCUMENT CAROUSEL — horizontal strip of clickable doc chips.
            Selecting one drives the details + PDF panels below. Replaces the
            previous vertical accordion sidebar; the deed list now lives at
            the top so the body can give the PDF a wide 70% read column. */}
        {results.length > 0 && (
          <div className="border-b border-slate-100 bg-white shrink-0 px-2 py-1.5">
            <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-[0.14em] shrink-0 pr-1">
                Docs ({results.length})
              </span>
              {results.map((r) => {
                const isSelected = r.document_number === selectedDocument;
                const score = r.validation_result.trustability_score;
                const fieldsTotal = r.validation_result.comparisons?.length || 0;
                // Coerced via the shared helper — defends against the
                // validator's match_count occasionally being a string like
                // "9 / 9" which would render as "9/9/9" otherwise. See
                // coerceMatchCount in @/lib/utils for the full rationale.
                const fieldsMatched = coerceMatchCount(
                  r.validation_result.match_count,
                  r.validation_result.comparisons,
                  fieldsTotal,
                );
                return (
                  <button
                    key={r.document_number}
                    onClick={() => setSelectedDocument(r.document_number)}
                    className={cn(
                      "shrink-0 inline-flex items-center gap-2 rounded-md border px-2 py-1 text-left transition-all",
                      isSelected
                        ? "border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-300"
                        : "border-slate-200 bg-white hover:border-indigo-200 hover:bg-slate-50",
                    )}
                    title={`${r.document_number} — ${fieldsMatched}/${fieldsTotal} fields${typeof score === "number" ? ` · ${score}%` : ""}`}
                  >
                    <span className="text-[11px] font-display font-extrabold text-slate-900 tabular-nums">
                      {r.document_number}
                    </span>
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full shrink-0",
                        r.match ? "bg-emerald-500" : "bg-amber-500",
                      )}
                    />
                    <span className="text-[9px] text-slate-500 font-bold tabular-nums">
                      {fieldsMatched}/{fieldsTotal}
                    </span>
                    {typeof score === "number" && (
                      <span
                        className={cn(
                          "text-[9px] font-bold tabular-nums",
                          score >= 90
                            ? "text-emerald-600"
                            : score >= 70
                              ? "text-blue-600"
                              : score >= 40
                                ? "text-amber-600"
                                : "text-red-600",
                        )}
                      >
                        {score}%
                      </span>
                    )}
                  </button>
                );
              })}
              {totalCriticalFlags > 0 && (
                <Badge className="ml-auto bg-red-50 text-red-700 border-red-200 hover:bg-red-50 text-[9px] uppercase font-bold tracking-wider px-1.5 h-4 inline-flex items-center gap-1 shrink-0">
                  <span className="w-1 h-1 rounded-full bg-red-500 animate-pulse-glow" />
                  {totalCriticalFlags}
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Red Flags strip — compact horizontal scroller when present. */}
        {red_flags.length > 0 && (
          <div className="border-b border-red-100 bg-gradient-to-r from-red-50 via-rose-50/50 to-orange-50/40 px-4 py-2 shrink-0">
            <div className="flex items-center gap-2 mb-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-red-600" />
              <span className="text-[10px] font-bold text-red-900 uppercase tracking-[0.16em]">
                Chain of Title Risk Alerts
              </span>
              <Badge
                variant="outline"
                className="bg-white text-red-700 border-red-200 font-bold text-[10px] tabular-nums h-4 px-1.5"
              >
                {red_flags.length}
              </Badge>
            </div>
            <div className="flex gap-2 overflow-x-auto custom-scrollbar pb-1">
              {red_flags.map((flag, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    const docNo = flag.doc || flag.docs?.[0];
                    if (docNo) setSelectedDocument(docNo);
                  }}
                  className="shrink-0 max-w-[320px] p-2 bg-white border border-red-100 rounded-lg shadow-sm hover:shadow hover:border-red-200 transition-all text-left"
                  title={flag.doc || flag.docs?.[0] ? "Open in document" : flag.message}
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle
                      className={cn(
                        "w-3.5 h-3.5 shrink-0 mt-0.5",
                        flag.severity === "CRITICAL"
                          ? "text-red-600 animate-pulse-glow"
                          : "text-orange-500",
                      )}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.14em]">
                          {flag.type.replace(/_/g, " ")}
                        </span>
                        <Badge
                          className={cn(
                            "text-[7px] h-3.5 px-1 font-bold uppercase tracking-wider",
                            flag.severity === "CRITICAL"
                              ? "bg-red-600 hover:bg-red-600"
                              : "bg-orange-500 hover:bg-orange-500",
                          )}
                        >
                          {flag.severity}
                        </Badge>
                      </div>
                      <p className="text-[11px] font-bold text-slate-800 leading-snug line-clamp-2">
                        {flag.message}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* SPLIT: 30% details · 70% PDF */}
        <ResizablePanelGroup direction="horizontal" className="h-full w-full flex-1 min-h-0">
          {/* LEFT: Selected document — field-by-field details */}
          <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
            <div className="h-full overflow-y-auto custom-scrollbar p-3 sm:p-4 bg-gradient-to-br from-white via-slate-50/30 to-white">
              {selectedResult ? (
                <SelectedDocumentDetails
                  result={selectedResult}
                  onPageSelect={(page) => {
                    setScrollToPage({ page, timestamp: Date.now() });
                  }}
                  onOpenInMap={onOpenInMap}
                />
              ) : results.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.4 }}
                  className="flex flex-col items-center justify-center py-16 px-4 text-center"
                >
                  <div className="relative w-16 h-16 mb-4">
                    <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-300 to-violet-400 blur-2xl opacity-25 animate-pulse-glow" />
                    <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-white to-indigo-50 flex items-center justify-center shadow-inner border border-slate-100 ring-4 ring-white animate-float">
                      <FileSearch className="w-7 h-7 text-indigo-300" strokeWidth={1.6} />
                    </div>
                  </div>
                  <p className="text-sm font-display font-bold text-slate-700">
                    No validation results yet
                  </p>
                  <p className="text-xs text-slate-400 font-medium mt-1.5 max-w-xs">
                    Trigger an audit to populate field-by-field forensic comparisons.
                  </p>
                </motion.div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 gap-2">
                  <Sparkles className="w-5 h-5" />
                  <p className="text-[11px] font-bold uppercase tracking-widest">
                    Pick a document above
                  </p>
                </div>
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle className="bg-slate-100" />

          {/* RIGHT: PDF Preview — now 70% of the body */}
          <ResizablePanel defaultSize={70} minSize={40}>
            <div className="h-full flex flex-col bg-gradient-to-br from-slate-100 via-slate-50 to-indigo-50/30">
              {pdfUrl && selectedResult ? (
                <motion.div
                  key={selectedResult.document_number}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.35 }}
                  className="h-full flex flex-col"
                >
                  <div className="px-3 py-1.5 border-b border-slate-200 bg-white/80 backdrop-blur-md flex items-center justify-between gap-2 flex-wrap shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shrink-0">
                        <FileText className="w-3 h-3 text-white" />
                      </div>
                      <p className="font-display font-extrabold text-xs text-slate-900 truncate">
                        {selectedResult.document_number}
                      </p>
                      <Badge
                        className={cn(
                          "px-1.5 h-4 text-[9px] font-bold uppercase tracking-wider inline-flex items-center gap-1 border",
                          selectedResult.match
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                            : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50",
                        )}
                      >
                        <span
                          className={cn(
                            "w-1 h-1 rounded-full animate-pulse-glow",
                            selectedResult.match ? "bg-emerald-500" : "bg-amber-500",
                          )}
                        />
                        {selectedResult.match ? "Matched" : "Review"}
                      </Badge>
                    </div>
                    {/* Notes trigger — toggles the draggable floating panel.
                        The panel itself is portaled to <body> below so it
                        floats over EVERYTHING and the user can drag it
                        anywhere on the screen via its header bar. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setNotesPopupOpen((v) => !v)}
                      className={cn(
                        "h-6 px-1.5 gap-1 text-[9px] font-bold uppercase tracking-wider text-amber-800 hover:text-amber-900 hover:bg-amber-50 shrink-0",
                        notesPopupOpen && "bg-amber-100 text-amber-900",
                      )}
                      title={notesPopupOpen ? "Hide PDF annotations" : "Show PDF annotations"}
                    >
                      <StickyNote className="w-3 h-3" />
                      Notes
                      <Badge
                        className={cn(
                          "h-3.5 px-1 text-[9px] font-bold tabular-nums border-0",
                          docNotes.length > 0
                            ? "bg-amber-500 text-white"
                            : "bg-slate-100 text-slate-500",
                        )}
                      >
                        {docNotes.length}
                      </Badge>
                    </Button>
                  </div>

                  {/* PDF — full height of the right pane, no bottom drawer.
                      The annotations list now lives in a slide-in Sheet
                      triggered from the header above. */}
                  <div className="flex-1 min-h-0 p-1.5">
                    <div className="w-full h-full rounded-lg shadow-md bg-white border border-slate-200 overflow-hidden relative">
                      <PdfAnnotator
                        url={pdfUrl}
                        docId={selectedResult.document_number}
                        parcelId={parcelId}
                        scrollToPage={scrollToPage}
                        focusHighlightId={focusHighlightId}
                        onAnnotationChange={(h) => setDocNotes(h)}
                      />
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="h-full flex flex-col items-center justify-center text-center px-6 space-y-5"
                >
                  <div className="relative w-20 h-20">
                    <div className="absolute inset-0 bg-gradient-to-br from-indigo-400 to-blue-500 rounded-3xl blur-2xl opacity-30 animate-pulse-glow" />
                    <div className="relative w-20 h-20 bg-white rounded-3xl flex items-center justify-center shadow-lg border border-slate-100 ring-1 ring-white animate-float">
                      <FileText className="w-9 h-9 text-indigo-300" strokeWidth={1.6} />
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-500 uppercase tracking-[0.22em]">
                      Select a document
                    </p>
                    <p className="text-xs text-slate-400 font-medium mt-1.5 max-w-xs">
                      Pick a deed from the validation list to view its source PDF and field-level evidence
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                    <Sparkles className="w-3 h-3 text-amber-400" />
                    <span>Click any deed on the left</span>
                  </div>
                </motion.div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* DRAGGABLE FLOATING ANNOTATIONS PANEL.
          Portaled to <body> so it floats over the entire app and can be
          dragged anywhere on the screen. The header bar (with the grip
          icon) is the drag handle — useDragControls + dragListener=false
          stops the scrollable body from absorbing pointer-down events. */}
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {notesPopupOpen && selectedResult && (
              <motion.div
                key="annotations-panel"
                drag
                dragControls={notesDragControls}
                dragListener={false}
                dragMomentum={false}
                dragElastic={0}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="fixed top-20 right-6 z-[60] w-[480px] max-w-[92vw] rounded-xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 overflow-hidden select-none"
                style={{ touchAction: "none" }}
              >
                {/* Drag handle bar — only this header captures pointer-down
                    for dragging. Body remains scrollable + clickable. */}
                <div
                  onPointerDown={(e) => notesDragControls.start(e)}
                  className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-amber-50/70 to-white cursor-move"
                  title="Drag to move"
                >
                  <GripHorizontal className="w-4 h-4 text-slate-400 shrink-0" />
                  <StickyNote className="w-4 h-4 text-amber-500 shrink-0" />
                  <span className="text-sm font-display font-extrabold text-slate-900 shrink-0">
                    PDF Annotations
                  </span>
                  <Badge variant="outline" className="text-[11px] font-bold bg-white h-5 px-2 shrink-0">
                    {docNotes.length}
                  </Badge>
                  <span className="ml-2 text-[11px] text-slate-500 font-medium truncate flex-1">
                    {selectedResult.document_number}
                  </span>
                  <button
                    onClick={() => setNotesPopupOpen(false)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors shrink-0"
                    aria-label="Close annotations"
                    title="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div
                  className="max-h-[78vh] overflow-y-auto custom-scrollbar p-4 space-y-3"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {docNotes.length === 0 ? (
                    <div className="flex flex-col items-center justify-center text-center text-slate-400 gap-3 py-14">
                      <StickyNote className="w-10 h-10 opacity-40" />
                      <p className="text-sm font-bold text-slate-500">
                        No notes on this document yet
                      </p>
                      <p className="text-xs max-w-[320px] leading-snug">
                        Toggle <span className="font-bold text-slate-600">Text</span> or{" "}
                        <span className="font-bold text-slate-600">Draw</span> in the
                        PDF, select a region, and your notes land here.
                      </p>
                    </div>
                  ) : (
                    notesByPage.flatMap(([page, items]) =>
                      items.map((n: any) => {
                        const ts = Date.now();
                        return (
                          <div
                            key={n.id}
                            onClick={() => {
                              setScrollToPage({ page, timestamp: ts });
                              setFocusHighlightId({ id: n.id, page, timestamp: ts });
                            }}
                            className="rounded-xl bg-slate-50/70 border border-slate-200 p-3 cursor-pointer hover:bg-amber-50/60 transition-colors space-y-2"
                            title="Click to scroll to this highlight"
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setScrollToPage({ page, timestamp: ts });
                                setFocusHighlightId({ id: n.id, page, timestamp: ts });
                              }}
                              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-extrabold uppercase tracking-wider bg-gradient-to-r from-violet-600 via-indigo-600 to-blue-600 text-white shadow-sm hover:shadow active:scale-95 transition-all"
                              title={`Jump to page ${page}`}
                            >
                              <ArrowRight className="w-3 h-3" />
                              Page {page}
                            </button>

                            {n.content?.text && (
                              <p className="text-xs italic font-semibold text-slate-700 leading-snug">
                                "{n.content.text}"
                              </p>
                            )}

                            {n.comment?.text ? (
                              <div className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-white border border-slate-200">
                                <MessageSquare className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                                <p className="text-xs font-medium text-slate-800 leading-snug break-words">
                                  {n.comment.text}
                                </p>
                              </div>
                            ) : (
                              <div className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-white border border-slate-200">
                                <MessageSquare className="w-3.5 h-3.5 text-slate-300 shrink-0 mt-0.5" />
                                <p className="text-xs italic text-slate-400">(no note text)</p>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </motion.div>
  );
}

// ─── Compact hero mini-stat (single label + number, no card chrome) ──────
function MiniStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: string;
}) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[8px] font-bold text-slate-400 uppercase tracking-[0.14em]">
        {label}
      </span>
      <span className={cn("text-xs font-display font-extrabold tabular-nums", accent)}>
        {value}
      </span>
    </div>
  );
}

// ─── Hero Stat Pill ────────────────────────────────────────────────────────

function StatPill({
  label,
  value,
  icon,
  theme,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  theme: "indigo" | "emerald" | "amber" | "violet" | "slate";
}) {
  const themes = {
    indigo: {
      ring: "from-indigo-500 to-blue-600",
      text: "text-indigo-700",
      soft: "bg-indigo-50",
      border: "border-indigo-100",
      shadow: "hover:shadow-indigo-100",
    },
    emerald: {
      ring: "from-emerald-500 to-emerald-600",
      text: "text-emerald-700",
      soft: "bg-emerald-50",
      border: "border-emerald-100",
      shadow: "hover:shadow-emerald-100",
    },
    amber: {
      ring: "from-amber-500 to-orange-500",
      text: "text-amber-700",
      soft: "bg-amber-50",
      border: "border-amber-100",
      shadow: "hover:shadow-amber-100",
    },
    violet: {
      ring: "from-violet-500 to-indigo-600",
      text: "text-violet-700",
      soft: "bg-violet-50",
      border: "border-violet-100",
      shadow: "hover:shadow-violet-100",
    },
    slate: {
      ring: "from-slate-400 to-slate-500",
      text: "text-slate-600",
      soft: "bg-slate-50",
      border: "border-slate-100",
      shadow: "hover:shadow-slate-100",
    },
  }[theme];

  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 8, scale: 0.96 },
        visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
      }}
      whileHover={{ y: -2 }}
      className={cn(
        "relative bg-white border rounded-xl px-3 py-2 flex items-center gap-2.5 shadow-sm transition-all",
        themes.border,
        themes.shadow,
      )}
    >
      <div
        className={cn(
          "w-7 h-7 rounded-lg flex items-center justify-center bg-gradient-to-br text-white shadow-sm shrink-0",
          themes.ring,
        )}
      >
        {icon}
      </div>
      <div className="flex flex-col leading-tight min-w-0">
        <span className="text-[8px] font-bold text-slate-400 uppercase tracking-[0.18em] truncate">
          {label}
        </span>
        <span className={cn("text-sm font-display font-extrabold tabular-nums", themes.text)}>
          {value}
        </span>
      </div>
    </motion.div>
  );
}

// ─── Selected Document Details ─────────────────────────────────────────────
// Field-by-field verification for the doc the user picked in the carousel.
// Renders the same content the previous AccordionContent did, minus the
// accordion chrome — the carousel above replaces the per-doc trigger row.
function SelectedDocumentDetails({
  result,
  onPageSelect,
  onOpenInMap,
}: {
  result: ResultItem;
  onPageSelect: (page: number) => void;
  onOpenInMap?: (docNo: string) => void;
}) {
  if (!result?.validation_result) return null;
  const vr = result.validation_result;

  return (
    <motion.div
      key={result.document_number}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-3"
    >
      <div className="flex items-start justify-between gap-2 pb-2 border-b border-slate-100">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display font-extrabold text-sm text-slate-900 truncate">
              {result.document_number}
            </span>
            <Badge
              className={cn(
                "text-[9px] uppercase font-bold tracking-wider px-1.5 h-4 border",
                result.match
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-amber-50 text-amber-700 border-amber-200",
              )}
            >
              {result.match ? "Match" : "Review"}
            </Badge>
          </div>
          <p className="text-[10px] text-slate-500 font-bold tabular-nums mt-0.5">
            {coerceMatchCount(vr.match_count, vr.comparisons)}/{vr.comparisons?.length || 0} fields matched
          </p>
        </div>
        {onOpenInMap && (
          <button
            onClick={() => onOpenInMap(result.document_number)}
            className="flex items-center gap-1 px-2 py-1 bg-primary/10 hover:bg-primary/20 text-primary text-[9px] font-bold rounded-md transition-all border border-primary/20 shrink-0"
            title="Open in lineage map"
          >
            <MapPin className="w-3 h-3" />
            MAP
          </button>
        )}
      </div>

      {vr.requires_extra_scrutiny && (
        <div className="p-3 rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 space-y-1.5">
          <div className="flex items-center gap-2 text-amber-800 font-bold text-xs">
            <ShieldCheck className="w-3.5 h-3.5" />
            LEGAL HEIR SCRUTINY ALERT
          </div>
          <p className="text-[11px] text-amber-900 leading-relaxed font-medium">
            {vr.scrutiny_reason ||
              "This document involves a family transfer (Settlement/Partition) which requires verification of Legal Heir Certificates and Death Certificates."}
          </p>
        </div>
      )}

      <TrustabilityScore score={vr.trustability_score} />

      {(vr.comparisons || []).map((comparison, idx) => {
        const isMatched =
          comparison.status.includes("MATCHED") &&
          !comparison.status.includes("NOT");
        const pageMatch = comparison.page_number?.match(/\d+/);
        const page = pageMatch ? Math.max(1, parseInt(pageMatch[0])) : null;
        return (
          <div
            key={idx}
            className={cn(
              "p-3 rounded-lg border",
              isMatched ? "bg-emerald-50/60 border-emerald-200" : "bg-red-50/60 border-red-200",
            )}
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0 flex-1">
                <span className="font-bold text-xs text-slate-900 leading-tight">
                  {comparison.field}
                </span>
                {page !== null && (
                  <button
                    onClick={() => onPageSelect(page)}
                    className="mt-1.5 text-[10px] bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 px-2 py-0.5 rounded transition-all flex items-center gap-1 font-bold w-fit"
                    title="Open the source PDF at this page"
                  >
                    <ExternalLink className="w-2.5 h-2.5" />
                    Source · Page {page}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {isMatched ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-600" />
                )}
                <Badge
                  className={cn(
                    "text-[9px] px-1.5 h-4 font-bold uppercase tracking-wider",
                    isMatched
                      ? "bg-emerald-600 hover:bg-emerald-600 text-white"
                      : "bg-red-600 hover:bg-red-600 text-white",
                  )}
                >
                  {comparison.status}
                </Badge>
              </div>
            </div>
            <div className="space-y-1 text-[11px]">
              <div className="break-words">
                <span className="text-slate-500 font-medium">EC Value: </span>
                <span className="font-semibold text-slate-800">{comparison.ec_value}</span>
              </div>
              <div className="break-words">
                <span className="text-slate-500 font-medium">Metadata Value: </span>
                <span className="font-semibold text-slate-800">{comparison.metadata_value}</span>
              </div>
              {comparison.reason && (
                <div className="pt-1.5 mt-1 text-slate-500 italic border-t border-slate-200/80 text-[10px] leading-relaxed">
                  {comparison.reason}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {vr.reason_for_failure &&
        vr.reason_for_failure !== "All fields consistent" && (
          <div className="p-2.5 rounded-lg bg-red-100 border border-red-300">
            <span className="text-[11px] text-red-700 font-semibold">
              Reason: {vr.reason_for_failure}
            </span>
          </div>
        )}
    </motion.div>
  );
}
