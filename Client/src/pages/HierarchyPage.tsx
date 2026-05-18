import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { ReactFlowHierarchy } from "@/features/hierarchy/components/ReactFlowHierarchy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, Calendar, MapPin, ArrowRight, Filter, X, FileText, Maximize2, Minimize2, User, Maximize, ShieldCheck, AlertCircle, MessageSquare, Plus, StickyNote, Loader2, Zap } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import DocChat from "@/features/analysis/components/DocChat";
import PdfAnnotator from "@/features/analysis/components/PdfAnnotator";
import NotesSummary, { type NoteJumpTarget } from "@/features/notes/components/NotesSummary";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { API_BASE_URL } from "@/lib/api";
import { landwiseApi } from "@/lib/landwise-api";
import { useDebouncedNoteSaver } from "@/hooks/useDebouncedNoteSaver";
import { toast } from "sonner";

export default function HierarchyPage() {
    const [searchParams] = useSearchParams();
    const requestId = searchParams.get("requestId");
    const surveyNumber = searchParams.get("surveyNumber");
    const limit = searchParams.get("limit");
    // Optional — when provided, PdfAnnotator persists notes to the server and
    // the Notes Summary cockpit becomes available. Pages that don't have a
    // parcel context (e.g. legacy /verify flow) still work via localStorage,
    // but we ALSO auto-resolve parcelId from request_id below so the Notes
    // Cockpit becomes available without the user having to pass it manually.
    const parcelIdFromUrl = searchParams.get("parcelId");
    const [resolvedParcelId, setResolvedParcelId] = useState<string | null>(parcelIdFromUrl);
    const parcelId = resolvedParcelId;
    // Deep-link params used by the Notes Cockpit (LegalDashboard) to land the
    // user directly on a specific deed + highlight when they click a note.
    const deepLinkDocNo = searchParams.get("docNo");
    const deepLinkNoteId = searchParams.get("noteId");
    const deepLinkPage = searchParams.get("page");

    const [loading, setLoading] = useState(true);
    const [statusIndex, setStatusIndex] = useState(0);
    const loadingMessages = [
        "Initializing Neural Pipeline...",
        "Scanning EC PDF structures...",
        "Extracting transaction lineage...",
        "Cross-referencing deed metadata...",
        "Generating relational hierarchy...",
        "Optimizing visualization graph..."
    ];

    useEffect(() => {
        if (loading) {
            const interval = setInterval(() => {
                setStatusIndex((prev) => (prev + 1) % loadingMessages.length);
            }, 2500);
            return () => clearInterval(interval);
        }
    }, [loading]);
    const [timeline, setTimeline] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<any[]>([]);
    const [selectedDoc, setSelectedDoc] = useState<{ docNo: string, url: string, data?: any, validation?: any } | null>(null);
    const [panelOpen, setPanelOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<"summary" | "chat" | "annotations">("summary");
    const [isNotesVisible, setIsNotesVisible] = useState(false);
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [verifyingDoc, setVerifyingDoc] = useState(false);
    const [verificationResult, setVerificationResult] = useState<any>(null);
    const [pdfAnnotations, setPdfAnnotations] = useState<any[]>([]);
    const [validatingSingle, setValidatingSingle] = useState(false);
    const [scrollToPage, setScrollToPage] = useState<{ page: number, timestamp: number } | undefined>(undefined);
    // Triggers a precise scroll-to-highlight + flash animation in PdfAnnotator
    // when a note is clicked from the annotations panel or the cockpit.
    const [focusHighlightId, setFocusHighlightId] = useState<{ id: string; page?: number; timestamp: number } | undefined>(undefined);
    const [notesSummaryOpen, setNotesSummaryOpen] = useState(false);

    // Auto-resolve parcelId from request_id when the URL didn't carry one.
    // Without this, opening /hierarchy from /verify would not have a parcel
    // context and the Notes Cockpit + server-side note persistence would be
    // unavailable.
    useEffect(() => {
        if (parcelIdFromUrl || !requestId) return;
        let cancelled = false;
        (async () => {
            try {
                const data = await landwiseApi.getParcelByRequest(requestId);
                if (!cancelled && data?.parcel_id) {
                    setResolvedParcelId(data.parcel_id);
                }
            } catch (e) {
                // 404 is expected for analyses that pre-date the parcel
                // tracking — fail silently, the page still works.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [requestId, parcelIdFromUrl]);

    const debouncedSaveNote = useDebouncedNoteSaver();

    useEffect(() => {
        const fetchInitialData = async () => {
            if (!requestId) {
                setError("Missing required parameter: requestId");
                setLoading(false);
                return;
            }

            try {
                const API_URL = API_BASE_URL;

                // Choose endpoint based on surveyNumber presence
                const timelineUrl = surveyNumber
                    ? `${API_URL}/api/v1/search-survey-timeline`
                    : `${API_URL}/api/v1/get-global-hierarchy/${requestId}`;

                const timelineInit = surveyNumber
                    ? {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            survey_number: surveyNumber,
                            request_id: requestId,
                            limit: limit === "all" || !limit ? null : parseInt(limit),
                        })
                    }
                    : { method: "GET" };

                // Fetch Timeline and Validation Results in parallel
                const [timelineResp, resultsResp] = await Promise.all([
                    fetch(timelineUrl, timelineInit),
                    fetch(`${API_URL}/api/v1/get-validation-results/${requestId}`)
                ]);

                if (!timelineResp.ok) throw new Error(`Timeline fetch failed: ${timelineResp.status}`);

                const timelineJson = await timelineResp.json();
                let timelineData = timelineJson.body?.response?.timeline || timelineJson.timeline;

                if (!timelineData) throw new Error("Failed to load timeline data");

                if (resultsResp.ok) {
                    const resultsData = await resultsResp.json();
                    setResults(resultsData);
                }

                // Fetch existing notes and merge them
                try {
                    const notesResp = await fetch(`${API_URL}/api/v1/get-node-notes`);
                    if (notesResp.ok) {
                        const notes = await notesResp.json();
                        timelineData.react_flow_data.nodes = timelineData.react_flow_data.nodes.map((node: any) => ({
                            ...node,
                            data: {
                                ...node.data,
                                notes: notes[node.data.document_number] || ""
                            }
                        }));
                    }
                } catch (e) {
                    console.error("Failed to load notes:", e);
                }

                setTimeline(timelineData);
            } catch (err) {
                setError(err instanceof Error ? err.message : "An unknown error occurred");
            } finally {
                setLoading(false);
            }
        };

        fetchInitialData();
    }, [requestId, surveyNumber, limit]);

    // Deep-link landing: once the timeline data is loaded, if the URL points
    // at a specific doc/note (from a Notes Cockpit click), open that deed in
    // the side panel and scroll to the highlight. We guard with a ref-style
    // boolean so this only fires once per page load.
    const [deepLinkApplied, setDeepLinkApplied] = useState(false);
    useEffect(() => {
        if (deepLinkApplied) return;
        if (!timeline || !deepLinkDocNo) return;
        // Use the existing node-click pipeline so the panel opens with proper
        // metadata + url, then schedule the focus pulse after PdfAnnotator has
        // had a chance to fetch the doc's annotations from the server.
        handleNodeClick(deepLinkDocNo);
        const t = setTimeout(() => {
            // Land on the annotations tab — the notes panel now sits in the
            // top half and leaves the PDF visible underneath, so the user
            // sees both the source note and the highlight flash.
            setActiveTab(deepLinkNoteId ? "annotations" : "summary");
            setPanelOpen(true);
            const pageHint = deepLinkPage ? parseInt(deepLinkPage) : NaN;
            const ts = Date.now();
            if (!Number.isNaN(pageHint)) {
                setScrollToPage({ page: pageHint, timestamp: ts });
            }
            if (deepLinkNoteId) {
                setFocusHighlightId({
                    id: deepLinkNoteId,
                    page: Number.isNaN(pageHint) ? undefined : pageHint,
                    timestamp: ts,
                });
            }
        }, 700);
        setDeepLinkApplied(true);
        return () => clearTimeout(t);
        // handleNodeClick is referentially stable enough for this purpose; we
        // intentionally exclude it to avoid re-triggering the deep-link.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timeline, deepLinkDocNo, deepLinkPage, deepLinkNoteId, deepLinkApplied]);

    const handleUpdateNodeNotes = useCallback(
        (docNo: string, notes: string) => {
            if (!timeline) return;

            const updatedData = {
                ...timeline,
                react_flow_data: {
                    ...timeline.react_flow_data,
                    nodes: timeline.react_flow_data.nodes.map((node: any) =>
                        node.data.document_number === docNo
                            ? { ...node, data: { ...node.data, notes } }
                            : node,
                    ),
                },
            };

            setTimeline(updatedData);
            debouncedSaveNote(docNo, notes);
        },
        [timeline, debouncedSaveNote],
    );

    const handleVerifySupportingDoc = async () => {
        if (!uploadFile || !selectedDoc?.data) return;

        setVerifyingDoc(true);
        try {
            const formData = new FormData();
            formData.append("file", uploadFile);
            formData.append("metadata", JSON.stringify(selectedDoc.data));

            const API_URL = API_BASE_URL;
            const response = await fetch(`${API_URL}/api/v1/verify-supporting-doc`, {
                method: "POST",
                body: formData,
            });

            if (!response.ok) throw new Error("Verification failed");
            const data = await response.json();
            setVerificationResult(data);
        } catch (e) {
            console.error(e);
            setVerificationResult({ verified: false, status: "Error", reason: "Connection failed" });
        } finally {
            setVerifyingDoc(false);
        }
    };

    const handleSinglePdfMatch = async () => {
        if (!selectedDoc || !requestId) return;

        setValidatingSingle(true);
        try {
            const API_URL = API_BASE_URL;

            // selectedDoc.url is usually like "[API_BASE_URL]/files/validate/ID/docs/file.pdf"
            // We need the relative path from /files/
            let relativePath = selectedDoc.url;
            if (relativePath.includes("/files/")) {
                relativePath = relativePath.split("/files/")[1];
            }

            const response = await fetch(`${API_URL}/api/v1/validate-single`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    request_id: requestId,
                    doc_no: selectedDoc.docNo,
                    file_path: relativePath
                }),
            });

            if (!response.ok) throw new Error("Validation failed");
            const data = await response.json();

            // Update selectedDoc with new validation results
            setSelectedDoc(prev => prev ? { ...prev, validation: data.validation_result } : null);

            // Update the results state as well so it persists if we re-click the node
            setResults(prev => {
                const existingIndex = prev.findIndex(r => r.document_number === selectedDoc.docNo);
                if (existingIndex >= 0) {
                    const updated = [...prev];
                    updated[existingIndex] = { ...updated[existingIndex], validation_result: data.validation_result };
                    return updated;
                } else {
                    return [...prev, { document_number: selectedDoc.docNo, validation_result: data.validation_result, file_path: relativePath }];
                }
            });

        } catch (e) {
            console.error("Single validation error:", e);
        } finally {
            setValidatingSingle(false);
        }
    };

    const handleNodeClick = useCallback((docNo: string, nodeData?: any) => {
        setVerificationResult(null);
        setUploadFile(null);
        setActiveTab("summary");
        setPdfAnnotations([]); // Reset annotations for new doc
        setScrollToPage(undefined); // Reset scroll position

        const normalize = (s: string) => s ? s.replace(/\s+/g, '').replace(/[-\/]/g, '').toLowerCase() : '';
        const normDocNo = normalize(docNo);

        // Locate node & path. If ReactFlow passed us nodeData, that is the exact clicked node.
        const nodeFromFlow = nodeData ? { data: nodeData } : null;
        const node = nodeFromFlow || timeline?.react_flow_data.nodes.find(
            (n: any) => n.data?.document_number && normalize(n.data.document_number) === normDocNo
        );
        let path = timeline?.doc_map?.[docNo] || node?.data?.pdf_url;

        // Prefer full transaction data but always merge in richer node survey info (incl. KIDE) and area
        const allTxs = timeline?.all_transactions || [];
        const tx = allTxs.find((t: any) => normalize(t.document_number) === normDocNo);
        const nodeSurvey =
            node?.data?.survey_number ||
            node?.data?.KIDE ||
            node?.data?.kide;
        const nodeArea = node?.data?.sq_feet || node?.data?.square_feet;

        const txData = tx
            ? {
                ...tx,
                // Ensure subdivided survey (e.g. 13/3) from node wins over flat base value
                survey_number: nodeSurvey || tx.survey_number,
                square_feet: nodeArea || tx.square_feet,
            }
            : node?.data;

        // Find validation results (with relaxed normalization)
        let resultItem = results.find(r => r.document_number === docNo);
        if (!resultItem) {
            const normalizedDoc = normDocNo;
            resultItem = results.find(r => normalize(r.document_number) === normalizedDoc);
        }

        const validation = resultItem?.validation_result;
        if (!path && resultItem?.file_path) {
            const API_URL = API_BASE_URL;
            path = `${API_URL}/files/${resultItem.file_path.replace(/\\/g, "/")}`;
        }

        if (path || txData) {
            setSelectedDoc({ docNo, url: path || "", data: txData, validation });
            setPanelOpen(true);
        }
    }, [timeline, results]);

    /**
     * In-document note click — pulses the highlight rectangle and scrolls
     * the PDF to it. We deliberately DO NOT also call setScrollToPage here:
     * react-pdf-highlighter's scrollTo() accepts a Highlight and renders a
     * temporary yellow indicator at its boundingRect. Calling it with our
     * page-only stub (boundingRect = {x1:10,y1:10,x2:90,y2:30}) paints a
     * misplaced yellow stripe scaled to ~80% of the page width — exactly
     * the "wrong-position highlight" symptom users were seeing. The
     * focusHighlightId path uses the note's REAL boundingRect, so it both
     * navigates to the right page AND renders the indicator at the actual
     * selected region.
     */
    const handleFocusLocalNote = useCallback((anno: any) => {
        const page = anno?.position?.pageNumber;
        if (!anno?.id) return;
        setFocusHighlightId({ id: anno.id, timestamp: Date.now() });
        toast.info(`Jumping to page ${page ?? "?"}`, {
            description: anno.comment?.text || anno.content?.text || "",
            duration: 1800,
        });
    }, []);

    /**
     * Notes Cockpit click-through handler. Closes the cockpit, loads the right
     * PDF if we're not already on it, then triggers PdfAnnotator's
     * focusHighlightId so the highlight scrolls into view. Lands on the
     * "annotations" tab so the user sees both the note + the PDF flash —
     * the notes panel and the PDF are now stacked (top + bottom), neither
     * covers the other.
     */
    const handleJumpToNote = useCallback((target: NoteJumpTarget) => {
        setNotesSummaryOpen(false);
        const stripPdf = (s: string) => s.replace(/\.pdf$/i, "");
        const sameDoc =
            !!selectedDoc?.docNo &&
            (stripPdf(selectedDoc.docNo) === stripPdf(target.doc_no) ||
                stripPdf(target.doc_no).includes(stripPdf(selectedDoc.docNo)) ||
                stripPdf(selectedDoc.docNo).includes(stripPdf(target.doc_no)));

        if (!sameDoc) {
            handleNodeClick(stripPdf(target.doc_no));
        }
        setTimeout(() => {
            setActiveTab("annotations");
            setPanelOpen(true);
            const ts = Date.now();
            setScrollToPage({ page: target.note.page_number, timestamp: ts });
            // page hint lets PdfAnnotator fall back to a page-level scroll
            // when the highlight id can't be resolved within the retry window
            // (slow PDF/server loads on cross-doc deep links).
            setFocusHighlightId({
                id: target.note.id,
                page: target.note.page_number,
                timestamp: ts,
            });
        }, sameDoc ? 50 : 600);
    }, [handleNodeClick, selectedDoc]);

    const getFullSurveyNumber = (data: any): string | undefined => {
        if (!data) return undefined;

        // Highest priority: geospatial key (often already like "13/3")
        const kide =
            data.kide ||
            data.KIDE;

        const base =
            kide ||
            data.survey_number ||
            data.survey_no ||
            data.Survey_No ||
            data.SURVEY_NO;

        const sub =
            data.sub_division ||
            data.subdivision ||
            data.sub_div ||
            data.sub_div_no ||
            data.subDivision;

        if (!base) return undefined;
        const baseStr = String(base);

        // If base already carries subdivision (e.g. "13/3"), do not append anything.
        if (baseStr.includes("/") || !sub) return baseStr;

        return `${baseStr}/${sub}`;
    };

    const handleOpenInMap = useCallback((docNoOverride?: string) => {
        const targetDocNo = docNoOverride || selectedDoc?.docNo;
        if (!targetDocNo) return;

        const normDoc = (s: string) => s ? s.replace(/\s+/g, '').replace(/[-\/]/g, '').toLowerCase() : '';
        const currentDocNoNorm = normDoc(targetDocNo);

        // Find metadata for the specific document if we're using an override
        let docData = selectedDoc?.data;
        if (docNoOverride && timeline?.all_transactions) {
            const tx = timeline.all_transactions.find((t: any) => normDoc(t.document_number) === currentDocNoNorm);
            if (tx) docData = tx;
        }

        // Find ALL survey numbers associated with this document in the registry to highlight all relevant areas
        const surveysForThisDoc = new Set<string>();

        // 1. Scan all transactions in the timeline for this document
        if (timeline?.all_transactions) {
            timeline.all_transactions.forEach((tx: any) => {
                if (normDoc(tx.document_number) === currentDocNoNorm) {
                    const sn = getFullSurveyNumber(tx);
                    if (sn) {
                        // If sn itself is comma-separated, split it
                        sn.split(',').forEach((s: string) => {
                            const trimmed = s.trim();
                            if (trimmed) surveysForThisDoc.add(trimmed);
                        });
                    }
                }
            });
        }

        // 2. Supplement from validation results (comparisons) which might have additional matches
        const resultItem = results.find(r => normDoc(r.document_number) === currentDocNoNorm);
        if (resultItem?.validation_result?.comparisons) {
            resultItem.validation_result.comparisons.forEach((comp: any) => {
                // Look for survey number related fields
                if (comp.field.toLowerCase().includes("survey")) {
                    const val = comp.metadata_value || comp.ec_value;
                    if (val && typeof val === 'string') {
                        val.split(',').forEach((s: string) => {
                            const trimmed = s.trim();
                            if (trimmed) surveysForThisDoc.add(trimmed);
                        });
                    }
                }
            });
        }

        // Join both into a comma-separated string for the MapView's multi-highlight support
        const allSurveys = Array.from(surveysForThisDoc).join(', ');
        const sn = allSurveys || (docData ? getFullSurveyNumber(docData) : undefined);

        if (!sn || !docData) return;

        const meta = {
            surveyNumber: sn,
            executant: docData.executant,
            claimant: docData.claimant,
            nature: docData.nature,
            landType: docData.nature_of_land,
            area: docData.square_feet || docData.sq_feet || "N/A",
            docNo: docData.document_number,
            date: docData.date
        };

        // Save metadata to sessionStorage to avoid passing it in the URL
        if (typeof window !== "undefined") {
            sessionStorage.setItem(`map_meta_${sn}`, JSON.stringify(meta));
            const url = `/map?surveyNumber=${encodeURIComponent(String(sn))}`;
            window.open(url, "_blank");
        }
    }, [selectedDoc, timeline, results]);

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-50 p-6 flex flex-col gap-6">
                {/* Progress Header */}
                <div className="w-full max-w-4xl mx-auto space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                                <Loader2 className="w-6 h-6 text-primary animate-spin" />
                            </div>
                            <div>
                                <h1 className="text-xl font-black text-slate-900 tracking-tight">Analyzing Document Hierarchy</h1>
                                <p className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                                    AI Engine: {loadingMessages[statusIndex]}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {loadingMessages.map((_, i) => (
                                <div
                                    key={i}
                                    className={cn(
                                        "w-2 h-2 rounded-full transition-all duration-500",
                                        i <= statusIndex ? "bg-primary scale-110 shadow-[0_0_8px_rgba(59,130,246,0.6)]" : "bg-slate-200"
                                    )}
                                />
                            ))}
                        </div>
                        <Badge variant="outline" className="bg-white px-4 py-1.5 border-slate-200 shadow-sm text-primary font-bold min-w-[120px] justify-center">
                            STEP {statusIndex + 1}/{loadingMessages.length}
                        </Badge>
                    </div>

                    {/* Modern Progress Bar */}
                    <div className="space-y-2">
                        <div className="flex justify-between text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                            <span>Extraction Engine Status</span>
                            <span className="text-primary italic">{Math.round(((statusIndex + 1) / loadingMessages.length) * 100)}% Optimized</span>
                        </div>
                        <div className="h-3 w-full bg-slate-200 rounded-full overflow-hidden border p-0.5 border-slate-300/20">
                            <div
                                className="h-full bg-gradient-to-r from-primary via-blue-400 to-indigo-500 rounded-full transition-all duration-1000 shadow-[0_0_12px_rgba(59,130,246,0.5)]"
                                style={{ width: `${((statusIndex + 1) / loadingMessages.length) * 100}%` }}
                            />
                        </div>
                    </div>
                </div>

                {/* Skeleton Hierarchy Layout */}
                <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-6 max-w-7xl mx-auto w-full">
                    <div className="md:col-span-2 bg-white rounded-3xl border border-slate-100 shadow-sm p-8 relative overflow-hidden">
                        {/* Fake Nodes Connection Lines */}
                        <svg className="absolute inset-0 w-full h-full opacity-[0.03] pointer-events-none">
                            <path d="M 400 100 L 400 200 M 400 200 L 200 300 M 400 200 L 600 300" stroke="currentColor" strokeWidth="4" fill="none" />
                        </svg>

                        <div className="flex flex-col items-center gap-12 pt-10">
                            {/* Root Node Skeleton */}
                            <div className="w-48 h-24 rounded-2xl border-4 border-slate-50 bg-slate-50/50 flex flex-col p-4 gap-2">
                                <div className="h-3 w-2/3 bg-slate-200 rounded animate-pulse" />
                                <div className="h-2 w-full bg-slate-100 rounded animate-pulse" />
                                <div className="h-2 w-1/2 bg-slate-100 rounded animate-pulse" />
                            </div>

                            <div className="flex gap-20">
                                {/* Child Node 1 */}
                                <div className="w-40 h-20 rounded-xl bg-slate-50/30 border border-slate-100 flex flex-col p-3 gap-2">
                                    <div className="h-2.5 w-1/2 bg-green-100 rounded animate-pulse" />
                                    <div className="h-2 w-full bg-slate-100 rounded animate-pulse" />
                                </div>
                                {/* Child Node 2 */}
                                <div className="w-40 h-20 rounded-xl bg-slate-50/30 border border-slate-100 flex flex-col p-3 gap-2">
                                    <div className="h-2.5 w-1/2 bg-red-100 rounded animate-pulse" />
                                    <div className="h-2 w-full bg-slate-100 rounded animate-pulse" />
                                </div>
                            </div>
                        </div>

                        {/* Scanning Overlay Effect */}
                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary/40 to-transparent shadow-[0_0_15px_rgba(59,130,246,0.8)] animate-scan-line-slow" />
                    </div>

                    {/* Metadata Panel Skeleton */}
                    <div className="space-y-6">
                        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6 space-y-4">
                            <div className="h-4 w-1/3 bg-slate-100 rounded animate-pulse" />
                            <div className="space-y-2">
                                <div className="h-10 w-full bg-slate-50 rounded-xl animate-pulse" />
                                <div className="h-10 w-full bg-slate-50 rounded-xl animate-pulse" />
                            </div>
                            <div className="pt-4 border-t border-slate-50">
                                <div className="h-32 w-full bg-slate-50 rounded-2xl animate-pulse" />
                            </div>
                        </div>

                        <div className="bg-primary/5 rounded-3xl border border-primary/10 p-6 flex flex-col items-center justify-center gap-3">
                            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                                <Zap className="w-6 h-6 text-primary animate-pulse" />
                            </div>
                            <p className="text-[10px] font-black text-primary uppercase tracking-widest text-center">
                                Optimizing Analysis Path...
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 p-4">
                <AlertCircle className="w-16 h-16 text-destructive mb-4" />
                <h1 className="text-2xl font-bold mb-2">Error Loading Hierarchy</h1>
                <p className="text-slate-600 mb-6">{error}</p>
                <Badge variant="outline" className="text-slate-400">Request ID: {requestId}</Badge>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-50 p-6">
            <Card className="border-primary/10 shadow-2xl h-[calc(100vh-48px)] flex flex-col overflow-hidden">
                <CardHeader className="bg-white border-b py-4 px-6 flex flex-row items-center justify-between space-y-0">
                    <div className="flex flex-col">
                        <CardTitle className="text-2xl font-black tracking-tight flex items-center gap-3">
                            {surveyNumber ? `Survey Lineage: ${surveyNumber}` : "Global Property Timeline"}
                        </CardTitle>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex gap-2 mr-4 px-4 py-1.5 bg-slate-50 rounded-full border">
                            <div className="flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
                                <span className="text-xs font-bold text-slate-600 uppercase">Sale</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                                <span className="text-xs font-bold text-slate-600 uppercase">Mortgage</span>
                            </div>
                        </div>
                        <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 px-3 py-1">
                            {timeline?.all_transactions?.length || 0} Transactions
                        </Badge>
                        {parcelId && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5 border-amber-200 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                                onClick={() => setNotesSummaryOpen(true)}
                                title="View every note across every PDF for this parcel"
                            >
                                <StickyNote className="w-3.5 h-3.5" />
                                Notes Cockpit
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            className="ml-2"
                            onClick={() => window.close()}
                        >
                            Close Tab
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="p-0 flex-1 relative bg-white overflow-hidden">
                    <ResizablePanelGroup direction="horizontal" className="h-full w-full">
                        <ResizablePanel defaultSize={panelOpen ? 60 : 100} minSize={30}>
                            <div className="w-full h-full relative">
                                {timeline && (
                                    <ReactFlowHierarchy
                                        data={timeline.react_flow_data}
                                        onNodeClick={handleNodeClick}
                                    />
                                )}
                            </div>
                        </ResizablePanel>

                        {panelOpen && <ResizableHandle withHandle />}

                        {panelOpen && (
                            <ResizablePanel defaultSize={40} minSize={20}>
                                <div className="h-full border-l flex flex-col bg-slate-50">
                                    <div className="p-3 border-b bg-white flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <FileText className="w-4 h-4 text-primary" />
                                            <span className="font-bold text-sm truncate max-w-[150px]">{selectedDoc?.docNo}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className={cn(
                                                    "h-8 w-8 hover:bg-white/20 relative",
                                                    isNotesVisible ? "bg-amber-400 text-amber-950 shadow-inner" : ""
                                                )}
                                                onClick={() => setIsNotesVisible(!isNotesVisible)}
                                                title={isNotesVisible ? "Hide Notes" : "View/Add Notes"}
                                            >
                                                <StickyNote className={cn("w-4 h-4 transition-all duration-300", isNotesVisible ? "scale-110" : "")} />
                                                {!isNotesVisible && timeline?.react_flow_data.nodes.find((n: any) => n.data.document_number === selectedDoc?.docNo)?.data.notes && (
                                                    <span className="absolute top-1 right-1 w-2 h-2 bg-amber-400 rounded-full border border-primary" />
                                                )}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8"
                                                onClick={() => setPanelOpen(false)}
                                            >
                                                <X className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="flex bg-primary/5 p-1 mx-2 mt-2 rounded-lg border border-primary/10">
                                        <button
                                            className={cn(
                                                "flex-1 flex items-center justify-center gap-1.5 py-1 text-[10px] font-bold rounded-md transition-all",
                                                activeTab === "summary" ? "bg-white shadow-sm text-primary" : "text-slate-500 hover:text-primary/70"
                                            )}
                                            onClick={() => setActiveTab("summary")}
                                        >
                                            <FileText className="w-3 h-3" /> Summary
                                        </button>
                                        <button
                                            className={cn(
                                                "flex-1 flex items-center justify-center gap-1.5 py-1 text-[10px] font-bold rounded-md transition-all",
                                                activeTab === "annotations" ? "bg-white shadow-sm text-primary" : "text-slate-500 hover:text-primary/70"
                                            )}
                                            onClick={() => setActiveTab("annotations")}
                                        >
                                            <StickyNote className="w-3 h-3" /> Notes
                                        </button>
                                    </div>

                                    <div className="flex-1 overflow-hidden flex flex-col relative bg-muted/20">
                                        {activeTab === "chat" && selectedDoc && (
                                            // z-[150] sits above PdfAnnotator's TEXT/DRAW toggle (z-100) and the
                                            // Single-PDF-Matching button (z-30) on the panel below, so those
                                            // controls don't bleed through the chat overlay. They remain in the
                                            // DOM and reappear automatically when the chat tab is closed.
                                            <div className="absolute inset-x-0 top-0 bottom-0 z-[150] animate-in slide-in-from-right duration-300">
                                                <DocChat
                                                    docNo={selectedDoc.docNo}
                                                    requestId={requestId || ""}
                                                    onClose={() => setActiveTab("summary")}
                                                    onPageClick={(page) => setScrollToPage({ page, timestamp: Date.now() })}
                                                />
                                            </div>
                                        )}

                                        {/* Notes panel — sits in the SAME slot as the metadata summary
                                            so the PDF below stays visible. Previously this was an
                                            `absolute inset-0` overlay that covered the PDF, which
                                            meant clicking a note scrolled the PDF underneath but the
                                            user couldn't see it happen. */}
                                        {activeTab === "annotations" && selectedDoc && (
                                            <div className="bg-white border-b shadow-sm z-10 max-h-[60%] flex flex-col p-4 animate-in slide-in-from-top-2 duration-200">
                                                <div className="flex items-center justify-between mb-4">
                                                    <h3 className="text-xs font-extra-bold uppercase tracking-tighter text-slate-400">
                                                        PDF Annotations &middot; {pdfAnnotations.length}
                                                    </h3>
                                                    <div className="flex items-center gap-1">
                                                        {parcelId && (
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-6 text-[10px] font-bold gap-1 text-primary hover:bg-primary/5"
                                                                onClick={() => setNotesSummaryOpen(true)}
                                                                title="See notes across every PDF for this parcel"
                                                            >
                                                                <StickyNote className="w-3 h-3" />
                                                                Parcel Notes
                                                            </Button>
                                                        )}
                                                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setActiveTab("summary")}><X className="w-3 h-3" /></Button>
                                                    </div>
                                                </div>
                                                <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">
                                                    {pdfAnnotations.length === 0 ? (
                                                        <div className="flex flex-col items-center justify-center py-8 opacity-40 grayscale">
                                                            <StickyNote className="w-8 h-8 mb-2" />
                                                            <p className="text-[10px] font-medium">No highlights yet</p>
                                                            <p className="text-[10px] text-slate-400 mt-1 max-w-[180px] text-center leading-snug not-italic">
                                                                Select text on the PDF and add a note. It will appear here.
                                                            </p>
                                                        </div>
                                                    ) : (
                                                        pdfAnnotations.map((anno: any) => {
                                                            const pageNum = anno.position?.pageNumber;
                                                            return (
                                                                // Card-level click also jumps (whole row is a hit
                                                                // target), but the PAGE pill is the explicit, visible
                                                                // CTA — gradient-filled with an arrow so it's
                                                                // obviously interactive.
                                                                <Card
                                                                    key={anno.id}
                                                                    className="p-3 border-primary/5 hover:border-primary/30 hover:shadow-sm transition-all cursor-pointer bg-slate-50/50 group"
                                                                    onClick={() => handleFocusLocalNote(anno)}
                                                                    role="button"
                                                                    tabIndex={0}
                                                                    onKeyDown={(e) => {
                                                                        if (e.key === "Enter" || e.key === " ") {
                                                                            e.preventDefault();
                                                                            handleFocusLocalNote(anno);
                                                                        }
                                                                    }}
                                                                    title="Jump to this highlight in the PDF"
                                                                >
                                                                    <div className="flex flex-col gap-1">
                                                                        <div className="flex items-center justify-between">
                                                                            <button
                                                                                type="button"
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    handleFocusLocalNote(anno);
                                                                                }}
                                                                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-extra-bold uppercase tracking-wider bg-gradient-to-r from-violet-600 via-indigo-600 to-blue-600 text-white shadow-sm hover:shadow hover:scale-[1.03] active:scale-[0.97] transition-all"
                                                                                title={`Open page ${pageNum ?? "?"} in the PDF`}
                                                                            >
                                                                                <ArrowRight className="w-3 h-3" />
                                                                                PAGE {pageNum ?? "?"}
                                                                            </button>
                                                                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity">
                                                                                Click to jump
                                                                            </span>
                                                                        </div>
                                                                        {anno.content?.text && (
                                                                            <p className="text-[11px] font-extra-bold text-slate-800 mt-1 line-clamp-2">"{anno.content.text.slice(0, 80)}..."</p>
                                                                        )}
                                                                        <div className="flex items-start gap-2 mt-2 p-2 bg-white rounded-lg border border-slate-100">
                                                                            <MessageSquare className="w-3 h-3 text-primary shrink-0 mt-0.5" />
                                                                            <p className="text-[10px] text-slate-600 italic leading-snug">{anno.comment?.text}</p>
                                                                        </div>
                                                                    </div>
                                                                </Card>
                                                            );
                                                        })
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {/* Metadata / Summary Panel — shown only on the summary tab.
                                            On the annotations tab, the notes list (above) takes this
                                            slot instead, so the PDF stays visible underneath in both
                                            cases. */}
                                        <div className={cn(
                                            "bg-white border-b shadow-sm z-10 transition-all duration-300 overflow-y-auto custom-scrollbar",
                                            activeTab === "summary" ? "max-h-[60%] p-5 space-y-4" : "hidden"
                                        )}>
                                            {selectedDoc?.data ? (
                                                <>
                                                    <div className="flex items-center justify-between border-b pb-3 border-slate-50">
                                                        <div className="flex flex-col gap-1">
                                                            <Badge variant="outline" className="text-[10px] font-bold uppercase tracking-widest bg-primary/5 text-primary border-primary/20 w-fit">
                                                                {selectedDoc.data.nature || "Nature N/A"}
                                                            </Badge>
                                                            <h3 className="text-sm font-bold text-slate-900">{selectedDoc.docNo}</h3>
                                                        </div>
                                                        <div className="flex flex-col items-end gap-1">
                                                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-medium">
                                                                <Calendar className="w-3.5 h-3.5" />
                                                                <span>{selectedDoc.data.date || "Date N/A"}</span>
                                                            </div>
                                                            <div className="flex items-center gap-1.5 text-[10px] text-primary font-bold">
                                                                <MapPin className="w-3.5 h-3.5" />
                                                                <span>
                                                                    S.No: {getFullSurveyNumber(selectedDoc.data) || "N/A"}
                                                                </span>
                                                            </div>
                                                            {getFullSurveyNumber(selectedDoc.data) && (
                                                                <Button
                                                                    variant="outline"
                                                                    size="sm"
                                                                    className="mt-1 h-7 px-2 text-[10px] font-bold flex items-center gap-1"
                                                                    onClick={() => handleOpenInMap()}
                                                                >
                                                                    <MapPin className="w-3 h-3" />
                                                                    View on Map
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </div>

                                                    <div className="grid grid-cols-2 gap-5 py-1">
                                                        <div className="space-y-1.5 p-3 rounded-xl bg-slate-50/50 border border-slate-100">
                                                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                                                                <User className="w-3 h-3 text-slate-400" /> Executant
                                                            </span>
                                                            <p className="text-[12px] font-bold text-slate-800 leading-tight">
                                                                {selectedDoc.data.executant || "N/A"}
                                                            </p>
                                                            {selectedDoc.data.executant_relationship && (
                                                                <p className="text-[10px] text-slate-500 italic leading-tight border-l-2 border-slate-200 pl-2 mt-1">
                                                                    {selectedDoc.data.executant_relationship}
                                                                </p>
                                                            )}
                                                            {selectedDoc.data.executant_docs && (
                                                                <p className="text-[9px] text-primary font-medium mt-1 flex items-center gap-1">
                                                                    <ShieldCheck className="w-2.5 h-2.5" /> {selectedDoc.data.executant_docs}
                                                                </p>
                                                            )}
                                                        </div>
                                                        <div className="space-y-1.5 p-3 rounded-xl bg-slate-50/50 border border-slate-100">
                                                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                                                                <User className="w-3 h-3 text-slate-400" /> Claimant
                                                            </span>
                                                            <p className="text-[12px] font-bold text-slate-800 leading-tight">
                                                                {selectedDoc.data.claimant || "N/A"}
                                                            </p>
                                                            {selectedDoc.data.claimant_relationship && (
                                                                <p className="text-[10px] text-slate-500 italic leading-tight border-l-2 border-slate-200 pl-2 mt-1">
                                                                    {selectedDoc.data.claimant_relationship}
                                                                </p>
                                                            )}
                                                            {selectedDoc.data.claimant_docs && (
                                                                <p className="text-[9px] text-primary font-medium mt-1 flex items-center gap-1">
                                                                    <ShieldCheck className="w-2.5 h-2.5" /> {selectedDoc.data.claimant_docs}
                                                                </p>
                                                            )}
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center justify-between p-3 bg-primary/5 rounded-xl border border-primary/10">
                                                        <div className="flex items-center gap-2">
                                                            <Maximize className="w-4 h-4 text-primary shrink-0" />
                                                            <div className="flex flex-col">
                                                                <span className="text-[9px] font-bold text-primary/60 uppercase">Property Area</span>
                                                                <span className="text-xs font-bold text-slate-800">{selectedDoc.data.square_feet || selectedDoc.data.extent || 'N/A'}</span>
                                                            </div>
                                                        </div>
                                                        <div className="h-8 w-px bg-primary/10 mx-2" />
                                                        <div className="flex items-center gap-2 flex-1 justify-end">
                                                            <div className="flex flex-col items-end">
                                                                <span className="text-[9px] font-bold text-primary/60 uppercase">Land Nature</span>
                                                                <span className="text-xs font-bold text-slate-800 text-right">{selectedDoc.data.nature_of_land || "Agricultural / Residential"}</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Legal Document Summary (supporting_documents) */}
                                                    {selectedDoc.data.supporting_documents &&
                                                        selectedDoc.data.supporting_documents !== 'None mentioned' &&
                                                        selectedDoc.data.supporting_documents !== 'N/A' && (
                                                            <div className="bg-amber-50/50 p-4 rounded-xl border border-amber-100 shadow-sm">
                                                                <div className="flex items-center gap-2 mb-2">
                                                                    <FileText className="w-4 h-4 text-amber-600" />
                                                                    <span className="text-[10px] font-bold text-amber-900 uppercase tracking-widest">Document Summary</span>
                                                                </div>
                                                                <p className="text-[11px] text-amber-900 leading-relaxed italic font-medium">
                                                                    {selectedDoc.data.supporting_documents.replace(/^[*-]\s*/, '').replace(/^Executant:\s*/i, '')}
                                                                </p>
                                                            </div>
                                                        )}

                                                    {/* Validation Grid */}
                                                    <div className="pt-2">
                                                        {selectedDoc?.validation?.comparisons ? (
                                                            <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-200">
                                                                <div className="flex items-center justify-between mb-3 px-1">
                                                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Audit Verification Results</span>
                                                                    <Button
                                                                        variant="outline"
                                                                        size="sm"
                                                                        className="h-7 px-2 text-[10px] font-bold flex items-center gap-1.5 bg-primary/5 border-primary/10 text-primary hover:bg-primary/10"
                                                                        onClick={() => handleOpenInMap(selectedDoc.docNo)}
                                                                    >
                                                                        <MapPin className="w-3.5 h-3.5" />
                                                                        VIEW ON MAP
                                                                    </Button>
                                                                </div>
                                                                <div className="flex flex-col gap-2">
                                                                    {selectedDoc.validation.comparisons.map((comp: any, i: number) => {
                                                                        const isSupporting = comp.field === "Supporting Documents";
                                                                        const isMatched = comp.status.includes("MATCHED");

                                                                        if (isSupporting) {
                                                                            return (
                                                                                <div key={i} className="flex flex-col gap-1.5 py-2 border-t border-slate-100 mt-1">
                                                                                    <div className="flex items-center justify-between">
                                                                                        <span className="text-[10px] text-slate-800 font-bold uppercase tracking-tight">{comp.field}</span>
                                                                                        <Badge variant="outline" className={cn(
                                                                                            "text-[9px] h-4.5 px-1.5 py-0 border-0 flex items-center gap-1 font-bold",
                                                                                            isMatched ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                                                                                        )}>
                                                                                            {isMatched ? <ShieldCheck className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                                                                                            {isMatched ? "OK" : "ISSUE"}
                                                                                        </Badge>
                                                                                    </div>
                                                                                    <div className="bg-white p-2.5 rounded-lg border border-slate-100 shadow-sm">
                                                                                        <p className="text-[9px] font-bold text-slate-400 uppercase mb-1">Verified Supporting Evidence (Govt. Proof / Certificates)</p>
                                                                                        <p className="text-[10px] text-slate-700 leading-relaxed font-medium">
                                                                                            {comp.reason || "No specific evidence details found in metadata."}
                                                                                        </p>
                                                                                    </div>
                                                                                </div>
                                                                            );
                                                                        }

                                                                        return (
                                                                            <div key={i} className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0 border-dashed">
                                                                                <span className="text-[10px] text-slate-600 font-bold truncate">{comp.field}</span>
                                                                                <Badge variant="outline" className={cn(
                                                                                    "text-[9px] h-4.5 px-1.5 py-0 border-0 flex items-center gap-1 font-bold",
                                                                                    isMatched ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                                                                                )}>
                                                                                    {isMatched ? <ShieldCheck className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                                                                                    {isMatched ? "OK" : "ISSUE"}
                                                                                </Badge>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="flex flex-col items-center gap-4 p-5 bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                                                                <div className="flex flex-col items-center text-center">
                                                                    <AlertCircle className="w-8 h-8 text-slate-300 mb-2" />
                                                                    <p className="text-[11px] text-slate-500 font-bold">No legal audit performed for this document</p>
                                                                </div>
                                                                <Button
                                                                    onClick={handleSinglePdfMatch}
                                                                    disabled={validatingSingle}
                                                                    className="w-full bg-primary hover:bg-primary/90 text-white font-bold text-xs h-10 shadow-lg shadow-primary/20 flex items-center justify-center gap-2"
                                                                >
                                                                    {validatingSingle ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                                                                    {validatingSingle ? "Processing Audit..." : "Run Single PDF Matching Audit"}
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </div>

                                                    {/* Notes Section Toggleable */}
                                                    {isNotesVisible ? (
                                                        <div className="bg-amber-50/30 rounded-xl border border-amber-100 overflow-hidden animate-in zoom-in-95 duration-200">
                                                            <div className="flex items-center justify-between p-3 border-b border-amber-100 bg-white">
                                                                <span className="text-[10px] font-bold text-amber-900 uppercase flex items-center gap-1.5">
                                                                    <StickyNote className="w-4 h-4 text-amber-500" /> Collaborative Notes
                                                                </span>
                                                                <Button variant="ghost" size="sm" className="h-6 text-[10px] hover:bg-amber-100 text-amber-700 hover:text-amber-800" onClick={() => setIsNotesVisible(false)}>Minimize</Button>
                                                            </div>
                                                            <textarea
                                                                className="w-full bg-transparent p-4 text-xs text-slate-800 focus:outline-none min-h-[120px] resize-none custom-scrollbar"
                                                                placeholder="Add collaborative notes or legal observations for this deed..."
                                                                value={timeline?.react_flow_data.nodes.find((n: any) => n.data.document_number === selectedDoc?.docNo)?.data.notes || ''}
                                                                onChange={(e) => handleUpdateNodeNotes(selectedDoc.docNo, e.target.value)}
                                                            />
                                                        </div>
                                                    ) : (
                                                        <Button
                                                            variant="outline"
                                                            className="w-full h-10 border-dashed border-slate-200 text-slate-500 text-xs gap-2 hover:bg-slate-50 hover:text-primary transition-all rounded-xl"
                                                            onClick={() => setIsNotesVisible(true)}
                                                        >
                                                            <StickyNote className="w-4 h-4" />
                                                            {timeline?.react_flow_data.nodes.find((n: any) => n.data.document_number === selectedDoc?.docNo)?.data.notes ? "Edit Existing Notes" : "Add Collaborative Notes"}
                                                        </Button>
                                                    )}

                                                    {/* Verification Upload Section */}
                                                    <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200">
                                                        <span className="text-[10px] font-bold text-slate-800 uppercase flex items-center gap-2 mb-3">
                                                            <ShieldCheck className="w-4 h-4 text-primary" /> Support Document Verification
                                                        </span>

                                                        {!verificationResult ? (
                                                            <div className="flex flex-col gap-3">
                                                                <p className="text-[10px] text-slate-500 leading-tight">
                                                                    Upload Govt ID (Aadhaar/PAN) or Death Certificate to cross-verify claimant/executant identities.
                                                                </p>
                                                                <div className="flex items-center gap-2">
                                                                    <Input type="file" className="h-9 text-[11px] bg-white border-slate-200 flex-1 hover:border-primary/50 transition-colors" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
                                                                    <Button size="sm" className="h-9 px-4 text-xs font-bold shadow-sm" disabled={!uploadFile || verifyingDoc} onClick={handleVerifySupportingDoc}>
                                                                        {verifyingDoc ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Verify File"}
                                                                    </Button>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex flex-col gap-2 animate-in slide-in-from-top-2">
                                                                <div className="flex items-center justify-between">
                                                                    <div className="flex items-center gap-2">
                                                                        {verificationResult.verified ? <ShieldCheck className="w-4 h-4 text-green-600" /> : <AlertCircle className="w-4 h-4 text-red-600" />}
                                                                        <span className={cn("text-xs font-bold", verificationResult.verified ? "text-green-700" : "text-red-700")}>{verificationResult.status}</span>
                                                                    </div>
                                                                    <Badge className={verificationResult.verified ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}>
                                                                        {verificationResult.verified ? "LEGIT" : "DISCREPANCY"}
                                                                    </Badge>
                                                                </div>
                                                                <p className="text-[11px] text-slate-600 leading-relaxed bg-slate-50 p-2 rounded-lg border-l-4 border-slate-200">{verificationResult.reason}</p>
                                                                <Button variant="ghost" size="sm" className="h-6 text-[10px] mt-1 text-primary hover:bg-primary/5 font-bold p-0 w-fit" onClick={() => setVerificationResult(null)}>Verify another document</Button>
                                                            </div>
                                                        )}
                                                    </div>
                                                </>
                                            ) : (
                                                <div className="flex flex-col items-center justify-center py-12 text-center text-slate-400 italic">
                                                    <FileText className="w-12 h-12 opacity-10 mb-4" />
                                                    <p className="text-xs">Select a document node in the hierarchy to view legal summary</p>
                                                </div>
                                            )}
                                        </div>

                                        {/* PDF View beneath metadata summary */}
                                        <div className="flex-1 p-2 bg-slate-100/50 relative">
                                            {selectedDoc?.url ? (
                                                <div className="w-full h-full rounded-xl overflow-hidden shadow-lg border border-white bg-white relative group">
                                                    <PdfAnnotator
                                                        url={selectedDoc.url}
                                                        docId={selectedDoc.docNo}
                                                        parcelId={parcelId || undefined}
                                                        onAnnotationChange={(h) => setPdfAnnotations(h)}
                                                        scrollToPage={scrollToPage}
                                                        focusHighlightId={focusHighlightId}
                                                    />

                                                    {/* Single PDF Matching Button - Always visible if PDF exists */}
                                                    <div className="absolute top-4 right-4 z-30 flex gap-2">
                                                        <Button
                                                            className="bg-primary hover:bg-primary/90 text-white font-bold text-[10px] shadow-xl flex items-center gap-2 h-8 px-3"
                                                            onClick={handleSinglePdfMatch}
                                                            disabled={validatingSingle}
                                                        >
                                                            {validatingSingle ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                                                            {validatingSingle ? "Matching..." : "Single PDF Matching"}
                                                        </Button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center italic">
                                                    <FileText className="w-16 h-16 opacity-5 mb-4" />
                                                    <p className="text-sm font-medium">Digital PDF preview unavailable for document {selectedDoc?.docNo || ""}</p>
                                                    <p className="text-[10px] max-w-[240px] mt-2 opacity-60">Try searching in the vault or re-uploading the source documents.</p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </ResizablePanel>
                        )}
                    </ResizablePanelGroup>
                </CardContent>
            </Card>

            {/* Parcel-wide Notes Cockpit. Aggregates every note across every PDF
                for this parcel; clicking a row opens the right deed and flashes
                the highlight. Only available when the URL provides parcelId. */}
            {parcelId && (
                <Dialog open={notesSummaryOpen} onOpenChange={setNotesSummaryOpen}>
                    <DialogContent className="max-w-6xl w-[min(95vw,1100px)] p-0 overflow-hidden h-[85vh] flex flex-col">
                        <DialogHeader className="sr-only">
                            <DialogTitle>Notes Cockpit</DialogTitle>
                        </DialogHeader>
                        <NotesSummary
                            parcelId={parcelId}
                            currentDocNo={selectedDoc?.docNo}
                            onJumpToNote={handleJumpToNote}
                            // CRITICAL: the cockpit MUST load the same PDF the
                            // user marked the note on. Document Analysis and
                            // the Hierarchy panel both serve the validation
                            // output via `/files/<file_path>`. If the cockpit
                            // instead serves a different version (e.g. the
                            // raw vault upload), react-pdf-highlighter scales
                            // the saved position against a different viewport
                            // and the highlight lands offset from the words.
                            //
                            // Lookup order:
                            //   1. validation result file_path  (same source as Analysis/Hierarchy)
                            //   2. vault download-by-path       (fallback for docs without a result)
                            pdfUrlResolver={(docNo: string) => {
                                if (!docNo) return null;
                                const norm = (s: string) =>
                                    (s || "").replace(/\.pdf$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
                                const target = norm(docNo);
                                const match = results.find(
                                    (r: any) =>
                                        norm(r.document_number) === target ||
                                        norm(r.doc_no) === target ||
                                        norm(r.file_path) === target,
                                );
                                if (match?.file_path) {
                                    return `${API_BASE_URL}/files/${match.file_path.replace(/\\/g, "/")}`;
                                }
                                // Returning null lets NotesSummary render the
                                // "PDF unavailable" empty state. The old
                                // download-by-path fallback 404'd for any doc
                                // not in the validation results.
                                return null;
                            }}
                        />
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
}
