import React, { useState, useCallback, useRef, useEffect } from "react";
import {
    PdfLoader,
    PdfHighlighter,
    Highlight,
    Popup,
    AreaHighlight,
} from "react-pdf-highlighter";
import { Trash2, MessageSquare, Loader2, AlertCircle, X } from "lucide-react";
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
    docId: string;
    onAnnotationChange?: (highlights: IHighlight[]) => void;
    scrollToPage?: number;
}

const PdfAnnotator: React.FC<PdfAnnotatorProps> = ({ url, docId, onAnnotationChange, scrollToPage }) => {
    const [highlights, setHighlights] = useState<IHighlight[]>([]);
    const [selectionMode, setSelectionMode] = useState<"text" | "area">("text");
    const highlighterRef = useRef<any>(null);
    const scrollViewerRef = useRef<any>(null);

    // Load highlights from localStorage for persistence (optional but good for UX)
    useEffect(() => {
        const saved = localStorage.getItem(`highlights_${docId}`);
        if (saved) {
            try {
                setHighlights(JSON.parse(saved));
            } catch (e) {
                console.error("Failed to load highlights", e);
            }
        } else {
            setHighlights([]);
        }
    }, [docId]);

    // Save to localStorage whenever highlights change
    useEffect(() => {
        localStorage.setItem(`highlights_${docId}`, JSON.stringify(highlights));
        if (onAnnotationChange) onAnnotationChange(highlights);
    }, [highlights, docId, onAnnotationChange]);

    const getNextId = () => String(Math.random()).slice(2);

    const addHighlight = (highlight: Omit<IHighlight, "id">) => {
        setHighlights((prev) => [{ ...highlight, id: getNextId() }, ...prev]);
    };

    const deleteHighlight = (id: string) => {
        setHighlights((prev) => prev.filter((h) => h.id !== id));
    };

    // Scroll to page logic
    useEffect(() => {
        if (scrollToPage && highlighterRef.current) {
            console.log("Scrolling to page:", scrollToPage);
            // Create a phantom highlight to trigger scroll
            const phantomHighlight = {
                position: {
                    pageNumber: scrollToPage,
                    boundingRect: { x1: 0, y1: 0, x2: 0, y2: 0, width: 0, height: 0 },
                    rects: []
                },
                content: {},
                comment: { text: '' }
            };
            highlighterRef.current.scrollTo(phantomHighlight);
        }
    }, [scrollToPage]);

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
                                    {component}
                                </Popup>
                            );
                        }}
                        highlights={highlights}
                        ref={(ref) => (highlighterRef.current = ref)}
                    />
                )}
            </PdfLoader>
        </div>
    );
};

export default PdfAnnotator;
