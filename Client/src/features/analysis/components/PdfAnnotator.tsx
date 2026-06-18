import React, { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { landwiseApi } from "@/lib/landwise-api";
import { toast } from "sonner";
import {
    PdfLoader,
    PdfHighlighter,
    Highlight,
    Popup,
    AreaHighlight,
} from "react-pdf-highlighter";
import { Trash2, MessageSquare, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import "./PdfAnnotator.css";

// CRITICAL: Base styles for the library's positioning logic
import "react-pdf-highlighter/dist/style.css";

// Set PDF.js Worker
import { GlobalWorkerOptions } from "pdfjs-dist";
GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js`;

interface IHighlight {
    id: string;
    content: {
        text?: string;
        image?: string;
    };
    position: any;
    comment: {
        text: string;
        emoji: string;
    };
}

interface PdfAnnotatorProps {
    url: string;
    /** Identifier for storing per-doc localStorage fallback (usually doc_no). */
    docId: string;
    /** Parcel UUID — required for server-side persistence. */
    parcelId?: string;
    onAnnotationChange?: (highlights: IHighlight[]) => void;
    /** Page-only navigation (no specific bbox). Used by chat citations. */
    scrollToPage?: { page: number; timestamp: number };
    /** Highlight-precise navigation. Used by Notes Hub click-throughs.
     *  When changed, the PDF scrolls to that highlight and flashes it. The
     *  optional `page` is a fallback hint: if the highlight id can't be
     *  resolved in time (cross-doc deep links, slow server loads), the
     *  viewer at least scrolls to the right page so the user isn't left
     *  staring at the top of page 1. */
    focusHighlightId?: { id: string; page?: number; timestamp: number };
    externalHighlights?: IHighlight[];
}

const FLASH_KEY = "__pdf_focused__";

const PdfAnnotator: React.FC<PdfAnnotatorProps> = ({
    url,
    docId,
    parcelId,
    onAnnotationChange,
    scrollToPage,
    focusHighlightId,
    externalHighlights = [],
}) => {
    const [highlights, setHighlights] = useState<IHighlight[]>([]);
    const [selectionMode, setSelectionMode] = useState<"text" | "area">("text");
    const [flashedId, setFlashedId] = useState<string | null>(null);
    const highlighterRef = useRef<any>(null);
    const scrollViewerRef = useRef<any>(null);
    // Mirror of the latest highlights array so the focus effect's retry
    // loop can read fresh values WITHOUT having to re-run (and re-cancel)
    // every time React Query pushes a new annotation list. Re-running was
    // causing the focus effect to fire `scrollTo()` repeatedly on the
    // same target during a single click — each call retriggering the
    // createRoot warning inside react-pdf-highlighter and racing the
    // flash-animation class on/off so the user never saw it complete.
    const highlightsRef = useRef<IHighlight[]>([]);
    useEffect(() => {
        highlightsRef.current = highlights;
    }, [highlights]);
    // Latches that scrollTo+flash already ran for a given focusHighlightId
    // signature; prevents the duplicate calls that produced the warning
    // and "highlight not visible" symptoms.
    const lastFocusedSigRef = useRef<string>("");
    // Tracks whether the load effect has finished. The mirror-to-localStorage
    // effect must NOT run before this is true: on mount, `highlights` is
    // always [], and writing that empty array to localStorage immediately
    // wipes any previously persisted notes BEFORE the load effect has had a
    // chance to read them. With this gate the mirror only runs after the
    // first real value (loaded or empty) is committed.
    const loadedRef = useRef(false);

    // ── Load existing notes via React Query (DB only) ────────────────────
    // Backed by the SAME query key the parent screens (LegalDashboard,
    // AnalysisDashboard) can prefetch with — react-query dedupes the
    // network call and serves a warm cache instantly when PdfAnnotator
    // mounts, so highlights appear at the same time the PDF does instead
    // of flashing in after a separate roundtrip.
    const queryClient = useQueryClient();
    const { data: annotationsResponse } = useQuery({
        queryKey: ["annotations", parcelId],
        queryFn: () => landwiseApi.getAnnotations(parcelId!),
        enabled: !!parcelId,
        staleTime: 60_000, // shared cache window for cockpit + analysis
    });

    // Invalidate this key after any mutation so a freshly created/deleted
    // note shows up the next time another consumer of the same key reads.
    // Without this the Notes Hub right-pane preview was reading stale
    // emptiness even after the user marked notes in Document Analysis.
    const invalidateAnnotationsCache = useCallback(() => {
        if (parcelId) {
            queryClient.invalidateQueries({ queryKey: ["annotations", parcelId] });
            queryClient.invalidateQueries({ queryKey: ["annotations-summary", parcelId] });
        }
    }, [parcelId, queryClient]);

    useEffect(() => {
        loadedRef.current = false;

        // 1×1 transparent PNG marker so react-pdf-highlighter picks the
        // <AreaHighlight> branch for area-mode notes (which have no real screenshot).
        const AREA_IMAGE_PLACEHOLDER =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const isAreaAnnotation = (a: any) => {
            if (a.annotation_type === "area") return true;
            if ((a.selected_text || "").toLowerCase() === "area selection") return true;
            return false;
        };

        if (!parcelId) {
            setHighlights([]);
            loadedRef.current = true;
            return;
        }

        // Server returns doc_no as the original filename ("5548_2013.pdf").
        // The frontend passes docId as a raw doc number ("5548/2013",
        // sometimes "5548_2013"). Normalize both sides to a slug
        // (lowercase, slashes → underscores, .pdf stripped) before comparing.
        const slug = (s: string) =>
            (s || "")
                .toLowerCase()
                .replace(/\.pdf$/i, "")
                .replace(/[\/\\]/g, "_");
        const target = slug(docId);
        const docAnnos: IHighlight[] = (annotationsResponse?.data || [])
            .filter((a: any) => {
                if (a.document_id === docId) return true;
                const docSlug = slug(a.doc_no || "");
                if (!target) return false;
                return docSlug === target || docSlug.includes(target);
            })
            .filter((a: any) => a.bounding_box)
            .map((a: any) => ({
                id: a.id,
                content: isAreaAnnotation(a)
                    ? { text: a.selected_text || "", image: AREA_IMAGE_PLACEHOLDER }
                    : { text: a.selected_text || "" },
                position: a.bounding_box,
                comment: { text: a.note || "", emoji: "" },
            }));
        setHighlights(docAnnos);
        loadedRef.current = true;
    }, [docId, parcelId, annotationsResponse]);

    // Notify any parent that holds an in-memory view of the highlights. We no
    // longer mirror to localStorage — RDS is the only persistence layer.
    useEffect(() => {
        if (onAnnotationChange) onAnnotationChange(highlights);
    }, [highlights, onAnnotationChange]);

    const getNextId = () => String(Math.random()).slice(2);

    const addHighlight = async (highlight: Omit<IHighlight, "id">) => {
        if (!parcelId) {
            toast.error("Cannot save note: parcel context missing");
            return;
        }

        // Deep-clone the position so any internal mutation by
        // react-pdf-highlighter (it sometimes scales / mutates the
        // boundingRect after the callback returns) can't corrupt the
        // coords we save to the DB.
        const frozenPosition = JSON.parse(JSON.stringify(highlight.position));
        const frozenContent = JSON.parse(JSON.stringify(highlight.content));

        const tempId = `pending-${getNextId()}`;
        setHighlights((prev) => [
            { ...highlight, position: frozenPosition, content: frozenContent, id: tempId },
            ...prev,
        ]);

        const isArea = Boolean(frozenContent.image);
        try {
            const created = await landwiseApi.createAnnotation(parcelId, {
                document_id: docId,
                annotation_type: isArea ? "area" : "note",
                selected_text: frozenContent.text || (isArea ? "Area Selection" : ""),
                note: highlight.comment.text,
                page_number: frozenPosition.pageNumber,
                bounding_box: frozenPosition,
            });
            const serverId = created?.id;
            if (serverId) {
                setHighlights((prev) =>
                    prev.map((h) => (h.id === tempId ? { ...h, id: serverId } : h))
                );
                toast.success("Note saved");
                // Cache bust: the cockpit's separate PdfAnnotator instance
                // (and any future remount here) reads from this query key,
                // so a stale cache would render this new note as missing.
                invalidateAnnotationsCache();
                // Tell the Notes Hub (and any other open observers) so the
                // new note shows up in the list without a manual refresh.
                window.dispatchEvent(
                    new CustomEvent("pdf-notes-changed", {
                        detail: {
                            action: "create",
                            docId,
                            parcelId,
                            noteId: serverId,
                            source: "server",
                        },
                    }),
                );
            } else {
                throw new Error("Server response missing annotation id");
            }
        } catch (e) {
            console.error("Failed to save annotation", e);
            toast.error("Failed to save note — please retry");
            setHighlights((prev) => prev.filter((h) => h.id !== tempId));
        }
    };

    const deleteHighlight = async (id: string) => {
        setHighlights((prev) => prev.filter((h) => h.id !== id));
        // Only the optimistic-temp ids start with "pending-"; everything
        // else is a real DB row and needs a server delete.
        if (parcelId && !id.startsWith("pending-")) {
            try {
                await landwiseApi.deleteAnnotation(id);
            } catch (e) {
                console.warn("Server delete failed (note removed from view)", e);
            }
            invalidateAnnotationsCache();
        }
        window.dispatchEvent(
            new CustomEvent("pdf-notes-changed", {
                detail: {
                    action: "delete",
                    docId,
                    parcelId,
                    noteId: id,
                    source: id.startsWith("pending-") ? "pending" : "server",
                },
            }),
        );
    };

    // ── Cross-component delete sync ──────────────────────────────────────
    // When another component (typically the Notes Hub) deletes a note,
    // remove it from our local highlights state so the PDF overlay
    // disappears without waiting for a re-mount. Filtered by docId so
    // sibling PdfAnnotator instances don't drop unrelated notes.
    useEffect(() => {
        const handler = (e: Event) => {
            const ce = e as CustomEvent;
            const d = ce?.detail;
            if (!d || d.action !== "delete" || !d.noteId) return;
            const stripPdf = (s: string) => (s || "").replace(/\.pdf$/i, "");
            const sameDoc =
                d.docId === docId ||
                stripPdf(d.docId) === stripPdf(docId) ||
                (typeof d.docId === "string" && d.docId.includes(docId)) ||
                (typeof docId === "string" && docId.includes(d.docId));
            if (!sameDoc) return;
            // parcelId match is best-effort: if either side is missing,
            // fall through (we already gated on docId).
            if (d.parcelId && parcelId && d.parcelId !== parcelId) return;
            setHighlights((prev) => prev.filter((h) => h.id !== d.noteId));
            // Bust react-query cache too so a remount (or another consumer
            // of the same key in the cockpit) doesn't render the deleted
            // note again from stale cache.
            invalidateAnnotationsCache();
        };
        window.addEventListener("pdf-notes-changed", handler);
        return () => window.removeEventListener("pdf-notes-changed", handler);
    }, [docId, parcelId]);

    // ── Page-only scroll (chat citations + Notes Hub) ───────────────
    // react-pdf-highlighter has no public "scroll to page top" API — only
    // scrollTo(highlight), which scrolls so the highlight's boundingRect
    // is near the viewport top. To navigate to a page without a real
    // highlight in hand we synthesise a temporary highlight whose
    // boundingRect is GUARANTEED invisible: zero-sized AND positioned at
    // negative coordinates relative to a tiny reference frame. Earlier
    // placeholders (a 1×1 rect inside a 1000×1000 frame) scaled to a
    // sub-pixel dot in the page's top-left corner, but on some lib
    // versions the scrolledTo indicator briefly painted a visible chip
    // there. With a 0×0 rect at (-1,-1) inside a 1×1 frame the scaled
    // output is empty space well outside the page, so no stray yellow
    // shape can leak in.
    useEffect(() => {
        if (!scrollToPage?.page) return;
        // When a highlight-precise focus is ALSO requested (note-click flows
        // from the Analysis Dashboard fire both), defer to focusHighlightId's
        // effect. Otherwise the page-level scroll wins the race against the
        // highlight scroll and the viewer visibly lands at the page top
        // instead of the highlight.
        if (focusHighlightId?.id) return;

        let cancelled = false;
        let attempts = 0;
        // The Notes Hub mounts a fresh PdfAnnotator on every note click,
        // so highlighterRef is often still null on the first effect run while
        // PdfLoader fetches and parses the PDF. Without a retry the scroll
        // silently fails — user clicks a note and the viewer stays on page 1.
        const MAX_ATTEMPTS = 30;
        const INTERVAL_MS = 250;
        const INVISIBLE_RECT = { x1: -1, y1: -1, x2: -1, y2: -1, width: 1, height: 1 };

        const tryScroll = () => {
            if (cancelled) return;
            attempts += 1;
            if (highlighterRef.current) {
                const tempHighlight = {
                    id: `temp-${Date.now()}`,
                    position: {
                        pageNumber: scrollToPage.page,
                        boundingRect: INVISIBLE_RECT,
                        rects: [INVISIBLE_RECT],
                    },
                    content: { text: "" },
                    comment: { text: "", emoji: "" },
                };
                try {
                    highlighterRef.current.scrollTo(tempHighlight);
                    return;
                } catch (e) {
                    // The ref is set but pdfjs's internal viewer hasn't
                    // attached its `viewport` yet — typical for the first
                    // few hundred ms after mount. Retry until it's ready.
                    if (attempts < MAX_ATTEMPTS) {
                        setTimeout(tryScroll, INTERVAL_MS);
                        return;
                    }
                    console.warn("scrollTo gave up after retries", e);
                    return;
                }
            }
            if (attempts < MAX_ATTEMPTS) {
                setTimeout(tryScroll, INTERVAL_MS);
            }
        };
        tryScroll();
        return () => {
            cancelled = true;
        };
    }, [scrollToPage, focusHighlightId]);

    // ── Highlight-precise scroll (Notes Hub click-through) ───────────
    // When focusHighlightId changes, scroll to that real highlight and flash
    // its border for 1.5s so the eye can find it on the page.
    //
    // Two correctness rules this effect now respects:
    //
    //  1. **Read highlights via a ref, not via the deps array.** When the
    //     deps included `highlights`, every annotation list update (React
    //     Query refetch, cache hit, mirror-from-localStorage) cancelled the
    //     in-flight retry loop and started a fresh one. That meant
    //     `scrollTo()` could fire MULTIPLE times for one click — each call
    //     re-mounting react-pdf-highlighter's tip layer and triggering the
    //     "createRoot() on a container that has already been passed to
    //     createRoot()" warning. The flash-class toggle would also race
    //     itself off, so the user never saw the amber pulse complete.
    //
    //  2. **Idempotency via a signature latch.** The same (id, page,
    //     timestamp) tuple is treated as "already focused" so a stray
    //     re-render can't re-trigger scrollTo. Click the same note twice
    //     in a row → focusKey bumps in the parent → new timestamp → new
    //     signature → we re-flash. That's the intended path.
    useEffect(() => {
        if (!focusHighlightId?.id) return;
        const signature = `${focusHighlightId.id}|${focusHighlightId.page ?? ""}|${focusHighlightId.timestamp ?? ""}`;
        if (signature === lastFocusedSigRef.current) return;

        let cancelled = false;
        let attempts = 0;
        const MAX_ATTEMPTS = 30;     // 30 × 250ms = 7.5s grace window — covers
                                      // cross-doc deep links where the PDF is
                                      // still being fetched + parsed.
        const INTERVAL_MS = 250;
        let flashClear: ReturnType<typeof setTimeout> | undefined;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const fallbackToPage = () => {
            if (cancelled) return;
            const page = focusHighlightId.page;
            if (!page || !highlighterRef.current) return;
            const INVISIBLE_RECT = { x1: 0, y1: 0, x2: 1, y2: 1, width: 1000, height: 1000 };
            try {
                highlighterRef.current.scrollTo({
                    id: `temp-focus-fallback-${Date.now()}`,
                    position: { pageNumber: page, boundingRect: INVISIBLE_RECT, rects: [INVISIBLE_RECT] },
                    content: { text: "" },
                    comment: { text: "", emoji: "" },
                });
            } catch {
                /* ignore — viewer likely not ready yet */
            }
        };

        const flashTarget = (id: string) => {
            // Clear first → next-frame set → CSS animation restarts cleanly
            // even on a same-note re-click. Without the null reset, the
            // class is already on the wrapper and the animation does nothing.
            setFlashedId(null);
            requestAnimationFrame(() => {
                if (cancelled) return;
                setFlashedId(id);
                flashClear = setTimeout(() => setFlashedId(null), 1500);
            });
        };

        const tryFocus = () => {
            if (cancelled) return;
            attempts += 1;
            // Read FRESH highlights via the ref so we don't have to be in
            // the effect's deps. Highlights can arrive after this effect
            // started; the retry loop keeps polling them.
            const target = highlightsRef.current.find((h) => h.id === focusHighlightId.id);
            if (target && highlighterRef.current) {
                try {
                    highlighterRef.current.scrollTo(target);
                    lastFocusedSigRef.current = signature;
                    flashTarget(target.id);
                    return;
                } catch (e) {
                    if (attempts < MAX_ATTEMPTS) {
                        retryTimer = setTimeout(tryFocus, INTERVAL_MS);
                        return;
                    }
                    console.warn("focus scrollTo gave up after retries", e);
                    return;
                }
            }
            if (attempts < MAX_ATTEMPTS) {
                retryTimer = setTimeout(tryFocus, INTERVAL_MS);
            } else {
                console.warn(
                    `focusHighlightId ${focusHighlightId.id} not found after ${MAX_ATTEMPTS} attempts; falling back to page scroll`,
                );
                lastFocusedSigRef.current = signature;
                fallbackToPage();
            }
        };
        tryFocus();
        return () => {
            cancelled = true;
            if (flashClear) clearTimeout(flashClear);
            if (retryTimer) clearTimeout(retryTimer);
        };
    }, [focusHighlightId]);

    return (
        <div className={cn("pdf-annotator-wrapper relative", selectionMode === "area" && "draw-mode")}>
            {/* Mode Toggle UI */}
            <div className="absolute top-4 right-4 z-[100] flex bg-white/90 backdrop-blur shadow-xl border border-slate-200 p-1 rounded-full animate-in slide-in-from-top-4 duration-500">
                <button
                    className={cn(
                        "px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all",
                        selectionMode === "text" ? "bg-primary text-white shadow-md scale-105" : "text-slate-500 hover:text-primary"
                    )}
                    onClick={() => setSelectionMode("text")}
                >
                    Text
                </button>
                <button
                    className={cn(
                        "px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all",
                        selectionMode === "area" ? "bg-primary text-white shadow-md scale-105" : "text-slate-500 hover:text-primary"
                    )}
                    onClick={() => setSelectionMode("area")}
                >
                    Draw
                </button>
            </div>

            <PdfLoader
                url={url}
                beforeLoad={
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
                        <Loader2 className="w-8 h-8 animate-spin" />
                        <span className="text-sm font-medium">Loading Smart Viewer...</span>
                    </div>
                }
                errorMessage={
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-red-500">
                        <AlertCircle className="w-8 h-8" />
                        <span className="text-sm font-medium">Failed to load PDF</span>
                    </div>
                }
            >
                {(pdfDocument) => (
                    <PdfHighlighter
                        pdfDocument={pdfDocument}
                        enableAreaSelection={(event) => selectionMode === "area" || event.altKey}
                        onScrollChange={() => { }}
                        scrollRef={(ref) => { scrollViewerRef.current = ref; }}
                        onSelectionFinished={(
                            position,
                            content,
                            hideTipAndSelection,
                            transformSelection
                        ) => (
                            <div className="anno-tip-container animate-in fade-in zoom-in-95 duration-200">
                                <textarea
                                    autoFocus
                                    className="anno-tip-input"
                                    placeholder="Annotate selection..."
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" && !e.shiftKey) {
                                            e.preventDefault();
                                            const val = (e.target as HTMLTextAreaElement).value;
                                            if (val.trim()) {
                                                addHighlight({
                                                    content,
                                                    position,
                                                    comment: { text: val, emoji: "" },
                                                });
                                            }
                                            hideTipAndSelection();
                                        }
                                    }}
                                />
                                <div className="flex justify-end gap-1 px-2 pb-2">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 text-[10px] uppercase font-bold text-slate-500"
                                        onClick={hideTipAndSelection}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        size="sm"
                                        className="h-7 text-[10px] uppercase font-bold"
                                        onClick={() => {
                                            const input = document.querySelector('.anno-tip-input') as HTMLTextAreaElement;
                                            if (input && input.value.trim()) {
                                                addHighlight({
                                                    content,
                                                    position,
                                                    comment: { text: input.value, emoji: "" },
                                                });
                                            }
                                            hideTipAndSelection();
                                        }}
                                    >
                                        Save
                                    </Button>
                                </div>
                            </div>
                        )}
                        highlightTransform={(
                            highlight,
                            index,
                            setTip,
                            hideTip,
                            viewportToScaled,
                            screenshot,
                            isScrolledTo
                        ) => {
                            const isTextHighlight = !Boolean(highlight.content.image);
                            const isFlashed = flashedId === highlight.id;

                            const component = isTextHighlight ? (
                                <Highlight
                                    isScrolledTo={isScrolledTo}
                                    position={highlight.position}
                                    comment={highlight.comment}
                                />
                            ) : (
                                <AreaHighlight
                                    isScrolledTo={isScrolledTo}
                                    highlight={highlight}
                                    onChange={() => { }}
                                />
                            );

                            return (
                                <Popup
                                    key={index}
                                    popupContent={
                                        <div className="anno-popup-card animate-in fade-in slide-in-from-bottom-1 duration-200">
                                            <div className="anno-popup-header">
                                                <MessageSquare className="w-3 h-3 text-primary" />
                                                <span>Observation</span>
                                            </div>
                                            <div className="anno-popup-content">{highlight.comment.text}</div>
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                className="w-full h-7 text-[10px] font-bold gap-1 mt-2"
                                                onClick={() => deleteHighlight(highlight.id)}
                                            >
                                                <Trash2 className="w-3 h-3" /> Remove Note
                                            </Button>
                                        </div>
                                    }
                                    onMouseOver={(popupContent) =>
                                        setTip(highlight, (highlight) => popupContent)
                                    }
                                    onMouseOut={hideTip}
                                >
                                    {/*
                                      `display:contents` makes this wrapper invisible to layout —
                                      the AreaHighlight / Highlight inside positions itself absolutely
                                      against the PDF page, and the Popup anchors to that real
                                      bounding box instead of to a stray block at (0,0) in the
                                      parent's normal flow.
                                    */}
                                    <div
                                        className={cn(isFlashed && FLASH_KEY)}
                                        style={{ display: "contents" }}
                                    >
                                        {component}
                                    </div>
                                </Popup>
                            );
                        }}
                        highlights={[...highlights, ...externalHighlights]}
                        ref={(ref) => (highlighterRef.current = ref)}
                    />
                )}
            </PdfLoader>
        </div>
    );
};

export default PdfAnnotator;
