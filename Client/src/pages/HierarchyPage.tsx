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
import { cn } from "@/lib/utils";
import { API_BASE_URL } from "@/lib/api";
import { useDebouncedNoteSaver } from "@/hooks/useDebouncedNoteSaver";

export default function HierarchyPage() {
    const [searchParams] = useSearchParams();
    const requestId = searchParams.get("requestId");
    const surveyNumber = searchParams.get("surveyNumber");
    const limit = searchParams.get("limit");

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

    const handleNodeClick = useCallback((docNo: string) => {
        setVerificationResult(null);
        setUploadFile(null);
        setActiveTab("summary");
        setPdfAnnotations([]); // Reset annotations for new doc
        setScrollToPage(undefined); // Reset scroll position

        const node = timeline?.react_flow_data.nodes.find((n: any) => n.data.document_number === docNo);
        let path = timeline?.doc_map?.[docNo] || node?.data?.pdf_url;

        // Try to get data from timeline transactions, fallback to node data
        const txData = timeline?.all_transactions?.find((t: any) => t.document_number === docNo) || node?.data;

        // Find validation results
        let resultItem = results.find(r => r.document_number === docNo);
        if (!resultItem) {
            const normalizedDoc = docNo.replace(/\s+/g, '').replace(/[-\/]/g, '');
            resultItem = results.find(r =>
                r.document_number.replace(/\s+/g, '').replace(/[-\/]/g, '') === normalizedDoc
            );
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
                                            <div className="absolute inset-x-0 top-0 bottom-0 z-20 animate-in slide-in-from-right duration-300">
                                                <DocChat 
                                                    docNo={selectedDoc.docNo} 
                                                    requestId={requestId || ""}
                                                    onClose={() => setActiveTab("summary")} 
                                                    onPageClick={(page) => setScrollToPage({ page, timestamp: Date.now() })}
                                                />
                                            </div>
                                        )}

                                        {activeTab === "annotations" && selectedDoc && (
                                            <div className="absolute inset-0 z-20 animate-in slide-in-from-right duration-300 bg-white flex flex-col p-4">
                                                <div className="flex items-center justify-between mb-4">
                                                    <h3 className="text-xs font-extra-bold uppercase tracking-tighter text-slate-400">PDF Annotations</h3>
                                                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setActiveTab("summary")}><X className="w-3 h-3" /></Button>
                                                </div>
                                                <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">
                                                    {pdfAnnotations.length === 0 ? (
                                                        <div className="flex flex-col items-center justify-center py-8 opacity-40 grayscale">
                                                            <StickyNote className="w-8 h-8 mb-2" />
                                                            <p className="text-[10px] font-medium">No highlights yet</p>
                                                        </div>
                                                    ) : (
                                                        pdfAnnotations.map((anno: any) => (
                                                            <Card key={anno.id} className="p-3 border-primary/5 hover:border-primary/20 transition-all cursor-pointer bg-slate-50/50">
                                                                <div className="flex flex-col gap-1">
                                                                    <div className="flex items-center justify-between">
                                                                        <Badge className="text-[8px] h-4 bg-primary/10 text-primary border-0">PAGE {anno.position.pageNumber}</Badge>
                                                                    </div>
                                                                    <p className="text-[11px] font-extra-bold text-slate-800 mt-1">"{anno.content.text?.slice(0, 60)}..."</p>
                                                                    <div className="flex items-start gap-2 mt-2 p-2 bg-white rounded-lg border border-slate-100">
                                                                        <MessageSquare className="w-3 h-3 text-primary shrink-0 mt-0.5" />
                                                                        <p className="text-[10px] text-slate-600 italic leading-snug">{anno.comment.text}</p>
                                                                    </div>
                                                                </div>
                                                            </Card>
                                                        ))
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {/* Metadata / Summary Panel */}
                                        <div className={cn(
                                            "bg-white border-b shadow-sm z-10 transition-all duration-300 overflow-y-auto custom-scrollbar",
                                            activeTab === "chat" ? "hidden" : "max-h-[60%] p-5 space-y-4"
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
                                                                <span>S.No: {selectedDoc.data.survey_number || "N/A"}</span>
                                                            </div>
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
                                                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-3 px-1">Audit Verification Results</span>
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
                                                        onAnnotationChange={(h) => setPdfAnnotations(h)}
                                                        scrollToPage={scrollToPage}
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
        </div>
    );
}
