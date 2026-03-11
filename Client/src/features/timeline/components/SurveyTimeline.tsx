import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, Calendar, MapPin, ArrowRight, Filter, X, FileText, Maximize2, Minimize2, User, Maximize, ShieldCheck, AlertCircle, MessageSquare, Plus, StickyNote, ExternalLink, Loader2 } from "lucide-react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { ReactFlowHierarchy } from "@/features/hierarchy/components/ReactFlowHierarchy";
import DocChat from "@/features/analysis/components/DocChat";
import PdfAnnotator from "@/features/analysis/components/PdfAnnotator";
import { cn } from "@/lib/utils";
import { API_BASE_URL } from "@/lib/api";
import { useDebouncedNoteSaver } from "@/hooks/useDebouncedNoteSaver";

interface Transaction {
    claimant: string;
    executant: string;
    survey_number: string;
    parent_survey_number: string | null;
    date: string;
    nature: string;
    document_number: string;
    nature_of_land: string;
    square_feet?: string;
    supporting_documents?: string;
    executant_docs?: string;
    claimant_docs?: string;
    executant_relationship?: string;
    claimant_relationship?: string;
    pdf_url?: string;
}

interface TimelineResult {
    survey_number: string;
    found: boolean;
    first_transaction: Transaction | null;
    last_transaction: Transaction | null;
    all_transactions: Transaction[];
    lineage_path: string[];
    mermaid_chart: string;
    react_flow_data: {
        nodes: any[];
        edges: any[];
    };
    doc_map?: Record<string, string>;
}

interface SurveyTimelineProps {
    requestId: string;
    results?: any[];
}

export function SurveyTimeline({ requestId, results }: SurveyTimelineProps) {
    const getPdfUrl = (relPath: string | undefined) => {
        if (!relPath) return undefined;
        // If it starts with http, it's already an absolute URL
        if (relPath.startsWith('http')) return relPath;

        const BASE_API = API_BASE_URL;
        // Clean any leading slashes or relative markers and ensure a single leading slash
        const cleaned = relPath.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "").replace(/^\/+/, "");

        return `${BASE_API}/${cleaned}`;
    };

    const [surveyNumber, setSurveyNumber] = useState("");
    const [explorationMode, setExplorationMode] = useState<"search" | "global">("search");
    const [timeline, setTimeline] = useState<TimelineResult | null>(null);
    const [masterTimeline, setMasterTimeline] = useState<TimelineResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [masterLoading, setMasterLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [transactionLimit, setTransactionLimit] = useState<string>("all");
    const [previewDoc, setPreviewDoc] = useState<{ docNo: string, url?: string, imageUrl?: string, data?: Transaction, validation?: any } | null>(null);
    const [panelOpen, setPanelOpen] = useState(false);
    const [fullScreenPreview, setFullScreenPreview] = useState(false);
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [verifyingDoc, setVerifyingDoc] = useState(false);
    const [verificationResult, setVerificationResult] = useState<any>(null);
    const [activeTab, setActiveTab] = useState<"summary" | "chat" | "annotations">("summary");
    const [isNotesVisible, setIsNotesVisible] = useState(false);
    const [pdfAnnotations, setPdfAnnotations] = useState<any[]>([]);
    const [validatingSingle, setValidatingSingle] = useState(false);
    const [validationCache, setValidationCache] = useState<Record<string, any>>({});
    const [scrollToPage, setScrollToPage] = useState<{ page: number, timestamp: number } | undefined>(undefined);

    const debouncedSaveNote = useDebouncedNoteSaver();

    const handleSearch = async () => {
        if (!surveyNumber.trim()) {
            setError("Please enter a survey number");
            return;
        }

        setLoading(true);
        setError(null);
        setTimeline(null);
        setPanelOpen(false);
        setPreviewDoc(null);
        setValidationCache({});

        try {
            const API_URL = API_BASE_URL;
            const requestBody = {
                survey_number: surveyNumber.trim(),
                request_id: requestId,
                limit: transactionLimit === "all" ? null : parseInt(transactionLimit),
            };

            const response = await fetch(`${API_URL}/api/v1/search-survey-timeline`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            let timelineData = null;
            let errorMessage = null;

            if (data.body?.response) {
                if (data.body.response.status === "success") {
                    timelineData = data.body.response.timeline;
                } else {
                    errorMessage = data.body.response.message || "Failed to fetch timeline";
                }
            } else if (data.status === "success") {
                timelineData = data.timeline;
            } else if (data.status === "error") {
                errorMessage = data.message || "Failed to fetch timeline";
            }

            if (timelineData) {
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

                // Auto-open is disabled as per user request
                /*
                if (timelineData.all_transactions && timelineData.all_transactions.length > 0) {
                    const latest = timelineData.all_transactions[timelineData.all_transactions.length - 1];
                    setTimeout(() => handleNodeClick(latest.document_number, latest), 500);
                }
                */
            } else {
                setError(errorMessage || "Failed to fetch timeline");
            }
        } catch (err) {
            setError(`Network error: ${err instanceof Error ? err.message : "Please try again"}`);
        } finally {
            setLoading(false);
        }
    };

    const handleLoadMasterMap = async () => {
        setMasterLoading(true);
        setError(null);
        const API_URL = API_BASE_URL;
        try {
            const response = await fetch(`${API_URL}/api/v1/get-global-hierarchy/${requestId}`);
            if (!response.ok) throw new Error("Failed to load global hierarchy");
            const data = await response.json();

            let rfData = data.body?.response?.react_flow_data || data.react_flow_data;
            if (rfData) {
                // Fetch existing notes and merge them
                try {
                    const notesResp = await fetch(`${API_URL}/api/v1/get-node-notes`);
                    if (notesResp.ok) {
                        const notes = await notesResp.json();
                        rfData.nodes = rfData.nodes.map((node: any) => ({
                            ...node,
                            data: {
                                ...node.data,
                                notes: notes[node.data.document_number] || ""
                            }
                        }));
                    }
                } catch (e) {
                    console.error("Failed to load master notes:", e);
                }

                setMasterTimeline({
                    react_flow_data: rfData,
                    all_transactions: rfData.nodes.map((n: any) => n.data).filter((d: any) => d.document_number),
                    survey_number: "Global Map",
                    found: true,
                    mermaid_chart: "",
                    lineage_path: [],
                    first_transaction: null,
                    last_transaction: null
                });
            }
        } catch (err) {
            console.error("Master Map Error:", err);
            setError("Failed to load master map");
        } finally {
            setMasterLoading(false);
        }
    };

    // Sync Master Map on Mode Switch
    useEffect(() => {
        if (explorationMode === "global" && !masterTimeline) {
            handleLoadMasterMap();
        }
    }, [explorationMode, masterTimeline]);


    const handleUpdateNodeNotes = useCallback(
        (docNo: string, notes: string) => {
            if (!timeline) return;

            const updatedData = {
                ...timeline,
                react_flow_data: {
                    ...timeline.react_flow_data,
                    nodes: timeline.react_flow_data.nodes.map((node) =>
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

    const handleNodeClick = useCallback((docNo: string, txData?: Transaction) => {
        console.log("Handling click for doc:", docNo);
        setVerificationResult(null);
        setUploadFile(null);
        setActiveTab("summary");
        setIsNotesVisible(false);
        setActiveTab("summary");
        setIsNotesVisible(false);
        setPdfAnnotations([]);
        setScrollToPage(undefined);

        // Helper to normalize doc numbers for mapping
        const normalize = (s: string) => s ? s.replace(/\s+/g, '').replace(/[-\/]/g, '').toLowerCase() : '';
        const normDocNo = normalize(docNo);

        // Find transaction data (Search in active and hidden timelines for sync)
        const allPossibleTxs = [
            ...(timeline?.all_transactions || []),
            ...(masterTimeline?.all_transactions || [])
        ];

        // Find transaction data if not provided (e.g. from React Flow)
        let activeTx = txData || allPossibleTxs.find(t => normalize(t.document_number) === normDocNo);

        // If still not found, check the node's data (it might be a parent node)
        const allNodes = [
            ...(timeline?.react_flow_data?.nodes || []),
            ...(masterTimeline?.react_flow_data?.nodes || [])
        ];

        if (!activeTx && allNodes.length > 0) {
            const node = allNodes.find(n => n.data?.document_number && normalize(n.data.document_number) === normDocNo);
            if (node?.data) {
                activeTx = node.data as any;
            }
        }

        // 3. Fallback to session results
        let resultItem = results?.find(r => normalize(r.document_number) === normDocNo);

        const validation = validationCache[docNo] || resultItem?.validation_result;

        // Determine PDF URL with multiple fallbacks
        let pdfUrl = getPdfUrl(activeTx?.pdf_url);

        // Try doc_map with normalization if direct URL is missing
        if (!pdfUrl && timeline?.doc_map) {
            const mappedEntry = Object.entries(timeline.doc_map).find(([k]) => normalize(k) === normDocNo);
            if (mappedEntry) {
                pdfUrl = getPdfUrl(mappedEntry[1]);
            }
        }

        // Final fallback to resultItem
        if (!pdfUrl && resultItem?.file_path) {
            pdfUrl = getPdfUrl(resultItem.file_path);
        }


        console.log(`[Preview Search] docNo=${docNo} norm=${normDocNo} pdfUrl=`, pdfUrl);

        setPreviewDoc({
            docNo: docNo,
            url: pdfUrl || undefined,
            data: activeTx,
            validation
        });
        setPanelOpen(true);
    }, [timeline, results, validationCache]);

    const handleVerifySupportingDoc = async () => {
        if (!uploadFile || !previewDoc?.data) return;

        setVerifyingDoc(true);
        try {
            const formData = new FormData();
            formData.append("file", uploadFile);
            formData.append("metadata", JSON.stringify(previewDoc.data));

            const API_URL = API_BASE_URL;
            const response = await fetch(`${API_URL}/api/v1/verify-supporting-doc`, {
                method: "POST",
                body: formData,
            });

            if (!response.ok) throw new Error("Verification failed");
            const result = await response.json();
            setVerificationResult(result);
        } catch (err) {
            console.error(err);
            setVerificationResult({
                verified: false,
                status: "ERROR",
                reason: "Failed to connect to verification server.",
                document_link_type: "Unknown"
            });
        } finally {
            setVerifyingDoc(false);
            setUploadFile(null);
        }
    };

    const handleSinglePdfMatch = async () => {
        if (!previewDoc || !requestId) return;

        setValidatingSingle(true);
        try {
            const API_URL = API_BASE_URL;
            let relativePath = previewDoc.url;
            if (relativePath && relativePath.includes("/files/")) {
                relativePath = relativePath.split("/files/")[1];
            } else if (!relativePath) {
                relativePath = `validate/${requestId}/matched_docs/${previewDoc.docNo}.pdf`;
            }
            const payload = {
                request_id: requestId,
                doc_no: previewDoc.docNo,
                file_path: relativePath
            };
            console.log("[Single Audit] Sending payload:", payload);
            const response = await fetch(`${API_URL}/api/v1/validate-single`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!response.ok) throw new Error("Validation failed");
            const data = await response.json();

            // Extract the result from the wrapped response
            const result = data.body?.response || data;
            const validationResult = result.validation_result;

            if (validationResult) {
                const newUrl = getPdfUrl(result.file_path);

                setValidationCache(prev => ({ ...prev, [previewDoc.docNo]: validationResult }));
                setPreviewDoc(prev => prev ? {
                    ...prev,
                    validation: validationResult,
                    url: newUrl || prev.url
                } : null);
            }

        } catch (e) {
            console.error("Single validation error:", e);
        } finally {
            setValidatingSingle(false);
        }
    };

    return (
        <div className="w-full space-y-6">
            <Card className="border-2 border-primary/20 bg-gradient-to-br from-background to-primary/5">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-2xl">
                        <Search className="w-6 h-6 text-primary" />
                        Smart Lineage Explorer
                    </CardTitle>
                    <CardDescription>
                        Trace ownership history through interactive diagrams and instant document previews
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col md:flex-row gap-4">
                        <div className="flex-[2]">
                            <Label htmlFor="survey-search" className="mb-2 block text-sm font-semibold">
                                Survey Number
                            </Label>
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                <Input
                                    id="survey-search"
                                    placeholder="Enter Survey Number (e.g., 47, 47/1, 47/6A3)"
                                    value={surveyNumber}
                                    onChange={(e) => setSurveyNumber(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                                    disabled={loading}
                                    className="pl-10 text-lg h-12 shadow-sm focus-visible:ring-primary"
                                />
                            </div>
                        </div>

                        <div className="flex-1">
                            <Label htmlFor="tx-limit" className="mb-2 block text-sm font-semibold">
                                History Depth
                            </Label>
                            <Select
                                value={transactionLimit}
                                onValueChange={setTransactionLimit}
                                disabled={loading}
                            >
                                <SelectTrigger id="tx-limit" className="h-12 border-primary/10">
                                    <SelectValue placeholder="All Transactions" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Transactions</SelectItem>
                                    <SelectItem value="5">Last 5 Transactions</SelectItem>
                                    <SelectItem value="10">Last 10 Transactions</SelectItem>
                                    <SelectItem value="20">Last 20 Transactions</SelectItem>
                                    <SelectItem value="1">Latest Only</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="flex items-end gap-2">
                            <Button
                                onClick={handleSearch}
                                disabled={loading}
                                size="lg"
                                className="h-12 px-8 w-full md:w-auto font-bold shadow-lg shadow-primary/20 transition-all hover:scale-105 active:scale-95"
                            >
                                {loading ? (
                                    <span className="flex items-center gap-2">
                                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        Analyzing...
                                    </span>
                                ) : "Explore Lineage"}
                            </Button>
                            {!loading && (
                                <Button
                                    variant="outline"
                                    size="lg"
                                    className="h-12 border-primary/20 text-primary font-bold hover:bg-primary/5"
                                    onClick={() => setExplorationMode(prev => prev === "search" ? "global" : "search")}
                                >
                                    {explorationMode === "search" ? "View Master Map" : "Back to Search"}
                                </Button>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>

            <div className="flex items-center gap-4 mb-6 sticky top-0 z-40 bg-background/80 backdrop-blur-md p-1 rounded-2xl border border-primary/10 shadow-sm">
                <Button
                    variant={explorationMode === "search" ? "default" : "ghost"}
                    className={cn(
                        "flex-1 font-bold text-xs h-11 transition-all rounded-xl",
                        explorationMode === "search" ? "shadow-lg shadow-primary/20 scale-[1.02]" : "text-muted-foreground hover:bg-primary/5"
                    )}
                    onClick={() => setExplorationMode("search")}
                >
                    <Search className="w-4 h-4 mr-2" />
                    Property Lineage Search
                </Button>
                <Button
                    variant={explorationMode === "global" ? "default" : "ghost"}
                    className={cn(
                        "flex-1 font-bold text-xs h-11 transition-all rounded-xl",
                        explorationMode === "global" ? "shadow-lg shadow-primary/20 scale-[1.02]" : "text-muted-foreground hover:bg-primary/5"
                    )}
                    onClick={() => setExplorationMode("global")}
                >
                    <Maximize className="w-4 h-4 mr-2" />
                    Master Network Overview
                </Button>
            </div>


            {
                (loading || masterLoading) && (
                    <div className="flex flex-col items-center justify-center p-24 text-center space-y-4 bg-primary/5 rounded-3xl border-4 border-dashed border-primary/10 animate-pulse mb-6">
                        <Loader2 className="w-12 h-12 text-primary animate-spin" />
                        <div className="space-y-1">
                            <p className="text-xl font-bold text-slate-800">Processing Documents</p>
                            <p className="text-sm text-slate-500 font-medium italic">Generating intelligence from legal records...</p>
                        </div>
                    </div>
                )
            }

            {
                error && (
                    <Card className="border-red-100 bg-red-50/50 rounded-2xl mb-6">
                        <CardContent className="flex flex-col items-center justify-center p-8 text-center text-red-600">
                            <AlertCircle className="w-8 h-8 mb-2 opacity-50" />
                            <p className="font-bold">{error}</p>
                            <Button variant="link" size="sm" onClick={() => { setError(null); if (explorationMode === "global") handleLoadMasterMap(); }}>Try reloading data</Button>
                        </CardContent>
                    </Card>
                )
            }


            {
                explorationMode === "search" && timeline && (
                    <>

                        <div className="flex flex-col md:flex-row gap-4 mb-4">
                            <Card className="flex-1 border-amber-200 bg-amber-50/30">
                                <CardHeader className="py-3 px-4 flex flex-row items-center gap-2 space-y-0">
                                    <StickyNote className="w-4 h-4 text-amber-500" />
                                    <CardTitle className="text-xs font-bold uppercase tracking-wider text-amber-700">Overall Request Notes</CardTitle>
                                </CardHeader>
                                <CardContent className="px-4 pb-3">
                                    <textarea
                                        className="w-full bg-white/50 border border-amber-100 rounded-lg p-3 text-xs min-h-[60px] resize-none focus:ring-1 focus:ring-amber-300 outline-none"
                                        placeholder="Add general observations about this property or lineage..."
                                        defaultValue={""}
                                    />
                                </CardContent>
                            </Card>

                            <Card className="flex-1 border-primary/20 bg-primary/5">
                                <CardHeader className="py-3 px-4 flex flex-row items-center gap-2 space-y-0">
                                    <ShieldCheck className="w-4 h-4 text-primary" />
                                    <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary/80">Government Proof Center</CardTitle>
                                </CardHeader>
                                <CardContent className="px-4 pb-3 flex flex-wrap gap-2">
                                    <Badge variant="outline" className="bg-white/80 gap-1.5 py-1 px-3">
                                        <User className="w-3 h-3 text-blue-500" /> Aadhar: <span className="text-blue-700">Audit Ready</span>
                                    </Badge>
                                    <Badge variant="outline" className="bg-white/80 gap-1.5 py-1 px-3">
                                        <Calendar className="w-3 h-3 text-red-500" /> Death Cert: <span className="text-red-700">Pending Verify</span>
                                    </Badge>
                                    <Badge variant="outline" className="bg-white/80 gap-1.5 py-1 px-3 text-[10px] italic">
                                        + Verification Summary Active
                                    </Badge>
                                </CardContent>
                            </Card>
                        </div>


                        <div className={cn(
                            "grid gap-6 transition-all duration-500",
                            panelOpen ? "grid-cols-1 lg:grid-cols-12" : "grid-cols-1"
                        )}>
                            {/* Left Side: Hierarchy & Timeline */}
                            <div className={cn(
                                "space-y-6 transition-all duration-500",
                                panelOpen ? "lg:col-span-7 xl:col-span-8" : "w-full"
                            )}>
                                {/* Lineage Path Breadcrumbs */}
                                {timeline.lineage_path && timeline.lineage_path.length > 0 && (
                                    <div className="flex items-center gap-2 px-1 mb-2 overflow-x-auto pb-2 scrollbar-hide">
                                        {timeline.lineage_path.map((path, idx) => (
                                            <div key={idx} className="flex items-center gap-2 shrink-0">
                                                <Badge
                                                    variant={idx === timeline.lineage_path.length - 1 ? "default" : "outline"}
                                                    className={cn(
                                                        "px-3 py-1 font-bold tracking-tight transition-all",
                                                        idx === timeline.lineage_path.length - 1
                                                            ? "bg-primary shadow-md scale-105"
                                                            : "bg-background hover:bg-muted"
                                                    )}
                                                >
                                                    {idx === 0 ? "Mother: " : idx === 1 ? "Child: " : idx === 2 ? "Grandchild: " : "Sub: "}
                                                    {path}
                                                </Badge>
                                                {idx < timeline.lineage_path.length - 1 && (
                                                    <ArrowRight className="w-4 h-4 text-muted-foreground/50" />
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {timeline.react_flow_data && (
                                    <Card className="border-primary/10 shadow-2xl shadow-primary/5 overflow-hidden group/flow rounded-3xl">
                                        <CardHeader className="bg-slate-900 border-b py-4 px-8 flex flex-row items-center justify-between space-y-0 text-white">
                                            <CardTitle className="text-lg font-bold flex items-center gap-3">
                                                <MapPin className="w-6 h-6 text-primary animate-pulse" />
                                                Interactive Ownership Flow
                                                <Badge className="ml-2 bg-primary/20 text-primary border-primary/10">
                                                    {timeline.react_flow_data.nodes?.length || 0} NODES FOUND
                                                </Badge>
                                            </CardTitle>
                                            <div className="flex items-center gap-2">
                                                <div className="flex gap-2 mr-4">
                                                    <Badge variant="outline" className="border-green-500/50 text-green-400 text-[10px]">SALE</Badge>
                                                    <Badge variant="outline" className="border-red-500/50 text-red-400 text-[10px]">MORTGAGE</Badge>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8 text-slate-400 hover:text-white hover:bg-white/10"
                                                    title="Open in Full View"
                                                    onClick={() => {
                                                        const url = `/hierarchy?requestId=${requestId}&surveyNumber=${surveyNumber}&limit=${transactionLimit}`;
                                                        window.open(url, '_blank');
                                                    }}
                                                >
                                                    <ExternalLink className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        </CardHeader>
                                        <CardContent className="p-0 relative h-[750px]">
                                            <ReactFlowHierarchy
                                                data={timeline.react_flow_data}
                                                onNodeClick={handleNodeClick}
                                                onNotesChange={handleUpdateNodeNotes}
                                            />
                                        </CardContent>
                                    </Card>
                                )}

                                {/* Transaction List */}
                                <Card className="border-primary/10 shadow-lg overflow-hidden">
                                    <CardHeader className="py-4 border-b bg-muted/10">
                                        <CardTitle className="text-lg flex items-center gap-2">
                                            <FileText className="w-5 h-5 text-primary" />
                                            Transaction Registry
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="p-0">
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-xs text-left border-collapse">
                                                <thead>
                                                    <tr className="bg-muted/50 text-muted-foreground uppercase text-[10px] font-bold tracking-wider">
                                                        <th className="px-4 py-3 border-b whitespace-nowrap">Date</th>
                                                        <th className="px-4 py-3 border-b whitespace-nowrap">Document</th>
                                                        <th className="px-4 py-3 border-b whitespace-nowrap text-center">Area</th>
                                                        <th className="px-4 py-3 border-b">Nature</th>
                                                        <th className="px-4 py-3 border-b whitespace-nowrap">Supporting Docs</th>
                                                        <th className="px-4 py-3 border-b">Parties</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-border">
                                                    {timeline.all_transactions.map((tx, idx) => (
                                                        <tr
                                                            key={idx}
                                                            className={cn(
                                                                "hover:bg-primary/[0.03] transition-colors cursor-pointer group",
                                                                previewDoc?.docNo === tx.document_number && "bg-primary/[0.05]"
                                                            )}
                                                            onClick={() => handleNodeClick(tx.document_number, tx)}
                                                        >
                                                            <td className="px-4 py-3 font-medium text-slate-500 whitespace-nowrap">{tx.date}</td>
                                                            <td className="px-4 py-3 font-bold text-primary whitespace-nowrap">{tx.document_number}</td>
                                                            <td className="px-4 py-3 text-center">
                                                                <div className="flex items-center justify-center gap-1.5 bg-slate-50 border border-slate-200 rounded-full px-2.5 py-1 w-fit mx-auto shadow-sm">
                                                                    <div className="w-1.5 h-1.5 rounded-full bg-primary/60" />
                                                                    <span className="font-bold text-slate-700 text-[10px] whitespace-nowrap">
                                                                        {tx.square_feet || 'N/A'}
                                                                    </span>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-3">
                                                                <Badge variant="outline" className="text-[10px] font-bold uppercase tracking-tight py-0">
                                                                    {tx.nature}
                                                                </Badge>
                                                            </td>
                                                            <td className="px-4 py-3 max-w-[150px]">
                                                                <span className="text-[10px] text-slate-500 italic line-clamp-1" title={tx.supporting_documents}>
                                                                    {tx.supporting_documents || 'None mentioned'}
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-3 text-slate-600">
                                                                <div className="flex flex-col gap-1.5">
                                                                    <div className="flex flex-col">
                                                                        <div className="flex items-center gap-1">
                                                                            <span className="text-[9px] font-bold text-muted-foreground uppercase w-4">E:</span>
                                                                            <span className="font-semibold text-slate-800 line-clamp-1">{tx.executant}</span>
                                                                        </div>
                                                                        {tx.executant_relationship && (
                                                                            <span className="text-[8px] text-slate-400 italic pl-5 leading-tight">{tx.executant_relationship}</span>
                                                                        )}
                                                                    </div>
                                                                    <div className="flex flex-col">
                                                                        <div className="flex items-center gap-1">
                                                                            <span className="text-[9px] font-bold text-muted-foreground uppercase w-4">C:</span>
                                                                            <span className="font-semibold text-slate-800 line-clamp-1">{tx.claimant}</span>
                                                                        </div>
                                                                        {tx.claimant_relationship && (
                                                                            <span className="text-[8px] text-slate-400 italic pl-5 leading-tight">{tx.claimant_relationship}</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                            {timeline.all_transactions.length === 0 && (
                                                <div className="py-12 text-center text-muted-foreground italic">
                                                    No detailed records found
                                                </div>
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            </div>

                            {/* Right Side: Preview Side Panel */}
                            {panelOpen && (
                                <div className={cn(
                                    "transition-all duration-500 relative",
                                    fullScreenPreview ? "fixed inset-0 z-50 bg-background" : "lg:col-span-5 xl:col-span-4"
                                )}>
                                    <Card className={cn(
                                        "border-primary/20 shadow-2xl flex flex-col overflow-hidden sticky top-6",
                                        fullScreenPreview ? "h-screen border-none rounded-none" : "h-[800px]"
                                    )}>
                                        <CardHeader className="bg-primary text-primary-foreground py-3 px-4 flex flex-row items-center justify-between space-y-0">
                                            <div className="flex items-center gap-2">
                                                <div className="p-1.5 bg-white/20 rounded-md">
                                                    <FileText className="w-4 h-4" />
                                                </div>
                                                <div className="flex flex-col">
                                                    <span className="text-[10px] opacity-70 leading-none">PROPERTIES OF</span>
                                                    <span className="text-sm font-bold truncate max-w-[150px]">{previewDoc?.docNo}</span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="h-8 w-8 hover:bg-white/20 text-white"
                                                    onClick={() => setFullScreenPreview(!fullScreenPreview)}
                                                >
                                                    {fullScreenPreview ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className={cn(
                                                        "h-8 w-8 hover:bg-white/20 text-white transition-all relative",
                                                        isNotesVisible ? "bg-amber-400 text-amber-950 shadow-inner" : ""
                                                    )}
                                                    onClick={() => setIsNotesVisible(!isNotesVisible)}
                                                    title={isNotesVisible ? "Hide Notes" : "View/Add Notes"}
                                                >
                                                    <StickyNote className={cn("w-4 h-4 transition-all duration-300", isNotesVisible ? "scale-110" : "")} />
                                                    {!isNotesVisible && timeline?.react_flow_data.nodes.find(n => n.data.document_number === previewDoc?.docNo)?.data.notes && (
                                                        <span className="absolute top-1 right-1 w-2 h-2 bg-amber-400 rounded-full border border-primary animate-pulse" />
                                                    )}
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="h-8 w-8 hover:bg-white/20 text-white"
                                                    onClick={() => { setPanelOpen(false); setFullScreenPreview(false); }}
                                                >
                                                    <X className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        </CardHeader>
                                        <div className="flex bg-primary/5 p-1 mx-4 mt-3 rounded-lg border border-primary/10">
                                            <button
                                                className={cn(
                                                    "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-md transition-all",
                                                    activeTab === "summary" ? "bg-white shadow-sm text-primary" : "text-slate-500 hover:text-primary/70"
                                                )}
                                                onClick={() => setActiveTab("summary")}
                                            >
                                                <FileText className="w-3.5 h-3.5" />
                                                Summary
                                            </button>
                                            <button
                                                className={cn(
                                                    "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-md transition-all",
                                                    activeTab === "annotations" ? "bg-white shadow-sm text-primary" : "text-slate-500 hover:text-primary/70"
                                                )}
                                                onClick={() => setActiveTab("annotations")}
                                            >
                                                <StickyNote className="w-3.5 h-3.5" />
                                                Notes
                                            </button>
                                            <button
                                                className={cn(
                                                    "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-md transition-all",
                                                    activeTab === "chat" ? "bg-white shadow-sm text-primary" : "text-slate-500 hover:text-primary/70"
                                                )}
                                                onClick={() => setActiveTab("chat")}
                                            >
                                                <MessageSquare className="w-3.5 h-3.5" />
                                                Chatbot
                                            </button>
                                        </div>

                                        <CardContent className="p-0 flex-1 flex flex-col relative bg-muted/20 overflow-hidden mt-2">
                                            {activeTab === "chat" && previewDoc && (
                                                <div className="absolute inset-x-0 top-0 bottom-[300px] z-20 animate-in slide-in-from-right duration-300">
                                                    <DocChat 
                                                        docNo={previewDoc.docNo} 
                                                        requestId={requestId} 
                                                        onClose={() => setActiveTab("summary")} 
                                                        onPageClick={(page) => setScrollToPage({ page, timestamp: Date.now() })}
                                                    />
                                                </div>
                                            )}

                                            {activeTab === "annotations" && previewDoc && (
                                                <div className="absolute inset-x-0 top-0 bottom-[300px] z-20 animate-in slide-in-from-right duration-300 bg-white flex flex-col p-4 border-b">
                                                    <div className="flex items-center justify-between mb-3">
                                                        <h3 className="text-[10px] font-extra-bold uppercase tracking-wider text-slate-400">PDF Annotations</h3>
                                                        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setActiveTab("summary")}><X className="w-3 h-3" /></Button>
                                                    </div>
                                                    <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">
                                                        {pdfAnnotations.length === 0 ? (
                                                            <div className="flex flex-col items-center justify-center py-6 opacity-30 grayscale">
                                                                <StickyNote className="w-6 h-6 mb-1" />
                                                                <p className="text-[9px] font-bold">Highlight text to add notes</p>
                                                            </div>
                                                        ) : (
                                                            pdfAnnotations.map((anno: any) => (
                                                                <Card key={anno.id} className="p-2 border-primary/5 bg-slate-50/50">
                                                                    <div className="flex flex-col gap-1">
                                                                        <Badge className="w-fit text-[7px] h-3.5 bg-primary/10 text-primary border-0">PAGE {anno.position.pageNumber}</Badge>
                                                                        <p className="text-[10px] font-bold text-slate-800 line-clamp-2">"{anno.content.text || 'Area selection'}"</p>
                                                                        <div className="flex items-start gap-1.5 mt-1 p-1.5 bg-white rounded border border-slate-100">
                                                                            <MessageSquare className="w-2.5 h-2.5 text-primary shrink-0 mt-0.5" />
                                                                            <p className="text-[9px] text-slate-600 italic leading-snug">{anno.comment.text}</p>
                                                                        </div>
                                                                    </div>
                                                                </Card>
                                                            ))
                                                        )}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Document Summary Section */}
                                            <div className={cn(
                                                "bg-white border-b p-4 space-y-3 shadow-sm z-10 transition-all duration-300",
                                                activeTab === "chat" ? "h-[100px] opacity-40 grayscale pointer-events-none overflow-hidden" : "max-h-[40%] overflow-y-auto custom-scrollbar"
                                            )}>
                                                {previewDoc?.data && (
                                                    <>
                                                        <div className="flex items-center justify-between">
                                                            <Badge variant="outline" className="text-[10px] font-bold uppercase tracking-tight">
                                                                {previewDoc.data.nature}
                                                            </Badge>
                                                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                                                <Calendar className="w-3 h-3" />
                                                                <span>{previewDoc.data.date}</span>
                                                            </div>
                                                        </div>

                                                        <div className="grid grid-cols-2 gap-4">
                                                            <div className="space-y-1">
                                                                <span className="text-[9px] font-bold text-muted-foreground uppercase flex items-center gap-1">
                                                                    <User className="w-2.5 h-2.5" /> Executant
                                                                </span>
                                                                <p className="text-xs font-semibold text-slate-800 leading-tight">
                                                                    {previewDoc.data.executant}
                                                                </p>
                                                                {previewDoc.data.executant_relationship && (
                                                                    <p className="text-[10px] text-slate-500 italic leading-tight">
                                                                        {previewDoc.data.executant_relationship}
                                                                    </p>
                                                                )}
                                                                {previewDoc.data.executant_docs && (
                                                                    <div className="flex items-center gap-1 mt-1 text-[9px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded border border-blue-100 w-fit">
                                                                        <ShieldCheck className="w-2.5 h-2.5" />
                                                                        <span>{previewDoc.data.executant_docs}</span>
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className="space-y-1">
                                                                <span className="text-[9px] font-bold text-muted-foreground uppercase flex items-center gap-1">
                                                                    <User className="w-2.5 h-2.5" /> Claimant
                                                                </span>
                                                                <p className="text-xs font-semibold text-slate-800 leading-tight">
                                                                    {previewDoc.data.claimant}
                                                                </p>
                                                                {previewDoc.data.claimant_relationship && (
                                                                    <p className="text-[10px] text-slate-500 italic leading-tight">
                                                                        {previewDoc.data.claimant_relationship}
                                                                    </p>
                                                                )}
                                                                {previewDoc.data.claimant_docs && (
                                                                    <div className="flex items-center gap-1 mt-1 text-[9px] bg-green-50 text-green-700 px-1.5 py-0.5 rounded border border-green-100 w-fit">
                                                                        <ShieldCheck className="w-2.5 h-2.5" />
                                                                        <span>{previewDoc.data.claimant_docs}</span>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>

                                                        <div className="flex items-center gap-4 pt-2 border-t border-slate-50">
                                                            <div className="flex items-center gap-1.5 text-xs">
                                                                <Maximize className="w-3.5 h-3.5 text-primary/70 shrink-0" />
                                                                <span className="font-bold text-slate-700">Area: {previewDoc.data.square_feet && previewDoc.data.square_feet !== 'N/A' ? previewDoc.data.square_feet : 'N/A (check deed)'}</span>
                                                            </div>
                                                            <div className="flex items-center gap-1.5 text-xs">
                                                                <MapPin className="w-3.5 h-3.5 text-primary/70 shrink-0" />
                                                                <span className="font-bold text-slate-700">S.No: {previewDoc.data.survey_number}</span>
                                                            </div>
                                                        </div>

                                                        {/* Detailed Validation List Design */}
                                                        {previewDoc?.validation?.comparisons ? (
                                                            <div className="space-y-4 mt-4">
                                                                <div className="flex items-center gap-2 mb-2">
                                                                    <div className="w-1.5 h-6 bg-blue-600 rounded-full" />
                                                                    <h3 className="text-lg font-bold text-slate-900">Validation Details</h3>
                                                                </div>

                                                                {/* Identity & Supporting Docs Summary - Prominent View */}
                                                                {(() => {
                                                                    const supDoc = previewDoc.validation.comparisons.find((c: any) => c.field === "Supporting Documents");
                                                                    if (supDoc) {
                                                                        const isMatched = supDoc.status.includes("MATCHED");
                                                                        return (
                                                                            <div className={cn(
                                                                                "p-4 rounded-xl border-l-4 shadow-sm mb-4",
                                                                                isMatched ? "bg-green-50 border-l-green-500 border-green-100" : "bg-red-50 border-l-red-500 border-red-100"
                                                                            )}>
                                                                                <div className="flex items-center gap-2 mb-2">
                                                                                    <ShieldCheck className={cn("w-5 h-5", isMatched ? "text-green-600" : "text-red-500")} />
                                                                                    <h4 className={cn("text-sm font-bold uppercase tracking-wider", isMatched ? "text-green-800" : "text-red-800")}>
                                                                                        Identity & Supporting Documents
                                                                                    </h4>
                                                                                </div>
                                                                                <p className="text-xs text-slate-700 font-medium leading-relaxed">
                                                                                    {supDoc.reason}
                                                                                </p>
                                                                                {supDoc.page_number && (
                                                                                    <Button
                                                                                        variant="ghost"
                                                                                        size="sm"
                                                                                        className="h-6 mt-2 text-[10px] font-bold bg-white/50 hover:bg-white text-slate-600 border border-slate-200"
                                                                                        onClick={() => setScrollToPage({ page: parseInt(supDoc.page_number), timestamp: Date.now() })}
                                                                                    >
                                                                                        <ArrowRight className="w-3 h-3 mr-1" />
                                                                                        View on Page {supDoc.page_number}
                                                                                    </Button>
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    }
                                                                    return null;
                                                                })()}

                                                                {/* Summary Card */}
                                                                <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
                                                                    <div className="p-4 border-b bg-slate-50/50 flex items-center justify-between cursor-pointer" onClick={() => { /* Toggle logic could go here, for now simpler */ }}>
                                                                        <div>
                                                                            <div className="flex items-center gap-3">
                                                                                <span className="text-xl font-bold text-slate-800">{previewDoc.docNo}</span>
                                                                                <Badge className={cn("text-xs font-bold px-3 py-1", previewDoc.validation.match ? "bg-green-500 hover:bg-green-600" : "bg-red-500 hover:bg-red-600")}>
                                                                                    {previewDoc.validation.match ? "MATCH" : "MISMATCH"}
                                                                                </Badge>
                                                                            </div>
                                                                            <p className="text-xs text-slate-500 font-medium mt-1">
                                                                                {previewDoc.validation.comparisons.filter((c: any) => c.status.includes("MATCHED")).length} / {previewDoc.validation.comparisons.length} fields matched
                                                                            </p>
                                                                        </div>
                                                                        {/* Trustability Score */}
                                                                        {previewDoc.validation.trustability_score !== undefined && (
                                                                            <div className="flex flex-col items-end">
                                                                                <Badge variant="default" className={cn(
                                                                                    "text-sm font-bold h-8 px-3 transition-all",
                                                                                    previewDoc.validation.trustability_score >= 80 ? "bg-green-500 hover:bg-green-600" :
                                                                                        previewDoc.validation.trustability_score >= 50 ? "bg-orange-500 hover:bg-orange-600" : "bg-red-500 hover:bg-red-600"
                                                                                )}>
                                                                                    {previewDoc.validation.trustability_score}% | {previewDoc.validation.trustability_score >= 90 ? "Trustable" : previewDoc.validation.trustability_score >= 70 ? "Good" : "Needs Review"}
                                                                                </Badge>
                                                                                <span className="text-[9px] text-slate-400 mt-1 italic">
                                                                                    Score based on data consistency
                                                                                </span>
                                                                            </div>
                                                                        )}
                                                                    </div>

                                                                    <div className="p-3 bg-slate-50/30 flex flex-col gap-3">
                                                                        {previewDoc.validation.comparisons.map((comp: any, idx: number) => {
                                                                            const isMatched = comp.status.includes("MATCHED");
                                                                            const isPartial = comp.status.includes("PARTIAL") || comp.status.includes("SUPPLEMENTAL");
                                                                            const statusColor = isMatched ? "bg-green-50 border-green-200" : isPartial ? "bg-amber-50 border-amber-200" : "bg-red-50 border-red-200";
                                                                            const titleColor = isMatched ? "text-green-800" : isPartial ? "text-amber-800" : "text-red-800";
                                                                            const badgeColor = isMatched ? "bg-green-500 hover:bg-green-600" : isPartial ? "bg-amber-500 hover:bg-amber-600" : "bg-red-500 hover:bg-red-600";

                                                                            return (
                                                                                <div key={idx} className={cn("p-4 rounded-xl border border-l-4 transition-all shadow-sm hover:shadow-md", statusColor, isMatched ? "border-l-green-500" : isPartial ? "border-l-amber-500" : "border-l-red-500")}>
                                                                                    <div className="flex items-center justify-between mb-3">
                                                                                        <h4 className="text-sm font-bold text-slate-800">{comp.field}</h4>
                                                                                        <div className="flex items-center gap-2">
                                                                                            {comp.page_number && (
                                                                                                <div
                                                                                                    className="flex items-center gap-1 bg-white px-2 py-1 rounded-md border border-slate-200 shadow-sm cursor-pointer hover:bg-blue-50 hover:border-blue-200 transition-all active:scale-95"
                                                                                                    onClick={(e) => {
                                                                                                        e.stopPropagation();
                                                                                                        setScrollToPage({ page: parseInt(comp.page_number), timestamp: Date.now() });
                                                                                                    }}
                                                                                                    title={`Jump to Page ${comp.page_number}`}
                                                                                                >
                                                                                                    <Plus className="w-3 h-3 text-slate-400" />
                                                                                                    <span className="text-[10px] font-bold text-slate-600 uppercase">Page {comp.page_number}</span>
                                                                                                </div>
                                                                                            )}
                                                                                            <Badge className={cn("text-[10px] h-6 px-2.5", badgeColor)}>
                                                                                                {isMatched ? <ShieldCheck className="w-3 h-3 mr-1" /> : <AlertCircle className="w-3 h-3 mr-1" />}
                                                                                                {isMatched ? "MATCHED" : isPartial ? "PARTIAL" : "MISMATCH"}
                                                                                            </Badge>
                                                                                        </div>
                                                                                    </div>

                                                                                    <div className="space-y-2 mb-3">
                                                                                        <div className="grid grid-cols-[80px_1fr] items-baseline gap-2">
                                                                                            <span className={cn("text-xs font-bold uppercase tracking-wider text-right", titleColor)}>EC Value:</span>
                                                                                            <span className="text-xs font-semibold text-slate-700 font-mono bg-white/50 px-2 py-0.5 rounded border border-black/5 w-fit">
                                                                                                {comp.ec_value || "N/A"}
                                                                                            </span>
                                                                                        </div>
                                                                                        <div className="grid grid-cols-[80px_1fr] items-baseline gap-2">
                                                                                            <span className={cn("text-xs font-bold uppercase tracking-wider text-right", titleColor)}>Doc Value:</span>
                                                                                            <span className="text-xs font-semibold text-slate-900 font-mono bg-white px-2 py-0.5 rounded border border-black/10 w-fit shadow-sm">
                                                                                                {comp.metadata_value || "N/A"}
                                                                                            </span>
                                                                                        </div>
                                                                                    </div>

                                                                                    <p className={cn("text-[11px] italic font-medium pt-2 border-t border-black/5", titleColor)}>
                                                                                        {comp.reason}
                                                                                    </p>
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-200 mt-2">
                                                                <div className="flex flex-col items-center gap-3 text-center p-2">
                                                                    <AlertCircle className="w-6 h-6 text-slate-300" />
                                                                    <p className="text-[10px] text-slate-500 font-bold">No legal audit performed for this document</p>
                                                                    <Button
                                                                        onClick={handleSinglePdfMatch}
                                                                        disabled={validatingSingle}
                                                                        className="w-full bg-primary hover:bg-primary/90 text-white font-bold text-xs h-8 shadow-sm flex items-center justify-center gap-2"
                                                                    >
                                                                        {validatingSingle ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                                                                        {validatingSingle ? "Processing..." : "Run Single PDF Matching Audit"}
                                                                    </Button>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {previewDoc.data.supporting_documents &&
                                                            previewDoc.data.supporting_documents !== 'None mentioned' &&
                                                            previewDoc.data.supporting_documents !== 'N/A' &&
                                                            previewDoc.data.supporting_documents.length > 3 && (
                                                                <div className="bg-primary/5 p-2 rounded-lg flex gap-2 border border-primary/10">
                                                                    <ShieldCheck className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                                                                    <div className="text-[10px] text-slate-600 leading-relaxed italic">
                                                                        <span className="font-bold text-primary/90 uppercase mr-1.5 not-italic">Verified Supporting Evidence (Govt. Proof / Certificates)</span>
                                                                        Found the following supporting documents: {previewDoc.data.supporting_documents?.replace(/^[*-]\s*/, '').replace(/^Executant:\s*/i, '')}
                                                                    </div>
                                                                </div>
                                                            )}

                                                        {/* Preview Page Notes Section */}
                                                        {(isNotesVisible) && (
                                                            <div className={cn(
                                                                "mt-4 pt-4 border-t border-slate-100 animate-in fade-in slide-in-from-top-4 duration-500",
                                                                "ring-2 ring-amber-400 ring-offset-4 rounded-xl p-1 bg-amber-50/30"
                                                            )}>
                                                                <div className="flex items-center justify-between mb-2">
                                                                    <span className="text-[10px] font-bold text-slate-800 uppercase flex items-center gap-1.5 px-2">
                                                                        <StickyNote className="w-3.5 h-3.5 text-amber-500" />
                                                                        Collaborative Notes
                                                                    </span>
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="sm"
                                                                        className="h-6 text-[10px] text-amber-700 hover:bg-amber-100"
                                                                        onClick={() => setIsNotesVisible(false)}
                                                                    >
                                                                        Cancel
                                                                    </Button>
                                                                </div>
                                                                <div className="relative group/note-preview px-1 pb-1">
                                                                    <textarea
                                                                        id={`notes-${previewDoc?.docNo}`}
                                                                        autoFocus={isNotesVisible}
                                                                        className="w-full bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 focus:outline-none focus:ring-2 focus:ring-amber-400/50 min-h-[80px] resize-none placeholder:italic placeholder:text-amber-300 shadow-sm transition-all"
                                                                        placeholder="Add sensitive legal notes or observations here..."
                                                                        value={timeline?.react_flow_data.nodes.find(n => n.data.document_number === previewDoc?.docNo)?.data.notes || ''}
                                                                        onChange={(e) => {
                                                                            if (previewDoc) handleUpdateNodeNotes(previewDoc.docNo, e.target.value);
                                                                        }}
                                                                    />
                                                                </div>
                                                            </div>
                                                        )}
                                                        {/* Support Document Verification Feature */}
                                                        <div className="mt-4 pt-4 border-t border-slate-100">
                                                            <div className="flex items-center justify-between mb-3">
                                                                <span className="text-[10px] font-bold text-slate-800 uppercase flex items-center gap-1.5">
                                                                    <ShieldCheck className="w-3.5 h-3.5 text-primary" /> Verification of Support Doc
                                                                </span>
                                                                {previewDoc?.validation?.match && (
                                                                    <Badge variant="outline" className="text-[8px] border-primary/20 bg-primary/5 text-primary">
                                                                        Required for Partition/Heirship
                                                                    </Badge>
                                                                )}
                                                            </div>

                                                            <div className="bg-slate-50 rounded-xl p-3 border border-dashed border-primary/20">
                                                                {!verificationResult ? (
                                                                    <div className="space-y-3">
                                                                        <p className="text-[10px] text-slate-500 italic">
                                                                            Upload proof (Death Cert, Aadhaar, etc.) to verify against this deed.
                                                                        </p>
                                                                        <div className="flex items-center gap-2">
                                                                            <Input
                                                                                type="file"
                                                                                accept=".pdf,.png,.jpg,.jpeg"
                                                                                className="h-8 text-[10px] bg-white cursor-pointer"
                                                                                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                                                                            />
                                                                            <Button
                                                                                size="sm"
                                                                                className="h-8 text-[10px] px-3 transition-all active:scale-95"
                                                                                disabled={!uploadFile || verifyingDoc}
                                                                                onClick={handleVerifySupportingDoc}
                                                                            >
                                                                                {verifyingDoc ? (
                                                                                    <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                                                ) : (
                                                                                    "Verify"
                                                                                )}
                                                                            </Button>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-2">
                                                                        <div className="flex items-start justify-between">
                                                                            <div className="flex items-center gap-1.5">
                                                                                {verificationResult.verified ? (
                                                                                    <div className="p-1 bg-green-100 rounded-full">
                                                                                        <ShieldCheck className="w-3 h-3 text-green-600" />
                                                                                    </div>
                                                                                ) : (
                                                                                    <div className="p-1 bg-red-100 rounded-full">
                                                                                        <AlertCircle className="w-3 h-3 text-red-600" />
                                                                                    </div>
                                                                                )}
                                                                                <span className={cn(
                                                                                    "text-[10px] font-bold",
                                                                                    verificationResult.verified ? "text-green-700" : "text-red-700"
                                                                                )}>
                                                                                    {verificationResult.status}
                                                                                </span>
                                                                            </div>
                                                                            <Badge className="text-[8px] bg-slate-200 text-slate-700 hover:bg-slate-300 border-none">
                                                                                {verificationResult.document_link_type}
                                                                            </Badge>
                                                                            <button
                                                                                className="text-slate-400 hover:text-slate-600"
                                                                                onClick={() => setVerificationResult(null)}
                                                                            >
                                                                                <X className="w-3 h-3" />
                                                                            </button>
                                                                        </div>
                                                                        <p className="text-[10px] text-slate-600 border-l-2 border-primary/20 pl-2 leading-relaxed">
                                                                            {verificationResult.reason}
                                                                        </p>
                                                                        {verificationResult.matching_entities && verificationResult.matching_entities.length > 0 && (
                                                                            <div className="flex flex-wrap gap-1 mt-1">
                                                                                {verificationResult.matching_entities.map((ent: string, i: number) => (
                                                                                    <Badge key={i} variant="secondary" className="text-[8px] py-0">
                                                                                        {ent}
                                                                                    </Badge>
                                                                                ))}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </>
                                                )}
                                            </div>

                                            <div className="flex-1 relative group">
                                                {previewDoc?.url ? (
                                                    <>
                                                        <PdfAnnotator
                                                            url={previewDoc.url}
                                                            docId={previewDoc.docNo}
                                                            onAnnotationChange={(h) => setPdfAnnotations(h)}
                                                            scrollToPage={scrollToPage}
                                                        />
                                                        <div className="absolute top-4 right-4 z-30 flex gap-2">
                                                            <Button
                                                                className="bg-primary hover:bg-primary/90 text-white font-bold text-xs shadow-xl flex items-center gap-2"
                                                                onClick={handleSinglePdfMatch}
                                                                disabled={validatingSingle}
                                                            >
                                                                {validatingSingle ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                                                                {validatingSingle ? "Matching..." : "Single PDF Matching"}
                                                            </Button>
                                                        </div>
                                                    </>
                                                ) : (
                                                    <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center italic">
                                                        <FileText className="w-12 h-12 opacity-10 mb-4" />
                                                        No preview document found
                                                    </div>
                                                )}
                                            </div>
                                        </CardContent>
                                    </Card>
                                </div>
                            )}
                        </div>
                    </>
                )
            }

            {explorationMode === "global" && masterTimeline && (
                <div className={cn(
                    "grid gap-6 transition-all duration-500",
                    panelOpen ? "grid-cols-1 lg:grid-cols-12" : "grid-cols-1"
                )}>
                    {/* Left Side: Global Network */}
                    <div className={cn(
                        "space-y-6 transition-all duration-500",
                        panelOpen ? "lg:col-span-12" : "w-full"
                    )}>
                        <Card className="border-primary/10 shadow-2xl shadow-primary/5 overflow-hidden group/flow rounded-3xl">
                            <CardHeader className="bg-slate-900 border-b py-4 px-8 flex flex-row items-center justify-between space-y-0 text-white">
                                <CardTitle className="text-lg font-bold flex items-center gap-3">
                                    <Maximize className="w-6 h-6 text-primary animate-pulse" />
                                    Master Network Map
                                    <Badge className="ml-2 bg-primary/20 text-primary border-primary/10">
                                        GLOBAL VIEW
                                    </Badge>
                                </CardTitle>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-slate-400 font-mono italic">
                                        {masterTimeline.react_flow_data.nodes.length} nodes extracted across the entire project
                                    </span>
                                </div>
                            </CardHeader>
                            <div className="h-[750px] relative">
                                <ReactFlowHierarchy
                                    data={masterTimeline.react_flow_data}
                                    onNodeClick={handleNodeClick}
                                />
                            </div>
                        </Card>
                    </div>
                </div>
            )}
        </div>
    );
}
