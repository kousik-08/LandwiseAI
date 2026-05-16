import React, { useEffect, useMemo, useState } from "react";
import {
    Loader2,
    StickyNote,
    FileText,
    Search,
    X,
    ChevronRight,
    ChevronDown,
    Filter,
    Copy,
    Check,
    ArrowRight,
    HardDrive,
    Server as ServerIcon,
    ExternalLink,
    Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { landwiseApi } from "@/lib/landwise-api";
import { API_BASE_URL } from "@/lib/api";
import PdfAnnotator from "@/features/analysis/components/PdfAnnotator";

export interface NoteRow {
    id: string;
    annotation_type: string;
    selected_text: string;
    note: string | null;
    page_number: number;
    bounding_box: any;
    is_resolved: boolean;
    created_at: string | null;
    /** Marks where this note was loaded from. */
    source?: "server" | "local";
}

export interface DocBucket {
    document_id: string;
    doc_no: string;
    document_type: string | null;
    notes: NoteRow[];
}

export interface NotesSummaryData {
    survey_number: string;
    parcel_id: string;
    total_notes: number;
    documents_with_notes: number;
    documents: DocBucket[];
}

/**
 * Emitted when the user clicks the external-link button on a note row. The
 * caller (HierarchyPage / LegalDashboard) typically navigates to the source
 * PDF in a fuller view. The cockpit's main click action is now the inline
 * preview, so this is an escape hatch for power users who want the full
 * hierarchy view.
 */
export interface NoteJumpTarget {
    doc_no: string;
    document_id: string;
    note: NoteRow;
}

interface NotesSummaryProps {
    parcelId: string;
    /** Currently-open document number (used to flag which bucket is "live"). */
    currentDocNo?: string;
    /** Refresh trigger — bump to force a re-fetch. */
    refreshKey?: number;
    /** Called when the user clicks the external-jump button. */
    onJumpToNote?: (target: NoteJumpTarget) => void;
    /** Resolves a `doc_no` to a renderable PDF URL. Required for inline
     *  preview. Returning null/undefined disables preview for that doc. */
    pdfUrlResolver?: (docNo: string) => string | null | undefined;
    /** Survey number to display when notes are loaded only from localStorage
     *  (no server response). */
    surveyNumberFallback?: string;
}

/** Format a "DOC 257/2011 · p.7" style citation. */
const formatCitation = (docNo: string, page: number, surveyNumber?: string) => {
    const docPart = docNo.replace(/\.pdf$/i, "");
    return surveyNumber
        ? `[SN ${surveyNumber} · ${docPart} · p.${page}]`
        : `[${docPart} · p.${page}]`;
};

/** Strip ".pdf" so server-side filenames and PdfAnnotator's docId match. */
const stripPdf = (s: string) => (s || "").replace(/\.pdf$/i, "");

/**
 * Build NotesSummaryData from localStorage. PdfAnnotator persists every
 * highlight into `localStorage["pnotes:<parcelId>:<docId>"]` (parcel-scoped)
 * even when the server is reachable, so we can list them here when the DB
 * is empty.
 *
 * We deliberately do NOT read the legacy unscoped `highlights_<docId>` key
 * here: those notes have no parcel attribution, so showing them would leak
 * one parcel's notes into another parcel's cockpit. PdfAnnotator migrates
 * legacy keys forward into the scoped form the next time the deed is
 * opened inside a parcel context.
 */
function scanLocalStorageNotes(surveyFallback: string, parcelId: string): NotesSummaryData {
    const buckets: DocBucket[] = [];
    const scopedPrefix = `pnotes:${parcelId}:`;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(scopedPrefix)) continue;
            const rawDoc = key.slice(scopedPrefix.length);
            if (!rawDoc) continue;
            let parsed: any[] = [];
            try {
                parsed = JSON.parse(localStorage.getItem(key) || "[]");
            } catch {
                continue;
            }
            if (!Array.isArray(parsed) || parsed.length === 0) continue;

            const notes: NoteRow[] = parsed
                .filter((h) => h && h.id && h.position)
                .map((h: any) => ({
                    id: h.id,
                    annotation_type: h?.content?.image ? "area" : "note",
                    selected_text: h?.content?.text || "Area Selection",
                    note: h?.comment?.text || "",
                    page_number: h?.position?.pageNumber || 1,
                    bounding_box: h.position,
                    is_resolved: false,
                    created_at: null,
                    source: "local",
                }));
            if (notes.length === 0) continue;
            // doc_no: localStorage uses the docId PdfAnnotator was passed (the
            // raw doc_no, sometimes with the ".pdf" suffix). Keep both forms in
            // mind during merge.
            buckets.push({
                document_id: rawDoc,
                doc_no: rawDoc,
                document_type: null,
                notes,
            });
        }
    } catch (e) {
        console.warn("localStorage scan failed", e);
    }
    const total = buckets.reduce((s, b) => s + b.notes.length, 0);
    return {
        survey_number: surveyFallback || "?",
        parcel_id: parcelId,
        total_notes: total,
        documents_with_notes: buckets.length,
        documents: buckets,
    };
}

/**
 * Merge server + localStorage buckets. Server is authoritative when both
 * have entries for the same doc; otherwise we keep whichever side has notes.
 */
function mergeBuckets(server: DocBucket[], local: DocBucket[]): DocBucket[] {
    const merged: DocBucket[] = [];
    const seen = new Set<string>();
    for (const sb of server) {
        // Tag server notes
        merged.push({
            ...sb,
            notes: sb.notes.map((n) => ({ ...n, source: n.source ?? "server" })),
        });
        seen.add(stripPdf(sb.doc_no).toLowerCase());
    }
    for (const lb of local) {
        const key = stripPdf(lb.doc_no).toLowerCase();
        if (seen.has(key)) continue;
        merged.push(lb);
        seen.add(key);
    }
    return merged;
}

const NotesSummary: React.FC<NotesSummaryProps> = ({
    parcelId,
    currentDocNo,
    refreshKey = 0,
    onJumpToNote,
    pdfUrlResolver,
    surveyNumberFallback,
}) => {
    const [serverData, setServerData] = useState<NotesSummaryData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
    const [collapsedDocs, setCollapsedDocs] = useState<Record<string, boolean>>({});
    const [copiedId, setCopiedId] = useState<string | null>(null);
    /** Inline PDF preview target: which note the user clicked. */
    const [previewNote, setPreviewNote] = useState<{
        docNo: string;
        documentId: string;
        note: NoteRow;
    } | null>(null);
    const [focusKey, setFocusKey] = useState(0);
    /** Bumped to force a server-fetch + localStorage scan (e.g. after an
     *  external "notes changed" event), even when the outer refreshKey
     *  hasn't changed. NOT used by the inline delete path — that uses
     *  optimistic local removal to avoid flashing the global loader. */
    const [internalRefreshKey, setInternalRefreshKey] = useState(0);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    /** Note ids that have just been deleted in this session. We hide them
     *  from the displayed list immediately so the row disappears in-place
     *  instead of waiting for the cockpit's server-fetch effect to run —
     *  the fetch effect sets `loading=true`, which unmounts the entire
     *  list and replaces it with the full-screen loader, which the user
     *  perceives as the remaining notes "misaligning" after a delete. */
    const [locallyDeletedIds, setLocallyDeletedIds] = useState<Set<string>>(() => new Set());

    // ── Reset session state when the parcel changes ──────────────────────
    // Otherwise a note we deleted in parcel A would stay hidden after we
    // switch to parcel B (different note ids but the same Set).
    useEffect(() => {
        setLocallyDeletedIds(new Set());
    }, [parcelId, refreshKey]);

    // ── Cross-component sync ─────────────────────────────────────────────
    // PdfAnnotator dispatches `pdf-notes-changed` whenever a note is
    // created or deleted. We listen for both:
    //   - create  → bump internalRefreshKey to refetch the summary so the
    //               new note shows up immediately.
    //   - delete  → hide it locally without waiting for a roundtrip.
    useEffect(() => {
        const handler = (e: Event) => {
            const ce = e as CustomEvent;
            const d = ce?.detail;
            if (!d) return;
            if (d.action === "delete" && d.noteId) {
                setLocallyDeletedIds((prev) => {
                    if (prev.has(d.noteId)) return prev;
                    const next = new Set(prev);
                    next.add(d.noteId);
                    return next;
                });
            } else if (d.action === "create") {
                setInternalRefreshKey((k) => k + 1);
            }
        };
        window.addEventListener("pdf-notes-changed", handler);
        return () => window.removeEventListener("pdf-notes-changed", handler);
    }, []);

    // ── Fetch server-side summary ────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        const fetchData = async () => {
            setLoading(true);
            setError(null);
            try {
                const json = await landwiseApi.getAnnotationsSummary(parcelId);
                if (!cancelled) setServerData(json);
            } catch (e: any) {
                if (!cancelled) {
                    // 404/empty are fine — we'll still surface localStorage notes.
                    setServerData(null);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        if (parcelId) fetchData();
        return () => {
            cancelled = true;
        };
    }, [parcelId, refreshKey, internalRefreshKey]);

    // ── Server-only view ────────────────────────────────────────────────
    // Notes live exclusively in document_annotations on RDS. The cockpit no
    // longer scans localStorage — it would surface stale rows that haven't
    // been migrated to the server.
    const data: NotesSummaryData | null = useMemo(() => {
        if (!serverData) return null;
        const docs = (serverData.documents ?? []).map((sb) => ({
            ...sb,
            notes: sb.notes.map((n) => ({ ...n, source: n.source ?? "server" })),
        }));
        const total = docs.reduce((s, d) => s + d.notes.length, 0);
        return {
            survey_number: serverData.survey_number || surveyNumberFallback || "?",
            parcel_id: parcelId,
            total_notes: total,
            documents_with_notes: docs.length,
            documents: docs,
        };
    }, [serverData, parcelId, surveyNumberFallback]);

    // ── Filtering ────────────────────────────────────────────────────────
    const filtered: DocBucket[] = useMemo(() => {
        if (!data) return [];
        const q = query.trim().toLowerCase();
        return data.documents
            .map((doc) => {
                const notes = doc.notes.filter((n) => {
                    // Hide notes that were just deleted in this session,
                    // even if the underlying server / localStorage data
                    // hasn't been refetched yet. Keeps the list stable
                    // across the click → delete → render cycle.
                    if (locallyDeletedIds.has(n.id)) return false;
                    if (filter === "open" && n.is_resolved) return false;
                    if (filter === "resolved" && !n.is_resolved) return false;
                    if (!q) return true;
                    const hay = `${n.note || ""} ${n.selected_text || ""} ${doc.doc_no} p${n.page_number}`.toLowerCase();
                    return hay.includes(q);
                });
                return { ...doc, notes };
            })
            .filter((doc) => doc.notes.length > 0);
    }, [data, query, filter, locallyDeletedIds]);

    const totalShown = filtered.reduce((sum, d) => sum + d.notes.length, 0);

    const toggleDoc = (docId: string) =>
        setCollapsedDocs((prev) => ({ ...prev, [docId]: !prev[docId] }));

    const copyCitation = async (note: NoteRow, doc: DocBucket) => {
        const citation = formatCitation(doc.doc_no, note.page_number, data?.survey_number);
        const body = note.note ? `${citation} ${note.note}` : citation;
        try {
            await navigator.clipboard.writeText(body);
            setCopiedId(note.id);
            setTimeout(() => setCopiedId(null), 1500);
        } catch (e) {
            console.error("clipboard write failed", e);
        }
    };

    const openInlinePreview = (note: NoteRow, doc: DocBucket) => {
        setPreviewNote({ docNo: doc.doc_no, documentId: doc.document_id, note });
        setFocusKey((k) => k + 1);
    };

    /**
     * Delete a single note.
     *
     * For server notes we call the soft-delete endpoint; for localStorage
     * notes we splice them out of `pnotes:<parcelId>:<docId>` directly.
     *
     * Two important UX choices live here:
     *
     *   1. We do NOT bump `internalRefreshKey` after a successful delete.
     *      That used to trigger the cockpit's server-fetch effect, which
     *      sets `loading=true`, which unmounts the list and replaces it
     *      with the full-screen loader. The user perceived that flash as
     *      the remaining notes "misaligning" / "shifting" — actually the
     *      whole UI was being re-mounted around them. Instead we add the
     *      deleted id to `locallyDeletedIds`; the filtered memo excludes
     *      it, so the row simply disappears in place. No loader, no flash.
     *
     *   2. We dispatch a `pdf-notes-changed` CustomEvent so any open
     *      PdfAnnotator instances (Document Analysis, Hierarchy panel) can
     *      drop the deleted highlight from their own state. Without this
     *      a deletion in the cockpit was invisible to other views until
     *      they remounted.
     */
    const deleteNote = async (note: NoteRow, doc: DocBucket) => {
        if (deletingId) return; // simple debounce against double-clicks
        setDeletingId(note.id);
        try {
            await landwiseApi.deleteAnnotation(note.id);

            // Optimistic local hide — list updates in place, no loader flash
            setLocallyDeletedIds((prev) => {
                const next = new Set(prev);
                next.add(note.id);
                return next;
            });

            // Close preview if it was pointing at this note
            if (previewNote?.note.id === note.id) setPreviewNote(null);

            // Tell any open PdfAnnotator instances (Document Analysis,
            // Hierarchy panel) so they remove this highlight from their
            // own state and the overlay disappears from the deed.
            window.dispatchEvent(
                new CustomEvent("pdf-notes-changed", {
                    detail: {
                        action: "delete",
                        docId: doc.document_id,
                        parcelId,
                        noteId: note.id,
                        source: note.source ?? "server",
                    },
                }),
            );

            toast.success("Note deleted");
        } catch (e: any) {
            console.error("delete note failed", e);
            toast.error("Could not delete note");
        } finally {
            setDeletingId(null);
        }
    };

    const previewPdfUrl = useMemo(() => {
        if (!previewNote) return null;
        // 1. Try the parent-provided resolver first (matches Document
        //    Analysis / Hierarchy's `validation_results.file_path`).
        const fromResolver = pdfUrlResolver?.(previewNote.docNo);
        if (fromResolver) return fromResolver;
        // 2. Fall back to the per-document download endpoint. The
        //    annotation row carries the real LandwiseDocument UUID; the
        //    backend resolves it to a presigned S3 URL via 302 redirect.
        if (previewNote.documentId) {
            return `${API_BASE_URL}/api/v1/landwise/documents/download/${previewNote.documentId}`;
        }
        return null;
    }, [previewNote, pdfUrlResolver]);

    // ── States ───────────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center p-10 gap-3 text-slate-400">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
                <span className="text-xs font-bold uppercase tracking-widest">Loading Notes Cockpit…</span>
            </div>
        );
    }
    if (error) {
        return (
            <div className="p-6 text-center bg-red-50 border-2 border-dashed border-red-200 rounded-2xl m-4">
                <p className="text-sm font-bold text-red-800">Couldn't load notes</p>
                <p className="text-xs text-red-600 mt-1">{error}</p>
            </div>
        );
    }
    if (!data || data.total_notes === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-10 text-center gap-3">
                <div className="w-14 h-14 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center">
                    <StickyNote className="w-6 h-6 text-slate-300" />
                </div>
                <div>
                    <p className="text-sm font-bold text-slate-600">No notes yet</p>
                    <p className="text-[11px] text-slate-400 mt-1 max-w-[260px]">
                        Open any deed in the hierarchy, highlight text or draw a region, and your
                        notes will appear here grouped by document.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-white">
            {/* Header */}
            <div className="px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-amber-50/60 via-white to-white shrink-0">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center">
                        <StickyNote className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-display font-extrabold text-slate-900 leading-none">
                            Notes Cockpit
                        </p>
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.16em] mt-0.5">
                            Survey No <span className="text-amber-700">{data.survey_number}</span> ·{" "}
                            {data.total_notes} note{data.total_notes === 1 ? "" : "s"} across{" "}
                            {data.documents_with_notes} deed{data.documents_with_notes === 1 ? "" : "s"}
                        </p>
                    </div>
                </div>

                {/* Search + filter */}
                <div className="flex items-center gap-2 mt-3">
                    <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                        <Input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search note text, doc, or page…"
                            className="h-8 pl-8 pr-7 text-xs"
                        />
                        {query && (
                            <button
                                onClick={() => setQuery("")}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-0.5 bg-slate-100 p-0.5 rounded-md border border-slate-200">
                        <Filter className="w-3 h-3 text-slate-400 ml-1" />
                        {(["all", "open", "resolved"] as const).map((f) => (
                            <button
                                key={f}
                                onClick={() => setFilter(f)}
                                className={cn(
                                    "px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors",
                                    filter === f ? "bg-white text-primary shadow-sm" : "text-slate-500 hover:text-primary",
                                )}
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                </div>

                {(query || filter !== "all") && (
                    <p className="text-[10px] text-slate-400 mt-2">
                        Showing {totalShown} of {data.total_notes} notes
                    </p>
                )}
            </div>

            {/* Body — split layout: list | inline PDF preview */}
            <div className="flex-1 min-h-0 flex">
                {/* LEFT: notes list */}
                <div className="w-2/5 min-w-[300px] max-w-[440px] border-r border-slate-100 overflow-y-auto custom-scrollbar p-3 space-y-3">
                    {filtered.length === 0 ? (
                        <div className="text-center py-8 text-xs text-slate-400 italic">
                            No notes match your search
                        </div>
                    ) : (
                        filtered.map((doc) => {
                            const collapsed = collapsedDocs[doc.document_id];
                            const isCurrent =
                                !!currentDocNo &&
                                stripPdf(doc.doc_no).toLowerCase() === stripPdf(currentDocNo).toLowerCase();
                            return (
                                <div
                                    key={doc.document_id}
                                    className={cn(
                                        "rounded-xl border bg-white overflow-hidden",
                                        isCurrent ? "border-amber-300 shadow-sm" : "border-slate-200",
                                    )}
                                >
                                    <button
                                        onClick={() => toggleDoc(doc.document_id)}
                                        className="w-full flex items-center justify-between px-3 py-2 bg-slate-50/70 hover:bg-slate-100/70 transition-colors"
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            {collapsed ? (
                                                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                            ) : (
                                                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                            )}
                                            <FileText className="w-3.5 h-3.5 text-primary shrink-0" />
                                            <span
                                                className="text-xs font-bold text-slate-800 truncate"
                                                title={doc.doc_no}
                                            >
                                                {stripPdf(doc.doc_no)}
                                            </span>
                                            {isCurrent && (
                                                <Badge className="text-[8px] h-4 px-1.5 bg-amber-500 text-white font-bold uppercase tracking-wider">
                                                    Open
                                                </Badge>
                                            )}
                                        </div>
                                        <Badge
                                            variant="outline"
                                            className="text-[9px] h-5 px-1.5 font-bold bg-white text-slate-600 border-slate-200"
                                        >
                                            {doc.notes.length} note{doc.notes.length === 1 ? "" : "s"}
                                        </Badge>
                                    </button>

                                    {!collapsed && (
                                        <ul className="divide-y divide-slate-100">
                                            {doc.notes.map((note) => {
                                                const isSelected = previewNote?.note.id === note.id;
                                                const isDeleting = deletingId === note.id;
                                                return (
                                                    <li
                                                        key={note.id}
                                                        className={cn(
                                                            "group p-3 transition-colors cursor-pointer",
                                                            isSelected ? "bg-amber-50/60 border-l-2 border-l-amber-500" : "hover:bg-amber-50/40",
                                                        )}
                                                        onClick={() => openInlinePreview(note, doc)}
                                                    >
                                                        {/* Top row: Page jump button (left) + source badge (right) */}
                                                        <div className="flex items-center justify-between gap-2 mb-1.5">
                                                            <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    openInlinePreview(note, doc);
                                                                }}
                                                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-extrabold uppercase tracking-wider bg-gradient-to-r from-violet-600 via-indigo-600 to-blue-600 text-white shadow-sm hover:shadow hover:scale-[1.03] active:scale-[0.97] transition-all"
                                                                title={`Preview page ${note.page_number}`}
                                                            >
                                                                <ArrowRight className="w-3 h-3" />
                                                                Page {note.page_number}
                                                            </button>
                                                            <Badge className="text-[8px] h-4 px-1 bg-emerald-100 text-emerald-700 border-0 font-bold uppercase tracking-wider gap-0.5">
                                                                <ServerIcon className="w-2.5 h-2.5" /> db
                                                            </Badge>
                                                        </div>

                                                        {/* Content */}
                                                        {note.selected_text && (
                                                            <p className="text-[11px] italic text-slate-500 line-clamp-2 mb-1">
                                                                "{note.selected_text}"
                                                            </p>
                                                        )}
                                                        {note.note && (
                                                            <p className="text-xs font-medium text-slate-800 leading-snug">
                                                                {note.note}
                                                            </p>
                                                        )}

                                                        {/* Bottom row: always-visible action bar.
                                                            Previously these controls were hidden until hover
                                                            (opacity-0 group-hover:opacity-100) which made the
                                                            delete option appear "missing" and the layout look
                                                            misaligned when controls suddenly popped in. */}
                                                        <div className="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-slate-100">
                                                            <span className="text-[9px] text-slate-400 font-mono truncate">
                                                                {note.created_at ? new Date(note.created_at).toLocaleString() : "Click to preview →"}
                                                            </span>
                                                            <div className="flex items-center gap-1 shrink-0">
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        copyCitation(note, doc);
                                                                    }}
                                                                    className="text-[9px] font-bold text-slate-500 hover:text-primary inline-flex items-center gap-0.5 px-1.5 py-1 rounded border border-slate-200 bg-white hover:border-primary/40 transition-colors"
                                                                    title="Copy as citation"
                                                                >
                                                                    {copiedId === note.id ? (
                                                                        <>
                                                                            <Check className="w-2.5 h-2.5" /> Copied
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <Copy className="w-2.5 h-2.5" /> Cite
                                                                        </>
                                                                    )}
                                                                </button>
                                                                {onJumpToNote && (
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            onJumpToNote({
                                                                                doc_no: doc.doc_no,
                                                                                document_id: doc.document_id,
                                                                                note,
                                                                            });
                                                                        }}
                                                                        className="text-[9px] font-bold text-slate-500 hover:text-primary inline-flex items-center gap-0.5 px-1.5 py-1 rounded border border-slate-200 bg-white hover:border-primary/40 transition-colors"
                                                                        title="Open in full hierarchy view"
                                                                    >
                                                                        <ExternalLink className="w-2.5 h-2.5" />
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        if (window.confirm("Delete this note?")) {
                                                                            deleteNote(note, doc);
                                                                        }
                                                                    }}
                                                                    disabled={isDeleting}
                                                                    className={cn(
                                                                        "text-[9px] font-bold inline-flex items-center gap-0.5 px-1.5 py-1 rounded border bg-white transition-colors",
                                                                        isDeleting
                                                                            ? "text-slate-300 border-slate-200 cursor-wait"
                                                                            : "text-red-500 border-red-200 hover:border-red-400 hover:bg-red-50",
                                                                    )}
                                                                    title="Delete this note"
                                                                >
                                                                    {isDeleting ? (
                                                                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                                                    ) : (
                                                                        <Trash2 className="w-2.5 h-2.5" />
                                                                    )}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>

                {/* RIGHT: inline PDF preview */}
                <div className="flex-1 min-w-0 bg-slate-50/60 flex flex-col">
                    {previewNote ? (
                        <>
                            <div className="px-4 py-2.5 border-b border-slate-100 bg-white flex items-center justify-between gap-2 shrink-0">
                                <div className="min-w-0">
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                        Preview · Page {previewNote.note.page_number}
                                    </p>
                                    <p className="text-xs font-bold text-slate-800 truncate" title={previewNote.docNo}>
                                        {stripPdf(previewNote.docNo)}
                                    </p>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-slate-400 hover:text-slate-700"
                                    onClick={() => setPreviewNote(null)}
                                    title="Close preview"
                                >
                                    <X className="w-4 h-4" />
                                </Button>
                            </div>
                            {/* Cockpit-only: PdfAnnotator gets scrollToPage but NOT focusHighlightId.
                                react-pdf-highlighter's scrollTo(highlight) lands the viewport at the
                                highlight's y-coordinate, which in the cockpit's narrow preview pane
                                often shows half of the highlight's page + half of the next — the
                                "stuck between pages" symptom. Page-level scroll lands cleanly at the
                                top of the target page; the orange-bordered area highlight (see
                                PdfAnnotator.css) is permanently visible so the user still spots the
                                note after the scroll. Document Analysis and Hierarchy keep using
                                focusHighlightId for precise scroll + amber flash. */}
                            <div className="flex-1 min-h-0 relative">
                                {previewPdfUrl ? (
                                    <PdfAnnotator
                                        url={previewPdfUrl}
                                        docId={stripPdf(previewNote.docNo)}
                                        parcelId={parcelId}
                                        scrollToPage={{
                                            page: previewNote.note.page_number,
                                            timestamp: focusKey,
                                        }}
                                    />
                                ) : (
                                    <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8 text-slate-400">
                                        <FileText className="w-10 h-10 mb-2 opacity-50" />
                                        <p className="text-sm font-bold text-slate-600">
                                            PDF unavailable for this deed
                                        </p>
                                        <p className="text-[11px] mt-1 max-w-[280px]">
                                            We couldn't resolve a viewable URL for{" "}
                                            <span className="font-mono">{stripPdf(previewNote.docNo)}</span>.
                                            Use the external-link icon on the note to open it in the
                                            full hierarchy view.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-slate-400">
                            <div className="w-14 h-14 rounded-full bg-white border border-slate-200 flex items-center justify-center mb-3 shadow-sm">
                                <ArrowRight className="w-6 h-6 text-slate-300" />
                            </div>
                            <p className="text-sm font-bold text-slate-600">Click any note to preview</p>
                            <p className="text-[11px] mt-1 max-w-[260px]">
                                The PDF will open here at the highlighted page so you can see the
                                source passage without leaving the cockpit.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default NotesSummary;
