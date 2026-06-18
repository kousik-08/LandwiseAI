import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertTriangle, Loader2, Sparkles, X, Minimize2, Maximize2, FileSearch } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AnalysisStep {
    id: string;
    label: string;
    status: "pending" | "running" | "success" | "failed";
}

interface LiveAnalysisProgressProps {
    open: boolean;
    steps: AnalysisStep[];
    /** Finished per-document results, grows as documents complete. */
    completed?: any[];
    totalDocs?: number;
    isComplete: boolean;
    onClose?: () => void;
    /** Click a finished document → reveal it in Document Analysis. */
    onViewDoc?: (docNo: string) => void;
    /** Latest backend activity line (e.g. "Processing EC Chunk 2/7…"). */
    activity?: string;
    /**
     * When true the component drives its OWN step progression on a timer
     * (for flows that don't stream real events yet, e.g. the dashboard).
     */
    simulateSteps?: boolean;
}

// The per-document narration the user sees while a document is "revealed".
const STAGES = [
    { emoji: "📄", text: "Extracting values from the deed" },
    { emoji: "🔍", text: "Matching values against the EC" },
    { emoji: "⚖️", text: "Checking for issues" },
    { emoji: "🖍️", text: "Marking with the visual debugger" },
];

const DEFAULT_STEPS: AnalysisStep[] = [
    { id: "ec_extraction", label: "EC Extraction", status: "pending" },
    { id: "matching", label: "Document Matching", status: "pending" },
    { id: "sale_deed_extraction", label: "Sale Deed Extraction", status: "pending" },
    { id: "hierarchy", label: "Hierarchy Generation", status: "pending" },
    { id: "validation", label: "Validation", status: "pending" },
];

const docNoOf = (d: any) => d?.document_number ?? d?.doc_no ?? "?";
const isMatch = (d: any) => !!(d?.match ?? d?.validation_result?.match);
const trustOf = (d: any) => d?.validation_result?.trustability_score ?? d?.trustability_score;
// The specific fields that did NOT match the EC (mirrors the backend's
// "NOT MATCHED" / mismatch detection) so we can show e.g. "Date of Registration".
const mismatchFields = (d: any): string[] => {
    const comps = d?.validation_result?.comparisons;
    if (!Array.isArray(comps)) return [];
    return comps
        .filter((c: any) => {
            const s = String(c?.status || "").toUpperCase();
            return (s.includes("NOT") && s.includes("MATCH")) || s.includes("MISMATCH");
        })
        .map((c: any) => c?.field)
        .filter((f: any): f is string => typeof f === "string" && f.length > 0);
};

export default function LiveAnalysisProgress({
    open,
    steps,
    completed = [],
    totalDocs,
    isComplete,
    onClose,
    onViewDoc,
    activity,
    simulateSteps = false,
}: LiveAnalysisProgressProps) {
    // ── Self-driven step progression for non-streaming flows ──────────────
    const [simSteps, setSimSteps] = useState<AnalysisStep[]>(DEFAULT_STEPS);
    useEffect(() => {
        if (!simulateSteps || !open) return;
        if (isComplete) {
            setSimSteps((prev) => prev.map((s) => ({ ...s, status: "success" })));
            return;
        }
        let i = 0;
        setSimSteps(DEFAULT_STEPS.map((s, idx) => ({ ...s, status: idx === 0 ? "running" : "pending" })));
        const t = setInterval(() => {
            setSimSteps((prev) => {
                const next = prev.map((s) => ({ ...s }));
                if (i < next.length) {
                    next[i].status = "running";
                    if (i > 0) next[i - 1].status = "success";
                }
                return next;
            });
            i += 1;
            if (i >= DEFAULT_STEPS.length) i = DEFAULT_STEPS.length - 1;
        }, 2600);
        return () => clearInterval(t);
    }, [simulateSteps, open, isComplete]);

    const effectiveSteps = simulateSteps ? simSteps : (steps?.length ? steps : DEFAULT_STEPS);

    // ── Per-document reveal queue ─────────────────────────────────────────
    const [revealedCount, setRevealedCount] = useState(0);
    const [stageIdx, setStageIdx] = useState(0);
    const revealing = !isComplete && completed.length > revealedCount ? completed[revealedCount] : null;

    useEffect(() => {
        // Once the whole run is done, surface every remaining doc immediately.
        if (isComplete) {
            const t = setTimeout(() => setRevealedCount(completed.length), 300);
            return () => clearTimeout(t);
        }
        if (completed.length <= revealedCount) return;
        setStageIdx(0);
        let i = 0;
        const stageTimer = setInterval(() => {
            i += 1;
            if (i >= STAGES.length) clearInterval(stageTimer);
            else setStageIdx(i);
        }, 430);
        const settle = setTimeout(() => setRevealedCount((c) => c + 1), STAGES.length * 430 + 250);
        return () => {
            clearInterval(stageTimer);
            clearTimeout(settle);
        };
    }, [revealedCount, completed.length, isComplete]);

    const revealedDocs = useMemo(() => completed.slice(0, revealedCount), [completed, revealedCount]);

    // ── Auto-minimize to the corner after the first document finishes ─────
    const [minimized, setMinimized] = useState(false);
    const autoMinRef = useRef(false);
    useEffect(() => {
        if (completed.length >= 1 && !autoMinRef.current) {
            autoMinRef.current = true;
            setMinimized(true);
        }
    }, [completed.length]);

    if (!open) return null;

    const total = totalDocs ?? (completed.length || undefined);
    const matchedCount = revealedDocs.filter(isMatch).length;
    const issueCount = revealedDocs.length - matchedCount;

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            className={cn(
                "fixed z-[400] transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
                minimized
                    ? "top-4 right-4 w-[min(380px,calc(100vw-2rem))]"
                    : "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(560px,calc(100vw-2rem))]",
            )}
        >
            <div className="rounded-2xl border border-indigo-200/70 bg-white/95 backdrop-blur-xl shadow-2xl shadow-indigo-900/20 overflow-hidden">
                {/* Header */}
                <div className="relative flex items-center justify-between gap-2 px-4 py-3 bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600 overflow-hidden">
                    <div className="pointer-events-none absolute inset-0 opacity-50">
                        <div className="absolute -top-8 -right-6 w-32 h-32 rounded-full bg-white/10 blur-2xl animate-pulse" />
                    </div>
                    <div className="relative flex items-center gap-2.5 min-w-0">
                        <motion.div
                            animate={{ rotate: isComplete ? 0 : 360 }}
                            transition={isComplete ? {} : { repeat: Infinity, duration: 2.4, ease: "linear" }}
                            className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center shrink-0 shadow-inner"
                        >
                            <Sparkles className="w-4 h-4 text-white" />
                        </motion.div>
                        <div className="min-w-0">
                            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/70 leading-none">
                                {isComplete ? "Analysis complete" : "Analyzing your documents"}
                            </p>
                            <p className="text-sm font-bold text-white truncate">
                                {isComplete
                                    ? `✅ ${matchedCount} matched · ⚠️ ${issueCount} to review`
                                    : revealing
                                        ? `${STAGES[stageIdx].emoji} ${docNoOf(revealing)} — ${STAGES[stageIdx].text}…`
                                        : (activity || "Scanning the encumbrance chain…")}
                            </p>
                        </div>
                    </div>
                    <div className="relative flex items-center gap-0.5 shrink-0">
                        <button
                            onClick={() => setMinimized((m) => !m)}
                            className="h-7 w-7 rounded-full text-white/90 hover:bg-white/15 flex items-center justify-center transition-colors"
                            title={minimized ? "Expand" : "Minimize to corner"}
                        >
                            {minimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
                        </button>
                        {onClose && (isComplete || minimized) && (
                            <button
                                onClick={onClose}
                                className="h-7 w-7 rounded-full text-white/90 hover:bg-white/15 flex items-center justify-center transition-colors"
                                title="Close"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                </div>

                {/* Step tracker */}
                <div className="flex items-center gap-1 px-4 py-2.5 border-b border-slate-100 bg-slate-50/60">
                    {effectiveSteps.map((s, i) => (
                        <React.Fragment key={s.id}>
                            <div className="flex items-center gap-1.5 min-w-0" title={s.label}>
                                <span
                                    className={cn(
                                        "w-2 h-2 rounded-full shrink-0 transition-colors",
                                        s.status === "success" && "bg-emerald-500",
                                        s.status === "running" && "bg-indigo-500 animate-pulse",
                                        s.status === "failed" && "bg-red-500",
                                        s.status === "pending" && "bg-slate-300",
                                    )}
                                />
                                {!minimized && (
                                    <span
                                        className={cn(
                                            "text-[9px] font-bold uppercase tracking-wide truncate",
                                            s.status === "running" ? "text-indigo-600" : s.status === "success" ? "text-emerald-600" : "text-slate-400",
                                        )}
                                    >
                                        {s.label}
                                    </span>
                                )}
                            </div>
                            {i < effectiveSteps.length - 1 && <div className="flex-1 h-px bg-slate-200" />}
                        </React.Fragment>
                    ))}
                </div>

                {/* Currently-revealing document narration */}
                <AnimatePresence mode="wait">
                    {revealing && (
                        <motion.div
                            key={docNoOf(revealing)}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            className="px-4 py-3 flex items-center gap-3 bg-gradient-to-r from-indigo-50/60 to-violet-50/40"
                        >
                            <motion.div
                                animate={{ scale: [1, 1.15, 1] }}
                                transition={{ repeat: Infinity, duration: 1 }}
                                className="text-2xl"
                            >
                                {STAGES[stageIdx].emoji}
                            </motion.div>
                            <div className="min-w-0">
                                <p className="text-xs font-bold text-slate-900 font-mono">{docNoOf(revealing)}</p>
                                <p className="text-[11px] text-slate-500 font-medium">{STAGES[stageIdx].text}…</p>
                            </div>
                            <Loader2 className="w-4 h-4 text-indigo-500 animate-spin ml-auto shrink-0" />
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Completed documents list (progressive reveal) */}
                <div className={cn("overflow-y-auto custom-scrollbar", minimized ? "max-h-[220px]" : "max-h-[320px]")}>
                    {revealedDocs.length === 0 && !revealing && (
                        <div className="flex flex-col items-center justify-center gap-2 py-7 text-center">
                            <FileSearch className="w-7 h-7 text-indigo-300 animate-pulse" />
                            <p className="text-[11px] text-slate-400 font-medium">
                                Working through the documents — finished ones will appear here.
                            </p>
                        </div>
                    )}
                    <AnimatePresence initial={false}>
                        {revealedDocs.map((d) => {
                            const matched = isMatch(d);
                            const trust = trustOf(d);
                            const issues = matched ? [] : mismatchFields(d);
                            return (
                                <motion.button
                                    key={docNoOf(d)}
                                    layout
                                    initial={{ opacity: 0, x: 24, scale: 0.96 }}
                                    animate={{ opacity: 1, x: 0, scale: 1 }}
                                    transition={{ type: "spring", stiffness: 320, damping: 26 }}
                                    onClick={() => onViewDoc?.(docNoOf(d))}
                                    className="w-full text-left px-4 py-2.5 flex flex-col gap-1 border-b border-slate-50 hover:bg-indigo-50/40 transition-colors"
                                >
                                    <div className="flex items-center gap-2.5">
                                        {matched ? (
                                            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                        ) : (
                                            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                                        )}
                                        <span className="text-xs font-bold text-slate-800 font-mono truncate">{docNoOf(d)}</span>
                                        <span
                                            className={cn(
                                                "text-[9px] font-extra-bold uppercase tracking-wide px-1.5 py-0.5 rounded",
                                                matched ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700",
                                            )}
                                        >
                                            {matched ? "Matched" : "Issue"}
                                        </span>
                                        {typeof trust === "number" && (
                                            <span className="text-[10px] font-bold text-slate-400 ml-auto shrink-0">{trust}%</span>
                                        )}
                                    </div>
                                    {issues.length > 0 && (
                                        <div className="pl-6 flex flex-wrap gap-1">
                                            {issues.slice(0, 3).map((f, i) => (
                                                <span
                                                    key={i}
                                                    className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5 py-0.5"
                                                >
                                                    {f} mismatch
                                                </span>
                                            ))}
                                            {issues.length > 3 && (
                                                <span className="text-[9px] font-bold text-slate-400">+{issues.length - 3} more</span>
                                            )}
                                        </div>
                                    )}
                                </motion.button>
                            );
                        })}
                    </AnimatePresence>
                </div>

                {/* Footer count */}
                <div className="px-4 py-2 border-t border-slate-100 bg-slate-50/60 flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {revealedDocs.length}{total ? ` / ${total}` : ""} document{revealedDocs.length === 1 ? "" : "s"}
                    </span>
                    {isComplete ? (
                        <span className="text-[10px] font-extra-bold text-emerald-600 uppercase tracking-wide flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" /> Done
                        </span>
                    ) : (
                        <span className="text-[10px] font-bold text-indigo-500 uppercase tracking-wide flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" /> Live
                        </span>
                    )}
                </div>
            </div>
        </motion.div>
    );
}
