import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, Calendar, MapPin, ArrowRight, Filter, X, FileText, Maximize2, Minimize2, User, Maximize, ShieldCheck, AlertCircle, MessageSquare, Plus, StickyNote, ExternalLink, Loader2, Sparkles, Network, Eye } from "lucide-react";
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
import { useChatWidget } from "@/context/ChatWidgetContext";
import { cn } from "@/lib/utils";
import { API_BASE_URL } from "@/lib/api";
import { landwiseApi } from "@/lib/landwise-api";
import { toast } from "sonner";
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
    sq_feet?: string;
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
    parcelId?: string;
}

export function SurveyTimeline({ requestId, results, parcelId }: SurveyTimelineProps) {
    const getPdfUrl = (relPath: string | undefined) => {
        if (!relPath) return undefined;
        // If it starts with http, it's already an absolute URL
        if (relPath.startsWith('http')) return relPath;

        const BASE_API = API_BASE_URL;
        // Clean any backslashes and normalize path
        let cleaned = relPath.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "").replace(/^\/+/, "");
        
        // Use download-by-path endpoint for reliable file serving
        // This endpoint handles both inputs/ and outputs/ paths correctly
        return `${BASE_API}/api/v1/landwise/documents/download-by-path?file_path=${encodeURIComponent(cleaned)}`;
    };

    // URL-backed search params. Without this, the user's last search was
    // wiped on reload and they were dumped back to the empty "enter a
    // survey number" screen. We use `tlSurvey` + `tlLimit` (rather than
    // bare `survey`/`limit`) to avoid colliding with the standalone
    // /hierarchy page's own URL contract.
    const [searchParams, setSearchParams] = useSearchParams();
    const urlSurvey = searchParams.get("tlSurvey") || "";
    const urlLimit = searchParams.get("tlLimit") || "all";

    const [surveyNumber, setSurveyNumber] = useState(urlSurvey);
    // Keep the input synced to the URL after mount. Needed because parcel
    // switches in the dashboard clear tlSurvey/tlLimit *after* this component
    // remounts — without this sync, the new parcel's input would still show
    // the previous parcel's search until the user typed over it. We only
    // ever write tlSurvey via handleSearch, so when an external clear sets
    // urlSurvey="" we want to mirror that here.
    useEffect(() => {
        setSurveyNumber(urlSurvey);
    }, [urlSurvey]);
    const [explorationMode, setExplorationMode] = useState<"search" | "global">("search");
    const [timeline, setTimeline] = useState<TimelineResult | null>(null);
    const [masterTimeline, setMasterTimeline] = useState<TimelineResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [masterLoading, setMasterLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [transactionLimit, setTransactionLimit] = useState<string>(urlLimit);
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
    // Triggers a precise scroll-to-highlight + amber flash in PdfAnnotator
    // when a PAGE button is clicked from the annotations panel.
    const [focusHighlightId, setFocusHighlightId] = useState<{ id: string; timestamp: number } | undefined>(undefined);
    // Floating PDF popup. Replaces the inline PDF iframe that previously
    // filled the bottom half of the right pane. The metadata + tabs stay
    // visible while the PDF lives in a draggable window the user can
    // position anywhere on screen (including a second monitor).
    const [isPdfPopupOpen, setIsPdfPopupOpen] = useState(false);
    const pdfPopupDragControls = useDragControls();

    // Property-wide ("overall") chatbot — now a global floating widget mounted
    // in AppShell. This page publishes its parcel/request context into it and
    // can open it / push documents into context.
    const { open: openChat, addActiveDoc, setAnalysisContext } = useChatWidget();

    // Close the popup when the user picks a different document, so they
    // don't accidentally read doc A's PDF while the right pane's metadata
    // updates to doc B.
    useEffect(() => {
        setIsPdfPopupOpen(false);
    }, [previewDoc?.docNo]);

    // Click handler for the per-document "PAGE N" buttons in the notes panel.
    // We only fire focusHighlightId — NOT scrollToPage — because the latter
    // builds a stub Highlight with placeholder coords and react-pdf-highlighter
    // renders a temporary yellow indicator at those wrong coords. The
    // focusHighlightId path scrolls AND highlights using the note's real
    // boundingRect, which is what we want.
    const handleFocusLocalNote = useCallback((anno: any) => {
        const page = anno?.position?.pageNumber;
        if (!anno?.id) return;
        setFocusHighlightId({ id: anno.id, timestamp: Date.now() });
        toast.info(`Jumping to page ${page ?? "?"}`, {
            description: anno.comment?.text || anno.content?.text || "",
            duration: 1800,
        });
    }, []);

    // PDF Vault docs: used as a fallback when the timeline data doesn't
    // include a direct PDF URL for a clicked node. We match by document
    // number embedded in the original filename.
    const [vaultDocs, setVaultDocs] = useState<Array<{ id: string; original_filename: string }>>([]);

    useEffect(() => {
        let cancelled = false;
        if (!parcelId) {
            setVaultDocs([]);
            return;
        }
        (async () => {
            try {
                const resp = await landwiseApi.listDocuments(parcelId);
                if (cancelled) return;
                setVaultDocs(resp?.data || []);
            } catch (e) {
                console.error("Failed to load vault docs for fallback preview:", e);
            }
        })();
        return () => { cancelled = true; };
    }, [parcelId]);

    // Helper: look up a matching vault PDF by document number. Tries an
    // exact filename match first, then a normalized substring match
    // (e.g. "1508/2008" matches "1508_2008.pdf" or "doc-1508-2008.pdf").
    const findVaultPdfUrl = useCallback((docNo: string): string | undefined => {
        if (!docNo || vaultDocs.length === 0) return undefined;
        const normalize = (s: string) => (s || "").replace(/[\s\-_/\\]/g, "").toLowerCase();
        const target = normalize(docNo);
        if (!target) return undefined;
        const match = vaultDocs.find((d) => {
            const fn = normalize(d.original_filename);
            return fn.includes(target);
        });
        if (!match) return undefined;
        return `${API_BASE_URL}/api/v1/landwise/documents/download/${match.id}`;
    }, [vaultDocs]);

    const debouncedSaveNote = useDebouncedNoteSaver();

    // Common search runner — used both by the user clicking "Search" and by
    // the on-mount auto-fire below. Takes the query explicitly so the auto-
    // fire can pass URL values without racing against state setters.
    const runSurveySearch = useCallback(async (sn: string, lim: string) => {
        const trimmed = sn.trim();
        if (!trimmed) {
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
                survey_number: trimmed,
                request_id: requestId,
                limit: lim === "all" ? null : parseInt(lim),
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
                        const rfData = timelineData.react_flow_data;
                        const nodes = Array.isArray(rfData?.nodes) ? rfData.nodes : [];
                        if (rfData) {
                            rfData.nodes = nodes.map((node: any) => ({
                                ...node,
                                data: {
                                    ...node.data,
                                    notes: notes[node.data?.document_number] || ""
                                }
                            }));
                        }
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
    }, [requestId]);

    // The button + Enter-key handler. Persists the query into the URL on
    // dispatch (not on response) so even a search that's still in flight
    // survives a reload — the auto-fire effect below will retry it.
    const handleSearch = useCallback(() => {
        const trimmed = surveyNumber.trim();
        if (!trimmed) {
            setError("Please enter a survey number");
            return;
        }
        const next = new URLSearchParams(searchParams);
        next.set("tlSurvey", trimmed);
        if (transactionLimit && transactionLimit !== "all") {
            next.set("tlLimit", transactionLimit);
        } else {
            next.delete("tlLimit");
        }
        setSearchParams(next, { replace: true });
        void runSurveySearch(trimmed, transactionLimit);
    }, [surveyNumber, transactionLimit, searchParams, setSearchParams, runSurveySearch]);

    // Auto-fire the search on mount when the URL already carries a query.
    // Guarded by a ref so it runs exactly once per page load — without this,
    // the effect would re-fire every time the URL was rewritten (which
    // happens on tab clicks via the dashboard's URL sync).
    const autoFiredRef = useRef(false);
    useEffect(() => {
        if (autoFiredRef.current) return;
        if (!requestId) return;
        if (!urlSurvey) return;
        autoFiredRef.current = true;
        void runSurveySearch(urlSurvey, urlLimit);
    }, [requestId, urlSurvey, urlLimit, runSurveySearch]);

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
                    ...(timeline?.react_flow_data ?? {}),
                    nodes: (timeline?.react_flow_data?.nodes ?? []).map((node: any) =>
                        node.data?.document_number === docNo
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

    const handleNodeClick = useCallback((docNo: string, txData?: Transaction | any, position?: { x: number; y: number }) => {
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

        // Find transaction data if not provided (e.g. from table row)
        let activeTx = txData || allPossibleTxs.find(t => normalize(t.document_number) === normDocNo);
        
        // Also locate the corresponding node (to pick display survey/sub-division if richer)
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

        // Last-resort fallback: search the PDF Vault for a document whose
        // filename contains this document number. This kicks in when the
        // timeline pipeline didn't carry a direct file path forward but
        // the user still uploaded the deed via the PDF Vault.
        if (!pdfUrl) {
            const vaultUrl = findVaultPdfUrl(docNo);
            if (vaultUrl) {
                pdfUrl = vaultUrl;
            }
        }

        console.log(`[Preview Search] docNo=${docNo} norm=${normDocNo} pdfUrl=`, pdfUrl);

        // Prefer the clicked node's survey number (which may include subdivision like 13/3) and area.
        // If txData came from ReactFlowHierarchy, it is exactly the clicked node's data.
        let nodeForDoc = txData
            ? { data: txData }
            : allNodes.find(n => n.data?.document_number && normalize(n.data.document_number) === normDocNo);

        const nodeSurvey =
            nodeForDoc?.data?.survey_number ||
            nodeForDoc?.data?.KIDE ||
            nodeForDoc?.data?.kide;

        const nodeArea =
            nodeForDoc?.data?.sq_feet ||
            nodeForDoc?.data?.square_feet;

        const enrichedData = activeTx
            ? {
                ...activeTx,
                survey_number: nodeSurvey || activeTx.survey_number,
                square_feet: nodeArea || activeTx.square_feet,
            }
            : activeTx;

        setPreviewDoc({
            docNo: docNo,
            url: pdfUrl || undefined,
            data: enrichedData,
            validation
        });
        setPanelOpen(true);

        // Cursor-style: a single click on a graph node loads that document into
        // the AI chat context and opens the assistant (no intermediate chooser).
        // Table-row clicks pass no position and simply open the detail panel.
        if (position) {
            addActiveDoc(docNo);
            openChat();
        }
    }, [timeline, results, validationCache, masterTimeline, findVaultPdfUrl, addActiveDoc, openChat]);

    // All document numbers across the active + master timelines — feeds the
    // overall chatbot's @-mention autocomplete.
    const docNumbers = useMemo(() => {
        const set = new Set<string>();
        const collect = (tl: any) => {
            (tl?.react_flow_data?.nodes || []).forEach((n: any) => {
                const d = n?.data?.document_number;
                if (d && d !== "NO TRANSACTION FOUND") set.add(d);
            });
        };
        collect(timeline);
        collect(masterTimeline);
        return Array.from(set).sort();
    }, [timeline, masterTimeline]);

    // Publish this analysis as the global chat widget's context so the floating
    // assistant (mounted in AppShell) knows which property/documents to discuss.
    // Clear it on unmount so other pages fall back to the "select a property"
    // prompt instead of talking about a parcel the user has navigated away from.
    useEffect(() => {
        setAnalysisContext({ requestId, parcelId, docNumbers });
        return () => setAnalysisContext({ docNumbers: [] });
    }, [requestId, parcelId, docNumbers, setAnalysisContext]);

    const getFullSurveyNumber = (data: any): string | undefined => {
        if (!data) return undefined;

        // Prefer KIDE (map key, usually includes subdivision like 13/3) when available
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

        if (baseStr.includes("/") || !sub) return baseStr;
        return `${baseStr}/${sub}`;
    };

    const handleOpenInMap = useCallback(() => {
        if (!previewDoc?.docNo) return;

        const normDoc = (s: string) => s ? s.replace(/\s+/g, '').replace(/[-\/]/g, '').toLowerCase() : '';
        const currentDocNoNorm = normDoc(previewDoc.docNo);

        // Find ALL survey numbers associated with this document across all registries
        const surveysForThisDoc = new Set<string>();

        // 1. Scan search results timeline
        if (timeline?.all_transactions) {
            timeline.all_transactions.forEach((tx: any) => {
                if (normDoc(tx.document_number) === currentDocNoNorm) {
                    const sn = getFullSurveyNumber(tx);
                    if (sn) {
                        sn.split(',').forEach((s: string) => {
                            const trimmed = s.trim();
                            if (trimmed) surveysForThisDoc.add(trimmed);
                        });
                    }
                }
            });
        }

        // 2. Scan master map records for this document
        if (masterTimeline?.all_transactions) {
            masterTimeline.all_transactions.forEach((tx: any) => {
                if (normDoc(tx.document_number) === currentDocNoNorm) {
                    const sn = getFullSurveyNumber(tx);
                    if (sn) {
                        sn.split(',').forEach((s: string) => {
                            const trimmed = s.trim();
                            if (trimmed) surveysForThisDoc.add(trimmed);
                        });
                    }
                }
            });
        }

        // 3. Scan validation results comparisons
        const resultItem = results?.find(r => normDoc(r.document_number) === currentDocNoNorm);
        if (resultItem?.validation_result?.comparisons) {
            resultItem.validation_result.comparisons.forEach((comp: any) => {
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

        // Combine into comma-separated list for MapView multi-highlight
        const allSurveys = Array.from(surveysForThisDoc).join(', ');
        const sn = allSurveys || getFullSurveyNumber(previewDoc.data);

        if (!sn || !previewDoc?.data) return;

        const meta = {
            surveyNumber: sn,
            executant: previewDoc.data.executant,
            claimant: previewDoc.data.claimant,
            nature: previewDoc.data.nature,
            landType: previewDoc.data.nature_of_land,
            area: previewDoc.data.square_feet || previewDoc.data.sq_feet || "N/A",
            docNo: previewDoc.data.document_number,
            date: previewDoc.data.date
        };

        // Save metadata to sessionStorage to avoid passing it in the URL
        if (typeof window !== "undefined") {
            sessionStorage.setItem(`map_meta_${sn}`, JSON.stringify(meta));
            const url = `/map?surveyNumber=${encodeURIComponent(String(sn))}`;
            window.open(url, "_blank");
        }
    }, [previewDoc, timeline, masterTimeline, results]);

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
            <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="relative bg-white border border-indigo-200 rounded-2xl sm:rounded-3xl shadow-sm shadow-indigo-100/40 overflow-hidden"
            >
                {/* Top accent strip */}
                <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-indigo-500 via-blue-500 to-violet-500" />
                {/* Animated background blobs */}
                <div className="pointer-events-none absolute inset-0 opacity-50">
                    <div className="absolute -top-32 -right-32 w-80 h-80 rounded-full bg-gradient-to-br from-blue-200/30 to-indigo-200/30 blur-3xl animate-blob-slow" />
                    <div className="absolute -bottom-32 -left-32 w-80 h-80 rounded-full bg-gradient-to-br from-violet-200/20 to-blue-200/20 blur-3xl animate-blob" />
                </div>

                {/* Compacted from p-5/p-7/p-8 → p-4/p-5/p-6 and shrunk the
                    header + form + buttons by one step. The hero was eating
                    the whole viewport above the fold; the result now leaves
                    room for the search-mode toggle and the proof-center cards
                    without scrolling. */}
                <div className="relative p-4 sm:p-5 lg:p-6">
                    {/* Header */}
                    <div className="flex items-start gap-2.5 mb-4">
                        <div className="relative shrink-0">
                            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500 to-blue-600 rounded-lg blur-md opacity-40 -z-10 animate-pulse-glow" />
                            <div className="w-9 h-9 bg-gradient-to-br from-indigo-600 via-indigo-500 to-blue-600 rounded-lg flex items-center justify-center shadow-md shadow-indigo-500/30 ring-1 ring-white/30">
                                <Search className="w-4 h-4 text-white" strokeWidth={2.5} />
                            </div>
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-base sm:text-lg font-display font-extrabold text-slate-900 tracking-tight flex items-center gap-1.5 flex-wrap">
                                Smart <span className="text-gradient-primary">Lineage Explorer</span>
                                <Sparkles className="w-3.5 h-3.5 text-amber-400 animate-pulse-subtle" />
                            </h3>
                            <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5 font-medium">
                                Trace ownership history through interactive diagrams and instant document previews
                            </p>
                        </div>
                    </div>

                    {/* Form */}
                    <div className="flex flex-col md:flex-row gap-3">
                        <div className="flex-[2] min-w-0">
                            <Label htmlFor="survey-search" className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                                Survey Number
                            </Label>
                            <div className="relative group focus-glow rounded-lg">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 group-focus-within:text-indigo-600 transition-colors" />
                                <Input
                                    id="survey-search"
                                    placeholder="Enter Survey Number (e.g., 47, 47/1, 47/6A3)"
                                    value={surveyNumber}
                                    onChange={(e) => setSurveyNumber(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                                    disabled={loading}
                                    className="pl-9 text-sm h-10 rounded-lg bg-white/80 border-slate-200 shadow-sm focus-visible:ring-2 focus-visible:ring-indigo-500/40 focus-visible:border-indigo-500/40 transition-all"
                                />
                            </div>
                        </div>

                        <div className="flex-1 min-w-0">
                            <Label htmlFor="tx-limit" className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                                History Depth
                            </Label>
                            <Select
                                value={transactionLimit}
                                onValueChange={setTransactionLimit}
                                disabled={loading}
                            >
                                <SelectTrigger id="tx-limit" className="h-10 text-sm rounded-lg bg-white/80 border-slate-200 hover:border-indigo-300 transition-all">
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

                        <div className="flex items-end gap-2 flex-wrap">
                            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                                <Button
                                    onClick={handleSearch}
                                    disabled={loading}
                                    className="h-10 px-4 sm:px-5 text-xs font-bold rounded-lg bg-gradient-to-r from-indigo-600 via-indigo-500 to-blue-600 hover:from-indigo-700 hover:via-indigo-600 hover:to-blue-700 text-white shadow-md shadow-indigo-500/30 hover:shadow-lg hover:shadow-indigo-500/40 shine-sweep transition-all"
                                >
                                    {loading ? (
                                        <span className="flex items-center gap-1.5">
                                            <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                            Analyzing...
                                        </span>
                                    ) : (
                                        <span className="flex items-center gap-1.5">
                                            Explore Lineage
                                            <ArrowRight className="w-3.5 h-3.5" />
                                        </span>
                                    )}
                                </Button>
                            </motion.div>
                            {!loading && (
                                <Button
                                    variant="outline"
                                    className="h-10 px-4 text-xs rounded-lg border-indigo-200 bg-white/80 text-indigo-700 hover:text-indigo-700 font-bold hover:bg-indigo-50 hover:border-indigo-300 transition-all"
                                    onClick={() => setExplorationMode(prev => prev === "search" ? "global" : "search")}
                                >
                                    {explorationMode === "search" ? "View Master Map" : "Back to Search"}
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </motion.div>

            {/* Mode toggle shrunk: h-11 → h-9, rounded-2xl → rounded-xl,
                mb-6 → mb-4. Matches the new hero's compact rhythm so the two
                strips read as a single block instead of competing for height. */}
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="flex items-center gap-1.5 mb-4 sticky top-0 z-40 bg-white/80 backdrop-blur-xl p-1 rounded-xl border border-slate-200 shadow-sm"
            >
                <button
                    onClick={() => setExplorationMode("search")}
                    className={cn(
                        "relative flex-1 flex items-center justify-center gap-1.5 font-bold text-[11px] sm:text-xs h-9 transition-colors rounded-lg",
                        explorationMode === "search" ? "text-white" : "text-slate-500 hover:text-indigo-600"
                    )}
                >
                    {explorationMode === "search" && (
                        <motion.span
                            layoutId="lineage-active-mode"
                            transition={{ type: "spring", stiffness: 380, damping: 30 }}
                            className="absolute inset-0 rounded-lg bg-gradient-to-r from-indigo-600 via-indigo-500 to-blue-600 shadow-md shadow-indigo-500/30"
                        />
                    )}
                    <span className="relative z-10 flex items-center gap-1.5">
                        <Search className="w-3.5 h-3.5" />
                        Property Lineage Search
                    </span>
                </button>
                <button
                    onClick={() => setExplorationMode("global")}
                    className={cn(
                        "relative flex-1 flex items-center justify-center gap-1.5 font-bold text-[11px] sm:text-xs h-9 transition-colors rounded-lg",
                        explorationMode === "global" ? "text-white" : "text-slate-500 hover:text-indigo-600"
                    )}
                >
                    {explorationMode === "global" && (
                        <motion.span
                            layoutId="lineage-active-mode"
                            transition={{ type: "spring", stiffness: 380, damping: 30 }}
                            className="absolute inset-0 rounded-lg bg-gradient-to-r from-indigo-600 via-indigo-500 to-blue-600 shadow-md shadow-indigo-500/30"
                        />
                    )}
                    <span className="relative z-10 flex items-center gap-1.5">
                        <Network className="w-3.5 h-3.5" />
                        Master Network Overview
                    </span>
                </button>

                {/* Property-wide AI assistant launcher — opens the global floating chat. */}
                <button
                    onClick={() => openChat()}
                    className="shrink-0 inline-flex items-center gap-1.5 font-bold text-[11px] sm:text-xs h-9 px-3 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-violet-500/30 hover:from-violet-700 hover:to-indigo-700 transition-all"
                    title="Ask the property AI assistant"
                >
                    <Sparkles className="w-3.5 h-3.5" />
                    Ask AI
                </button>
            </motion.div>


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
                        {/* Mismatch Issues Hub moved to the Overview tab
                            (ParcelOverview in LegalDashboard.tsx) per user
                            request — it surfaced the same parcel-scoped
                            validation_results data and naturally belongs on
                            the dashboard summary page. */}

                        <div className={cn(
                            "grid gap-6 transition-all duration-500",
                            panelOpen ? "grid-cols-1 lg:grid-cols-12" : "grid-cols-1"
                        )}>
                            {/* Left Side: Hierarchy & Timeline.
                                Widened to 9/12 (75%) — the per-doc preview
                                panel only needs 25% now that its header row
                                wraps and its badges have whitespace-nowrap /
                                shrink-0 guards (see the earlier overflow fix
                                in the summary card). */}
                            <div className={cn(
                                "space-y-6 transition-all duration-500",
                                panelOpen ? "lg:col-span-9 xl:col-span-9" : "w-full"
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

                                {timeline?.react_flow_data && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 16 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                                    >
                                    <Card className="relative border-indigo-100 shadow-2xl shadow-indigo-500/10 overflow-hidden group/flow rounded-2xl sm:rounded-3xl">
                                        {/* Top accent strip */}
                                        <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500 z-20" />
                                        <CardHeader className="relative bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 border-b border-indigo-500/20 py-4 px-5 sm:px-7 flex flex-row items-center justify-between gap-4 flex-wrap space-y-0 text-white overflow-hidden">
                                            {/* Background flourish */}
                                            <div className="pointer-events-none absolute inset-0 opacity-50">
                                                <div className="absolute -top-32 right-10 w-72 h-72 rounded-full bg-gradient-to-br from-indigo-500/20 to-violet-500/20 blur-3xl animate-blob-slow" />
                                                <div className="absolute -bottom-32 -left-10 w-72 h-72 rounded-full bg-gradient-to-br from-blue-500/15 to-indigo-500/15 blur-3xl animate-blob" />
                                            </div>
                                            <CardTitle className="relative text-base sm:text-lg font-display font-extrabold flex items-center gap-3 min-w-0 tracking-tight">
                                                <div className="relative shrink-0">
                                                    <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl blur-md opacity-50 -z-10 animate-pulse-glow" />
                                                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 via-indigo-500 to-blue-500 flex items-center justify-center shadow-lg shadow-indigo-500/40 ring-1 ring-white/20">
                                                        <MapPin className="w-5 h-5 text-white" strokeWidth={2.5} />
                                                    </div>
                                                </div>
                                                <span className="truncate">Interactive Ownership Flow</span>
                                                <Badge className="ml-1 bg-indigo-500/25 text-indigo-200 border-indigo-400/30 hover:bg-indigo-500/30 text-[10px] font-bold uppercase tracking-[0.18em] px-2.5 py-1 inline-flex items-center gap-1.5 shrink-0">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-300 animate-pulse-glow" />
                                                    {timeline.react_flow_data.nodes?.length || 0} Nodes Found
                                                </Badge>
                                            </CardTitle>
                                            <div className="relative flex items-center gap-2 shrink-0">
                                                <div className="flex gap-1.5 mr-2">
                                                    <Badge variant="outline" className="border-emerald-500/50 text-emerald-300 bg-emerald-500/10 text-[10px] font-bold uppercase tracking-[0.16em] inline-flex items-center gap-1.5">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Sale
                                                    </Badge>
                                                    <Badge variant="outline" className="border-rose-500/50 text-rose-300 bg-rose-500/10 text-[10px] font-bold uppercase tracking-[0.16em] inline-flex items-center gap-1.5">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-rose-400" /> Mortgage
                                                    </Badge>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-9 w-9 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-all hover:scale-105"
                                                    title="Open in Full View"
                                                    onClick={() => {
                                                        // Pass parcelId so the HierarchyPage's Notes Hub
                                                        // can fetch parcel-wide annotations.
                                                        const params = new URLSearchParams({
                                                            requestId: requestId || '',
                                                            surveyNumber: surveyNumber || '',
                                                            limit: String(transactionLimit ?? ''),
                                                        });
                                                        if (parcelId) params.set('parcelId', parcelId);
                                                        window.open(`/hierarchy?${params.toString()}`, '_blank');
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
                                                validationResults={results}
                                            />
                                        </CardContent>
                                    </Card>
                                    </motion.div>
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
                                                    {(timeline?.all_transactions ?? []).map((tx, idx) => (
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
                                            {(timeline?.all_transactions?.length ?? 0) === 0 && (
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
                                    fullScreenPreview ? "fixed inset-0 z-50 bg-background" : "lg:col-span-3 xl:col-span-3"
                                )}>
                                    {/* Non-fullscreen height switched from the hardcoded `h-[800px]`
                                        to `h-auto max-h-[calc(100vh-6rem)]`. The 800px was sized for the
                                        old inline PDF iframe; now that the PDF lives in a draggable
                                        floating popup, the Card was leaving ~500px of empty whitespace
                                        below the buttons. `h-auto` lets it hug the metadata + tabs +
                                        compact source strip; the max-height cap keeps it from scrolling
                                        the page on very tall content. */}
                                    <Card className={cn(
                                        "border-primary/20 shadow-2xl flex flex-col overflow-hidden sticky top-6",
                                        fullScreenPreview
                                            ? "h-screen border-none rounded-none"
                                            // Summary view hugs its content (h-auto) so the compact panel
                                            // doesn't leave whitespace. But the Chatbot / Notes overlays are
                                            // absolutely positioned (top-0 bottom-0) and contribute no height
                                            // to an h-auto parent — they collapsed to ~0px, which is why the
                                            // chat "wouldn't open". Give the panel the full available height
                                            // whenever a non-summary tab is active so the overlay has room.
                                            : activeTab === "summary"
                                                ? "h-auto max-h-[calc(100vh-6rem)]"
                                                : "h-[calc(100vh-6rem)]"
                                    )}>
                                        {/* Header tightened to match the slimmer 25% panel:
                                            padding py-3 px-4 → py-2 px-3, icon tile p-1.5 → p-1,
                                            doc-no font text-sm → text-xs, buttons h-8 w-8 → h-7 w-7.
                                            max-w on the docNo drops from 150 → 110 since the row
                                            has less available width. */}
                                        <CardHeader className="bg-primary text-primary-foreground py-2 px-3 flex flex-row items-center justify-between space-y-0">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                <div className="p-1 bg-white/20 rounded-md shrink-0">
                                                    <FileText className="w-3.5 h-3.5" />
                                                </div>
                                                <div className="flex flex-col min-w-0">
                                                    <span className="text-[9px] opacity-70 leading-none">PROPERTIES OF</span>
                                                    <span className="text-xs font-bold truncate max-w-[110px]">{previewDoc?.docNo}</span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-0.5 shrink-0">
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="h-7 w-7 hover:bg-white/20 text-white"
                                                    onClick={() => setFullScreenPreview(!fullScreenPreview)}
                                                >
                                                    {fullScreenPreview ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className={cn(
                                                        "h-7 w-7 hover:bg-white/20 text-white transition-all relative",
                                                        isNotesVisible ? "bg-amber-400 text-amber-950 shadow-inner" : ""
                                                    )}
                                                    onClick={() => setIsNotesVisible(!isNotesVisible)}
                                                    title={isNotesVisible ? "Hide Notes" : "View/Add Notes"}
                                                >
                                                    <StickyNote className={cn("w-3.5 h-3.5 transition-all duration-300", isNotesVisible ? "scale-110" : "")} />
                                                    {!isNotesVisible && timeline?.react_flow_data.nodes.find(n => n.data.document_number === previewDoc?.docNo)?.data.notes && (
                                                        <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-amber-400 rounded-full border border-primary animate-pulse" />
                                                    )}
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="h-7 w-7 hover:bg-white/20 text-white"
                                                    onClick={() => { setPanelOpen(false); setFullScreenPreview(false); }}
                                                >
                                                    <X className="w-3.5 h-3.5" />
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
                                                // z-[150] sits above PdfAnnotator's TEXT/DRAW toggle (z-100) and the
                                                // Single-PDF-Matching button (z-30) so the chat overlay isn't
                                                // pierced by PDF chrome. Buttons stay in the DOM and reappear
                                                // when the chat tab closes.
                                                <div className="absolute inset-x-0 top-0 bottom-0 z-[150] animate-in slide-in-from-right duration-300">
                                                    <DocChat
                                                        docNo={previewDoc.docNo}
                                                        requestId={requestId}
                                                        onClose={() => setActiveTab("summary")}
                                                        onPageClick={(page) => {
                                                            // Same pattern as the in-summary page pills:
                                                            // chatbot citations now open the PDF popup so
                                                            // the user actually lands on the cited page.
                                                            setIsPdfPopupOpen(true);
                                                            setScrollToPage({ page, timestamp: Date.now() });
                                                        }}
                                                    />
                                                </div>
                                            )}

                                            {activeTab === "annotations" && previewDoc && (
                                                <div className="absolute inset-x-0 top-0 bottom-0 z-[150] animate-in slide-in-from-right duration-300 bg-white flex flex-col p-4 border-b">
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
                                                            pdfAnnotations.map((anno: any) => {
                                                                const pageNum = anno.position?.pageNumber;
                                                                return (
                                                                    <Card
                                                                        key={anno.id}
                                                                        className="p-2 border-primary/5 bg-slate-50/50 hover:border-primary/30 hover:shadow-sm transition-all cursor-pointer group"
                                                                        onClick={() => handleFocusLocalNote(anno)}
                                                                        role="button"
                                                                        tabIndex={0}
                                                                        onKeyDown={(e) => {
                                                                            if (e.key === "Enter" || e.key === " ") {
                                                                                e.preventDefault();
                                                                                handleFocusLocalNote(anno);
                                                                            }
                                                                        }}
                                                                        title={`Open page ${pageNum ?? "?"} in the PDF`}
                                                                    >
                                                                        <div className="flex flex-col gap-1">
                                                                            <div className="flex items-center justify-between">
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={(e) => {
                                                                                        e.stopPropagation();
                                                                                        handleFocusLocalNote(anno);
                                                                                    }}
                                                                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-extra-bold uppercase tracking-wider bg-gradient-to-r from-violet-600 via-indigo-600 to-blue-600 text-white shadow-sm hover:shadow hover:scale-[1.03] active:scale-[0.97] transition-all"
                                                                                    title={`Open page ${pageNum ?? "?"} in the PDF`}
                                                                                >
                                                                                    <ArrowRight className="w-2.5 h-2.5" />
                                                                                    PAGE {pageNum ?? "?"}
                                                                                </button>
                                                                                <span className="text-[8px] font-bold text-slate-400 uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity">
                                                                                    Click to jump
                                                                                </span>
                                                                            </div>
                                                                            <p className="text-[10px] font-bold text-slate-800 line-clamp-2 mt-1">"{anno.content?.text || 'Area selection'}"</p>
                                                                            <div className="flex items-start gap-1.5 mt-1 p-1.5 bg-white rounded border border-slate-100">
                                                                                <MessageSquare className="w-2.5 h-2.5 text-primary shrink-0 mt-0.5" />
                                                                                <p className="text-[9px] text-slate-600 italic leading-snug">{anno.comment?.text}</p>
                                                                            </div>
                                                                        </div>
                                                                    </Card>
                                                                );
                                                            })
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

                                                        <div className="flex items-center justify-between gap-4 pt-2 border-t border-slate-50">
                                                            <div className="flex items-center gap-1.5 text-xs">
                                                                <Maximize className="w-3.5 h-3.5 text-primary/70 shrink-0" />
                                                                <span className="font-bold text-slate-700">
                                                                    Area: {previewDoc.data.square_feet && previewDoc.data.square_feet !== 'N/A' ? previewDoc.data.square_feet : 'N/A (check deed)'}
                                                                </span>
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                <div className="flex items-center gap-1.5 text-xs">
                                                                    <MapPin className="w-3.5 h-3.5 text-primary/70 shrink-0" />
                                                                    <span className="font-bold text-slate-700">
                                                                        S.No: {getFullSurveyNumber(previewDoc.data)}
                                                                    </span>
                                                                </div>
                                                                {getFullSurveyNumber(previewDoc.data) && (
                                                                    <Button
                                                                        variant="outline"
                                                                        size="sm"
                                                                        className="h-7 px-2 text-[10px] font-bold flex items-center gap-1"
                                                                        onClick={handleOpenInMap}
                                                                    >
                                                                        <MapPin className="w-3 h-3" />
                                                                        View on Map
                                                                    </Button>
                                                                )}
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
                                                                                {supDoc.page_number && (() => {
                                                                                    // Strip any "Page" / "Pages" prefix and grab the
                                                                                    // first integer so the label reads "View on Page 2"
                                                                                    // instead of "View on Page Page 2, 15".
                                                                                    const m = String(supDoc.page_number).match(/\d+/);
                                                                                    const pg = m ? parseInt(m[0]) : null;
                                                                                    if (pg === null) return null;
                                                                                    return (
                                                                                        <Button
                                                                                            variant="ghost"
                                                                                            size="sm"
                                                                                            className="h-6 mt-2 text-[10px] font-bold bg-white/50 hover:bg-white text-slate-600 border border-slate-200"
                                                                                            onClick={() => {
                                                                                                setIsPdfPopupOpen(true);
                                                                                                setScrollToPage({ page: pg, timestamp: Date.now() });
                                                                                            }}
                                                                                        >
                                                                                            <ArrowRight className="w-3 h-3 mr-1" />
                                                                                            View on Page {pg}
                                                                                        </Button>
                                                                                    );
                                                                                })()}
                                                                            </div>
                                                                        );
                                                                    }
                                                                    return null;
                                                                })()}

                                                                {/* Summary Card — shrunk again because the docNo
                                                                    was still wrapping ("5829/2" / "010") at the
                                                                    25% panel width. docNo text-lg → text-sm,
                                                                    MATCH badge text-[11px] → text-[9px],
                                                                    trustability badge text-xs h-7 → text-[10px] h-5. */}
                                                                <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
                                                                    <div className="p-2.5 border-b bg-slate-50/50 flex items-start justify-between gap-1.5 flex-wrap cursor-pointer" onClick={() => { /* Toggle logic could go here, for now simpler */ }}>
                                                                        <div className="min-w-0 flex-1">
                                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                                <span className="text-sm font-bold text-slate-800">{previewDoc.docNo}</span>
                                                                                <Badge className={cn("text-[9px] font-bold px-1.5 py-0 h-4", previewDoc.validation.match ? "bg-green-500 hover:bg-green-600" : "bg-red-500 hover:bg-red-600")}>
                                                                                    {previewDoc.validation.match ? "MATCH" : "MISMATCH"}
                                                                                </Badge>
                                                                            </div>
                                                                            <p className="text-[10px] text-slate-500 font-medium mt-0.5">
                                                                                {previewDoc.validation.comparisons.filter((c: any) => c.status.includes("MATCHED")).length} / {previewDoc.validation.comparisons.length} fields matched
                                                                            </p>
                                                                        </div>
                                                                        {/* Trustability Score */}
                                                                        {previewDoc.validation.trustability_score !== undefined && (
                                                                            <div className="flex flex-col items-end shrink-0">
                                                                                <Badge variant="default" className={cn(
                                                                                    "text-[10px] font-bold h-5 px-1.5 transition-all whitespace-nowrap",
                                                                                    previewDoc.validation.trustability_score >= 80 ? "bg-green-500 hover:bg-green-600" :
                                                                                        previewDoc.validation.trustability_score >= 50 ? "bg-orange-500 hover:bg-orange-600" : "bg-red-500 hover:bg-red-600"
                                                                                )}>
                                                                                    {previewDoc.validation.trustability_score}% | {previewDoc.validation.trustability_score >= 90 ? "Trustable" : previewDoc.validation.trustability_score >= 70 ? "Good" : "Needs Review"}
                                                                                </Badge>
                                                                                <span className="text-[8px] text-slate-400 mt-0.5 italic whitespace-nowrap">
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
                                                                                <div key={idx} className={cn("p-3 rounded-xl border border-l-4 transition-all shadow-sm hover:shadow-md", statusColor, isMatched ? "border-l-green-500" : isPartial ? "border-l-amber-500" : "border-l-red-500")}>
                                                                                    {/* Header row uses flex-wrap + min-w-0 so the field
                                                                                        title can shrink and the badge group drops to a
                                                                                        second line instead of being clipped. Previously
                                                                                        "Document Number" was forced into two lines because
                                                                                        the row tried to fit Page pill + MATCHED badge on
                                                                                        the same line — that badge ended up cropped to
                                                                                        "MATCHE...". */}
                                                                                    <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                                                                                        <h4 className="text-xs font-bold text-slate-800 min-w-0 break-words">{comp.field}</h4>
                                                                                        <div className="flex items-center gap-1.5 shrink-0">
                                                                                            {comp.page_number && (() => {
                                                                                                // The AI sometimes returns page_number as a
                                                                                                // bare number ("2"), sometimes as "Page 2",
                                                                                                // sometimes as "Pages 2, 15". Extract the
                                                                                                // first integer to keep the click target
                                                                                                // sane and avoid rendering "PAGE PAGE 2".
                                                                                                const m = String(comp.page_number).match(/\d+/);
                                                                                                const pg = m ? parseInt(m[0]) : null;
                                                                                                if (pg === null) return null;
                                                                                                return (
                                                                                                    <div
                                                                                                        className="flex items-center gap-1 bg-white px-1.5 py-0.5 rounded-md border border-slate-200 shadow-sm cursor-pointer hover:bg-blue-50 hover:border-blue-200 transition-all active:scale-95"
                                                                                                        onClick={(e) => {
                                                                                                            e.stopPropagation();
                                                                                                            // Open the draggable PDF popup AND tell its
                                                                                                            // PdfAnnotator to land on this page. Previously
                                                                                                            // the click only set scrollToPage, which did
                                                                                                            // nothing when the popup was closed — the user
                                                                                                            // saw the "Jump to Page N" tooltip but nothing
                                                                                                            // visible happened. React 18 batches both state
                                                                                                            // updates, so PdfAnnotator mounts with the
                                                                                                            // scrollToPage prop already set.
                                                                                                            setIsPdfPopupOpen(true);
                                                                                                            setScrollToPage({ page: pg, timestamp: Date.now() });
                                                                                                        }}
                                                                                                        title={`Jump to Page ${pg}`}
                                                                                                    >
                                                                                                        <Plus className="w-2.5 h-2.5 text-slate-400" />
                                                                                                        <span className="text-[9px] font-bold text-slate-600 uppercase whitespace-nowrap">Page {pg}</span>
                                                                                                    </div>
                                                                                                );
                                                                                            })()}
                                                                                            <Badge className={cn("text-[9px] h-5 px-2 whitespace-nowrap", badgeColor)}>
                                                                                                {isMatched ? <ShieldCheck className="w-2.5 h-2.5 mr-0.5" /> : <AlertCircle className="w-2.5 h-2.5 mr-0.5" />}
                                                                                                {isMatched ? "MATCHED" : isPartial ? "PARTIAL" : "MISMATCH"}
                                                                                            </Badge>
                                                                                        </div>
                                                                                    </div>

                                                                                    {/* Tighter EC/Doc rows. Label column 80px → 64px,
                                                                                        text-xs → text-[10px], so the value chip has
                                                                                        more room and doesn't wrap awkwardly inside the
                                                                                        narrow 25% panel. */}
                                                                                    <div className="space-y-1.5 mb-2">
                                                                                        <div className="grid grid-cols-[64px_1fr] items-baseline gap-1.5">
                                                                                            <span className={cn("text-[10px] font-bold uppercase tracking-wider text-right", titleColor)}>EC Value:</span>
                                                                                            <span className="text-[10px] font-semibold text-slate-700 font-mono bg-white/50 px-1.5 py-0.5 rounded border border-black/5 w-fit break-all">
                                                                                                {comp.ec_value || "N/A"}
                                                                                            </span>
                                                                                        </div>
                                                                                        <div className="grid grid-cols-[64px_1fr] items-baseline gap-1.5">
                                                                                            <span className={cn("text-[10px] font-bold uppercase tracking-wider text-right", titleColor)}>Doc Value:</span>
                                                                                            <span className="text-[10px] font-semibold text-slate-900 font-mono bg-white px-1.5 py-0.5 rounded border border-black/10 w-fit shadow-sm break-all">
                                                                                                {comp.metadata_value || "N/A"}
                                                                                            </span>
                                                                                        </div>
                                                                                    </div>

                                                                                    <p className={cn("text-[10px] italic font-medium pt-1.5 border-t border-black/5", titleColor)}>
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

                                            {/* Dropped the `flex-1` here. Previously the child was a
                                                full-height <PdfAnnotator> that genuinely needed to stretch
                                                — now it's a 50px-tall horizontal strip, and `flex-1`
                                                was producing the empty whitespace below the buttons.
                                                Use `shrink-0` so this strip sits at its natural height
                                                and the column above it can take whatever space remains. */}
                                            <div className="shrink-0 relative group">
                                                {previewDoc?.url ? (
                                                    /* Compact source-document footer. Stacked vertically
                                                       (docNo row → button row) because at the current
                                                       25% panel width the inline layout truncated the
                                                       docNo to zero — the Preview + Match buttons claimed
                                                       all the horizontal space. Keeping the strip at the
                                                       same total height by using tight gaps. */
                                                    <div className="px-3 py-2 flex flex-col gap-1.5 border-t border-slate-100">
                                                        <div className="flex items-center gap-2 min-w-0">
                                                            <div className="w-5 h-5 rounded-md bg-indigo-50 flex items-center justify-center shrink-0">
                                                                <FileText className="w-3 h-3 text-indigo-600" />
                                                            </div>
                                                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">
                                                                Source
                                                            </span>
                                                            <span className="text-[11px] font-black text-slate-900 tabular-nums truncate">
                                                                {previewDoc.docNo}
                                                            </span>
                                                        </div>
                                                        <button
                                                            onClick={() => setIsPdfPopupOpen(true)}
                                                            className="w-full inline-flex items-center justify-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[10px] uppercase tracking-wider px-2 h-7 rounded-md shadow-sm transition-all"
                                                            title="Open the document in a draggable preview window"
                                                        >
                                                            <Eye className="w-3 h-3" />
                                                            Preview
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <motion.div
                                                        initial={{ opacity: 0, y: 8 }}
                                                        animate={{ opacity: 1, y: 0 }}
                                                        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                                                        className="relative w-full h-full flex flex-col items-center justify-center p-8 text-center overflow-hidden"
                                                    >
                                                        <div className="pointer-events-none absolute inset-0 opacity-50">
                                                            <div className="absolute -top-32 -left-20 w-72 h-72 rounded-full bg-gradient-to-br from-indigo-200/30 to-blue-200/30 blur-3xl animate-blob-slow" />
                                                            <div className="absolute -bottom-32 -right-20 w-72 h-72 rounded-full bg-gradient-to-br from-violet-200/25 to-indigo-200/25 blur-3xl animate-blob" />
                                                        </div>
                                                        <motion.div
                                                            initial={{ scale: 0.7, opacity: 0 }}
                                                            animate={{ scale: 1, opacity: 1 }}
                                                            transition={{ delay: 0.05, duration: 0.55, ease: [0.34, 1.56, 0.64, 1] }}
                                                            className="relative w-20 h-20 mb-5"
                                                        >
                                                            <div className="absolute inset-0 bg-gradient-to-br from-indigo-400 to-blue-500 rounded-3xl blur-2xl opacity-30 animate-pulse-glow" />
                                                            <div className="relative w-20 h-20 bg-white rounded-3xl flex items-center justify-center shadow-xl border border-slate-100 ring-4 ring-white animate-float">
                                                                <FileText className="w-9 h-9 text-indigo-300" strokeWidth={1.4} />
                                                            </div>
                                                            <motion.div
                                                                initial={{ scale: 0 }}
                                                                animate={{ scale: 1 }}
                                                                transition={{ delay: 0.4, duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
                                                                className="absolute -top-1 -right-1 w-7 h-7 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-md ring-2 ring-white"
                                                            >
                                                                <AlertCircle className="w-3.5 h-3.5 text-white" />
                                                            </motion.div>
                                                        </motion.div>
                                                        <h3 className="relative text-base font-display font-extrabold text-slate-700 tracking-tight">
                                                            <span className="text-gradient-primary">No preview</span>
                                                            <span className="text-slate-700"> available</span>
                                                        </h3>
                                                        <p className="relative text-xs text-slate-500 font-medium mt-2 max-w-xs leading-relaxed">
                                                            We couldn&apos;t locate the source PDF for this deed. It may not have been uploaded to the vault, or the file path is unresolved.
                                                        </p>
                                                        <div className="relative mt-4 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
                                                            <Sparkles className="w-3 h-3 text-amber-400" />
                                                            Upload to PDF Vault to enable preview
                                                        </div>
                                                    </motion.div>
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
                        <motion.div
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                        >
                        <Card className="relative border-indigo-100 shadow-2xl shadow-indigo-500/10 overflow-hidden group/flow rounded-2xl sm:rounded-3xl">
                            {/* Top accent strip */}
                            <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500 z-20" />
                            <CardHeader className="relative bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 border-b border-indigo-500/20 py-4 px-5 sm:px-7 flex flex-row items-center justify-between gap-4 flex-wrap space-y-0 text-white overflow-hidden">
                                <div className="pointer-events-none absolute inset-0 opacity-50">
                                    <div className="absolute -top-32 right-10 w-72 h-72 rounded-full bg-gradient-to-br from-violet-500/20 to-indigo-500/20 blur-3xl animate-blob-slow" />
                                    <div className="absolute -bottom-32 -left-10 w-72 h-72 rounded-full bg-gradient-to-br from-blue-500/15 to-violet-500/15 blur-3xl animate-blob" />
                                </div>
                                <CardTitle className="relative text-base sm:text-lg font-display font-extrabold flex items-center gap-3 min-w-0 tracking-tight">
                                    <div className="relative shrink-0">
                                        <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl blur-md opacity-50 -z-10 animate-pulse-glow" />
                                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 via-indigo-500 to-blue-500 flex items-center justify-center shadow-lg shadow-indigo-500/40 ring-1 ring-white/20">
                                            <Network className="w-5 h-5 text-white" strokeWidth={2.5} />
                                        </div>
                                    </div>
                                    <span className="truncate">Master Network Map</span>
                                    <Badge className="ml-1 bg-indigo-500/25 text-indigo-200 border-indigo-400/30 hover:bg-indigo-500/30 text-[10px] font-bold uppercase tracking-[0.18em] px-2.5 py-1 inline-flex items-center gap-1.5 shrink-0">
                                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-300 animate-pulse-glow" />
                                        Global View
                                    </Badge>
                                </CardTitle>
                                <div className="relative flex items-center gap-2 shrink-0">
                                    <span className="text-[10px] sm:text-xs font-mono font-bold text-indigo-200/80 tracking-tight tabular-nums">
                                        {masterTimeline.react_flow_data.nodes.length} nodes · entire project
                                    </span>
                                </div>
                            </CardHeader>
                            <div className="h-[750px] relative bg-gradient-to-br from-slate-50 via-white to-indigo-50/30">
                                <ReactFlowHierarchy
                                    data={masterTimeline.react_flow_data}
                                    onNodeClick={handleNodeClick}
                                    validationResults={results}
                                />
                            </div>
                        </Card>
                        </motion.div>
                    </div>
                </div>
            )}

            {/* ─── Floating draggable PDF popup ────────────────────────────
                Mounted at the component root so it floats above everything,
                including the master-network-map and the right-pane card.
                Same architecture as the HierarchyTab popup:
                  - dragListener={false} + onPointerDown on the header strip
                    means only the header drags; the PDF body keeps normal
                    scroll / text-selection / annotation behavior
                  - dragMomentum={false} so it stops where you release
                  - AnimatePresence handles the scale-from-0.92 enter/exit
                  - Auto-closes on previewDoc.docNo change (see useEffect)
            */}
            <AnimatePresence>
                {isPdfPopupOpen && previewDoc?.url && (
                    <motion.div
                        drag
                        dragControls={pdfPopupDragControls}
                        dragListener={false}
                        dragMomentum={false}
                        dragElastic={0}
                        initial={{ opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.92 }}
                        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        className="fixed top-20 right-8 z-[200] w-[680px] max-w-[92vw] h-[82vh] rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/30 overflow-hidden flex flex-col select-none"
                    >
                        <div
                            onPointerDown={(e) => pdfPopupDragControls.start(e)}
                            className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-100 bg-gradient-to-r from-indigo-50/70 via-white to-violet-50/70 cursor-move"
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center shrink-0 shadow-sm">
                                    <FileText className="w-3.5 h-3.5 text-white" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[9px] font-black uppercase tracking-widest text-indigo-700 leading-none">
                                        Document Preview
                                    </p>
                                    <p className="text-xs font-black text-slate-900 truncate">
                                        {previewDoc.docNo}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <Button
                                    size="sm"
                                    className="h-7 bg-primary hover:bg-primary/90 text-white font-bold text-[10px] uppercase tracking-wider gap-1.5 px-2.5"
                                    onClick={handleSinglePdfMatch}
                                    disabled={validatingSingle}
                                    title="Re-match this PDF against the EC"
                                >
                                    {validatingSingle ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                                    {validatingSingle ? "Matching" : "Match"}
                                </Button>
                                <button
                                    onClick={() => setIsPdfPopupOpen(false)}
                                    className="p-1.5 hover:bg-white rounded-lg transition-all text-slate-400 hover:text-indigo-600"
                                    title="Close preview"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 min-h-0 bg-slate-900 relative">
                            <PdfAnnotator
                                url={previewDoc.url}
                                docId={previewDoc.docNo}
                                parcelId={parcelId}
                                onAnnotationChange={(h) => setPdfAnnotations(h)}
                                scrollToPage={scrollToPage}
                                focusHighlightId={focusHighlightId}
                            />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* The property-wide AI assistant is a global floating widget mounted
                in AppShell; it reads this page's context via useChatWidget(). */}
        </div>
    );
}
