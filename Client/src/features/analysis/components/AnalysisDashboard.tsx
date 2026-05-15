import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
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
} from "lucide-react";
import { Accordion } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ValidationResultItem } from "./AnalysisResultItem";
import PdfAnnotator from "./PdfAnnotator";
import { cn } from "@/lib/utils";
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
  const [openAccordion, setOpenAccordion] = useState<string | undefined>(
    results.length > 0 ? results[0].document_number : undefined,
  );
  // Drives PdfAnnotator's scroll-to-page when a citation chip is clicked.
  // The timestamp ensures clicking the same page twice still re-scrolls.
  const [scrollToPage, setScrollToPage] = useState<{ page: number; timestamp: number } | undefined>(
    undefined,
  );
  // Click on a note row → flash that highlight in the embedded PDF.
  const [focusHighlightId, setFocusHighlightId] = useState<{ id: string; timestamp: number } | undefined>(
    undefined,
  );
  // Highlights for the currently-selected document, surfaced from
  // PdfAnnotator via onAnnotationChange so we can render the notes list
  // alongside the PDF without overlapping it.
  const [docNotes, setDocNotes] = useState<any[]>([]);

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

  const handleAccordionChange = (value: string | undefined) => {
    setOpenAccordion(value);
    if (value) setSelectedDocument(value);
  };

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
      className="relative flex flex-col h-[calc(100vh-160px)] min-h-[560px] w-full rounded-2xl sm:rounded-3xl overflow-hidden bg-white border border-slate-200 shadow-sm"
    >
      {/* Top gradient accent strip */}
      <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500 z-10" />

      {/* Hero header */}
      <div className="relative px-4 sm:px-6 lg:px-8 py-4 sm:py-5 border-b border-slate-100 bg-gradient-to-r from-white via-indigo-50/40 to-white overflow-hidden">
        {/* Background flourish */}
        <div className="pointer-events-none absolute inset-0 opacity-50">
          <div className="absolute -top-24 -right-20 w-64 h-64 rounded-full bg-gradient-to-br from-violet-200/40 to-indigo-200/40 blur-3xl animate-blob-slow" />
        </div>

        <div className="relative flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          {/* Title */}
          <div className="flex items-center gap-3 min-w-0">
            <motion.div
              initial={{ scale: 0.6, rotate: -15, opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
              className="relative shrink-0"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl blur-md opacity-40 -z-10 animate-pulse-glow" />
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600 flex items-center justify-center shadow-lg shadow-indigo-500/30 ring-1 ring-white/30">
                <FileSearch className="w-5 h-5 text-white" strokeWidth={2.5} />
              </div>
            </motion.div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl lg:text-2xl font-display font-extrabold tracking-tight">
                <span className="text-slate-900">Document </span>
                <span className="text-gradient-primary">Analysis</span>
              </h2>
              <p className="text-[10px] sm:text-[11px] text-slate-500 font-bold uppercase tracking-[0.18em] flex items-center gap-1.5 mt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse-glow" />
                Forensic Field-by-Field Verification
                {requestId && (
                  <span className="hidden md:inline ml-2 font-mono normal-case tracking-tight text-slate-400">
                    REQ&middot;{requestId.slice(0, 6)}
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Stat pills */}
          <motion.div
            initial="hidden"
            animate="visible"
            variants={{
              hidden: {},
              visible: { transition: { staggerChildren: 0.06, delayChildren: 0.15 } },
            }}
            className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5 shrink-0 w-full lg:w-auto"
          >
            <StatPill
              label="Total"
              value={totalDocs}
              icon={<FileText className="w-3.5 h-3.5" />}
              theme="indigo"
            />
            <StatPill
              label="Matched"
              value={matchedDocs}
              icon={<CheckCircle2 className="w-3.5 h-3.5" />}
              theme="emerald"
            />
            <StatPill
              label="Review"
              value={reviewDocs}
              icon={<AlertCircle className="w-3.5 h-3.5" />}
              theme={reviewDocs > 0 ? "amber" : "slate"}
            />
            <StatPill
              label="Avg Trust"
              value={`${avgTrust}%`}
              icon={<TrendingUp className="w-3.5 h-3.5" />}
              theme="violet"
            />
          </motion.div>
        </div>

        {/* Match rate progress */}
        {totalDocs > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.4 }}
            className="relative mt-4 flex items-center gap-3"
          >
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 shrink-0">
              Match Rate
            </span>
            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${matchRate}%` }}
                transition={{ delay: 0.5, duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
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
              />
            </div>
            <span className="text-xs font-display font-extrabold text-slate-900 tabular-nums shrink-0">
              {matchRate}%
            </span>
          </motion.div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden relative">
        <ResizablePanelGroup direction="horizontal" className="h-full w-full">
          {/* LEFT: Validation Details */}
          <ResizablePanel defaultSize={45} minSize={30}>
            <div className="h-full overflow-y-auto custom-scrollbar p-4 sm:p-6 bg-gradient-to-br from-white via-slate-50/30 to-white">
              <div className="flex items-center justify-between mb-5 gap-3">
                <h3 className="text-sm sm:text-base font-display font-extrabold text-slate-900 flex items-center gap-2.5">
                  <span className="inline-block w-1 h-5 rounded-full bg-gradient-to-b from-violet-500 to-indigo-600" />
                  Validation Details
                </h3>
                {totalCriticalFlags > 0 && (
                  <Badge className="bg-red-50 text-red-700 border-red-200 hover:bg-red-50 text-[10px] uppercase font-bold tracking-[0.16em] px-2 h-5 inline-flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-glow" />
                    {totalCriticalFlags} Critical
                  </Badge>
                )}
              </div>

              {/* Red Flags */}
              {red_flags.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  className="mb-5 space-y-2.5 bg-gradient-to-br from-red-50 via-rose-50/50 to-orange-50/40 border border-red-200/60 p-4 rounded-2xl shadow-sm"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <ShieldCheck className="w-4 h-4 text-red-600" />
                    <span className="text-[10px] font-bold text-red-900 uppercase tracking-[0.18em]">
                      Chain of Title Risk Alerts
                    </span>
                    <Badge
                      variant="outline"
                      className="ml-auto bg-white text-red-700 border-red-200 font-bold text-[10px] tabular-nums"
                    >
                      {red_flags.length}
                    </Badge>
                  </div>
                  <div className="space-y-2">
                    {red_flags.map((flag, idx) => (
                      <motion.div
                        key={idx}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.05 + idx * 0.04, duration: 0.3 }}
                        className="p-3 bg-white border border-red-100 rounded-xl shadow-sm hover:shadow-md hover:border-red-200 transition-all"
                      >
                        <div className="flex items-start gap-3">
                          <AlertCircle
                            className={cn(
                              "w-4 h-4 shrink-0 mt-0.5",
                              flag.severity === "CRITICAL"
                                ? "text-red-600 animate-pulse-glow"
                                : "text-orange-500",
                            )}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.16em] leading-none">
                                {flag.type.replace(/_/g, " ")}
                              </span>
                              <Badge
                                className={cn(
                                  "text-[8px] h-4 px-1.5 font-bold uppercase tracking-wider",
                                  flag.severity === "CRITICAL"
                                    ? "bg-red-600 hover:bg-red-600"
                                    : "bg-orange-500 hover:bg-orange-500",
                                )}
                              >
                                {flag.severity}
                              </Badge>
                            </div>
                            <p className="text-[11px] font-bold text-slate-800 leading-snug">
                              {flag.message}
                            </p>
                            {(flag.doc || flag.docs) && (
                              <button
                                onClick={() => {
                                  const docNo = flag.doc || flag.docs![0];
                                  setSelectedDocument(docNo);
                                  setOpenAccordion(docNo);
                                }}
                                className="mt-2 text-[10px] font-bold text-indigo-600 hover:text-indigo-700 hover:underline flex items-center gap-1 transition-colors"
                              >
                                Go to Deed
                                <ExternalLink className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Documents accordion list */}
              {results.length > 0 ? (
                <motion.div
                  initial="hidden"
                  animate="visible"
                  variants={{
                    hidden: {},
                    visible: { transition: { staggerChildren: 0.05, delayChildren: 0.2 } },
                  }}
                >
                  <Accordion
                    type="single"
                    collapsible
                    className="w-full space-y-2.5"
                    value={openAccordion}
                    onValueChange={handleAccordionChange}
                  >
                    {results.map((result) => (
                      <motion.div
                        key={result.document_number}
                        variants={{
                          hidden: { opacity: 0, y: 8 },
                          visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
                        }}
                      >
                        <ValidationResultItem
                          result={result}
                          onSelect={() => {
                            setSelectedDocument(result.document_number);
                          }}
                          onPageSelect={(page) => {
                            setSelectedDocument(result.document_number);
                            // PdfAnnotator listens on scrollToPage changes;
                            // bumping the timestamp re-triggers even if the
                            // user clicks the same page chip twice.
                            setScrollToPage({ page, timestamp: Date.now() });
                          }}
                          onOpenInMap={onOpenInMap}
                        />
                      </motion.div>
                    ))}
                  </Accordion>
                </motion.div>
              ) : (
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
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle className="bg-slate-100" />

          {/* RIGHT: PDF Preview */}
          <ResizablePanel defaultSize={55} minSize={35}>
            <div className="h-full flex flex-col bg-gradient-to-br from-slate-100 via-slate-50 to-indigo-50/30">
              {pdfUrl && selectedResult ? (
                <motion.div
                  key={selectedResult.document_number}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.35 }}
                  className="h-full flex flex-col"
                >
                  <div className="px-4 sm:px-5 py-3 border-b border-slate-200 bg-white/80 backdrop-blur-md flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shrink-0 shadow-md shadow-indigo-500/30">
                        <FileText className="w-4 h-4 text-white" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-display font-extrabold text-sm sm:text-base text-slate-900 truncate">
                          {selectedResult.document_number}
                        </p>
                        <p className="text-[10px] text-slate-400 uppercase font-bold tracking-[0.16em]">
                          Active Document Preview
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge
                        className={cn(
                          "px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] inline-flex items-center gap-1.5 border",
                          selectedResult.match
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                            : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50",
                        )}
                      >
                        <span
                          className={cn(
                            "w-1.5 h-1.5 rounded-full animate-pulse-glow",
                            selectedResult.match ? "bg-emerald-500" : "bg-amber-500",
                          )}
                        />
                        {selectedResult.match ? "Matched" : "Manual Review"}
                      </Badge>
                      {docNotes.length > 0 && (
                        <Badge className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] inline-flex items-center gap-1.5 bg-amber-100 text-amber-800 border-amber-300">
                          <StickyNote className="w-3 h-3" />
                          {docNotes.length} note{docNotes.length === 1 ? "" : "s"}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Vertical split: PDF (with note-taking) on top, list of
                      this document's notes on the bottom. The two regions
                      use a Resizable handle so the user can grow the notes
                      list when reviewing many highlights. Nothing overlays
                      the PDF — they sit in distinct stacked regions. */}
                  <ResizablePanelGroup direction="vertical" className="flex-1">
                    <ResizablePanel defaultSize={70} minSize={40}>
                      <div className="h-full p-3 sm:p-4">
                        <div className="w-full h-full rounded-2xl shadow-2xl bg-white border border-slate-200 overflow-hidden relative">
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
                    </ResizablePanel>

                    <ResizableHandle withHandle className="bg-slate-100" />

                    <ResizablePanel defaultSize={30} minSize={15}>
                      <div className="h-full bg-white border-t border-slate-200 flex flex-col">
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-2 shrink-0">
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                            PDF Annotations
                          </h4>
                          <Badge variant="outline" className="text-[10px] font-bold bg-white">
                            {docNotes.length}
                          </Badge>
                        </div>
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
                          {docNotes.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-center text-slate-400 gap-2">
                              <StickyNote className="w-7 h-7 opacity-40" />
                              <p className="text-[11px] font-bold text-slate-500">
                                No notes on this document yet
                              </p>
                              <p className="text-[10px] max-w-[280px] leading-snug">
                                Toggle <span className="font-bold text-slate-600">Text</span> or{" "}
                                <span className="font-bold text-slate-600">Draw</span> in the
                                PDF, select a region, and your notes will land here grouped by
                                page.
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
                                    className="rounded-2xl bg-slate-50/70 border border-slate-200 p-4 cursor-pointer hover:bg-amber-50/60 transition-colors space-y-3"
                                    title="Click to scroll to this highlight"
                                  >
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setScrollToPage({ page, timestamp: ts });
                                        setFocusHighlightId({ id: n.id, page, timestamp: ts });
                                      }}
                                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-extrabold uppercase tracking-wider bg-gradient-to-r from-violet-600 via-indigo-600 to-blue-600 text-white shadow-sm hover:shadow active:scale-95 transition-all"
                                      title={`Jump to page ${page}`}
                                    >
                                      <ArrowRight className="w-3 h-3" />
                                      Page {page}
                                    </button>

                                    {n.content?.text && (
                                      <p className="text-xs italic font-semibold text-slate-700">
                                        "{n.content.text}"
                                      </p>
                                    )}

                                    {n.comment?.text ? (
                                      <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-white border border-slate-200">
                                        <MessageSquare className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                                        <p className="text-xs font-medium text-slate-800 leading-snug break-words">
                                          {n.comment.text}
                                        </p>
                                      </div>
                                    ) : (
                                      <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-white border border-slate-200">
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
                      </div>
                    </ResizablePanel>
                  </ResizablePanelGroup>
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
    </motion.div>
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
