import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import ReactMarkdown from 'react-markdown';
import { useSearchParams } from "react-router-dom";
import { 
  Search, 
  Filter, 
  MapPin, 
  ShieldCheck, 
  AlertTriangle, 
  CheckCircle2, 
  Clock, 
  Users, 
  ChevronDown, 
  LayoutDashboard, 
  FileText, 
  Layers, 
  Settings, 
  Bell, 
  MoreVertical,
  Activity,
  Plus,
  Zap,
  X,
  ArrowRight,
  Upload,
  Share2,
  Info,
  ChevronRight,
  RefreshCcw,
  Download,
  AlertCircle,
  FileSignature,
  FolderArchive,
  PlayCircle,
  SearchCode,
  Eye,
  Calculator,
  RotateCw,
  Trash2,
  Calendar,
  CalendarDays,
  ShieldAlert,
  Building,
  GanttChart,
  Scale,
  Landmark,
  TreePine,
  Factory,
  HardHat,
  Home,
  CalendarIcon,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Menu,
  ScrollText,
  Gavel,
  XCircle,
  StickyNote,
  PanelLeftClose,
  PanelLeftOpen,
  Loader2,
  Circle
} from "lucide-react";
import NotesSummary, { type NoteJumpTarget } from "@/features/notes/components/NotesSummary";
import { useHeaderSlot } from "@/components/AppShell";
import { useAuth } from "@/context/AuthContext";
import { SurveyTimeline } from "@/features/timeline/components/SurveyTimeline";
import { 
  ResizableHandle, 
  ResizablePanel, 
  ResizablePanelGroup 
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ParcelWorkspaceLayout from "@/components/ParcelWorkspaceLayout";
import OverallChat from "@/features/analysis/components/OverallChat";
import { DocumentAnalysisRevamp } from "@/features/analysis/components/DocumentAnalysisRevamp";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarUI } from "@/components/ui/calendar";
import { format } from "date-fns";
import { cn, coerceMatchCount } from "@/lib/utils";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { landwiseApi } from "@/lib/landwise-api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogDescription,
  DialogFooter,
  DialogTrigger
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ReactFlowHierarchy } from "@/features/hierarchy/components/ReactFlowHierarchy";
import PdfAnnotator from "@/features/analysis/components/PdfAnnotator";
import DocChat from "@/features/analysis/components/DocChat";
import { ValidationResults } from "@/features/analysis/components/AnalysisDashboard";
import { RiskScoreCard } from "@/features/analysis/components/RiskScoreCard";
import LiveAnalysisProgress, { type AnalysisStep } from "@/features/analysis/components/LiveAnalysisProgress";
import { LANDWISE_CHECKS, ALL_CHECK_IDS, AUTOMATED_CHECK_IDS, CHECK_CATEGORIES, getSelectedChecks, hasSavedChecks, setSelectedChecks as persistSelectedChecks } from "@/lib/landwise-checks";
import { getFileUrl, API_BASE_URL } from "@/lib/api";

interface Project {
  id: string;
  name: string;
  description: string;
  district: string;
  state: string;
  status: string;
  parcel_count: number;
}

interface Parcel {
  id: string;
  survey_number: string;
  subdivision: string | null;
  village: string;
  taluk: string;
  status: string;
  risk_score: number;
  completion_score: number;
  doc_completeness_pct: number;
  updated_at: string;
  last_analysis_request_id?: string;
}

interface LandwiseDocument {
  id: string;
  original_filename: string;
  document_type: string;
  language: string;
  extraction_status: string;
  extraction_confidence: number | null;
  uploaded_at: string;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

// Pipeline stages streamed by the analyze workflow — used by the live progress
// overlay. Ids match the backend `step` values in the ndjson event stream.
const ANALYZE_STEPS: AnalysisStep[] = [
  { id: "ec_extraction", label: "EC Extraction", status: "pending" },
  { id: "matching", label: "Document Matching", status: "pending" },
  { id: "sale_deed_extraction", label: "Sale Deed Extraction", status: "pending" },
  { id: "hierarchy", label: "Hierarchy Generation", status: "pending" },
  { id: "validation", label: "Validation", status: "pending" },
];

export default function LegalDashboard() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // Seed all routable state from the URL so a hard reload lands the user
  // exactly where they were. Previously only `projectId` was persisted, so
  // reloading from Overview / Document Analysis / Hierarchy tabs reset
  // `selectedParcelId` to null and dropped the user back to the parcel
  // listing. Now `parcelId` and `tab` are also URL-backed.
  const urlProjectId = searchParams.get("projectId");
  const urlParcelId = searchParams.get("parcelId");
  const urlTab = searchParams.get("tab");

  const isDesktop = useMediaQuery("(min-width: 768px)");

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(urlProjectId);
  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(urlParcelId);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<string>(urlTab || "overview");
  // Global "Ask AI" property assistant — available on every workspace tab.
  const [askAiOpen, setAskAiOpen] = useState(false);
  // Document the Risk Score tab asked us to focus inside Document Analysis.
  const [docAnalysisFocusDoc, setDocAnalysisFocusDoc] = useState<string | null>(null);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isBatchAuditModalOpen, setIsBatchAuditModalOpen] = useState(false);
  // Checklist popup shown after Batch Audit upload; on approve it starts the run.
  const [checklistOpen, setChecklistOpen] = useState(false);
  // Files attached in Batch Audit, held until the user approves the checklist —
  // only THEN are they uploaded and the analysis started.
  const [pendingBatch, setPendingBatch] = useState<{ ec: File; zip: File; limit?: number } | null>(null);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [hierarchyPreview, setHierarchyPreview] = useState<any>(null);
  // Parcel-wide Notes Hub. Aggregates every note across every PDF for the
  // selected parcel; clicking a note opens HierarchyPage at that document
  // with the highlight scrolled into view and flashed.
  const [notesSummaryOpen, setNotesSummaryOpen] = useState(false);
  // Sidebar collapse — managed via ResizablePanel's imperative API so the
  // resize handle stays consistent with the rest of the layout. `collapsed`
  // mirrors panel state for rendering an expand button inside the strip.
  const sidebarPanelRef = useRef<any>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // The parcel breadcrumb + tab strip + Notes Hub + user info are
  // injected into AppShell's header so they share a row with the brand +
  // logout button. Without this, two header rows stack vertically.
  const { setHeaderSlot } = useHeaderSlot();

  // Auto-close mobile sidebar when a parcel is selected
  useEffect(() => {
    if (!isDesktop && selectedParcelId) {
      setMobileSidebarOpen(false);
    }
  }, [selectedParcelId, isDesktop]);

  // Reflect projectId / parcelId / tab back into the URL so refresh,
  // browser-back, copy-link and external deep-link all behave correctly.
  // `replace: true` keeps tab clicks out of browser history. We mutate a
  // fresh URLSearchParams (rather than passing an object) so the three
  // params don't clobber each other in the same render. `tab=overview` is
  // the default and omitted to keep clean URLs on the landing view.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;

    if (selectedProjectId) {
      if (next.get("projectId") !== selectedProjectId) {
        next.set("projectId", selectedProjectId);
        changed = true;
      }
    } else if (next.has("projectId")) {
      next.delete("projectId");
      changed = true;
    }

    if (selectedParcelId) {
      if (next.get("parcelId") !== selectedParcelId) {
        next.set("parcelId", selectedParcelId);
        changed = true;
      }
    } else if (next.has("parcelId")) {
      next.delete("parcelId");
      changed = true;
    }

    if (activeTab && activeTab !== "overview") {
      if (next.get("tab") !== activeTab) {
        next.set("tab", activeTab);
        changed = true;
      }
    } else if (next.has("tab")) {
      next.delete("tab");
      changed = true;
    }

    if (changed) {
      setSearchParams(next, { replace: true });
    }
  }, [selectedProjectId, selectedParcelId, activeTab, searchParams, setSearchParams]);

  // Unified parcel selector. Sets selectedParcelId AND synchronously clears
  // the timeline-tab URL params (tlSurvey / tlLimit) in the same event so
  // both state updates land in a single React batch — by the time
  // SurveyTimeline remounts (it's keyed by parcelId) the URL is already
  // clean, so its useState init reads tlSurvey="" and the auto-fire effect
  // sees no query to run. A post-render useEffect can't help here because
  // SurveyTimeline reads searchParams during its first render, before any
  // effect would fire.
  const handleSelectParcel = useCallback((id: string | null) => {
    setSelectedParcelId(id);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      let dirty = false;
      if (next.has("tlSurvey")) { next.delete("tlSurvey"); dirty = true; }
      if (next.has("tlLimit")) { next.delete("tlLimit"); dirty = true; }
      return dirty ? next : prev;
    }, { replace: true });
  }, [setSearchParams]);

  // 1. Fetch Projects
  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: landwiseApi.getProjects
  });

  const projects: Project[] = (projectsData?.data || []).filter((p: Project | null | undefined): p is Project => !!p && !!p.id);
  
  // 1.5. Fetch Audit Data (Shared for Hierarchy, Timeline, etc.)
  const { data: auditData, isLoading: auditLoading } = useQuery({
    queryKey: ['hierarchy', selectedParcelId],
    queryFn: () => landwiseApi.getHierarchy(selectedParcelId!),
    enabled: !!selectedParcelId
  });

  const requestId = auditData?.request_id;
  const validationResults = auditData?.validation_results || [];

  // Parcel's full document list — used by the Notes Hub's pdfUrlResolver
  // as a fallback when validation hasn't been run yet (no validationResults).
  // Without this, the cockpit shows "PDF unavailable for this deed" for every
  // note even though we have a perfectly downloadable copy in S3.
  const { data: parcelDocsData } = useQuery({
    queryKey: ['documents', selectedParcelId],
    queryFn: () => landwiseApi.listDocuments(selectedParcelId!),
    enabled: !!selectedParcelId,
  });
  const parcelDocs: any[] = parcelDocsData?.data || [];

  // Prefetch annotations the moment a parcel is selected, so when the user
  // opens a PDF in Document Analysis / Notes Hub the highlights are already
  // in react-query's cache and render at the same time as the PDF instead
  // of flashing in late. PdfAnnotator reads the same query key so it gets
  // an instant cache hit. staleTime matches PdfAnnotator's so all consumers
  // share one cached result instead of triggering separate fetches.
  useQuery({
    queryKey: ['annotations', selectedParcelId],
    queryFn: () => landwiseApi.getAnnotations(selectedParcelId!),
    enabled: !!selectedParcelId,
    staleTime: 60_000,
  });

  // Set default project if none in URL
  useEffect(() => {
    if (!projectsLoading) {
      if (projects.length > 0) {
        if (!selectedProjectId) {
          setSelectedProjectId(projects[0].id);
        }
      } else {
        // No projects exist, redirect to home page
        window.location.href = "/";
      }
    }
  }, [projects, projectsLoading, selectedProjectId]);

  // 2. Fetch Parcels for Selected Project
  const { data: parcelsData, isLoading: parcelsLoading } = useQuery({
    queryKey: ['parcels', selectedProjectId],
    queryFn: () => landwiseApi.getParcels(selectedProjectId!),
    enabled: !!selectedProjectId
  });

  // 3. Fetch Dashboard Stats for Project Overview
  const { data: dashboardStats } = useQuery({
    queryKey: ['dashboard_stats', selectedProjectId],
    queryFn: () => landwiseApi.getDashboardStats(selectedProjectId!),
    enabled: !!selectedProjectId && !selectedParcelId
  });

  // 4. Fetch Risks for Selected Parcel
  const { data: risksData } = useQuery({
    queryKey: ['risks', selectedParcelId],
    queryFn: () => landwiseApi.getRisks(selectedParcelId!),
    enabled: !!selectedParcelId
  });

  // 5. Fetch Parcel Stats (Risk Score, Workflow Phase)
  const { data: parcelStatsData, isLoading: parcelStatsLoading, isFetching: parcelStatsFetching } = useQuery({
    queryKey: ['parcel-stats', selectedParcelId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/v1/landwise/parcels/${selectedParcelId}/stats`);
      if (!res.ok) throw new Error('Failed to fetch parcel stats');
      return res.json();
    },
    enabled: !!selectedParcelId
  });

  const parcels: Parcel[] = (parcelsData?.data || []).filter((p: Parcel | null | undefined): p is Parcel => !!p && !!p.id);
  const risks = risksData?.data || [];
  const selectedProject = useMemo(() => projects.find(p => p.id === selectedProjectId), [projects, selectedProjectId]);
  const selectedParcel = useMemo(() => parcels.find(p => p.id === selectedParcelId), [parcels, selectedParcelId]);

  // Auth — needed for the user pill we render into AppShell's header slot.
  const { user } = useAuth();

  // Inject the parcel breadcrumb + tabs + Notes Hub + user info into
  // AppShell's center slot whenever the parcel or active tab changes, so
  // everything sits in ONE top row with the brand and logout button.
  // Cleanup on unmount clears the slot so other pages start with an empty bar.
  useEffect(() => {
    if (!selectedParcel) {
      setHeaderSlot(null);
      return;
    }
    const initials = user?.full_name
      ? user.full_name.split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase()
      : "AK";
    const displayName = user?.full_name ? `Advs. ${user.full_name}` : "Advs. Kousik";

    setHeaderSlot(
      // New top bar: project dropdown + global search + parcel pills (left),
      // register-survey + notes hub + bell + user (right). The workspace
      // tab nav moved out of here into the new dark left sidebar
      // (ParcelWorkspaceLayout). One row, no double headers.
      <>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Project dropdown trigger */}
          <button
            type="button"
            className="hidden md:inline-flex shrink-0 items-center gap-1.5 px-2.5 h-8 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-xs font-bold text-slate-700"
            title="Project"
          >
            <span className="truncate max-w-[120px]">{selectedProject?.name || "Project"}</span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          </button>

          {/* Global search */}
          <div className="relative flex-1 min-w-0 max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search surveys..."
              className="w-full h-8 pl-8 pr-3 rounded-lg bg-slate-50 hover:bg-white focus:bg-white border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 text-xs font-medium placeholder:text-slate-400 outline-none transition-all"
            />
          </div>

          {/* Parcel pills */}
          <div className="hidden md:flex items-center gap-1 min-w-0 overflow-x-auto custom-scrollbar py-0.5">
            {parcels.map(p => {
              const isActive = p.id === selectedParcelId;
              return (
                <div
                  key={p.id}
                  onClick={() => handleSelectParcel(p.id)}
                  className={cn(
                    "group inline-flex items-center gap-1.5 h-8 pl-2.5 pr-1 rounded-full cursor-pointer transition-all text-xs font-bold whitespace-nowrap shrink-0",
                    isActive
                      ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/30"
                      : "bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200",
                  )}
                  title={`Open SN ${p.survey_number}`}
                >
                  <span className={cn("w-1.5 h-1.5 rounded-full", isActive ? "bg-white" : "bg-emerald-500")} />
                  <span>SN {p.survey_number}</span>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      if (isActive) handleSelectParcel(null);
                    }}
                    className={cn(
                      "w-5 h-5 inline-flex items-center justify-center rounded-full transition-colors",
                      isActive ? "hover:bg-white/20 text-white" : "hover:bg-slate-200 text-slate-400",
                    )}
                    aria-label={`Close ${p.survey_number}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold gap-1.5 h-8 px-3 rounded-lg hidden lg:inline-flex"
            onClick={() => setIsUploadModalOpen(true)}
          >
            <Plus className="w-3.5 h-3.5" />
            Register Survey
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 border-amber-200 text-amber-700 hover:bg-amber-50 hover:text-amber-800 hidden md:inline-flex"
            onClick={() => setNotesSummaryOpen(true)}
            title="View every note across every PDF for this parcel"
          >
            <StickyNote className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">Notes Hub</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 relative h-8 w-8"
            aria-label="Notifications"
          >
            <Bell className="w-4 h-4" />
            <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-indigo-600 rounded-full border-2 border-white" />
          </Button>
          <div className="h-5 w-[1px] bg-slate-200 hidden md:block" />
          <div className="hidden md:flex items-center gap-2">
            <div className="text-right hidden xl:block">
              <p className="text-xs font-bold text-slate-900 leading-tight">{displayName}</p>
              <p className="text-[9px] text-slate-500 uppercase font-bold tracking-[0.18em] leading-tight">Legal Advisor</p>
            </div>
            <div
              className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-600 via-indigo-500 to-blue-500 shadow-md shadow-indigo-500/30 flex items-center justify-center text-[10px] font-bold text-white ring-2 ring-white"
              title={displayName}
            >
              {initials}
            </div>
          </div>
        </div>
      </>,
    );

    return () => setHeaderSlot(null);
  }, [
    setHeaderSlot,
    selectedParcel,
    selectedParcelId,
    selectedProject,
    activeTab,
    user,
    parcels,
    searchQuery,
    handleSelectParcel,
  ]);

  // 6. Fetch Risk Score from dedicated endpoint
  const riskScoreRequestId = selectedParcel?.last_analysis_request_id;
  const { data: riskScoreData, isLoading: riskScoreLoading, isFetching: riskScoreFetching } = useQuery({
    queryKey: ['risk-score', riskScoreRequestId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/v1/get-risk-score/${riskScoreRequestId}`);
      if (!res.ok) throw new Error('Failed to fetch risk score');
      return res.json();
    },
    enabled: !!riskScoreRequestId
  });
  
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // Keeps the live-progress overlay in its "complete / reveal" state for a
  // short window after the stream ends.
  const [showAnalyzeComplete, setShowAnalyzeComplete] = useState(false);
  // Real stage + per-document state fed by the analyze event stream.
  const [analyzeSteps, setAnalyzeSteps] = useState<AnalysisStep[]>(() => ANALYZE_STEPS.map((s) => ({ ...s })));
  const [analyzeCompleted, setAnalyzeCompleted] = useState<any[]>([]);
  const [analyzeActivity, setAnalyzeActivity] = useState("");

  // Run a parcel analyze as a LIVE stream: parse the ndjson workflow events and
  // drive the progress overlay (EC extraction → matching → … and each finished
  // document revealed as its `partial_result` arrives).
  const runStreamingAnalyze = useCallback(async (pid: string, limit?: number) => {
    setAnalyzeSteps(ANALYZE_STEPS.map((s) => ({ ...s, status: "pending" })));
    setAnalyzeCompleted([]);
    setAnalyzeActivity("");
    setShowAnalyzeComplete(false);
    setIsAnalyzing(true);
    try {
      const resp = await landwiseApi.analyzeParcelStream(pid, limit);
      if (!resp.ok || !resp.body) throw new Error(`Analyze failed (${resp.status})`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.type === "step_start") {
              setAnalyzeSteps((prev) => prev.map((s) => (s.id === data.step ? { ...s, status: "running" } : s)));
            } else if (data.type === "step_complete") {
              setAnalyzeSteps((prev) =>
                prev.map((s) => (s.id === data.step ? { ...s, status: data.status === "success" ? "success" : "failed" } : s)),
              );
            } else if (data.type === "partial_result" && data.data) {
              setAnalyzeCompleted((prev) =>
                prev.some((r) => r.document_number === data.data.document_number) ? prev : [...prev, data.data],
              );
            } else if ((data.type === "log" || data.type === "sub_log") && data.message) {
              // Surface the live backend activity (e.g. "Processing EC Chunk 2/7…").
              setAnalyzeActivity(String(data.message));
            }
          } catch {
            /* ignore a malformed/partial line */
          }
        }
      }
      setAnalyzeSteps((prev) => prev.map((s) => (s.status === "failed" ? s : { ...s, status: "success" })));
      setShowAnalyzeComplete(true);
      window.setTimeout(() => setShowAnalyzeComplete(false), 15000);
      toast.success("Analysis complete", { icon: <Zap className="w-4 h-4 text-indigo-500" /> });
      // The DB persist runs in a server BackgroundTask AFTER the stream ends, so
      // wait briefly before refetching the DB-backed views (hierarchy/risk/etc.).
      // The Document Analysis tab is unaffected — it reads the streamed results.
      window.setTimeout(() => {
        ["parcel-stats", "documents", "hierarchy", "risks", "timeline", "checklist"].forEach((k) =>
          queryClient.invalidateQueries({ queryKey: [k, pid] }),
        );
        queryClient.invalidateQueries({ queryKey: ["parcels"] });
      }, 2000);
    } catch (err: any) {
      toast.error("Analysis failed", { description: err?.message || "Could not run the analysis stream." });
      setShowAnalyzeComplete(false);
    } finally {
      setIsAnalyzing(false);
    }
  }, [queryClient]);

  const handleAnalyze = async () => {
    if (!selectedParcelId) return;
    await runStreamingAnalyze(selectedParcelId);
  };

  const handleDeleteParcel = async (e: React.MouseEvent, parcelId: string) => {
    e.stopPropagation();
    if (confirm("Are you sure you want to deactivate this survey record? You will still be able to view it as 'Inactive'.")) {
      try {
        await landwiseApi.deleteParcel(parcelId);
        toast.success("Survey record deactivated.");
        queryClient.invalidateQueries({ queryKey: ["parcels"] });
      } catch (e) {
        toast.error("Failed to deactivate record.");
      }
    }
  };

  useEffect(() => {
    setHierarchyPreview(null);
    // Drop streamed live-analysis results when switching parcels so they don't
    // bleed into another parcel's Document Analysis view.
    setAnalyzeCompleted([]);
  }, [selectedParcelId]);


  // Filter parcels (Hide inactive by default). Coalesce nullable fields —
  // a freshly-registered parcel can briefly have null village or
  // survey_number before the form save completes, and calling .toLowerCase()
  // on undefined crashed the whole sidebar render.
  const filteredParcels = useMemo(() => {
    const q = (searchQuery || "").toLowerCase();
    return parcels.filter((p) => {
      if (p.status === "inactive") return false;
      if (!q) return true;
      const sn = (p.survey_number || "").toLowerCase();
      const village = (p.village || "").toLowerCase();
      const taluk = (p.taluk || "").toLowerCase();
      return sn.includes(q) || village.includes(q) || taluk.includes(q);
    });
  }, [parcels, searchQuery]);

  // Document numbers across the property — drives the global Ask AI
  // @-mention autocomplete. Prefer live-streamed results, fall back to the
  // persisted validation results.
  const globalDocNumbers = useMemo(() => {
    const src = (analyzeCompleted.length > 0 ? analyzeCompleted : validationResults) || [];
    const set = new Set<string>();
    src.forEach((r: any) => { if (r?.document_number) set.add(r.document_number); });
    return Array.from(set).sort();
  }, [analyzeCompleted, validationResults]);

  // Tab content extracted into a const so it can render inside either the
  // new ParcelWorkspaceLayout (when a parcel is selected) or the legacy
  // ResizablePanelGroup (project view) without being duplicated. Includes
  // both the parcel-selected branch (overview / documents / timeline / …)
  // and the no-parcel fallback (project overview grid).
  const tabContentNode = (
    <ScrollArea className="flex-1">
      <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto space-y-4 lg:space-y-6">
        {selectedParcelId ? (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            {parcels.find(p => p.id === selectedParcelId)?.status === 'inactive' ? (
              <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 bg-white rounded-3xl border border-dashed border-slate-200">
                <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mb-2">
                  <Trash2 className="w-8 h-8 text-red-500" />
                </div>
                <h2 className="text-2xl font-black text-slate-900 uppercase tracking-tighter">Survey Deleted</h2>
                <p className="text-slate-500 max-w-sm text-sm font-medium italic">
                  This survey record and its associated physical files have been deactivated. It is no longer available for active legal review.
                </p>
                <Button
                  variant="outline"
                  onClick={() => handleSelectParcel(null)}
                  className="mt-4 border-slate-200 hover:bg-slate-50 font-bold px-8"
                >
                  Return to Project Overview
                </Button>
              </div>
            ) : (
              <>
                {activeTab === "overview" && (
                  <ParcelOverview
                    parcel={parcels.find(p => p.id === selectedParcelId)}
                    stats={parcelStatsData?.stats}
                    workflow={parcelStatsData?.workflow}
                    riskScore={riskScoreData?.data}
                    validationResults={validationResults}
                    isStatsLoading={parcelStatsLoading || (!parcelStatsData && parcelStatsFetching)}
                    isRiskScoreLoading={!!riskScoreRequestId && (riskScoreLoading || (!riskScoreData && riskScoreFetching))}
                    isAuditLoading={auditLoading}
                    onActionOpinion={() => setActiveTab("opinion")}
                    onUploadClick={() => setIsUploadModalOpen(true)}
                    onAnalyze={handleAnalyze}
                    isAnalyzing={isAnalyzing}
                    onBatchAuditClick={() => setIsBatchAuditModalOpen(true)}
                    onReviewFindings={() => setActiveTab("audit-value")}
                  />
                )}
                {activeTab === "documents" && (() => {
                  // Prefer LIVE streamed results (so documents appear in this tab
                  // as they finish, before the post-run persist/refetch lands);
                  // fall back to the persisted results for an already-analyzed parcel.
                  const docResults = analyzeCompleted.length > 0 ? analyzeCompleted : validationResults;
                  return docResults && docResults.length > 0 ? (
                    <DocumentAnalysisRevamp
                      results={docResults}
                      requestId={requestId}
                      parcelId={selectedParcelId || undefined}
                      focusDocNo={docAnalysisFocusDoc || undefined}
                      onOpenInMap={(docNo) => {
                        setActiveTab("hierarchy");
                        setHierarchyPreview({ docNo, data: docResults.find((r: any) => r.document_number === docNo)?.validation_result });
                      }}
                    />
                  ) : (
                    <DocumentsTab
                      parcelId={selectedParcelId!}
                      onUploadClick={() => setIsUploadModalOpen(true)}
                    />
                  );
                })()}
                {activeTab === "checklist" && (
                  <ChecklistTab parcelId={selectedParcelId!} />
                )}
                {activeTab === "hierarchy" && (
                  <HierarchyTab
                    parcelId={selectedParcelId!}
                    auditResults={auditData}
                    isAuditLoading={auditLoading}
                    hierarchyPreview={hierarchyPreview}
                    setHierarchyPreview={setHierarchyPreview}
                  />
                )}
                {activeTab === "timeline" && (
                  <TimelineTab parcelId={selectedParcelId!} requestId={requestId} results={validationResults} onUploadClick={() => setIsUploadModalOpen(true)} />
                )}
                {activeTab === "ownership-audit" && (
                  <OwnershipAuditTab parcelId={selectedParcelId!} auditResults={auditData} isAuditLoading={auditLoading} />
                )}
                {activeTab === "pdf-vault" && (
                  <PdfVaultTab parcelId={selectedParcelId!} auditResults={auditData} />
                )}
                {activeTab === "risks" && (
                  <RisksTab
                    requestId={auditData?.request_id}
                    onOpenDocAnalysis={(docNo) => { setDocAnalysisFocusDoc(docNo); setActiveTab("documents"); }}
                  />
                )}
                {activeTab === "opinion" && (
                  <OpinionTab parcelId={selectedParcelId!} />
                )}
              </>
            )}
          </div>
        ) : (
          <ProjectOverview
            project={selectedProject}
            parcels={parcels}
            stats={dashboardStats}
            onSelectParcel={(id) => handleSelectParcel(id)}
          />
        )}
      </div>
    </ScrollArea>
  );

  // When a parcel is selected, use the new ParcelWorkspaceLayout (dark
  // workspace nav on the left, no parcel-list sidebar — parcels are now
  // accessed via top-bar pills). Otherwise keep the legacy
  // ResizablePanelGroup with the parcel-list sidebar for the project view.
  // Both branches share `tabContentNode` so the tab JSX isn't duplicated.
  const selectedParcelForLayout = parcels.find(p => p.id === selectedParcelId);

  return (
    <div className="h-screen w-full bg-[#F8FAFC] text-[#111827] overflow-hidden font-sans selection:bg-[#EBF1FF]">
      {/* Engaging live analysis overlay — driven by the REAL analyze event
          stream: stages light up as the backend reports them, and each finished
          document is revealed as its result streams in. */}
      {(isAnalyzing || showAnalyzeComplete) && (
        <LiveAnalysisProgress
          open
          steps={analyzeSteps}
          completed={analyzeCompleted}
          activity={analyzeActivity}
          isComplete={showAnalyzeComplete}
          onClose={() => setShowAnalyzeComplete(false)}
          onViewDoc={(docNo) => {
            setDocAnalysisFocusDoc(docNo);
            setActiveTab("documents");
            setShowAnalyzeComplete(false);
          }}
        />
      )}

      {/* BACKGROUND GRADIENTS — navy brand palette. Only rendered for the
          project view; ParcelWorkspaceLayout has its own background. */}
      {!selectedParcelId && (
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-[#1A367E]/[0.06] blur-[120px] rounded-full animate-blob-slow" />
          <div className="absolute bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-[#3B82F6]/[0.05] blur-[120px] rounded-full animate-blob" />
          <div className="absolute top-[40%] left-[40%] w-[20%] h-[20%] bg-[#1A367E]/[0.04] blur-[100px] rounded-full animate-float-slow" />
        </div>
      )}

      {selectedParcelId ? (
        <ParcelWorkspaceLayout
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          activeSurveyLabel={selectedParcelForLayout ? `SN ${selectedParcelForLayout.survey_number}` : undefined}
          activeSurveySubtitle={
            selectedParcelForLayout
              ? [selectedParcelForLayout.village, selectedParcelForLayout.taluk]
                  .filter(Boolean)
                  .join(" · ") || undefined
              : undefined
          }
        >
          <div className="flex flex-col h-full">{tabContentNode}</div>
          {/* GLOBAL ASK AI — a floating assistant reachable from every
              workspace tab. The Timeline tab has its own inline launcher
              (with hierarchy node-click @-mentions) and shares the same
              sessionStorage history, so we skip the floating one there to
              avoid a duplicate panel. */}
          {activeTab !== "timeline" && (
            <>
              {!askAiOpen && (
                <button
                  type="button"
                  onClick={() => setAskAiOpen(true)}
                  className="fixed bottom-4 right-4 z-[290] inline-flex items-center gap-2 h-11 pl-3.5 pr-4 rounded-full text-white text-sm font-bold shadow-xl shadow-indigo-500/30 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 transition-all animate-in fade-in slide-in-from-bottom-4 duration-300"
                  title="Ask AI about this property"
                >
                  <Sparkles className="w-4 h-4" />
                  Ask AI
                </button>
              )}
              {askAiOpen && (
                <OverallChat
                  requestId={requestId}
                  parcelId={selectedParcelId || undefined}
                  docNumbers={globalDocNumbers}
                  onClose={() => setAskAiOpen(false)}
                />
              )}
            </>
          )}
        </ParcelWorkspaceLayout>
      ) : (
      <ResizablePanelGroup direction="horizontal" key={isDesktop ? "desktop" : "mobile"} className="h-full">

        {/* COLUMN 1: NAVIGATION & PARCEL LIST (DESKTOP) */}
        {isDesktop && (
          <>
            <ResizablePanel
              ref={sidebarPanelRef}
              defaultSize={22}
              minSize={18}
              maxSize={32}
              collapsible
              collapsedSize={3}
              onCollapse={() => setSidebarCollapsed(true)}
              onExpand={() => setSidebarCollapsed(false)}
              className="border-r border-[#E2E8F0] bg-white/90 backdrop-blur-xl shadow-xl shadow-indigo-900/5 z-20"
            >
              {sidebarCollapsed ? (
                // Thin strip with a single expand button. Keeps the
                // ResizableHandle alive so the layout stays consistent.
                <div className="flex flex-col items-center pt-4 h-full">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600"
                    onClick={() => sidebarPanelRef.current?.expand?.()}
                    title="Expand sidebar"
                    aria-label="Expand sidebar"
                  >
                    <PanelLeftOpen className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <DashboardSidebar
                  selectedProject={selectedProject}
                  selectedProjectId={selectedProjectId}
                  setSelectedProjectId={setSelectedProjectId}
                  projects={projects}
                  setIsNewProjectModalOpen={setIsNewProjectModalOpen}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  parcels={parcels}
                  filteredParcels={filteredParcels}
                  parcelsLoading={parcelsLoading}
                  selectedParcelId={selectedParcelId}
                  setSelectedParcelId={handleSelectParcel}
                  handleDeleteParcel={handleDeleteParcel}
                  onCollapse={() => sidebarPanelRef.current?.collapse?.()}
                />
              )}
            </ResizablePanel>
            <ResizableHandle withHandle className="bg-[#E2E8F0]" />
          </>
        )}

        {/* COLUMN 2: WORKSPACE
            defaultSize is computed so the two panels always sum to 100%:
              - desktop: sidebar(22) + workspace(78) = 100
              - mobile : workspace(100) alone (sidebar is not rendered)
            The previous fixed value of 55 left 23% unaccounted for on
            desktop and triggered react-resizable-panels' "Invalid layout
            total size: 55%" warning at startup. */}
        <ResizablePanel defaultSize={isDesktop ? 78 : 100} className="bg-transparent">
          <div className="flex flex-col h-full">

            {/* The workspace-column header (breadcrumb + tab strip + Notes
                Cockpit + Advs. Kousik) used to live here. It now lives in
                AppShell's top bar — see the useHeaderSlot() effect above
                this component's return — so the parcel tabs share a single
                row with the brand + logout button instead of stacking.

                A small mobile-only sidebar trigger stays here because the
                shell header is too cramped on phones. */}
            <div className="md:hidden border-b border-[#E2E8F0] px-3 py-2 bg-white/80 backdrop-blur-xl sticky top-0 z-10">
              <Button
                variant="ghost"
                size="icon"
                className="text-slate-600 hover:bg-indigo-50 hover:text-indigo-600"
                onClick={() => setMobileSidebarOpen(true)}
                aria-label="Open sidebar"
              >
                <Menu className="w-5 h-5" />
              </Button>
            </div>

            {/* WORKSPACE CONTENT — shared between the legacy ResizablePanelGroup
                (this branch, used for the project view when no parcel is
                selected) and the new ParcelWorkspaceLayout above. Single
                source of truth = tabContentNode. */}
            {tabContentNode}
          </div>
        </ResizablePanel>

      </ResizablePanelGroup>
      )}

      {/* MODALS */}
      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        onClose={() => setIsNewProjectModalOpen(false)}
      />
      <UploadDocumentModal 
        isOpen={isUploadModalOpen} 
        onClose={() => setIsUploadModalOpen(false)} 
        parcelId={selectedParcelId!} 
      />
      <BatchAuditModal
        isOpen={isBatchAuditModalOpen}
        onClose={() => setIsBatchAuditModalOpen(false)}
        parcelId={selectedParcelId!}
        onUploaded={(ec, zip, limit) => { setPendingBatch({ ec, zip, limit }); setChecklistOpen(true); }}
      />
      <ChecklistModal
        isOpen={checklistOpen}
        onClose={() => setChecklistOpen(false)}
        onApprove={async (ids) => {
          if (!selectedParcelId || !pendingBatch) return;
          persistSelectedChecks(selectedParcelId, ids);
          setChecklistOpen(false);
          // Show the progress overlay while we upload the held files, then stream.
          setIsAnalyzing(true);
          setAnalyzeSteps(ANALYZE_STEPS.map((s) => ({ ...s, status: "pending" })));
          setAnalyzeCompleted([]);
          setAnalyzeActivity("Uploading Encumbrance Certificate…");
          try {
            const ecFd = new FormData();
            ecFd.append("file", pendingBatch.ec);
            ecFd.append("document_type", "encumbrance_certificate");
            ecFd.append("language", "tamil");
            ecFd.append("source", "uploaded");
            await landwiseApi.uploadDocument(selectedParcelId, ecFd);
            setAnalyzeActivity("Uploading sale-deeds archive…");
            const zipFd = new FormData();
            zipFd.append("file", pendingBatch.zip);
            zipFd.append("document_type", "sale_deed");
            zipFd.append("language", "tamil");
            zipFd.append("source", "uploaded");
            await landwiseApi.uploadDocument(selectedParcelId, zipFd);
            queryClient.invalidateQueries({ queryKey: ["documents", selectedParcelId] });
          } catch (err: any) {
            setIsAnalyzing(false);
            toast.error("Upload failed", { description: err?.response?.data?.detail || "Could not upload the documents." });
            return;
          }
          const limit = pendingBatch.limit;
          setPendingBatch(null);
          runStreamingAnalyze(selectedParcelId, limit);
        }}
      />

      {/* PARCEL-WIDE NOTES COCKPIT
          Aggregates every note across every PDF for the selected parcel. A
          click on a note opens HierarchyPage in a new tab with the matching
          deed pre-selected and the highlight scrolled into view. */}
      {selectedParcelId && (
        <Dialog open={notesSummaryOpen} onOpenChange={setNotesSummaryOpen}>
          {/* Cockpit is now a split view (notes list + PDF preview), so we
              widen the dialog and give it most of the viewport height. */}
          <DialogContent className="max-w-6xl w-[min(95vw,1100px)] p-0 overflow-hidden h-[85vh] flex flex-col">
            <DialogHeader className="sr-only">
              <DialogTitle>Notes Hub</DialogTitle>
            </DialogHeader>
            <NotesSummary
              parcelId={selectedParcelId}
              surveyNumberFallback={selectedParcel?.survey_number}
              // CRITICAL: the cockpit MUST load the same PDF the user marked
              // the note on. Document Analysis and the Hierarchy panel both
              // serve the validation output via `/files/<file_path>`. If the
              // cockpit instead serves a different version (e.g. the raw
              // vault upload), react-pdf-highlighter scales the saved
              // position against a different viewport and the highlight
              // lands offset from the words.
              //
              // Lookup order:
              //   1. validation result file_path  (same source as Analysis/Hierarchy)
              //   2. vault download-by-path       (fallback for docs without a result)
              pdfUrlResolver={(docNo: string) => {
                if (!docNo) return null;
                const norm = (s: string) =>
                  (s || "").replace(/\.pdf$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
                const target = norm(docNo);

                // 1) Best source: the validation result. Same PDF version that
                //    Document Analysis and Hierarchy render — coordinates from
                //    a saved note will line up exactly. CRITICAL: use
                //    getFileUrl() so the "outputs/" prefix is stripped to
                //    match the backend's static mount at /files/ (without
                //    this the URL was 404'ing → "Failed to load PDF" in the
                //    cockpit while Document Analysis worked fine).
                const vrMatch = (validationResults || []).find(
                  (r: any) =>
                    norm(r.document_number) === target ||
                    norm(r.doc_no) === target ||
                    norm(r.file_path) === target,
                );
                if (vrMatch?.file_path) {
                  return getFileUrl(vrMatch.file_path.replace(/\\/g, "/"));
                }

                // 2) Fallback: stream the doc straight from S3 by its
                //    LandwiseDocument UUID. Works for parcels where the
                //    note exists but analysis hasn't been run yet (so
                //    validationResults is empty) — previously this case
                //    surfaced "PDF unavailable for this deed".
                //    Caveat: this serves the ORIGINAL PDF (without
                //    visual-debugger red boxes). If the note was created
                //    against the validation-marked PDF, highlight positions
                //    are still saved in PDF-point space and align fine, but
                //    the surrounding visual content will look different.
                const docMatch = (parcelDocs || []).find(
                  (d: any) =>
                    norm(d.original_filename) === target ||
                    norm(d.id) === target,
                );
                if (docMatch?.id) {
                  return `${API_BASE_URL}/api/v1/landwise/documents/download/${docMatch.id}`;
                }

                // Nothing matched. NotesSummary still has its own document_id
                // fallback (server-note rows carry the UUID), so returning
                // null here is safe.
                return null;
              }}
              onJumpToNote={(target: NoteJumpTarget) => {
                const requestId = selectedParcel?.last_analysis_request_id;
                if (!requestId) {
                  toast.error("Run the analysis first to open this note in the full hierarchy view.");
                  return;
                }
                const params = new URLSearchParams({
                  requestId,
                  parcelId: selectedParcelId,
                  docNo: target.doc_no,
                  noteId: target.note.id,
                  page: String(target.note.page_number),
                });
                window.open(`/hierarchy?${params.toString()}`, "_blank", "noopener");
                setNotesSummaryOpen(false);
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* MOBILE SIDEBAR DRAWER */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent
          side="left"
          className="p-0 w-[88vw] sm:max-w-sm border-r border-slate-200 bg-white/95 backdrop-blur-xl"
        >
          <DashboardSidebar
            selectedProject={selectedProject}
            selectedProjectId={selectedProjectId}
            setSelectedProjectId={setSelectedProjectId}
            projects={projects}
            setIsNewProjectModalOpen={setIsNewProjectModalOpen}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            parcels={parcels}
            filteredParcels={filteredParcels}
            parcelsLoading={parcelsLoading}
            selectedParcelId={selectedParcelId}
            setSelectedParcelId={handleSelectParcel}
            handleDeleteParcel={handleDeleteParcel}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// COMPONENT HELPERS
// ──────────────────────────────────────────────────────────────────────────

interface DashboardSidebarProps {
  selectedProject?: Project;
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string) => void;
  projects: Project[];
  setIsNewProjectModalOpen: (open: boolean) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  parcels: Parcel[];
  filteredParcels: Parcel[];
  parcelsLoading: boolean;
  selectedParcelId: string | null;
  setSelectedParcelId: (id: string) => void;
  handleDeleteParcel: (e: React.MouseEvent, id: string) => void;
  /** Desktop-only — when provided, a collapse button appears in the header. */
  onCollapse?: () => void;
}

function DashboardSidebar({
  selectedProject,
  selectedProjectId,
  setSelectedProjectId,
  projects,
  setIsNewProjectModalOpen,
  searchQuery,
  setSearchQuery,
  parcels,
  filteredParcels,
  parcelsLoading,
  selectedParcelId,
  setSelectedParcelId,
  handleDeleteParcel,
  onCollapse,
}: DashboardSidebarProps) {
  return (
    <div className="flex flex-col h-full">
      {/* BRAND & PROJECT SELECTOR */}
      <div className="p-3 sm:p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center gap-2 min-w-0"
          >
            <div className="relative shrink-0">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500 to-blue-600 rounded-lg blur opacity-40 -z-10 animate-pulse-glow" />
              <div className="w-7 h-7 bg-gradient-to-br from-indigo-600 via-indigo-500 to-blue-600 rounded-lg flex items-center justify-center shadow-sm shadow-indigo-500/30 ring-1 ring-white/30">
                <ShieldCheck className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
              </div>
            </div>
            <div className="min-w-0 leading-tight">
              <h1 className="font-display font-extrabold text-sm tracking-tight leading-none truncate">
                <span className="text-slate-900">Land</span>
                <span className="text-gradient-primary">wiseAI</span>
              </h1>
              <span className="text-[8px] uppercase tracking-[0.18em] text-slate-500 font-bold mt-0.5 inline-block">Legal Intelligence</span>
            </div>
          </motion.div>
          <div className="flex items-center gap-0.5 shrink-0">
            {onCollapse && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 transition-colors"
                onClick={onCollapse}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
              >
                <PanelLeftClose className="w-3.5 h-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 transition-colors"
              onClick={() => window.location.href = "/"}
              title="Home"
              aria-label="Home"
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-full justify-between bg-gradient-to-r from-slate-50 to-white border-slate-200 hover:bg-indigo-50/40 hover:border-indigo-200 text-slate-700 h-9 px-2.5 shadow-sm transition-all group">
              <div className="flex items-center gap-2 truncate min-w-0">
                <div className="w-5 h-5 rounded-md bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shadow-sm shrink-0">
                  <Layers className="w-3 h-3 text-white" />
                </div>
                <span className="truncate text-xs font-bold tracking-tight">{selectedProject?.name || "Select Project"}</span>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 group-hover:text-indigo-500 transition-transform group-data-[state=open]:rotate-180 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[calc(var(--radix-dropdown-menu-trigger-width))] bg-white border-slate-200 text-slate-700">
            {projects.map((p: Project) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => setSelectedProjectId(p.id)}
                className="focus:bg-indigo-600 focus:text-white font-medium"
              >
                {p.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onClick={() => setIsNewProjectModalOpen(true)}
              className="border-t border-slate-100 mt-1 text-indigo-600 font-bold cursor-pointer"
            >
              <Plus className="w-4 h-4 mr-2" /> New Project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* PARCEL SEARCH & LIST */}
      <div className="px-3 sm:px-4 space-y-2.5 flex flex-col flex-1 pb-4 overflow-hidden">
        <div className="relative group focus-glow rounded-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 transition-colors group-focus-within:text-indigo-600" />
          <Input
            placeholder="Search survey..."
            className="pl-8 h-8 text-xs bg-slate-50/80 border-slate-200 focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500/40 transition-all"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="text-[9px] uppercase tracking-[0.16em] text-slate-400 font-bold shrink-0">
            Parcels ({parcels.length})
          </span>
          <div className="flex gap-1 items-center">
            {selectedProjectId && <RegisterParcelDialog projectId={selectedProjectId} />}
            <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-indigo-50 hover:text-indigo-600 transition-all">
              <Filter className="w-3 h-3" />
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1 -mx-1.5 px-1.5">
          <motion.div
            className="space-y-1"
            initial="hidden"
            animate="visible"
            variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.04 } } }}
          >
            {filteredParcels.map((parcel: Parcel) => (
              <motion.div
                key={parcel.id}
                variants={{ hidden: { opacity: 0, x: -10 }, visible: { opacity: 1, x: 0 } }}
                whileHover={{ x: 3 }}
                onClick={() => setSelectedParcelId(parcel.id)}
                className={cn(
                  "p-2 rounded-lg cursor-pointer transition-all border group relative overflow-hidden",
                  selectedParcelId === parcel.id
                    ? "bg-gradient-to-br from-indigo-50 via-blue-50/50 to-indigo-50 border-indigo-200 shadow-sm shadow-indigo-500/10"
                    : "border-transparent hover:bg-slate-50 hover:border-slate-200"
                )}
              >
                {selectedParcelId === parcel.id && (
                  <motion.div
                    layoutId="active-indicator"
                    className="absolute left-0 top-0 bottom-0 w-[2px] bg-gradient-to-b from-indigo-500 to-blue-600 rounded-r"
                  />
                )}

                <div className="flex justify-between items-start mb-1 gap-2">
                  <div className="min-w-0">
                    <p className="font-display font-extrabold text-xs text-slate-900 tracking-tight truncate leading-tight">
                      SN {parcel.survey_number}{parcel.subdivision ? `/${parcel.subdivision}` : ''}
                    </p>
                    <p className="text-[10px] text-slate-500 font-medium truncate flex items-center gap-1 mt-0.5">
                      <MapPin className="w-2.5 h-2.5 text-slate-400 shrink-0" />
                      <span className="truncate">{parcel.village}, {parcel.taluk}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={(e) => handleDeleteParcel(e, parcel.id)}
                      className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-all opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                    <StatusBadge status={parcel.status} />
                  </div>
                </div>

                <div className="space-y-1 mt-1.5">
                  <div className="flex justify-between text-[9px] text-slate-500">
                    <span className="flex items-center gap-1 font-bold"><Activity className="w-2.5 h-2.5 text-indigo-600" /> Completion</span>
                    <span className="font-bold tabular-nums text-indigo-600">{parcel.completion_score}%</span>
                  </div>
                  <Progress
                    value={parcel.completion_score}
                    className="h-1 bg-slate-100"
                    indicatorClassName="bg-gradient-to-r from-indigo-500 to-blue-500"
                  />
                </div>
              </motion.div>
            ))}

            {filteredParcels.length === 0 && !parcelsLoading && (
              <div className="text-center py-8 opacity-50">
                <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-2">
                  <Search className="w-4 h-4 text-slate-400" />
                </div>
                <p className="text-[11px] font-bold text-slate-500">No parcels found</p>
              </div>
            )}

            {parcelsLoading && (
              <div className="space-y-2 py-1">
                {[1,2,3,4].map(i => (
                  <div key={i} className="h-16 rounded-lg animate-skeleton" style={{ animationDelay: `${i * 0.08}s` }} />
                ))}
              </div>
            )}
          </motion.div>
        </ScrollArea>
      </div>
    </div>
  );
}

function ParcelOverview({
  parcel,
  stats,
  workflow,
  riskScore: riskScoreData,
  validationResults,
  isStatsLoading = false,
  isRiskScoreLoading = false,
  isAuditLoading = false,
  onActionOpinion,
  onUploadClick,
  onAnalyze,
  isAnalyzing,
  onBatchAuditClick,
  onReviewFindings
}: {
  parcel: Parcel | undefined,
  stats?: any,
  workflow?: any[],
  riskScore?: any,
  validationResults?: any[],
  isStatsLoading?: boolean,
  isRiskScoreLoading?: boolean,
  isAuditLoading?: boolean,
  onActionOpinion: () => void,
  onUploadClick: () => void,
  onAnalyze: () => void,
  isAnalyzing: boolean,
  onBatchAuditClick: () => void,
  onReviewFindings: () => void
}) {
  const [scoreBreakdownExpanded, setScoreBreakdownExpanded] = React.useState(false);

  // Mismatch Issues Hub state — relocated here from the Timeline tab. The
  // hub flattens every non-MATCHED comparison across all validated documents
  // in this parcel. Clicking a row opens a floating popup with the marked
  // PDF (the server's box-annotated artifact at matched_docs/<docNo>.pdf,
  // referenced by validationResult.file_path) scrolled to the cited page.
  // scrollToPage is captured into state (not derived in JSX) so the
  // timestamp is stable across re-renders. Otherwise Date.now() in JSX
  // would re-fire PdfAnnotator's scroll effect on every render.
  const [hubPreview, setHubPreview] = useState<{
    docNo: string;
    url: string;
    page?: number;
    scrollToPage?: { page: number; timestamp: number };
  } | null>(null);
  const hubPopupDragControls = useDragControls();

  const mismatchIssues = useMemo(() => {
    const list: Array<{
      docNo: string;
      field: string;
      status: string;
      reason: string;
      page?: string | number;
      file_path?: string;
      ec_value?: string;
      metadata_value?: string;
    }> = [];
    (validationResults || []).forEach((r: any) => {
      const comps = r?.validation_result?.comparisons || [];
      comps.forEach((c: any) => {
        const status = String(c?.status || "").toUpperCase();
        // Clean MATCH = contains "MATCHED" AND not "NOT MATCHED"
        const clean = status.includes("MATCHED") && !status.includes("NOT");
        if (clean) return;
        list.push({
          docNo: r.document_number,
          field: c.field,
          status: c.status,
          reason: c.reason,
          page: c.page_number,
          file_path: r.file_path,
          ec_value: c.ec_value,
          metadata_value: c.metadata_value,
        });
      });
    });
    return list;
  }, [validationResults]);

  // Guard AFTER all hooks (Rules of Hooks). Previously this was at the top of
  // the component, before the useState/useMemo/useDragControls above — so when
  // `parcel` toggled defined/undefined across re-renders the hook COUNT changed
  // and React crashed ParcelOverview to a blank screen.
  if (!parcel) {
    // Show a loader rather than a blank screen while the parcel record loads
    // (or briefly toggles undefined during a refetch).
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
        <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
        <p className="text-sm text-slate-500 font-medium">Loading parcel…</p>
      </div>
    );
  }

  // Build the download URL for a server-side artifact path. Mirrors the
  // helper in SurveyTimeline.getPdfUrl — kept inline because the
  // ParcelOverview is the only consumer here.
  const getPdfUrlFromPath = (relPath: string | undefined) => {
    if (!relPath) return undefined;
    if (relPath.startsWith('http')) return relPath;
    const cleaned = relPath.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "").replace(/^\/+/, "");
    return `${API_BASE_URL}/api/v1/landwise/documents/download-by-path?file_path=${encodeURIComponent(cleaned)}`;
  };

  const handleHubIssueClick = (issue: { docNo: string; file_path?: string; page?: string | number }) => {
    const url = getPdfUrlFromPath(issue.file_path);
    if (!url) {
      toast.error(`No PDF artifact recorded for ${issue.docNo}`);
      return;
    }
    let pg: number | undefined;
    if (issue.page !== undefined && issue.page !== null) {
      const m = String(issue.page).match(/\d+/);
      if (m) pg = parseInt(m[0]);
    }
    setHubPreview({
      docNo: issue.docNo,
      url,
      page: pg,
      scrollToPage: pg ? { page: pg, timestamp: Date.now() } : undefined,
    });
  };

  // First-load skeleton: render only when NONE of the data has arrived yet
  // (no stats AND no risk score AND no validation results). Once any of
  // them lands the user sees the real layout; the slim refresh indicator
  // (below the header) tells them a background refetch is still running.
  const hasAnyData = !!stats || !!riskScoreData || (validationResults && validationResults.length > 0);
  const isInitialLoading = (isStatsLoading || isRiskScoreLoading || isAuditLoading) && !hasAnyData;
  const isBackgroundRefreshing = (isStatsLoading || isRiskScoreLoading || isAuditLoading) && hasAnyData;

  if (isInitialLoading) {
    return (
      <div className="space-y-4 animate-in fade-in duration-300">
        {/* Header skeleton */}
        <div className="flex items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200">
          <div className="space-y-2 flex-1">
            <div className="h-5 w-56 rounded animate-skeleton" />
            <div className="h-3 w-40 rounded animate-skeleton" style={{ animationDelay: "0.08s" }} />
          </div>
          <Loader2 className="w-5 h-5 text-indigo-500 animate-spin shrink-0" />
        </div>
        {/* Risk-score + workflow row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className="h-32 rounded-2xl bg-white border border-slate-200 animate-skeleton"
              style={{ animationDelay: `${0.1 + i * 0.08}s` }}
            />
          ))}
        </div>
        {/* KPI tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => (
            <div
              key={i}
              className="h-20 rounded-2xl bg-white border border-slate-200 animate-skeleton"
              style={{ animationDelay: `${0.3 + i * 0.06}s` }}
            />
          ))}
        </div>
        {/* Sections body */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 h-64 rounded-2xl bg-white border border-slate-200 animate-skeleton" style={{ animationDelay: "0.5s" }} />
          <div className="h-64 rounded-2xl bg-white border border-slate-200 animate-skeleton" style={{ animationDelay: "0.55s" }} />
        </div>
        <p className="text-[11px] text-slate-400 font-medium text-center pt-1 flex items-center justify-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          Loading overview data — backend response can take a few seconds on cold cache…
        </p>
      </div>
    );
  }
  
  // Use dedicated risk score endpoint data when available, fall back to stats
  const riskScore = riskScoreData?.score ?? stats?.risk_score ?? 0;
  const riskGrade = riskScoreData?.grade ?? null;
  const riskStatus = riskScoreData ? (riskGrade === 'A' ? 'EXCELLENT' : riskGrade === 'B' ? 'GOOD' : riskGrade === 'C' ? 'MODERATE' : riskGrade === 'D' ? 'HIGH RISK' : 'CRITICAL') : (stats?.risk_status ?? 'PENDING');
  const aiSummary = riskScoreData?.ai_summary ?? stats?.ai_summary ?? null;
  const riskFactors = riskScoreData?.factors ?? stats?.risk_factors ?? [];
  const docCount = stats?.document_count ?? 0;
  const auditedDocs = stats?.audited_docs_count ?? 0;
  const pendingDocs = Math.max(0, docCount - auditedDocs);
  const chainYears = stats?.chain_length_years ?? 0;


  // Determine trend based on risk score
  const getTrend = (score: number) => {
    if (score >= 80) return { label: 'SAFE', color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' };
    if (score >= 60) return { label: 'MODERATE', color: 'text-yellow-600', bg: 'bg-yellow-50', border: 'border-yellow-200' };
    if (score >= 40) return { label: 'CAUTION', color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200' };
    return { label: 'HIGH RISK', color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200' };
  };
  const trend = getTrend(riskScore);
  
  return (
    <div className="space-y-5">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="flex items-center justify-between flex-wrap gap-3"
      >
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h2 className="text-lg sm:text-xl lg:text-2xl font-display font-extrabold tracking-tight text-slate-900 flex items-center gap-2">
              Parcel <span className="text-gradient-primary">SN {parcel.survey_number}</span>
            </h2>
            <Badge className={cn(
              "text-[9px] uppercase font-bold tracking-[0.14em] h-5 flex items-center px-2.5 gap-1.5 rounded-full border",
              parcel.status === 'pending'
                ? "bg-amber-50 text-amber-700 border-amber-200"
                : "bg-emerald-50 text-emerald-700 border-emerald-200"
            )}>
              <span className={cn(
                "w-1.5 h-1.5 rounded-full",
                parcel.status === 'pending' ? "bg-amber-500 animate-pulse-glow" : "bg-emerald-500 animate-pulse-glow"
              )} />
              {parcel.status === 'pending' ? 'Documents Required' : 'Ready for Audit'}
            </Badge>
            {/* Background-refresh pill: visible only when stats/risk-score/audit
                queries are revalidating with stale data already on screen. Keeps
                the user informed without unmounting the layout — the values
                they're looking at will swap in once the fetch resolves. */}
            {isBackgroundRefreshing && (
              <span
                className="text-[9px] uppercase font-bold tracking-[0.14em] h-5 inline-flex items-center px-2.5 gap-1.5 rounded-full border bg-indigo-50 text-indigo-700 border-indigo-200 animate-in fade-in"
                title="Pulling latest stats / risk score / audit results from the server"
              >
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Refreshing
              </span>
            )}
          </div>
          <p className="text-slate-500 font-medium flex items-center gap-1.5 text-xs">
            <MapPin className="w-3.5 h-3.5 text-indigo-500" />
            <span className="font-bold text-slate-700">{parcel.village}</span>
            <span className="text-slate-300">·</span>
            <span>{parcel.taluk}</span>
            <span className="text-slate-300">·</span>
            <span>Tamil Nadu</span>
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button
              onClick={onBatchAuditClick}
              className="bg-[#1A367E] hover:bg-[#152b66] text-white text-xs shadow-md shadow-[#1A367E]/20 hover:shadow-lg hover:shadow-[#1A367E]/30 font-bold gap-1.5 px-3.5 h-9 rounded-lg shine-sweep transition-all"
            >
              <Zap className="w-3.5 h-3.5" />
              Launch Smart Analysis
            </Button>
          </motion.div>
          <Button
            onClick={onActionOpinion}
            variant="ghost"
            className="text-slate-600 hover:bg-slate-100 hover:text-indigo-600 text-xs font-bold gap-1.5 h-9 px-3 rounded-lg transition-all"
          >
            <FileSignature className="w-3.5 h-3.5" />
            Opinion Builder
          </Button>
        </div>
      </motion.div>

      {/* STAT CARDS - Real Time Data
          Encumbrances tile intentionally removed (per product call): the
          stats endpoint over-counted historical mortgages whose discharge
          receipts weren't recognized. Open-encumbrance status is still
          surfaced authoritatively in the Survey Ownership Audit verdict
          ("ENCUMBERED" badge), which is the safer single source of truth. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 lg:gap-4">
        <StatCard
          label="Risk Score"
          value={riskScore}
          unit="/ 100"
          trend={riskStatus}
          trendColor={trend.color}
          isRisk
          alert={riskScore < 60}
        />
        <StatCard
          label="Documents"
          value={docCount}
          unit=""
          trend={
            docCount === 0
              ? 'Empty'
              : pendingDocs > 0
                ? `${pendingDocs} Pending`
                : (auditedDocs > 0 ? `${auditedDocs} Verified` : 'Verified')
          }
          trendColor={pendingDocs > 0 ? 'text-amber-600' : 'text-emerald-600'}
        />
        <StatCard
          label="Chain Length"
          value={chainYears}
          unit="Years"
          trend={chainYears > 0 ? `${chainYears} Years` : 'N/A'}
          trendColor={chainYears > 0 ? 'text-emerald-600' : 'text-slate-400'}
        />
      </div>

      {/* CHECKS SELECTED — reflects the user's pre-analysis selection EXACTLY:
          every check the user kept ticked (AI and Manual), nothing more,
          nothing less. AI items are run by LandwiseAI; Manual items are
          flagged for the user's offline verification. */}
      {(() => {
        // Only after an analysis has actually completed (produced results /
        // a risk score) AND the user approved a check selection. Hidden for
        // un-analysed parcels.
        const analysed = (validationResults && validationResults.length > 0) || !!riskScoreData;
        if (!analysed || !hasSavedChecks(parcel.id)) return null;
        const ids = getSelectedChecks(parcel.id);
        // Exactly what the user ticked — preserve checklist order, keep BOTH
        // AI and Manual. No filtering to automated, no fixed-universe framing.
        const chosen = LANDWISE_CHECKS.filter((c) => ids.includes(c.id));
        if (chosen.length === 0) return null;
        const aiCount = chosen.filter((c) => c.automated).length;
        const manualCount = chosen.length - aiCount;
        return (
          <Card className="border-slate-200 overflow-hidden">
            <CardHeader className="py-2.5 px-3 flex flex-row items-center gap-2.5 space-y-0 bg-slate-50/60">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-sm shrink-0">
                <CheckCircle2 className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
              </div>
              <div className="min-w-0 flex-1">
                <CardTitle className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-700">Checks Selected</CardTitle>
                <p className="text-[10px] text-slate-500 mt-0.5 font-medium">
                  {chosen.length} selected · {aiCount} AI{manualCount > 0 ? ` · ${manualCount} manual` : ""}
                </p>
              </div>
            </CardHeader>
            <CardContent className="p-3 flex flex-wrap gap-1.5">
              {chosen.map((c) => (
                <span
                  key={c.id}
                  className={cn(
                    "inline-flex items-center gap-1 text-[10px] font-semibold border rounded-full px-2 py-0.5",
                    c.automated
                      ? "text-emerald-800 bg-emerald-50 border-emerald-100"
                      : "text-slate-600 bg-slate-50 border-slate-200",
                  )}
                >
                  {c.automated
                    ? <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" />
                    : <Circle className="w-2.5 h-2.5 text-slate-400" />}
                  {c.label}
                  <span
                    className={cn(
                      "ml-0.5 text-[8px] font-bold uppercase tracking-wide px-1 py-0 rounded border",
                      c.automated ? "bg-indigo-50 text-indigo-700 border-indigo-100" : "bg-slate-100 text-slate-500 border-slate-200",
                    )}
                  >
                    {c.automated ? "AI" : "Manual"}
                  </span>
                </span>
              ))}
            </CardContent>
          </Card>
        );
      })()}

      {/* MISMATCH ISSUES HUB — surfaces every non-MATCHED comparison
          across all validated docs in this parcel. Click any row to
          open the Visual Debugger's marked PDF (the artifact the
          server emits at outputs/validate/<reqId>/matched_docs/<docNo>.pdf
          with the per-field bounding boxes drawn). */}
      {mismatchIssues.length > 0 && (
        <Card className="relative border-red-200 bg-gradient-to-br from-red-50/60 via-rose-50/30 to-red-50/30 overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-red-500 via-rose-500 to-red-500" />
          <CardHeader className="py-2.5 px-3 flex flex-row items-center gap-2.5 space-y-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-red-500 to-rose-500 flex items-center justify-center shadow-sm shadow-red-500/30 shrink-0">
              <AlertCircle className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-[11px] font-bold uppercase tracking-[0.18em] text-red-800">
                Mismatch Issues Hub
              </CardTitle>
              <p className="text-[10px] text-red-700/80 mt-0.5 font-medium">
                {mismatchIssues.length} issue{mismatchIssues.length !== 1 ? "s" : ""} across {new Set(mismatchIssues.map(i => i.docNo)).size} document{new Set(mismatchIssues.map(i => i.docNo)).size !== 1 ? "s" : ""} — click any row to open the marked PDF at the cited page
              </p>
            </div>
            <Badge className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 shrink-0">
              {mismatchIssues.length}
            </Badge>
          </CardHeader>
          <CardContent className="px-3 pb-3 max-h-[320px] overflow-y-auto custom-scrollbar">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              {mismatchIssues.map((issue, idx) => {
                const pageMatch = issue.page !== undefined && issue.page !== null
                  ? String(issue.page).match(/\d+/)
                  : null;
                const pageLabel = pageMatch ? pageMatch[0] : null;
                return (
                  <button
                    key={`${issue.docNo}-${issue.field}-${idx}`}
                    onClick={() => handleHubIssueClick(issue)}
                    className="text-left bg-white border border-red-100 hover:border-red-300 hover:shadow-md rounded-lg px-2.5 py-2 transition-all group focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[11px] font-bold text-slate-900 tabular-nums truncate">
                        {issue.docNo}
                      </span>
                      <Badge variant="outline" className="text-[8px] font-bold uppercase shrink-0 border-red-200 bg-red-50 text-red-700 px-1.5 py-0 h-4 whitespace-nowrap">
                        {issue.status}
                      </Badge>
                    </div>
                    <div className="text-[10px] font-bold text-slate-800 truncate" title={issue.field}>
                      {issue.field}
                    </div>
                    {/* Side-by-side EC vs Deed values so the lawyer can see
                        the actual mismatch at a glance without opening the
                        PDF. Label column is fixed-width; value uses font-mono
                        with break-all so long Tamil/multi-line strings wrap
                        cleanly inside the narrow card. Falls back to "—" when
                        the validator emitted no value for one side. */}
                    {(issue.ec_value || issue.metadata_value) && (
                      <div className="mt-1 space-y-0.5 bg-slate-50/60 rounded p-1.5 border border-slate-100">
                        <div className="grid grid-cols-[40px_1fr] gap-1 items-baseline">
                          <span className="text-[8px] font-bold uppercase tracking-wider text-red-700 text-right">EC:</span>
                          <span className="text-[9px] font-mono text-slate-800 break-all line-clamp-2" title={String(issue.ec_value || "—")}>
                            {issue.ec_value || "—"}
                          </span>
                        </div>
                        <div className="grid grid-cols-[40px_1fr] gap-1 items-baseline">
                          <span className="text-[8px] font-bold uppercase tracking-wider text-red-700 text-right">Deed:</span>
                          <span className="text-[9px] font-mono text-slate-800 break-all line-clamp-2" title={String(issue.metadata_value || "—")}>
                            {issue.metadata_value || "—"}
                          </span>
                        </div>
                      </div>
                    )}
                    {issue.reason && (
                      <div className="text-[9px] text-slate-500 italic line-clamp-2 mt-1" title={issue.reason}>
                        {issue.reason}
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-1.5 pt-1 border-t border-red-100/60">
                      <span className="text-[8px] uppercase tracking-wider font-bold text-red-600 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1">
                        <Eye className="w-2.5 h-2.5" />
                        Open marked PDF
                      </span>
                      {pageLabel && (
                        <span className="text-[8px] font-bold text-slate-400 uppercase whitespace-nowrap">
                          Page {pageLabel}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* MAIN ANALYTICS ROW */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-5">
        <div className="xl:col-span-2 space-y-4 lg:space-y-5 min-w-0">
          {/* AI Title Health Score Section */}
          <div className="space-y-3">
            <div className="flex items-start gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-md shadow-blue-500/20 shrink-0">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-display font-extrabold text-slate-900 tracking-tight leading-tight">AI Title Health Score</h2>
                <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5 font-medium">Automated risk assessment of the property title chain — designed for legal professionals and banks.</p>
              </div>
            </div>

            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="relative bg-white border border-blue-200 rounded-xl sm:rounded-2xl p-4 sm:p-5 lg:p-6 shadow-sm shadow-blue-100 min-h-[280px] sm:min-h-[320px] flex flex-col items-center justify-center overflow-hidden"
            >
              {/* Animated background flourish */}
              <div className="pointer-events-none absolute inset-0 opacity-60">
                <div className="absolute -top-32 -right-32 w-80 h-80 rounded-full bg-gradient-to-br from-blue-200/40 to-indigo-200/40 blur-3xl animate-blob-slow" />
                <div className="absolute -bottom-32 -left-32 w-80 h-80 rounded-full bg-gradient-to-br from-indigo-200/30 to-violet-200/30 blur-3xl animate-blob" />
              </div>
              {riskStatus === 'PENDING' || riskStatus === 'COMPUTING' ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="relative text-center space-y-3 max-w-md mx-auto"
                >
                  <div className="relative w-16 h-16 mx-auto">
                    <div className="absolute inset-0 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 blur-2xl opacity-40 animate-pulse-glow" />
                    <div className="relative w-16 h-16 bg-gradient-to-br from-blue-50 via-white to-indigo-50 rounded-full flex items-center justify-center mx-auto shadow-inner border border-blue-100 ring-4 ring-white animate-float">
                      <ShieldCheck className="w-8 h-8 text-blue-400" strokeWidth={1.8} />
                    </div>
                  </div>
                  <div>
                    <h3 className="text-base sm:text-lg font-display font-extrabold text-slate-900 tracking-tight">Health Analysis Pending</h3>
                    <p className="text-xs text-slate-500 mt-1 font-medium leading-relaxed">
                      Upload land documents to the PDF Vault and click
                      <span className="text-indigo-600 font-bold mx-1">Launch Smart Analysis</span>
                      to generate your AI Title Health Score and risk assessment.
                    </p>
                  </div>
                  <div className="pt-1">
                    <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }} className="inline-block">
                      <Button
                        variant="outline"
                        className="rounded-full border-[#1A367E]/20 bg-[#EBF1FF] text-[#1A367E] text-xs font-bold hover:bg-[#1A367E] hover:border-[#1A367E] hover:text-white shine-sweep transition-all px-4 h-9"
                        onClick={() => document.getElementById('documents-tab-trigger')?.click()}
                      >
                        Go to PDF Vault
                        <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                      </Button>
                    </motion.div>
                  </div>
                </motion.div>
              ) : (
                <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8 w-full animate-in fade-in duration-700">
                  {/* Left: Score Gauge */}
                  <div className="flex flex-col items-center justify-center">
                    <div className="relative w-48 h-48">
                      {/* Semi-circle gauge background */}
                      <svg viewBox="0 0 200 120" className="w-full h-full">
                        <path d="M 20 100 A 80 80 0 0 1 180 100" stroke="#E2E8F0" strokeWidth="20" fill="none" strokeLinecap="round" />
                        <path 
                          d="M 20 100 A 80 80 0 0 1 180 100" 
                          stroke="currentColor" 
                          strokeWidth="20" 
                          fill="none" 
                          strokeLinecap="round" 
                          className={cn("transition-all duration-1000", trend.color.replace('text', 'stroke'))}
                          strokeDasharray="251.2"
                          strokeDashoffset={251.2 - (251.2 * riskScore / 100)}
                        />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center pt-8">
                        <span className={cn("text-5xl font-black transition-colors duration-500", trend.color)}>{riskScore}</span>
                        <span className="text-xs text-slate-400 mt-1 font-bold">/100</span>
                      </div>
                    </div>
                    <Badge className={cn("mt-4 font-bold px-4 py-1 border transition-colors", trend.bg, trend.color, trend.border)}>
                      <ShieldCheck className="w-3 h-3 mr-1" /> {riskStatus}
                    </Badge>
                  </div>
                  
                  {/* Right: Score Details */}
                  <div className="space-y-6">
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <Activity className="w-5 h-5 text-blue-600" />
                        <h3 className="text-lg font-black text-slate-900">Title Health Score</h3>
                      </div>
                      <p className="text-[10px] text-slate-400 font-mono font-bold uppercase tracking-tight">
                        REQ-ID: {stats?.last_analysis_request_id || 'ANALYSIS_PENDING'}
                      </p>
                    </div>
                    
                    {/* Stats Grid */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-emerald-50 rounded-xl p-3 text-center border border-emerald-100">
                        <div className="text-xl font-black text-emerald-600">
                          {validationResults?.length || 0}/{stats?.document_count || 0}
                        </div>
                        <div className="text-[9px] text-emerald-600 font-bold uppercase tracking-wide">Docs Matched</div>
                      </div>
                      <div className="bg-blue-50 rounded-xl p-3 text-center border border-blue-100">
                        <div className="text-xl font-black text-blue-600">
                          {stats?.avg_trust || 0}%
                        </div>
                        <div className="text-[9px] text-blue-600 font-bold uppercase tracking-wide">Avg Trust</div>
                      </div>
                      <div className="bg-slate-50 rounded-xl p-3 text-center border border-slate-100">
                        <div className="text-xl font-black text-slate-500">
                          {stats?.scrutiny_doc_count || 0}
                        </div>
                        <div className="text-[9px] text-slate-500 font-bold uppercase tracking-wide">Scrutiny Docs</div>
                      </div>
                    </div>
                    
                    {/* AI Risk Assessment */}
                    <div className="bg-slate-900 rounded-xl p-4 text-white shadow-lg relative overflow-hidden group">
                      <div className="absolute top-0 right-0 w-20 h-20 bg-blue-500/10 rounded-full blur-2xl group-hover:bg-blue-500/20 transition-colors" />
                      <div className="flex items-center gap-2 mb-2">
                        <Sparkles className="w-4 h-4 text-blue-400" />
                        <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">AI Risk Assessment</span>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed font-medium relative z-10">
                        {aiSummary || "Our AI is analyzing your property title chain to identify potential risks and encumbrances. Complete analysis to view details."}
                      </p>
                    </div>
                    
                    {/* Legal Recommendation */}
                    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Zap className="w-4 h-4 text-blue-600" />
                        <span className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">Legal Recommendation</span>
                      </div>
                      <p className="text-xs text-slate-700 font-medium">
                        {stats?.recommendation || "Upload documents and launch analysis to get legal recommendations."}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>

            {/* Score Factor Breakdown */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden hover:border-indigo-200 hover:shadow-md transition-all">
              <button
                type="button"
                className="w-full p-4 border-b border-slate-100 cursor-pointer hover:bg-slate-50/70 transition-colors text-left"
                onClick={() => setScoreBreakdownExpanded(!scoreBreakdownExpanded)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Calculator className="w-4 h-4 text-indigo-500" />
                    <span className="text-sm font-bold text-slate-900">Score Factor Breakdown</span>
                  </div>
                  <ChevronRight className={cn("w-4 h-4 text-slate-400 transition-transform duration-200", scoreBreakdownExpanded && "rotate-90")} />
                </div>
              </button>
              {scoreBreakdownExpanded && <div className="p-4 space-y-5">
                {riskFactors && riskFactors.length > 0 ? (
                  riskFactors.map((factor: any, idx: number) => {
                    const isNeg = factor.polarity === "negative";
                    const pct = Math.abs((factor.contribution / (isNeg ? -factor.max : factor.max)) * 100);
                    const color = isNeg ? "bg-red-400" : "bg-emerald-400";
                    const Icon = isNeg ? TrendingDown : TrendingUp;
                    const iconColor = isNeg ? "text-red-500" : "text-emerald-500";
                    const contributionColor = isNeg ? "text-red-600" : "text-emerald-600";

                    return (
                      <div key={idx} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Icon className={cn("w-4 h-4", iconColor)} />
                            <span className="text-xs font-bold text-slate-700">{factor.label}</span>
                          </div>
                          <span className={cn("text-xs font-black", contributionColor)}>
                            {factor.contribution > 0 ? `+${factor.contribution}` : factor.contribution} pts
                          </span>
                        </div>
                        <div className="space-y-1">
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div 
                              className={cn("h-full rounded-full transition-all duration-700", color)} 
                              style={{ width: `${pct}%` }} 
                            />
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-slate-400">
                            <span>{factor.detail}</span>
                            <span className="font-mono font-bold">{factor.value_display}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="py-10 text-center">
                    <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">No Breakdown Available</p>
                  </div>
                )}
              </div>}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="relative bg-white border border-slate-200 rounded-2xl p-4 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
          >
            {/* Subtle gradient header strip */}
            <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-indigo-500 via-blue-500 to-violet-500" />
            <h3 className="text-xs font-display font-bold text-slate-900 mb-4 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <GanttChart className="w-3.5 h-3.5 text-indigo-500" />
                Workflow Phase
              </span>
              <span className="text-[9px] text-indigo-600 font-bold uppercase tracking-[0.18em] inline-flex items-center gap-1.5 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse-glow" />
                Active
              </span>
            </h3>
            <div className="space-y-4 relative">
              <div className="absolute left-[11px] top-5 bottom-5 w-[2px] bg-gradient-to-b from-slate-100 via-slate-200 to-slate-100" />
              {workflow?.map((phase: any) => (
                <PhaseItem
                  key={phase.num}
                  num={phase.num}
                  label={phase.label}
                  status={phase.status}
                  active={phase.state === 'completed' || phase.state === 'in_progress'}
                  current={phase.state === 'in_progress'}
                />
              )) || (
                <div className="space-y-4">
                  <PhaseItem active current num={1} label="Document Ingestion" status="Pending" />
                  <PhaseItem num={2} label="Data Extraction & NER" status="Pending" />
                  <PhaseItem num={3} label="Chain Verification" status="Not Started" />
                  <PhaseItem num={4} label="Risk Analysis" status="Not Started" />
                  <PhaseItem num={5} label="Opinion Draft" status="Locked" />
                </div>
              )}
            </div>
          </motion.div>

        </div>
      </div>

      {/* Floating draggable PDF popup for the Mismatch Issues Hub.
          Renders the Visual Debugger's marked PDF (box-annotated for the
          mismatch) scrolled to the cited page. Same architecture as the
          Timeline tab and HierarchyTab popups: fixed positioning, header
          drag handle (dragListener=false + onPointerDown), z-[200] to sit
          above all other dashboard chrome. */}
      <AnimatePresence>
        {hubPreview && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            drag
            dragControls={hubPopupDragControls}
            dragListener={false}
            dragMomentum={false}
            dragElastic={0}
            className="fixed top-20 right-8 w-[680px] max-w-[92vw] h-[82vh] bg-white border border-slate-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden z-[200]"
          >
            <div
              onPointerDown={(e) => hubPopupDragControls.start(e)}
              className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-red-600 via-rose-600 to-red-600 text-white cursor-grab active:cursor-grabbing select-none"
            >
              <div className="flex items-center gap-2 min-w-0">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[9px] font-bold uppercase tracking-[0.18em] opacity-80 leading-none">Marked PDF</div>
                  <div className="text-sm font-bold truncate flex items-center gap-2">
                    {hubPreview.docNo}
                    {hubPreview.page && (
                      <span className="text-[10px] font-bold bg-white/20 px-1.5 py-0.5 rounded">
                        Page {hubPreview.page}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setHubPreview(null)}
                className="p-1.5 hover:bg-white/20 rounded-lg transition-all text-white shrink-0"
                title="Close preview"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 bg-slate-900 relative">
              <PdfAnnotator
                url={hubPreview.url}
                docId={hubPreview.docNo}
                scrollToPage={hubPreview.scrollToPage}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Document category buckets used by PDF Vault
const DOC_CATEGORIES: { key: string; title: string; icon: React.ComponentType<any>; types: string[]; accent: string }[] = [
  {
    key: "ec",
    title: "Encumbrance Certificates",
    icon: FileSignature,
    types: ["ENCUMBRANCE_CERTIFICATE", "EC"],
    accent: "from-emerald-500 to-teal-600",
  },
  {
    key: "title",
    title: "Title Documents",
    icon: ScrollText,
    types: ["SALE_DEED", "PARENT_DOCUMENT", "GIFT_DEED", "PARTITION_DEED", "SETTLEMENT_DEED", "RELEASE_DEED", "WILL", "POA"],
    accent: "from-blue-500 to-indigo-600",
  },
  {
    key: "revenue",
    title: "Revenue Records",
    icon: Landmark,
    types: ["PATTA", "CHITTA", "ADANGAL"],
    accent: "from-amber-500 to-orange-600",
  },
  {
    key: "court",
    title: "Court & Legal",
    icon: Gavel,
    types: ["COURT_ORDER"],
    accent: "from-rose-500 to-red-600",
  },
  {
    key: "survey",
    title: "Survey & Plans",
    icon: MapPin,
    types: ["SURVEY_SKETCH", "BUILDING_PLAN"],
    accent: "from-violet-500 to-purple-600",
  },
  {
    key: "misc",
    title: "Other Documents",
    icon: FileText,
    types: ["NOC", "MISC"],
    accent: "from-slate-500 to-slate-600",
  },
];

type DocStatus = "verified" | "mismatch" | "review";

interface CategorizedDoc {
  doc: any;
  status: DocStatus;
  validationResult?: any;
}

function deriveDocStatus(doc: any, validationResults: any[]): { status: DocStatus; validationResult?: any } {
  // Normalize to alphanumerics only (strips slashes, dashes, underscores, dots, spaces)
  const norm = (s: any) => (s || "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");

  const docNumberNorm = norm(doc.document_number);
  const filenameNormFull = norm(doc.original_filename);
  // Filename without trailing ".pdf" alphanumeric remains
  const filenameNorm = filenameNormFull.replace(/pdf$/, "");

  let match: any = null;

  // Pass 1 — exact normalized doc_number
  if (docNumberNorm) {
    match = validationResults.find((r) => norm(r.document_number) === docNumberNorm);
  }

  // Pass 2 — validation doc_number contained in/equal to vault filename (or vice-versa)
  if (!match && filenameNorm) {
    match = validationResults.find((r) => {
      const dn = norm(r.document_number);
      if (!dn) return false;
      return filenameNorm.includes(dn) || dn.includes(filenameNorm);
    });
  }

  // Pass 3 — validation file_path basename matches vault filename
  if (!match && filenameNormFull) {
    match = validationResults.find((r) => {
      const fp = (r.file_path || "").toString();
      if (!fp) return false;
      const base = norm(fp.split(/[\\/]/).pop() || "");
      return base && (base === filenameNormFull || base.includes(filenameNorm) || filenameNorm.includes(base.replace(/pdf$/, "")));
    });
  }

  if (match) {
    if (match.match === true) return { status: "verified", validationResult: match };
    if (match.match === false) return { status: "mismatch", validationResult: match };
  }

  // No validation entry yet → still pending review (do NOT use extraction_status,
  // which only reflects OCR completion, not legal verification).
  return { status: "review" };
}

function PdfVaultTab({ parcelId, auditResults }: { parcelId: string; auditResults?: any }) {
  const { data: docsData, isLoading } = useQuery({
    queryKey: ['documents', parcelId],
    queryFn: () => landwiseApi.listDocuments(parcelId)
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDoc, setSelectedDoc] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | DocStatus>("all");

  const docs = docsData?.data || [];
  const validationResults = (auditResults?.validation_results || []) as any[];
  
  // Categorize + decorate every doc with verification status
  const categorized = useMemo(() => {
    const buckets: Record<string, CategorizedDoc[]> = {};
    DOC_CATEGORIES.forEach((c) => (buckets[c.key] = []));
    const miscList: CategorizedDoc[] = [];

    for (const doc of docs) {
      const { status, validationResult } = deriveDocStatus(doc, validationResults);
      const decorated: CategorizedDoc = { doc, status, validationResult };
      const upper = (doc.document_type || "").toString().toUpperCase().replace(/\s+/g, "_");
      const cat = DOC_CATEGORIES.find((c) => c.types.includes(upper));
      if (cat) buckets[cat.key].push(decorated);
      else miscList.push(decorated);
    }
    if (miscList.length) buckets["misc"].push(...miscList);
    return buckets;
  }, [docs, validationResults]);

  // Apply search + status filter to each category
  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const out: Record<string, CategorizedDoc[]> = {};
    for (const cat of DOC_CATEGORIES) {
      out[cat.key] = (categorized[cat.key] || []).filter(({ doc, status }) => {
        if (statusFilter !== "all" && status !== statusFilter) return false;
        if (!q) return true;
        return (
          (doc.original_filename || "").toLowerCase().includes(q) ||
          (doc.document_type || "").toLowerCase().includes(q)
        );
      });
    }
    return out;
  }, [categorized, searchQuery, statusFilter]);

  // Top-level counters for header chip
  const counts = useMemo(() => {
    const all = Object.values(categorized).flat();
    return {
      total: all.length,
      verified: all.filter((d) => d.status === "verified").length,
      mismatch: all.filter((d) => d.status === "mismatch").length,
      review: all.filter((d) => d.status === "review").length,
    };
  }, [categorized]);

  // Auto-select first available doc when data loads
  useEffect(() => {
    if (selectedDoc) return;
    const first = Object.values(filtered).flat()[0];
    if (first) setSelectedDoc(first.doc);
  }, [filtered, selectedDoc]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[600px]">
        <RefreshCcw className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="relative h-[calc(100vh-180px)] bg-white rounded-2xl sm:rounded-3xl border border-slate-200 shadow-sm overflow-hidden flex flex-col"
    >
      {/* Top accent strip */}
      <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500 z-10" />

      <div className="p-4 sm:p-6 border-b border-slate-100 bg-gradient-to-r from-white via-indigo-50/40 to-white space-y-4">
        {/* Top row: brand + search */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative shrink-0">
              <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl blur-lg opacity-40 -z-10 animate-pulse-glow" />
              <div className="w-11 h-11 bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/30 ring-1 ring-white/30">
                <FileText className="w-5 h-5 text-white" strokeWidth={2.5} />
              </div>
            </div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-display font-extrabold tracking-tight">
                <span className="text-slate-900">PDF</span>
                <span className="text-gradient-primary"> Vault</span>
              </h2>
              <p className="text-[9px] sm:text-[10px] text-slate-500 font-bold uppercase tracking-[0.22em] flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse-glow" />
                Document Intelligence Center
              </p>
            </div>
          </div>
          <div className="relative w-full sm:w-72 group focus-glow rounded-xl">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-indigo-600 transition-colors" />
            <Input
              placeholder="Search documents..."
              className="pl-10 h-10 bg-white border-slate-200 rounded-xl text-sm focus-visible:ring-2 focus-visible:ring-indigo-500/40 focus-visible:border-indigo-500/40 transition-all"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Second row: stat cards (also act as status filters) */}
        <motion.div
          initial="hidden"
          animate="visible"
          variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } } }}
          className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3"
        >
          <VaultStatCard
            label="Total"
            value={counts.total}
            icon={<FileText className="w-3.5 h-3.5" />}
            theme="indigo"
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          <VaultStatCard
            label="Verified"
            value={counts.verified}
            icon={<CheckCircle2 className="w-3.5 h-3.5" />}
            theme="emerald"
            active={statusFilter === "verified"}
            onClick={() => setStatusFilter("verified")}
          />
          <VaultStatCard
            label="Mismatch"
            value={counts.mismatch}
            icon={<XCircle className="w-3.5 h-3.5" />}
            theme="rose"
            active={statusFilter === "mismatch"}
            onClick={() => setStatusFilter("mismatch")}
          />
          <VaultStatCard
            label="Pending Review"
            value={counts.review}
            icon={<Clock className="w-3.5 h-3.5" />}
            theme="amber"
            active={statusFilter === "review"}
            onClick={() => setStatusFilter("review")}
          />
        </motion.div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar List - grouped by category */}
        <div className="w-[300px] shrink-0 border-r border-slate-100 flex flex-col bg-gradient-to-b from-white to-slate-50/50">
          <ScrollArea className="flex-1">
            <div className="p-4 sm:p-5 space-y-6">
              {DOC_CATEGORIES.map((cat) => {
                const items = filtered[cat.key] || [];
                if (items.length === 0) return null;
                const verifiedInCat = items.filter((i) => i.status === "verified").length;
                const Icon = cat.icon;
                return (
                  <motion.section
                    key={cat.key}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    className="space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2 px-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={cn("w-5 h-5 rounded-md bg-gradient-to-br flex items-center justify-center shrink-0", cat.accent)}>
                          <Icon className="w-3 h-3 text-white" />
                        </div>
                        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 truncate">
                          {cat.title}
                        </span>
                      </div>
                      <span className="text-[10px] font-bold tabular-nums text-slate-400 shrink-0">
                        {verifiedInCat}/{items.length} verified
                      </span>
                    </div>
                    <div className="h-[1px] bg-gradient-to-r from-slate-200 via-slate-100 to-transparent" />

                    <motion.div
                      className="grid grid-cols-1 gap-2.5"
                      initial="hidden"
                      animate="visible"
                      variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.04 } } }}
                    >
                      {items.map(({ doc, status, validationResult }) => (
                        <DocumentVaultCard
                          key={doc.id}
                          doc={doc}
                          status={status}
                          validationResult={validationResult}
                          icon={Icon}
                          isSelected={selectedDoc?.id === doc.id}
                          onSelect={() => setSelectedDoc(doc)}
                        />
                      ))}
                    </motion.div>
                  </motion.section>
                );
              })}

              {Object.values(filtered).flat().length === 0 && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  className="text-center py-16 sm:py-20 px-4"
                >
                  <div className="relative w-16 h-16 mx-auto mb-3">
                    <div className="absolute inset-0 rounded-full bg-gradient-to-br from-slate-100 to-indigo-100 blur-xl opacity-60" />
                    <div className="relative w-16 h-16 bg-gradient-to-br from-white to-slate-50 rounded-full flex items-center justify-center mx-auto border border-slate-200 shadow-inner animate-float">
                      <Search className="w-7 h-7 text-slate-300" strokeWidth={1.8} />
                    </div>
                  </div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">No documents found</p>
                  <p className="text-[10px] text-slate-400 font-medium mt-1">
                    {docs.length === 0 ? "Upload land documents to populate the vault" : "Try a different filter or search"}
                  </p>
                </motion.div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* PDF Viewer Area */}
        <div className="flex-1 bg-gradient-to-br from-slate-100 via-slate-50 to-indigo-50/30 relative">
          {selectedDoc ? (
            <motion.div
              key={selectedDoc.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.35 }}
              className="h-full flex flex-col"
            >
              <div className="p-3 bg-white/80 backdrop-blur-md border-b border-slate-200 flex items-center justify-between px-4 sm:px-6 gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shrink-0 shadow-sm shadow-indigo-500/20">
                    <FileText className="w-3.5 h-3.5 text-white" />
                  </div>
                  <p className="text-xs font-bold text-slate-900 truncate">{selectedDoc.original_filename}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="sm" asChild className="h-8 border-indigo-200 text-indigo-700 hover:text-indigo-700 hover:bg-indigo-50 font-bold text-[10px] uppercase rounded-lg transition-all hover:scale-105">
                    <a href={`${API_BASE_URL}/api/v1/landwise/documents/download/${selectedDoc.id}`} target="_blank" rel="noopener noreferrer">
                      <Download className="w-3 h-3 mr-1.5" /> Download
                    </a>
                  </Button>
                </div>
              </div>
              <div className="flex-1 flex items-center justify-center overflow-hidden">
                {selectedDoc.original_filename.toLowerCase().endsWith('.pdf') ? (
                  <iframe
                    src={`${API_BASE_URL}/api/v1/landwise/documents/download/${selectedDoc.id}#toolbar=1&view=FitH`}
                    className="w-full h-full bg-white"
                    title="PDF Preview"
                  />
                ) : (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
                    className="text-center space-y-4"
                  >
                    <div className="relative w-24 h-24 mx-auto">
                      <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-3xl blur-xl opacity-30 animate-pulse-glow" />
                      <div className="relative w-24 h-24 bg-white rounded-3xl flex items-center justify-center shadow-xl border border-slate-100 ring-1 ring-white">
                        <FolderArchive className="w-12 h-12 text-indigo-600" />
                      </div>
                    </div>
                    <div>
                      <h3 className="text-lg font-display font-extrabold text-slate-900">Archive File</h3>
                      <p className="text-sm text-slate-500 max-w-xs mx-auto mt-1">ZIP archives cannot be previewed. Download to view contents.</p>
                      <Button asChild className="mt-4 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 text-white font-bold rounded-xl shine-sweep shadow-lg shadow-indigo-500/30">
                        <a href={`${API_BASE_URL}/api/v1/landwise/documents/download/${selectedDoc.id}`} download>
                          <Download className="w-4 h-4 mr-2" /> Download ZIP
                        </a>
                      </Button>
                    </div>
                  </motion.div>
                )}
              </div>
            </motion.div>
          ) : (
            <NoDocumentSelectedState />
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Vault Stat Card (clickable filter) ───────────────────────────────────

function VaultStatCard({
  label,
  value,
  icon,
  theme,
  active,
  onClick,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  theme: "indigo" | "emerald" | "rose" | "amber";
  active: boolean;
  onClick: () => void;
}) {
  const animated = useStatCountUp(value);
  const themes = {
    indigo: {
      ring: "from-indigo-500 to-blue-600",
      text: "text-indigo-700",
      soft: "from-indigo-50 to-white",
      border: "border-indigo-200",
      shadow: "hover:shadow-indigo-100",
      activeBorder: "border-indigo-400",
      activeRing: "ring-indigo-300/50",
    },
    emerald: {
      ring: "from-emerald-500 to-emerald-600",
      text: "text-emerald-700",
      soft: "from-emerald-50 to-white",
      border: "border-emerald-200",
      shadow: "hover:shadow-emerald-100",
      activeBorder: "border-emerald-400",
      activeRing: "ring-emerald-300/50",
    },
    rose: {
      ring: "from-rose-500 to-red-600",
      text: "text-rose-700",
      soft: "from-rose-50 to-white",
      border: "border-rose-200",
      shadow: "hover:shadow-rose-100",
      activeBorder: "border-rose-400",
      activeRing: "ring-rose-300/50",
    },
    amber: {
      ring: "from-amber-500 to-orange-500",
      text: "text-amber-700",
      soft: "from-amber-50 to-white",
      border: "border-amber-200",
      shadow: "hover:shadow-amber-100",
      activeBorder: "border-amber-400",
      activeRing: "ring-amber-300/50",
    },
  }[theme];

  return (
    <motion.button
      type="button"
      onClick={onClick}
      variants={{
        hidden: { opacity: 0, y: 8, scale: 0.97 },
        visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
      }}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.98 }}
      className={cn(
        "group relative bg-gradient-to-br border rounded-xl p-3 text-left overflow-hidden transition-all hover:shadow-lg ring-2 ring-transparent",
        themes.soft,
        themes.border,
        themes.shadow,
        active && cn(themes.activeBorder, themes.activeRing, "shadow-lg"),
      )}
    >
      {/* Corner glow */}
      <div className={cn("absolute -top-8 -right-8 w-20 h-20 rounded-full opacity-20 blur-xl bg-gradient-to-br", themes.ring)} />
      {/* Active indicator strip */}
      {active && (
        <motion.span
          layoutId="vault-stat-active"
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          className={cn("absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r", themes.ring)}
        />
      )}
      <div className="relative flex items-center gap-2.5">
        <div className={cn("w-8 h-8 rounded-lg bg-gradient-to-br flex items-center justify-center text-white shadow-sm shrink-0 transition-transform group-hover:scale-105 group-hover:rotate-3", themes.ring)}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn("text-lg sm:text-xl font-display font-extrabold tabular-nums leading-none", themes.text)}>
            {animated}
          </p>
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.16em] mt-1 truncate">
            {label}
          </p>
        </div>
      </div>
    </motion.button>
  );
}

// ─── Vault Card with status colors ────────────────────────────────────────

function DocumentVaultCard({
  doc,
  status,
  validationResult,
  icon: Icon,
  isSelected,
  onSelect,
}: {
  doc: any;
  status: DocStatus;
  validationResult?: any;
  icon: React.ComponentType<any>;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const theme = {
    verified: {
      bg: "bg-gradient-to-br from-emerald-50 via-emerald-50/60 to-white",
      border: "border-emerald-200/80",
      ring: "hover:ring-emerald-300/60",
      iconBg: "bg-white",
      iconColor: "text-emerald-600",
      dot: "bg-emerald-500",
      label: "Verified",
      labelColor: "text-emerald-700",
      labelBg: "bg-emerald-500",
      shadow: "shadow-emerald-100/50",
      LabelIcon: CheckCircle2,
    },
    mismatch: {
      bg: "bg-gradient-to-br from-rose-50 via-red-50/60 to-white",
      border: "border-rose-200/80",
      ring: "hover:ring-rose-300/60",
      iconBg: "bg-white",
      iconColor: "text-rose-600",
      dot: "bg-rose-500",
      label: "Mismatch",
      labelColor: "text-rose-700",
      labelBg: "bg-rose-500",
      shadow: "shadow-rose-100/50",
      LabelIcon: XCircle,
    },
    review: {
      bg: "bg-gradient-to-br from-amber-50 via-yellow-50/60 to-white",
      border: "border-amber-200/80",
      ring: "hover:ring-amber-300/60",
      iconBg: "bg-white",
      iconColor: "text-amber-600",
      dot: "bg-amber-500",
      label: "Pending Review",
      labelColor: "text-amber-700",
      labelBg: "bg-amber-500",
      shadow: "shadow-amber-100/50",
      LabelIcon: Clock,
    },
  }[status];

  // Compose meta line: source · year(s) · pages · size
  const sizeStr = doc.file_size_bytes
    ? doc.file_size_bytes >= 1024 * 1024
      ? `${(doc.file_size_bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${(doc.file_size_bytes / 1024).toFixed(0)} KB`
    : null;
  const pages = doc.page_count || doc.pages || validationResult?.pages;
  const yearLabel = doc.year_label || (doc.start_year && doc.end_year
    ? `${doc.start_year}-${doc.end_year}`
    : doc.year || null);
  const source = (doc.source || doc.registry || "").toString().toLowerCase();
  const metaParts = [source, yearLabel, pages ? `${pages}p` : null, sizeStr].filter(Boolean);
  const fields = validationResult?.match_count
    ? `${coerceMatchCount(validationResult.match_count, validationResult.comparisons)}/${validationResult.comparisons?.length || 0}`
    : null;

  return (
    <motion.button
      variants={{ hidden: { opacity: 0, y: 6 }, visible: { opacity: 1, y: 0 } }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.99 }}
      onClick={onSelect}
      className={cn(
        "relative w-full text-left p-4 rounded-2xl border transition-all overflow-hidden group ring-2 ring-transparent",
        theme.bg,
        theme.border,
        theme.ring,
        theme.shadow,
        isSelected && "ring-indigo-400/60 shadow-lg"
      )}
    >
      {/* Status dot, top-right */}
      <span className="absolute top-3 right-3 inline-flex items-center justify-center">
        <span className={cn("w-2 h-2 rounded-full animate-pulse-glow", theme.dot)} />
      </span>

      {/* Icon tile */}
      <div className={cn(
        "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border border-white shadow-sm",
        theme.iconBg
      )}>
        <Icon className={cn("w-4 h-4", theme.iconColor)} strokeWidth={2.2} />
      </div>

      {/* Title + meta */}
      <div className="mt-3">
        <p className="text-sm font-display font-extrabold text-slate-900 truncate" title={doc.original_filename}>
          {doc.original_filename}
        </p>
        {metaParts.length > 0 && (
          <p className="text-[10px] font-mono text-slate-500 mt-1.5 truncate">
            {metaParts.map((p, i) => (
              <span key={i}>
                {p}
                {i < metaParts.length - 1 && <span className="mx-1.5 text-slate-300">·</span>}
              </span>
            ))}
          </p>
        )}
      </div>

      {/* Status badge */}
      <div className="mt-3 pt-3 border-t border-white/80 flex items-center justify-between gap-2">
        <span className={cn(
          "inline-flex items-center gap-1.5 text-[10px] font-bold tabular-nums px-2 py-0.5 rounded-md",
          theme.labelColor
        )}>
          <span className={cn(
            "inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-white shadow-sm",
            theme.labelBg
          )}>
            <theme.LabelIcon className="w-2.5 h-2.5" strokeWidth={3} />
          </span>
          {theme.label}
        </span>
        {fields && (
          <span className="text-[10px] font-bold text-slate-500 tabular-nums">
            {fields} fields
          </span>
        )}
      </div>
    </motion.button>
  );
}

// ─── Empty preview state ──────────────────────────────────────────────────

function NoDocumentSelectedState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="relative h-full flex flex-col items-center justify-center text-center px-6 overflow-hidden"
    >
      {/* Decorative blob bg */}
      <div className="pointer-events-none absolute inset-0 opacity-50">
        <div className="absolute -top-32 -left-20 w-72 h-72 rounded-full bg-gradient-to-br from-indigo-200/30 to-blue-200/30 blur-3xl animate-blob-slow" />
        <div className="absolute -bottom-32 -right-20 w-72 h-72 rounded-full bg-gradient-to-br from-violet-200/25 to-indigo-200/25 blur-3xl animate-blob" />
      </div>
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.05, duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
        className="relative w-24 h-24 mb-5"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-400 to-blue-500 rounded-3xl blur-2xl opacity-30 animate-pulse-glow" />
        <div className="relative w-24 h-24 bg-white rounded-3xl flex items-center justify-center shadow-xl border border-slate-100 ring-4 ring-white animate-float">
          <FileText className="w-11 h-11 text-indigo-300" strokeWidth={1.4} />
        </div>
        {/* tiny floating sparkle */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.4, duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
          className="absolute -top-1 -right-1 w-7 h-7 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-md"
        >
          <Sparkles className="w-3.5 h-3.5 text-white" />
        </motion.div>
      </motion.div>
      <div className="relative max-w-sm">
        <h3 className="text-base sm:text-lg font-display font-extrabold text-slate-700 tracking-tight">
          <span className="text-gradient-primary">No preview</span>{" "}
          <span className="text-slate-700">selected yet</span>
        </h3>
        <p className="text-xs sm:text-sm text-slate-500 font-medium mt-2 leading-relaxed">
          Pick any document from the list to view it inline. Verified, mismatched, and pending-review files are color-coded so you can audit at a glance.
        </p>
        <div className="flex items-center justify-center gap-3 mt-5 text-[10px] font-bold uppercase tracking-[0.18em]">
          <span className="inline-flex items-center gap-1.5 text-emerald-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Verified
          </span>
          <span className="inline-flex items-center gap-1.5 text-rose-700">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> Mismatch
          </span>
          <span className="inline-flex items-center gap-1.5 text-amber-700">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Pending
          </span>
        </div>
      </div>
    </motion.div>
  );
}

function DocumentsTab({ parcelId, onUploadClick }: { parcelId: string, onUploadClick: () => void }) {
  const { data: docsData, isLoading } = useQuery({
    queryKey: ['documents', parcelId],
    queryFn: () => landwiseApi.listDocuments(parcelId)
  });

  const docs = docsData?.data || [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-black tracking-tight text-slate-900 mb-1">Document Repository</h2>
          <p className="text-slate-500 text-sm font-medium">Managing {docs.length} core legal assets for this parcel.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {docs.map((doc: any) => (
          <div key={doc.id} className="bg-white border border-slate-200 rounded-3xl p-5 hover:border-indigo-300 transition-all group shadow-sm flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100 group-hover:bg-indigo-50 group-hover:border-indigo-200 transition-colors">
                {doc.original_filename.toLowerCase().endsWith('.zip') ? (
                  <FolderArchive className="w-6 h-6 text-indigo-600" />
                ) : (
                  <FileText className="w-6 h-6 text-indigo-600" />
                )}
              </div>
              <Badge variant="outline" className={cn(
                "text-[9px] font-black uppercase tracking-widest px-2 h-5 border shadow-sm",
                doc.extraction_status === 'completed' ? "bg-green-50 text-green-700 border-green-200" : "bg-blue-50 text-blue-700 border-blue-200 animate-pulse"
              )}>
                {doc.extraction_status}
              </Badge>
            </div>
            
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-black text-slate-900 truncate max-w-full" title={doc.original_filename}>{doc.original_filename}</h4>
              <p className="text-[11px] text-slate-500 uppercase font-black tracking-widest mt-1">
                {(doc.document_type || "Unknown").replace('_', ' ')} • {doc.language || "EN"}
              </p>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100">
              <div className="flex flex-col">
                <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider">Extraction Confidence</span>
                <span className="text-xs font-black text-indigo-600">{doc.extraction_confidence ?? "Pending"}%</span>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-slate-100 text-slate-400 hover:text-indigo-600">
                  <Download className="w-3.5 h-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-slate-100 text-slate-400 hover:text-indigo-600">
                  <MoreVertical className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        ))}

        {docs.length === 0 && !isLoading && (
          <div className="col-span-full py-20 text-center border-2 border-dashed border-white/5 rounded-3xl group hover:border-indigo-500/20 transition-colors">
            <div className="w-16 h-16 mx-auto mb-4 bg-white/5 rounded-full flex items-center justify-center border border-white/5">
              <Upload className="w-6 h-6 opacity-20 text-indigo-400" />
            </div>
            <h3 className="text-lg font-bold text-slate-400">No documents uploaded yet</h3>
            <p className="text-slate-600 text-sm mb-6">Start by adding the Encumbrance Certificate or Patta.</p>
            <Button onClick={onUploadClick} variant="outline" className="bg-white/5 border-white/10 hover:bg-white/10">Add First Document</Button>
          </div>
        )}

        {isLoading && (
           [1,2,3].map(i => (
             <div key={i} className="h-32 bg-white/5 animate-pulse rounded-3xl" />
           ))
        )}
      </div>
    </div>
  );
}

function UploadDocumentModal({ isOpen, onClose, parcelId }: { isOpen: boolean, onClose: () => void, parcelId: string }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState("encumbrance_certificate");
  const [language, setLanguage] = useState("tamil");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const handleUpload = async () => {
    if (!file) return;
    
    setIsUploading(true);
    setUploadProgress(10);
    
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("document_type", docType);
      formData.append("language", language);
      formData.append("source", "uploaded");

      // Progress simulation
      const interval = setInterval(() => {
        setUploadProgress(prev => Math.min(prev + 10, 90));
      }, 500);

      // 1) Upload the document.
      await landwiseApi.uploadDocument(parcelId, formData);

      clearInterval(interval);
      setUploadProgress(100);
      queryClient.invalidateQueries({ queryKey: ['documents', parcelId] });

      toast.success("Document uploaded. Starting analysis…", {
        description: `Running the AI pipeline for ${file.name}.`,
        icon: <CheckCircle2 className="w-4 h-4 text-green-500" />,
      });
      onClose();
      reset();

      // 2) Auto-start the workflow. Uploading alone triggers nothing
      //    server-side, so kick off analyze here. Run it in the background
      //    (the pipeline can take a while) and refresh the parcel views when it
      //    finishes. A missing EC makes analyze return 400 — surface that
      //    without flagging the upload itself as failed.
      landwiseApi.analyzeParcel(parcelId)
        .then(() => {
          ["parcels", "parcel-stats", "documents", "hierarchy", "risks", "timeline", "checklist"].forEach((k) =>
            queryClient.invalidateQueries({
              queryKey: k === "parcels" ? ["parcels"] : [k, parcelId],
            })
          );
          toast.success("Analysis complete", {
            icon: <CheckCircle2 className="w-4 h-4 text-green-500" />,
          });
        })
        .catch((analyzeErr: any) => {
          const msg =
            analyzeErr.response?.data?.body?.responseMessage ||
            analyzeErr.response?.data?.detail ||
            "Analysis could not start.";
          toast.info("Uploaded, but analysis didn't run", { description: msg });
        });

    } catch (error: any) {
      toast.error("Upload failed", {
        description:
          error.response?.data?.body?.responseMessage ||
          error.response?.data?.detail ||
          "An unexpected error occurred.",
      });
      setIsUploading(false);
    }
  };

  const reset = () => {
    setFile(null);
    setDocType("encumbrance_certificate");
    setLanguage("tamil");
    setIsUploading(false);
    setUploadProgress(0);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isUploading && onClose()}>
      <DialogContent className="sm:max-w-[500px] bg-white border-slate-200 text-slate-900 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-black flex items-center gap-2 tracking-tight">
            <Upload className="w-5 h-5 text-indigo-600" />
            Upload Legal Asset
          </DialogTitle>
          <DialogDescription className="text-slate-500 font-medium">
            Select a legal document for AI extraction and verification.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label className="text-xs font-bold uppercase tracking-widest text-slate-500">File selection</Label>
            {!file ? (
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-200 bg-slate-50 rounded-2xl cursor-pointer hover:bg-slate-100 transition-all group">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <div className="w-10 h-10 rounded-full bg-slate-200/50 flex items-center justify-center mb-2 group-hover:scale-110 transition-transform">
                      <FileText className="w-5 h-5 text-indigo-500" />
                  </div>
                  <p className="text-[10px] text-slate-500 uppercase mt-1 font-black">Attach .PDF</p>
                </div>
                <input type="file" className="hidden" accept=".pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </label>
            ) : (
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-200 shadow-inner">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-indigo-600/10 rounded flex items-center justify-center">
                    <FileText className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-black text-slate-900 truncate max-w-[200px]">{file.name}</p>
                    <p className="text-[10px] text-slate-500 italic">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setFile(null)} disabled={isUploading} className="h-8 w-8 hover:bg-red-500/10 text-slate-500 hover:text-red-400">
                  <X className="w-4 h-4" />
                </Button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs font-black uppercase tracking-widest text-slate-400">Document Type</Label>
              <Select value={docType} onValueChange={setDocType} disabled={isUploading}>
                <SelectTrigger className="bg-slate-50 border-slate-200 h-10 text-slate-700 font-medium">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent className="bg-white border-slate-200 text-slate-700 font-medium">
                  <SelectItem value="encumbrance_certificate">Encumbrance Cert (EC)</SelectItem>
                  <SelectItem value="sale_deed">Sale Deed</SelectItem>
                  <SelectItem value="patta_chitta">Patta / Chitta</SelectItem>
                  <SelectItem value="field_measurement_book">FMB Map</SelectItem>
                  <SelectItem value="parent_document">Parent Document</SelectItem>
                  <SelectItem value="other">Other Supporting Doc</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-black uppercase tracking-widest text-slate-400">Primary Language</Label>
              <Select value={language} onValueChange={setLanguage} disabled={isUploading}>
                <SelectTrigger className="bg-slate-50 border-slate-200 h-10 text-slate-700 font-medium">
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent className="bg-white border-slate-200 text-slate-700 font-medium">
                  <SelectItem value="tamil">Tamil</SelectItem>
                  <SelectItem value="english">English</SelectItem>
                  <SelectItem value="telugu">Telugu</SelectItem>
                  <SelectItem value="hindi">Hindi</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {isUploading && (
            <div className="space-y-2 animate-in fade-in zoom-in-95 duration-300">
              <div className="flex justify-between items-end mb-1">
                <span className="text-[10px] font-black uppercase text-indigo-600 flex items-center gap-2">
                  <RefreshCcw className="w-3 h-3 animate-spin" /> Transmitting Digital Asset...
                </span>
                <span className="text-xs font-black text-slate-900">{uploadProgress}%</span>
              </div>
              <Progress value={uploadProgress} className="h-2 bg-slate-100" indicatorClassName="bg-indigo-600 shadow-sm" />
            </div>
          )}

          <div className="p-4 bg-indigo-600/5 rounded-2xl border border-indigo-500/10 flex gap-3">
             <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
             <p className="text-[11px] text-slate-500 leading-tight">
               AI will automatically identify survey numbers, owner names, and transaction history. Extraction results will appear in the Intelligence rail.
             </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onClose} disabled={isUploading} className="text-slate-500 hover:bg-slate-100 font-bold">Cancel</Button>
          <Button 
            onClick={handleUpload} 
            disabled={!file || isUploading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white min-w-[120px] shadow-lg shadow-indigo-600/20 font-bold"
          >
            {isUploading ? "Uploading..." : "Start Extraction"}
            {!isUploading && <ChevronRight className="w-4 h-4 ml-2" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BatchAuditModal({ isOpen, onClose, parcelId, onUploaded }: { isOpen: boolean, onClose: () => void, parcelId: string, onUploaded?: (ec: File, zip: File, limit?: number) => void }) {
  const queryClient = useQueryClient();
  const [ecFile, setEcFile] = useState<File | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [transactionLimit, setTransactionLimit] = useState<string>("all");
  const [isUploading, setIsUploading] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");
  const [visualDebugEnabled, setVisualDebugEnabled] = useState(true);
  // "Upload & Continue" hands the attached files + limit to the checklist step.
  // NOTHING is uploaded yet — the actual upload + analysis only happen after the
  // user approves the checklist (see the dashboard's ChecklistModal onApprove).
  const handleBatchAudit = () => {
    if (!ecFile || !zipFile) {
      toast.error("Missing files", {
        description: "Please attach both the Encumbrance Certificate and the Sale Deeds ZIP.",
      });
      return;
    }
    const limitVal = transactionLimit === "all" ? undefined : parseInt(transactionLimit);
    const ec = ecFile;
    const zip = zipFile;
    onClose();
    reset();
    onUploaded?.(ec, zip, limitVal);
  };

  const reset = () => {
    setEcFile(null);
    setZipFile(null);
    setTransactionLimit("all");
    setIsUploading(false);
    setProgressLabel("");
  };

  const bothFilesReady = !!ecFile && !!zipFile;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isUploading && onClose()}>
      <DialogContent className="sm:max-w-[600px] bg-white border-slate-200 text-slate-900 shadow-2xl rounded-2xl overflow-hidden p-0 max-h-[90vh]">
        {/* Top accent strip */}
        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500 z-10" />
        {/* Background flourish */}
        <div className="pointer-events-none absolute inset-0 opacity-40">
          <div className="absolute -top-24 -right-24 w-56 h-56 rounded-full bg-gradient-to-br from-violet-200/40 to-indigo-200/40 blur-3xl animate-blob-slow" />
          <div className="absolute -bottom-24 -left-24 w-56 h-56 rounded-full bg-gradient-to-br from-blue-200/30 to-indigo-200/30 blur-3xl animate-blob" />
        </div>

        <div className="relative px-4 py-4 overflow-y-auto custom-scrollbar max-h-[90vh]">
        <DialogHeader>
          <DialogTitle asChild>
            <div className="flex items-center gap-2 tracking-tight">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600 flex items-center justify-center shadow-sm shadow-indigo-500/30 shrink-0">
                <Zap className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
              </div>
              <h2 className="text-base sm:text-lg font-display font-extrabold leading-tight">
                Trigger <span className="text-gradient-primary">Batch Audit</span>
              </h2>
            </div>
          </DialogTitle>
          <DialogDescription asChild>
            <p className="text-slate-500 font-medium pt-0.5 text-xs leading-snug">
              Replicates the legacy workflow perfectly. Upload EC and Deeds at the same time to trigger immediate verification flow.
            </p>
          </DialogDescription>
        </DialogHeader>

        <motion.div
          className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-3"
          initial="hidden"
          animate="visible"
          variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } } }}
        >
          {/* EC FILE SLOT */}
          <motion.div
            variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } } }}
            className="space-y-1.5"
          >
            <Label className="text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500 flex items-center gap-1.5">
              <span className="w-3.5 h-3.5 rounded bg-gradient-to-br from-indigo-500 to-blue-600 text-white text-[8px] font-bold flex items-center justify-center">1</span>
              Encumbrance Certificate
            </Label>
            <AnimatePresence mode="wait" initial={false}>
              {!ecFile ? (
                <motion.label
                  key="empty-ec"
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.2 }}
                  className="relative flex flex-col items-center justify-center w-full h-24 border-2 border-dashed border-slate-200 bg-gradient-to-br from-slate-50 to-white rounded-lg cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-all group"
                >
                  <div className="relative flex flex-col items-center justify-center">
                    <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center shadow-sm border border-slate-200 group-hover:border-indigo-200 transition-all">
                      <FileText className="w-4 h-4 text-indigo-500" strokeWidth={2} />
                    </div>
                    <p className="text-[9px] text-slate-500 group-hover:text-indigo-600 uppercase font-bold tracking-[0.14em] mt-1.5 transition-colors">Attach .PDF</p>
                  </div>
                  <input type="file" className="hidden" accept=".pdf" onChange={(e) => setEcFile(e.target.files?.[0] || null)} />
                </motion.label>
              ) : (
                <motion.div
                  key="filled-ec"
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.94 }}
                  transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
                  className="relative flex items-center gap-2 p-2.5 bg-gradient-to-br from-indigo-50 to-blue-50/40 rounded-lg border border-indigo-200 shadow-sm h-24"
                >
                  <div className="relative w-9 h-9 rounded-lg bg-white flex items-center justify-center shadow-sm border border-indigo-100 shrink-0">
                    <FileText className="w-4 h-4 text-indigo-600" />
                    <span className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full bg-emerald-500 flex items-center justify-center ring-2 ring-white">
                      <CheckCircle2 className="w-2 h-2 text-white" strokeWidth={3} />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-display font-extrabold text-slate-900 truncate" title={ecFile.name}>{ecFile.name}</p>
                    <p className="text-[9px] uppercase font-bold tracking-wider text-indigo-600/80 mt-0.5 tabular-nums">
                      {(ecFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => setEcFile(null)} className="h-6 w-6 rounded-md text-slate-400 hover:text-red-500 hover:bg-white shrink-0">
                    <X className="w-3 h-3" />
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* ZIP FILE SLOT */}
          <motion.div
            variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } } }}
            className="space-y-1.5"
          >
            <Label className="text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500 flex items-center gap-1.5">
              <span className="w-3.5 h-3.5 rounded bg-gradient-to-br from-violet-500 to-indigo-600 text-white text-[8px] font-bold flex items-center justify-center">2</span>
              Sale Deeds Archive
            </Label>
            <AnimatePresence mode="wait" initial={false}>
              {!zipFile ? (
                <motion.label
                  key="empty-zip"
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.2 }}
                  className="relative flex flex-col items-center justify-center w-full h-24 border-2 border-dashed border-slate-200 bg-gradient-to-br from-slate-50 to-white rounded-lg cursor-pointer hover:border-violet-300 hover:bg-violet-50/30 transition-all group"
                >
                  <div className="relative flex flex-col items-center justify-center">
                    <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center shadow-sm border border-slate-200 group-hover:border-violet-200 transition-all">
                      <FolderArchive className="w-4 h-4 text-violet-500" strokeWidth={2} />
                    </div>
                    <p className="text-[9px] text-slate-500 group-hover:text-violet-600 uppercase font-bold tracking-[0.14em] mt-1.5 transition-colors">Attach .ZIP</p>
                  </div>
                  <input type="file" className="hidden" accept=".zip" onChange={(e) => setZipFile(e.target.files?.[0] || null)} />
                </motion.label>
              ) : (
                <motion.div
                  key="filled-zip"
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.94 }}
                  transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
                  className="relative flex items-center gap-2 p-2.5 bg-gradient-to-br from-violet-50 to-indigo-50/40 rounded-lg border border-violet-200 shadow-sm h-24"
                >
                  <div className="relative w-9 h-9 rounded-lg bg-white flex items-center justify-center shadow-sm border border-violet-100 shrink-0">
                    <FolderArchive className="w-4 h-4 text-violet-600" />
                    <span className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full bg-emerald-500 flex items-center justify-center ring-2 ring-white">
                      <CheckCircle2 className="w-2 h-2 text-white" strokeWidth={3} />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-display font-extrabold text-slate-900 truncate" title={zipFile.name}>{zipFile.name}</p>
                    <p className="text-[9px] uppercase font-bold tracking-wider text-violet-600/80 mt-0.5 tabular-nums">
                      {(zipFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => setZipFile(null)} className="h-6 w-6 rounded-md text-slate-400 hover:text-red-500 hover:bg-white shrink-0">
                    <X className="w-3 h-3" />
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>

        {/* Visual Debugger Toggle */}
        <div className="py-2.5 border-t border-slate-100 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 cursor-pointer min-w-0 flex-1" onClick={() => setVisualDebugEnabled(!visualDebugEnabled)}>
            <motion.div
              animate={{
                background: visualDebugEnabled
                  ? "linear-gradient(135deg, #7c3aed, #4f46e5)"
                  : "#f1f5f9",
              }}
              transition={{ duration: 0.25 }}
              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
            >
              <SearchCode className={cn("w-3.5 h-3.5 transition-colors", visualDebugEnabled ? "text-white" : "text-slate-400")} />
            </motion.div>
            <div className="min-w-0 leading-tight">
              <p className="text-[11px] font-bold text-slate-900 uppercase tracking-[0.12em]">Enable Visual Debugger</p>
              <p className="text-[9px] text-slate-500 font-medium leading-tight mt-0.5">Generates forensic PDF proofs for field mismatches.</p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={visualDebugEnabled}
            onClick={() => setVisualDebugEnabled(!visualDebugEnabled)}
            className={cn(
              "w-9 h-5 rounded-full p-0.5 transition-all relative shrink-0",
              visualDebugEnabled
                ? "bg-gradient-to-r from-violet-600 to-indigo-600"
                : "bg-slate-200"
            )}
          >
            <motion.div
              layout
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className={cn(
                "w-4 h-4 bg-white rounded-full shadow flex items-center justify-center",
                visualDebugEnabled ? "ml-auto" : ""
              )}
            />
          </button>
        </div>

        {/* Transaction Scope */}
        <div className="py-2.5 border-t border-slate-100 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-50 to-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0">
              <Filter className="w-3.5 h-3.5 text-indigo-600" />
            </div>
            <div className="min-w-0 leading-tight">
              <Label className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-700 block">Transaction Scope</Label>
              <p className="text-[9px] text-slate-400 font-medium mt-0.5">Limit the audit depth for faster processing</p>
            </div>
          </div>
          <Select value={transactionLimit} onValueChange={setTransactionLimit}>
            <SelectTrigger className="w-full sm:w-[180px] border-slate-200 bg-slate-50 hover:border-indigo-300 hover:bg-indigo-50/30 text-xs font-bold transition-all rounded-md h-8 focus:ring-2 focus:ring-indigo-500/40">
              <SelectValue placeholder="All Transactions" />
            </SelectTrigger>
            <SelectContent className="border-slate-200 rounded-md text-xs">
              <SelectItem value="5" className="font-bold">Last 5 Transactions</SelectItem>
              <SelectItem value="10" className="font-bold">Last 10 Transactions</SelectItem>
              <SelectItem value="20" className="font-bold">Last 20 Transactions</SelectItem>
              <SelectItem value="all" className="font-bold text-indigo-600">Entire Legal History</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <DialogFooter className="pt-3 mt-1 border-t border-slate-100 gap-2 flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isUploading}
            className="text-slate-500 hover:bg-slate-100 hover:text-slate-700 text-xs font-bold h-8 px-3 rounded-md"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleBatchAudit}
            disabled={!ecFile || !zipFile || isUploading}
            className={cn(
              "min-w-[180px] text-xs font-bold h-8 px-4 rounded-md gap-1.5 text-white transition-all shine-sweep",
              bothFilesReady && !isUploading
                ? "bg-gradient-to-r from-violet-600 via-indigo-600 to-blue-600 hover:from-violet-700 hover:via-indigo-700 hover:to-blue-700 shadow-md shadow-indigo-500/30"
                : "bg-slate-300 hover:bg-slate-300 cursor-not-allowed"
            )}
          >
            {isUploading ? (
              <>
                <RefreshCcw className="w-3 h-3 animate-spin" />
                <span className="truncate">{progressLabel}</span>
              </>
            ) : (
              <>
                Upload &amp; Continue
                <ChevronRight className="w-3 h-3" />
              </>
            )}
          </Button>
        </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChecklistModal({ isOpen, onClose, onApprove }: { isOpen: boolean; onClose: () => void; onApprove: (ids: string[]) => void }) {
  const [selectedChecks, setSelectedChecks] = useState<string[]>(AUTOMATED_CHECK_IDS);
  // Reset each time the modal opens: AI-automatable checks pre-selected (the
  // ones that actually run), manual ones shown but unticked.
  useEffect(() => {
    if (isOpen) setSelectedChecks([...AUTOMATED_CHECK_IDS]);
  }, [isOpen]);
  const toggleCheck = (id: string) =>
    setSelectedChecks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[640px] bg-white border-slate-200 text-slate-900 shadow-2xl rounded-2xl overflow-hidden p-0 max-h-[90vh]">
        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-emerald-500 via-green-500 to-teal-500 z-10" />
        <div className="relative px-5 py-4 overflow-y-auto custom-scrollbar max-h-[90vh]">
          <DialogHeader>
            <DialogTitle asChild>
              <div className="flex items-center gap-2 tracking-tight">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-sm shrink-0">
                  <CheckCircle2 className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
                </div>
                <h2 className="text-base sm:text-lg font-display font-extrabold leading-tight">Checks to <span className="text-gradient-primary">Run</span></h2>
              </div>
            </DialogTitle>
            <DialogDescription asChild>
              <p className="text-slate-500 font-medium pt-0.5 text-xs leading-snug">
                Documents uploaded. The full property checklist is shown — items marked <b>AI</b> are run automatically by LandwiseAI (pre-selected); <b>Manual</b> items are for your offline verification. Untick anything you don't want in the report.
              </p>
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-end gap-2 mt-3 mb-2">
            <span className="text-[10px] font-bold text-emerald-700 tabular-nums">{selectedChecks.length}/{LANDWISE_CHECKS.length} selected</span>
            <button
              type="button"
              onClick={() => setSelectedChecks(selectedChecks.length === LANDWISE_CHECKS.length ? [] : [...ALL_CHECK_IDS])}
              className="text-[9px] font-bold uppercase tracking-wide text-indigo-600 hover:text-indigo-700"
            >
              {selectedChecks.length === LANDWISE_CHECKS.length ? "Clear all" : "Select all"}
            </button>
          </div>

          {/* All sections on one scrollable page — every category shown with a
              sticky section header (no tabs). */}
          <div className="max-h-[440px] overflow-y-auto custom-scrollbar rounded-xl border border-slate-100">
            {CHECK_CATEGORIES.map((cat) => {
              const catChecks = LANDWISE_CHECKS.filter((c) => c.category === cat);
              const catSel = catChecks.filter((c) => selectedChecks.includes(c.id)).length;
              return (
                <div key={cat}>
                  <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-3 py-1.5 bg-slate-50 border-y border-slate-100">
                    <span className="text-[10px] font-extra-bold uppercase tracking-[0.12em] text-slate-500">{cat}</span>
                    <span className="text-[9px] font-bold text-slate-400 tabular-nums">{catSel}/{catChecks.length}</span>
                  </div>
                  <div className="divide-y divide-slate-50">
                    {catChecks.map((chk) => {
                      const on = selectedChecks.includes(chk.id);
                      return (
                        <button
                          key={chk.id}
                          type="button"
                          onClick={() => toggleCheck(chk.id)}
                          className="w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50 transition-colors"
                        >
                          <span className={cn("w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors", on ? "bg-emerald-500 border-emerald-500" : "bg-white border-slate-300")}>
                            {on && <CheckCircle2 className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
                          </span>
                          <span className={cn("text-sm font-semibold truncate flex-1 min-w-0", on ? "text-slate-800" : "text-slate-400 line-through")}>{chk.label}</span>
                          <span
                            className={cn(
                              "text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0",
                              chk.automated ? "bg-indigo-50 text-indigo-700 border-indigo-100" : "bg-slate-100 text-slate-500 border-slate-200",
                            )}
                            title={chk.automated ? "Performed automatically by LandwiseAI" : "Verify manually — not automated"}
                          >
                            {chk.automated ? "AI" : "Manual"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <DialogFooter className="pt-4 mt-1 border-t border-slate-100 gap-2 flex-wrap">
            <Button variant="ghost" size="sm" onClick={onClose} className="text-slate-500 hover:bg-slate-100 hover:text-slate-700 text-xs font-bold h-9 px-3 rounded-md">
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => onApprove(selectedChecks)}
              className="min-w-[200px] text-xs font-bold h-9 px-4 rounded-md gap-1.5 text-white bg-gradient-to-r from-emerald-600 via-green-600 to-teal-600 hover:from-emerald-700 hover:via-green-700 hover:to-teal-700 shadow-md shadow-emerald-500/30 shine-sweep transition-all"
            >
              Approve &amp; Start Analysis
              <Zap className="w-3.5 h-3.5" />
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TabButton({ label, active, icon, onClick }: { label: string, active?: boolean, icon: React.ReactNode, onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-2 px-4 py-2 rounded-lg text-[11px] font-bold transition-all h-9 tracking-wide uppercase whitespace-nowrap",
        active
          ? "text-white"
          : "text-slate-500 hover:text-indigo-600"
      )}
    >
      {active && (
        <motion.span
          layoutId="dashboard-active-tab"
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          className="absolute inset-0 rounded-lg bg-gradient-to-br from-indigo-600 to-blue-600 shadow-lg shadow-indigo-500/30"
        />
      )}
      <span className="relative z-10 flex items-center gap-2">
        {icon}
        {label}
      </span>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { wrap: string; dot: string }> = {
    pending:   { wrap: "bg-slate-100 text-slate-600 border-slate-200",   dot: "bg-slate-400" },
    in_review: { wrap: "bg-blue-50 text-blue-700 border-blue-200",       dot: "bg-blue-500 animate-pulse-glow" },
    flagged:   { wrap: "bg-red-50 text-red-700 border-red-200",          dot: "bg-red-500 animate-pulse-glow" },
    verified:  { wrap: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
    completed: { wrap: "bg-indigo-50 text-indigo-700 border-indigo-200", dot: "bg-indigo-500" },
    inactive:  { wrap: "bg-slate-50 text-slate-400 border-slate-100 italic opacity-60", dot: "bg-slate-300" },
  };

  // Coalesce — a freshly-registered parcel can briefly have null/undefined
  // status before the row is persisted, and StatusBadge mounted before the
  // value arrived crashed the whole sidebar render.
  const safeStatus = status || 'pending';
  const label = safeStatus === 'in_review' ? 'Reviewing' : safeStatus.charAt(0).toUpperCase() + safeStatus.slice(1);
  const cfg = styles[safeStatus] || styles.pending;

  return (
    <Badge variant="outline" className={cn("text-[9px] font-bold uppercase px-2 h-5 border leading-none tracking-wider gap-1.5 inline-flex items-center", cfg.wrap)}>
      <span className={cn("w-1.5 h-1.5 rounded-full", cfg.dot)} />
      {label}
    </Badge>
  );
}

function StatCard({ label, value, unit, trend, trendColor, isRisk, alert }: { label: string, value: any, unit?: string, trend: string, trendColor?: string, isRisk?: boolean, alert?: boolean }) {
  const numericValue = typeof value === "number" ? value : parseFloat(String(value));
  const animatedNumber = useStatCountUp(Number.isFinite(numericValue) ? numericValue : 0);
  const displayValue = Number.isFinite(numericValue) ? animatedNumber : value;

  // Color theme per card — Risk=amber, Documents=amber, Chain=slate, Encumbrances=emerald
  // (Brand spec: navy primary + outlined status accents)
  const theme = (() => {
    if (isRisk) {
      return {
        topAccent: "bg-[#F59E0B]",
        ring:      "from-[#F59E0B] to-[#D97706]",
        soft:      "bg-[#FEF3C7]",
        dot:       "bg-[#F59E0B]",
        text:      "text-[#D97706]",
        border:    "hover:border-[#F59E0B]/40",
        shadow:    "hover:shadow-amber-100",
      };
    }
    const l = label.toLowerCase();
    if (l.includes("doc")) {
      return {
        topAccent: "bg-[#F59E0B]",
        ring:      "from-[#F59E0B] to-[#D97706]",
        soft:      "bg-[#FEF3C7]",
        dot:       "bg-[#F59E0B]",
        text:      "text-[#D97706]",
        border:    "hover:border-[#F59E0B]/40",
        shadow:    "hover:shadow-amber-100",
      };
    }
    if (l.includes("chain")) {
      return {
        topAccent: "bg-[#CBD5E1]",
        ring:      "from-[#94A3B8] to-[#64748B]",
        soft:      "bg-[#F1F5F9]",
        dot:       "bg-[#94A3B8]",
        text:      "text-[#475569]",
        border:    "hover:border-[#CBD5E1]",
        shadow:    "hover:shadow-slate-100",
      };
    }
    if (l.includes("encum")) {
      return {
        topAccent: "bg-[#10B981]",
        ring:      "from-[#10B981] to-[#059669]",
        soft:      "bg-[#DCFCE7]",
        dot:       "bg-[#10B981]",
        text:      "text-[#166534]",
        border:    "hover:border-[#10B981]/40",
        shadow:    "hover:shadow-emerald-100",
      };
    }
    if (l.includes("complete")) {
      return {
        topAccent: "bg-[#10B981]",
        ring:      "from-[#10B981] to-[#059669]",
        soft:      "bg-[#DCFCE7]",
        dot:       "bg-[#10B981]",
        text:      "text-[#166534]",
        border:    "hover:border-[#10B981]/40",
        shadow:    "hover:shadow-emerald-100",
      };
    }
    // Fallback — navy brand
    return {
      topAccent: "bg-[#1A367E]",
      ring:      "from-[#1A367E] to-[#3B82F6]",
      soft:      "bg-[#EBF1FF]",
      dot:       "bg-[#1A367E]",
      text:      "text-[#1A367E]",
      border:    "hover:border-[#1A367E]/30",
      shadow:    "hover:shadow-blue-100",
    };
  })();

  // Pick an icon based on label
  const StatIcon = (() => {
    if (isRisk) return ShieldAlert;
    const l = label.toLowerCase();
    if (l.includes("doc"))     return FileText;
    if (l.includes("chain"))   return Layers;
    if (l.includes("encum"))   return AlertCircle;
    if (l.includes("complete"))return CheckCircle2;
    return Activity;
  })();

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -2 }}
      className={cn(
        "relative bg-white border border-slate-200 rounded-lg p-2.5 shadow-sm transition-all overflow-hidden group hover:shadow-md",
        theme.border, theme.shadow
      )}
    >
      {/* Top accent ribbon */}
      <div className={cn(
        "absolute inset-x-0 top-0 h-[2px]",
        theme.topAccent
      )} />

      {/* Row 1: tiny label + icon */}
      <div className="relative flex items-center justify-between gap-2 mb-1">
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-[0.14em] leading-none truncate">
          {label}
        </p>
        <div className={cn(
          "w-5 h-5 rounded-md flex items-center justify-center bg-gradient-to-br text-white shrink-0",
          theme.ring
        )}>
          <StatIcon className="w-3 h-3" />
        </div>
      </div>

      {/* Row 2: big number + unit + trend pill side-by-side */}
      <div className="relative flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1 min-w-0">
          <h4 className={cn(
            "text-xl sm:text-2xl font-display font-extrabold tabular-nums tracking-tight leading-none",
            isRisk ? "text-rose-600" : "text-slate-900"
          )}>
            {displayValue}
          </h4>
          {unit && <span className="text-[9px] font-bold text-slate-400 leading-none">{unit}</span>}
        </div>
        <span className={cn(
          "text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider inline-flex items-center gap-1 border shrink-0",
          (isRisk || alert)
            ? "bg-rose-50 text-rose-700 border-rose-200"
            : trendColor && trendColor.includes("emerald")
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : trendColor && trendColor.includes("amber")
                ? "bg-amber-50 text-amber-700 border-amber-200"
                : cn(theme.soft, theme.text, "border-transparent")
        )}>
          <span className={cn("w-1 h-1 rounded-full", (isRisk || alert) ? "bg-rose-500" : theme.dot)} />
          {trend}
        </span>
      </div>
    </motion.div>
  );
}

function useStatCountUp(target: number, duration = 1100) {
  const [val, setVal] = React.useState(0);
  React.useEffect(() => {
    if (!Number.isFinite(target)) return;
    let raf = 0;
    let start: number | null = null;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(eased * target));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function PhaseItem({ num, label, status, active, current }: { num: number, label: string, status: string, active?: boolean, current?: boolean }) {
  const isComplete = active && !current;
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex gap-4 relative z-10 group"
    >
      <div className="relative">
        {current && (
          <span className="absolute inset-0 rounded-xl bg-indigo-500/30 blur-md animate-pulse-glow" />
        )}
        <div className={cn(
          "relative w-7 h-7 rounded-xl flex items-center justify-center text-[10px] font-bold shadow-sm transition-all duration-500",
          isComplete && "bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-emerald-200",
          current && "bg-gradient-to-br from-indigo-600 to-blue-600 text-white shadow-indigo-300 ring-4 ring-indigo-100",
          !active && "bg-slate-100 text-slate-400"
        )}>
          {isComplete ? <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={3} /> : num}
        </div>
      </div>
      <div className="flex-1 pb-1">
        <p className={cn(
          "text-[11px] font-bold uppercase tracking-wide transition-colors",
          active ? "text-slate-900" : "text-slate-400",
          "group-hover:text-indigo-600"
        )}>
          {label}
        </p>
        <p className={cn(
          "text-[10px] font-medium mt-0.5",
          current ? "text-indigo-600" : isComplete ? "text-emerald-600" : "text-slate-400"
        )}>
          {current && <span className="inline-flex w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse-glow mr-1.5 align-middle" />}
          {status}
        </p>
      </div>
    </motion.div>
  );
}

function RiskAlert({ category, desc, severity }: { category: string, desc: string, severity: string }) {
  return (
    <div className="p-3 bg-red-400/5 border border-red-500/10 rounded-xl group hover:border-red-500/30 transition-all cursor-pointer">
       <div className="flex items-center justify-between mb-1">
         <span className="text-[10px] font-black uppercase text-red-400/80 tracking-tighter flex items-center gap-1">
           <AlertTriangle className="w-3 h-3" /> {category}
         </span>
         <span className="text-[9px] font-bold text-red-500/50">{severity}</span>
       </div>
       <p className="text-[11px] text-slate-500 leading-tight group-hover:text-slate-400">{desc}</p>
    </div>
  );
}

function ProjectOverview({ project, parcels, stats, onSelectParcel }: { project: Project | undefined, parcels: Parcel[], stats: any, onSelectParcel: (id: string) => void }) {
  if (!project) return null;
  
  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg sm:text-xl font-display font-extrabold tracking-tight text-slate-900 mb-0.5">{project.name}</h2>
          <p className="text-xs text-slate-500 font-medium flex items-center gap-1.5">
             <MapPin className="w-3.5 h-3.5 text-indigo-500" />
             Project Command Center • {project.district}
          </p>
        </div>
        <div className="flex gap-2">
          <RegisterParcelDialog projectId={project.id} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 sm:gap-3 lg:gap-4">
        <StatCard label="Live Surveys" value={parcels.length} trend="+2 this week" />
        <StatCard label="Avg Risk" value={stats?.avg_risk || "0"} unit="/ 100" trend={stats?.avg_risk > 30 ? "High" : "Optimal"} isRisk />
        <StatCard label="Avg Completion" value={stats?.avg_completion || "0"} unit="%" trend="Real-time" />
      </div>

      <div className="space-y-3">
        <h3 className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-500">Survey Numbers ({parcels.length})</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 sm:gap-3">
          {parcels.map(parcel => (
            <div
              key={parcel.id}
              className="bg-white border border-slate-200 rounded-xl p-3 hover:border-indigo-600 hover:shadow-md transition-all cursor-pointer group shadow-sm"
              onClick={() => onSelectParcel(parcel.id)}
            >
              <div className="flex justify-between items-start mb-2">
                <div className="w-8 h-8 bg-slate-50 rounded-lg flex items-center justify-center border border-slate-100 group-hover:bg-indigo-50 transition-colors">
                  <MapPin className="w-4 h-4 text-indigo-600" />
                </div>
                <StatusBadge status={parcel.status} />
              </div>
              <h4 className="text-sm font-display font-extrabold text-slate-900 group-hover:text-indigo-600 transition-colors leading-tight">SN {parcel.survey_number}</h4>
              <p className="text-[10px] text-slate-500 mb-2 mt-0.5">{parcel.village}, {parcel.taluk}</p>
              <div className="flex items-center justify-between mt-auto">
                 <div className="flex items-center gap-1.5">
                    <Activity className="w-3 h-3 text-indigo-600" />
                    <span className="text-[10px] font-bold text-slate-900">{parcel.completion_score}% Complete</span>
                 </div>
                 <ArrowRight className="w-3.5 h-3.5 text-indigo-600 opacity-0 group-hover:opacity-100 transition-all" />
              </div>
            </div>
          ))}

          {parcels.length === 0 && (
            <div className="col-span-full py-12 text-center border-2 border-dashed border-slate-200 rounded-2xl">
               <LayoutDashboard className="w-9 h-9 text-slate-200 mx-auto mb-2" />
               <h3 className="text-sm font-bold text-slate-400">No survey numbers registered</h3>
               <p className="text-xs text-slate-500 mb-4">Begin by registering the first survey number for this project.</p>
               <RegisterParcelDialog projectId={project.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NewProjectModal({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [targetDate, setTargetDate] = useState<Date | undefined>(undefined);
  
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    district: "",
    state: "Tamil Nadu",
    project_type: "Land Acquisition",
    project_icon: "building",
    legal_advisor_id: "",
    status: "active"
  });

  const { data: advisorsData } = useQuery<any[]>({
    queryKey: ['legal-advisors'],
    queryFn: landwiseApi.listLegalAdvisors,
    enabled: isOpen
  });

  const advisors = (advisorsData as any[]) || [];

  const projectTypes = [
    { value: "Land Acquisition", label: "Land Acquisition" },
    { value: "Title Diligence", label: "Title Diligence" },
    { value: "Development Project", label: "Development Project" },
    { value: "Industrial Setup", label: "Industrial Setup" },
    { value: "Residential Layout", label: "Residential Layout" },
    { value: "Litigation Portfolio", label: "Litigation Portfolio" }
  ];

  const icons = [
    { id: "building", icon: Building, color: "text-blue-500" },
    { id: "home", icon: Home, color: "text-indigo-500" },
    { id: "tree", icon: TreePine, color: "text-green-500" },
    { id: "factory", icon: Factory, color: "text-slate-500" },
    { id: "hardhat", icon: HardHat, color: "text-amber-500" },
    { id: "scale", icon: Scale, color: "text-purple-500" },
    { id: "landmark", icon: Landmark, color: "text-orange-500" },
    { id: "gantt", icon: GanttChart, color: "text-teal-500" }
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const payload = {
        ...formData,
        target_acquisition_date: targetDate ? format(targetDate, "yyyy-MM-dd") : null
      };
      await landwiseApi.createProject(payload);
      toast.success("Project created successfully", {
        description: `${formData.name} has been added to your portfolio.`,
        icon: <CheckCircle2 className="w-4 h-4 text-green-500" />,
      });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
      resetForm();
    } catch (error: any) {
      toast.error("Failed to create project", {
        description: error.response?.data?.detail || "An unexpected error occurred."
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      district: "",
      state: "Tamil Nadu",
      project_type: "Land Acquisition",
      project_icon: "building",
      legal_advisor_id: "",
      status: "active"
    });
    setTargetDate(undefined);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent className="sm:max-w-[600px] bg-white border-slate-200 text-slate-900 shadow-2xl rounded-3xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-black flex items-center gap-2 tracking-tight">
            <Plus className="w-5 h-5 text-indigo-600" />
            Initiate Project
          </DialogTitle>
          <DialogDescription className="text-slate-500 font-medium">
            Define a new real-estate project to begin legal auditing.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 py-4">
          <div className="space-y-5">
            {/* Project Name & Type */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-xs font-black uppercase tracking-widest text-slate-500">Project Name</Label>
                <Input 
                  id="name"
                  required
                  placeholder="e.g. Green Valley Residency" 
                  className="bg-slate-50 border-slate-200 h-11 text-slate-700 font-medium focus:ring-indigo-500"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Project Type</Label>
                <Select value={formData.project_type} onValueChange={(val) => setFormData({ ...formData, project_type: val })}>
                  <SelectTrigger className="bg-slate-50 border-slate-200 h-11 text-slate-700 font-medium">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-slate-200 text-slate-700 font-medium">
                    {projectTypes.map((type) => (
                      <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Location */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="district" className="text-xs font-black uppercase tracking-widest text-slate-500">District</Label>
                <Select value={formData.district} onValueChange={(val) => setFormData({ ...formData, district: val })}>
                  <SelectTrigger className="bg-slate-50 border-slate-200 h-11 text-slate-700 font-medium">
                    <SelectValue placeholder="Select district" />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-slate-200 text-slate-700 font-medium">
                    <SelectItem value="Chennai">Chennai</SelectItem>
                    <SelectItem value="Coimbatore">Coimbatore</SelectItem>
                    <SelectItem value="Madurai">Madurai</SelectItem>
                    <SelectItem value="Trichy">Trichy</SelectItem>
                    <SelectItem value="Salem">Salem</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="state" className="text-xs font-black uppercase tracking-widest text-slate-500">State</Label>
                <Select value={formData.state} onValueChange={(val) => setFormData({ ...formData, state: val })}>
                  <SelectTrigger className="bg-slate-50 border-slate-200 h-11 text-slate-700 font-medium">
                    <SelectValue placeholder="Select state" />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-slate-200 text-slate-700 font-medium">
                    <SelectItem value="Tamil Nadu">Tamil Nadu</SelectItem>
                    <SelectItem value="Karnataka">Karnataka</SelectItem>
                    <SelectItem value="Kerala">Kerala</SelectItem>
                    <SelectItem value="Andhra Pradesh">Andhra Pradesh</SelectItem>
                    <SelectItem value="Telangana">Telangana</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Advisor & Date */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Legal Advisor</Label>
                <Select value={formData.legal_advisor_id} onValueChange={(val) => setFormData({ ...formData, legal_advisor_id: val })}>
                  <SelectTrigger className="bg-slate-50 border-slate-200 h-11 text-slate-700 font-medium">
                    <SelectValue placeholder="Select advisor" />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-slate-200 text-slate-700 font-medium">
                    {advisors.map((advisor: any) => (
                      <SelectItem key={advisor.id} value={advisor.id}>{advisor.full_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Target Completion Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn(
                        "w-full bg-slate-50 border-slate-200 h-11 justify-start text-left font-medium",
                        !targetDate && "text-slate-400"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {targetDate ? format(targetDate, "PPP") : <span>Pick a date</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 bg-white" align="start">
                    <CalendarUI
                      mode="single"
                      selected={targetDate}
                      onSelect={setTargetDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            {/* Project Icon Selector */}
            <div className="space-y-3">
              <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Project Icon</Label>
              <div className="flex flex-wrap gap-3">
                {icons.map((item) => {
                  const IconComp = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setFormData({ ...formData, project_icon: item.id })}
                      className={cn(
                        "w-10 h-10 rounded-xl flex items-center justify-center border-2 transition-all",
                        formData.project_icon === item.id 
                          ? "bg-indigo-50 border-indigo-500 shadow-sm" 
                          : "bg-white border-slate-100 hover:border-slate-200"
                      )}
                    >
                      <IconComp className={cn("w-5 h-5", item.color)} />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter className="pt-6 border-t border-slate-100">
            <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting} className="text-slate-500 hover:bg-slate-100 font-bold">Cancel</Button>
            <Button 
              type="submit"
              disabled={isSubmitting}
              className="bg-indigo-600 hover:bg-indigo-700 text-white min-w-[140px] shadow-lg shadow-indigo-600/20 font-bold"
            >
              {isSubmitting ? "Initiating..." : "Initiate Project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RegisterParcelDialog({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [formData, setFormData] = useState({
    survey_number: "",
    subdivision: "",
    district: "",
    taluk: "",
    village: "",
    land_use_type: "agricultural"
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await landwiseApi.createParcel(projectId, formData);
      toast.success("Survey Number Registered", {
        description: `SN ${formData.survey_number} has been added to the project.`
      });
      queryClient.invalidateQueries({ queryKey: ["parcels", projectId] });
      setIsOpen(false);
    } catch (err: any) {
      toast.error("Registration failed", { description: err.response?.data?.detail || "Error" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="bg-indigo-600 hover:bg-indigo-700 text-white gap-1 font-bold text-[11px] h-7 px-2.5 shadow-sm shadow-indigo-600/20"
        >
          <Plus className="w-3 h-3" /> Register Survey
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-white border-slate-200 text-slate-900">
        <DialogHeader>
          <DialogTitle className="text-xl font-black">Register New Survey Number</DialogTitle>
          <DialogDescription>Add a specific land parcel to the project for AI analysis.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-4">
          <div className="space-y-2">
            <Label className="text-[10px] font-black uppercase text-slate-500">Survey Number</Label>
            <Input value={formData.survey_number} onChange={e => setFormData({...formData, survey_number: e.target.value})} placeholder="e.g. 122" />
          </div>
          <div className="space-y-2">
            <Label className="text-[10px] font-black uppercase text-slate-500">Subdivision</Label>
            <Input value={formData.subdivision} onChange={e => setFormData({...formData, subdivision: e.target.value})} placeholder="e.g. 2A" />
          </div>
          <div className="space-y-2">
            <Label className="text-[10px] font-black uppercase text-slate-500">Taluk</Label>
            <Input value={formData.taluk} onChange={e => setFormData({...formData, taluk: e.target.value})} />
          </div>
          <div className="space-y-2">
            <Label className="text-[10px] font-black uppercase text-slate-500">Village</Label>
            <Input value={formData.village} onChange={e => setFormData({...formData, village: e.target.value})} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setIsOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isSubmitting} className="bg-indigo-600 text-white">
            {isSubmitting ? "Registering..." : "Register Survey"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChecklistTab({ parcelId }: { parcelId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["checklist", parcelId],
    queryFn: () => landwiseApi.getChecklist(parcelId),
    enabled: !!parcelId
  });

  const updateVerdict = useMutation({
    mutationFn: ({ itemId, verdict, notes }: { itemId: string, verdict: string, notes: string }) => 
      landwiseApi.updateChecklistVerdict(itemId, { verdict, lawyer_notes: notes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["checklist", parcelId] });
      queryClient.invalidateQueries({ queryKey: ["parcels"] });
      toast.success("Checklist updated");
    },
    onError: (err: any) => {
      toast.error("Update failed", { description: err.response?.data?.detail });
    }
  });

  if (isLoading) return <div className="p-20 text-center text-slate-400 font-bold uppercase tracking-widest animate-pulse">Loading legal checklist...</div>;

  const phases = data?.phases || {};
  const progress = data?.progress || 0;

  const phaseLabels: Record<string, string> = {
    documents: "Phase 1: Documents",
    ownership: "Phase 2: Ownership",
    encumbrances: "Phase 3: Encumbrances",
    compliance: "Phase 4: Compliance",
    final_review: "Phase 5: Final Review"
  };

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex items-center justify-between bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
        <div>
          <h3 className="text-xl font-black text-slate-900">Legal Verification Progress</h3>
          <p className="text-sm text-slate-500 font-medium">Complete all mandatory items to unlock the Legal Opinion builder.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
           <span className="text-3xl font-black text-indigo-600">{Math.round(progress)}%</span>
           <Progress value={progress} className="w-56 h-3 bg-slate-100" indicatorClassName="bg-indigo-600 shadow-sm" />
        </div>
      </div>

      <div className="space-y-8">
        {Object.entries(phaseLabels).map(([key, label]) => {
          const items = phases[key] || [];
          return (
            <div key={key} className="space-y-4">
              <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] pl-2">{label}</h4>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
                {items.length > 0 ? items.map((item: any) => (
                  <div key={item.id} className="p-6 hover:bg-slate-50/80 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div className="flex gap-5 items-start">
                       <div className={cn(
                         "w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5 shadow-sm",
                         item.verdict === "clear" ? "bg-green-100 text-green-600" :
                         item.verdict === "issue" ? "bg-red-100 text-red-600" :
                         item.verdict === "escalated" ? "bg-amber-100 text-amber-600" :
                         "bg-slate-100 text-slate-400"
                       )}>
                         {item.verdict === "clear" && <CheckCircle2 className="w-3.5 h-3.5" />}
                         {item.verdict === "issue" && <AlertTriangle className="w-3.5 h-3.5" />}
                         {item.verdict === "pending" && <Clock className="w-3.5 h-3.5" />}
                         {item.verdict === "na" && <X className="w-3.5 h-3.5" />}
                       </div>
                       <div>
                         <p className="text-sm font-black text-slate-800 leading-tight mb-1">{item.item_label}</p>
                         <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{item.item_code} • {item.is_mandatory ? "MANDATORY" : "OPTIONAL"}</p>
                       </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <Select 
                        value={item.verdict} 
                        onValueChange={(v) => updateVerdict.mutate({ itemId: item.id, verdict: v, notes: item.lawyer_notes || "" })}
                      >
                        <SelectTrigger className={cn(
                          "w-[130px] h-9 text-[10px] font-black uppercase tracking-widest",
                          item.verdict === "clear" ? "bg-green-50 text-green-700 border-green-200" :
                          item.verdict === "issue" ? "bg-red-50 text-red-700 border-red-200" :
                          item.verdict === "pending" ? "bg-slate-50 text-slate-600 border-slate-200" :
                          "bg-amber-50 text-amber-700 border-amber-200"
                        )}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-white border-slate-200 text-slate-700 font-bold">
                          <SelectItem value="pending">PENDING</SelectItem>
                          <SelectItem value="clear">CLEAR</SelectItem>
                          <SelectItem value="issue">ISSUE</SelectItem>
                          <SelectItem value="escalated">ESCALATE</SelectItem>
                          <SelectItem value="na">N/A</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )) : (
                  <div className="p-10 text-center text-slate-400 italic text-xs font-bold uppercase tracking-widest opacity-50">No items found in this phase.</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimelineTab({ parcelId, requestId, results, onUploadClick }: { parcelId: string, requestId?: string, results?: any[], onUploadClick: () => void }) {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
       {/* Keying by parcelId forces a fresh SurveyTimeline mount per parcel
           so the search input, timeline result, validation cache, preview
           popup and auto-fire ref all reset cleanly. Without the key, the
           previous parcel's "86 nodes found" graph + cached search query
           would carry over into the next parcel's view. */}
       <SurveyTimeline key={parcelId} requestId={requestId || ""} results={results} parcelId={parcelId} />
    </div>
  );
}

function OpinionTab({ parcelId }: { parcelId: string }) {
  const queryClient = useQueryClient();
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [reportSections, setReportSections] = useState<any[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["opinion", parcelId],
    queryFn: () => landwiseApi.getOpinion(parcelId),
    enabled: !!parcelId,
    retry: false
  });

  // Fetch parsed report sections only AFTER the AI report has been generated.
  // Previously this ran whenever `data.status !== "not_started"`, which fired
  // a 404 for every freshly-initialized draft (no .md file yet). Gating on
  // `report_storage_key` (set by the backend when /generate-report writes
  // legal_opinion_report.md) eliminates the false 404 noise without removing
  // any of the existing follow-up logic.
  useEffect(() => {
    if (!parcelId || !data || data.status === "not_started") return;
    if (!data.report_storage_key) return;  // report not generated yet
    if (reportSections.length > 0) return;
    fetch(`${API_BASE_URL}/api/v1/landwise/parcels/${parcelId}/report-sections`)
      .then(r => (r.ok ? r.json() : null))
      .then(resp => {
        if (resp && resp.status === "success" && Array.isArray(resp.sections)) {
          setReportSections(resp.sections);
        }
      })
      .catch(() => {/* file may not exist yet */});
  }, [parcelId, data?.status, data?.report_storage_key]);

  const createDraft = useMutation({
    mutationFn: () => landwiseApi.createOpinionDraft(parcelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opinion", parcelId] });
      toast.success("Draft Opinion Initialized");
    }
  });

  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [manualContent, setManualContent] = useState("");

  const updateSection = useMutation({
    mutationFn: ({ sectionId, content, accepted }: { sectionId: string, content: string, accepted: boolean }) =>
      landwiseApi.updateOpinionSection(sectionId, { final_content: content, is_accepted: accepted }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opinion", parcelId] });
      toast.success("Section updated");
    }
  });

  const addAdvisorNote = useMutation({
    mutationFn: async ({ sectionId, note }: { sectionId: string, note: string }) => {
      const resp = await fetch(
        `${API_BASE_URL}/api/v1/landwise/parcels/${parcelId}/opinion/legal-advisor-note`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section_id: sectionId, manual_content: note })
        }
      );
      if (!resp.ok) throw new Error("Failed to add note");
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opinion", parcelId] });
      toast.success("Legal advisor note added");
      setEditingSection(null);
      setManualContent("");
    }
  });

  const generateReport = useMutation({
    mutationFn: () => landwiseApi.generateReport(parcelId),
    onSuccess: (resp) => {
      if (resp.status === "success") {
        toast.success("AI Legal Report Generated Successfully", {
          description: "The draft sections and PDF report are now available."
        });
        // Auto-open PDF preview if report_url is in response
        if (resp.report_url) {
          const url = `${API_BASE_URL}/api/v1/landwise/documents/download-by-path?file_path=${encodeURIComponent(resp.report_url)}`;
          setReportUrl(url);
        }
        // Store parsed sections
        if (resp.sections) {
          setReportSections(resp.sections);
        }
        // Update query cache with new report data so UI shows immediately
        queryClient.setQueryData(["opinion", parcelId], (old: any) => {
          if (!old) return old;
          return {
            ...old,
            report_storage_key: resp.report_url,
            report_md_content: resp.report_md || old.report_md_content
          };
        });
      }
      // Still invalidate to ensure fresh data from server
      queryClient.invalidateQueries({ queryKey: ["opinion", parcelId] });
    }
  });

  if (isLoading) return <div className="p-20 text-center text-slate-400 font-bold uppercase tracking-widest animate-pulse">Generating legal intelligence draft...</div>;

  if (!data || data.status === 'not_started') {
    return (
      <div className="py-20 text-center space-y-8 max-w-lg mx-auto animate-in fade-in zoom-in-95 duration-700">
        <div className="w-24 h-24 bg-gradient-to-br from-slate-50 to-slate-100 rounded-[2rem] flex items-center justify-center mx-auto mb-8 shadow-inner border border-white">
          <FileSignature className="w-10 h-10 text-slate-300" />
        </div>
        <div className="space-y-3">
          <h3 className="text-2xl font-black text-slate-900 tracking-tight">Legal Opinion Locked</h3>
          <p className="text-sm text-slate-500 font-medium leading-relaxed">
            You must complete the mandatory checklist verification or trigger the AI smart analysis to unlock the legal opinion drafting.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <Button 
            className="px-10 h-14 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase tracking-widest text-xs shadow-xl shadow-indigo-200 group transition-all"
            onClick={() => createDraft.mutate()}
            disabled={createDraft.isPending}
          >
            {createDraft.isPending ? "Initializing Workspace..." : "Initialize AI Legal Opinion"}
            <Zap className="w-4 h-4 ml-2 group-hover:scale-110 transition-transform text-yellow-300" />
          </Button>
        </div>
      </div>
    );
  }

  const handleViewReport = () => {
    if (data.report_storage_key) {
      const url = `${API_BASE_URL}/api/v1/landwise/documents/download-by-path?file_path=${encodeURIComponent(data.report_storage_key)}`;
      setReportUrl(url);
    } else {
      generateReport.mutate();
    }
  };

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-500">
       <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div>
            <h3 className="text-base font-black text-slate-900 tracking-tight">Legal Opinion Workspace</h3>
            <p className="text-[11px] text-slate-500 font-medium italic">Review AI-suggested sections and accept for final digital signing.</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className={cn(
                "h-9 px-4 rounded-xl border font-black uppercase tracking-wider text-[9px] transition-all",
                reportUrl ? "border-indigo-600 bg-indigo-50 text-indigo-700" : "border-slate-200 hover:border-indigo-500 hover:text-indigo-600"
              )}
              onClick={handleViewReport}
              disabled={generateReport.isPending}
            >
              <FileText className="w-3 h-3 mr-1.5" />
              {data.report_storage_key ? (reportUrl ? "CLOSE PREVIEW" : "PREVIEW AI REPORT") : (generateReport.isPending ? "GENERATING..." : "GENERATE AI REPORT")}
            </Button>
            <Button
              disabled={!data.can_sign}
              className={cn(
                "h-9 px-5 rounded-xl font-black uppercase tracking-wider text-[9px] shadow-md transition-all",
                data.can_sign
                  ? "bg-green-600 hover:bg-green-700 text-white shadow-green-100"
                  : "bg-slate-100 text-slate-400 shadow-none border border-slate-200"
              )}
              onClick={() => data.can_sign && landwiseApi.signOpinion(parcelId).then(() => queryClient.invalidateQueries({ queryKey: ["opinion", parcelId] }))}
             >
              <ShieldCheck className="w-3 h-3 mr-1.5" />
              {data.status === 'signed' ? 'VIEW SIGNED OPINION' : 'AUTHORIZE & SIGN'}
            </Button>
          </div>
       </div>

       {reportUrl && (
         <div className="bg-slate-900 rounded-[2.5rem] overflow-hidden shadow-2xl border-4 border-slate-800 animate-in zoom-in-95 duration-500">
           <div className="p-4 bg-slate-800 flex justify-between items-center">
             <span className="text-white text-[10px] font-black uppercase tracking-widest px-4">Live Report Preview</span>
             <Button 
               variant="ghost" 
               size="sm" 
               className="text-slate-400 hover:text-white"
               onClick={() => setReportUrl(null)}
             >
               <X className="w-4 h-4" />
             </Button>
           </div>
           <div className="h-[800px] w-full bg-white">
              <iframe 
                src={reportUrl} 
                className="w-full h-full border-none"
                title="AI Legal Report Preview"
              />
           </div>
         </div>
       )}

       {/* Structured Report Sections */}
       {(reportSections.length > 0 || data.report_md_content) && (
         <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
           <div className="p-6 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
             <div className="flex items-center gap-4">
               <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-lg shadow-indigo-100">
                 <FileText className="w-5 h-5" />
               </div>
               <div>
                 <h4 className="text-sm font-black text-slate-900 uppercase tracking-wider">AI Generated Legal Report</h4>
                 <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tighter">Structured Sections with Subtitles</p>
               </div>
             </div>
             <Button 
               variant="ghost" 
               size="sm" 
               className="text-slate-400 hover:text-indigo-600"
               onClick={() => setReportUrl(data.report_storage_key ? `${API_BASE_URL}/api/v1/landwise/documents/download-by-path?file_path=${encodeURIComponent(data.report_storage_key)}` : null)}
             >
               <Download className="w-4 h-4 mr-1" />
               PDF
             </Button>
           </div>
           <div className="p-8 max-h-[800px] overflow-y-auto space-y-6">
             {reportSections.length > 0 ? (
               // Show parsed sections with subtitles
               reportSections.map((section: any, idx: number) => (
                 <div key={idx} className="border border-slate-200 rounded-2xl overflow-hidden">
                   <div className="bg-indigo-50 p-4 border-b border-indigo-100">
                     <h5 className="text-sm font-black text-indigo-900">
                       {section.number}) {section.title}
                     </h5>
                   </div>
                   <div className="p-4 space-y-4">
                     {section.subtitles?.map((sub: any, sidx: number) => (
                       <div key={sidx} className="bg-slate-50 rounded-xl p-4">
                         <h6 className="text-xs font-bold text-slate-700 mb-2">
                           {sub.letter}. {sub.title}
                         </h6>
                         <div className="text-xs text-slate-600 whitespace-pre-wrap leading-relaxed">
                           <ReactMarkdown>{sub.content}</ReactMarkdown>
                         </div>
                       </div>
                     ))}
                   </div>
                 </div>
               ))
             ) : (
               // Fallback to raw markdown
               <div className="prose prose-slate prose-sm max-w-none">
                 <ReactMarkdown>{data.report_md_content}</ReactMarkdown>
               </div>
             )}
           </div>
         </div>
       )}


       <div className="space-y-3">
          {data.sections?.map((section: any) => {
             const reportSection = findReportSectionForType(section.type, reportSections);
             const hasManualContent = !!(section.final_content && section.final_content.trim() && section.final_content !== section.ai_draft);
             return (
             <div key={section.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all group">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 group-hover:bg-white transition-colors">
                   <div className="flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-[10px] font-black shadow shadow-indigo-100">
                        {section.order}
                      </div>
                      <div>
                        <h4 className="text-[11px] font-black text-slate-900 uppercase tracking-[0.08em] leading-tight">
                          {section.type.replace(/_/g, " ")}
                        </h4>
                        <p className="text-[9px] text-slate-400 mt-0.5 font-medium leading-tight">
                          {section.type?.includes("possession") && "Analysis of current possession status, Patta, Chitta"}
                          {section.type?.includes("land_nature") && "Classification (Wet/Dry), land use, physical description"}
                          {section.type?.includes("tn_land") && "Ceiling limits, tenancy, assigned lands, Schedule VI/VII"}
                          {section.type?.includes("title_flow") && "Chain of title from EC records and encumbrance status"}
                          {section.type?.includes("legal_protections") && "Alienation restrictions, UDR Act applicability"}
                          {section.type?.includes("acquisitions") && "Land acquisition status, government notices, attachments"}
                          {section.type?.includes("lis_pendens") && "Pending litigation, civil suits, court case status"}
                          {section.type?.includes("documents") && "Verification of documents and noted discrepancies"}
                          {section.type?.includes("final") && "Overall legal opinion, risk assessment, recommendations"}
                        </p>
                      </div>
                   </div>
                   {section.is_accepted ? (
                      <Badge className="bg-green-50 text-green-700 border-green-200 font-black text-[8px] px-2 h-5 uppercase tracking-widest">VERIFIED & ACCEPTED</Badge>
                   ) : (
                      <Badge variant="outline" className="text-slate-400 font-black text-[8px] px-2 h-5 uppercase tracking-widest bg-slate-50">PENDING REVIEW</Badge>
                   )}
                </div>
                <div className="px-4 py-4">
                   {/* Manual / final content (if the advisor wrote one) */}
                   {hasManualContent && (
                     <div className="relative mb-3">
                       <div className="absolute -left-2 top-0 bottom-0 w-0.5 bg-amber-100 rounded-full" />
                       <p className="text-[9px] font-black uppercase tracking-widest text-amber-700 mb-1.5">Legal Advisor Note</p>
                       <p className="text-xs text-slate-700 leading-relaxed font-medium whitespace-pre-wrap">
                         {section.final_content}
                       </p>
                     </div>
                   )}

                   {/* AI Report content — DB-stored rich markdown takes priority */}
                   {(() => {
                     const dbDraft: string = section.ai_draft || "";
                     // "Rich" = the persisted markdown body (multi-line, or contains markdown markers)
                     const isRichDb = dbDraft.length > 0 && (dbDraft.includes("\n") || dbDraft.includes("**"));

                     if (isRichDb) {
                       return (
                         <div className="relative mb-3">
                           <div className="absolute -left-2 top-0 bottom-0 w-0.5 bg-indigo-100 rounded-full" />
                           <div className="rounded-lg bg-slate-50 border border-slate-100 p-3 text-xs text-slate-700 leading-relaxed prose prose-slate prose-xs max-w-none prose-p:my-1.5 prose-strong:text-slate-900 prose-li:my-0.5 prose-headings:text-slate-900 prose-headings:text-xs">
                             <ReactMarkdown>{dbDraft}</ReactMarkdown>
                           </div>
                         </div>
                       );
                     }

                     // Fallback: parsed sections fetched from /report-sections
                     if (reportSection) {
                       return (
                         <div className="relative mb-3">
                           <div className="absolute -left-2 top-0 bottom-0 w-0.5 bg-indigo-100 rounded-full" />
                           <p className="text-[9px] font-black uppercase tracking-widest text-indigo-700 mb-2">
                             {reportSection.number !== "F" ? `Section ${reportSection.number} · ` : ""}{reportSection.title}
                           </p>
                           <div className="space-y-2">
                             {reportSection.subtitles?.length > 0 ? (
                               reportSection.subtitles.map((sub: any, sidx: number) => (
                                 <div key={sidx} className="rounded-lg bg-slate-50 border border-slate-100 p-2.5">
                                   <h6 className="text-[10px] font-black text-slate-800 mb-1 uppercase tracking-wider">
                                     {sub.letter}. {sub.title}
                                   </h6>
                                   <div className="text-xs text-slate-600 leading-relaxed prose prose-slate prose-xs max-w-none prose-p:my-1 prose-strong:text-slate-900">
                                     <ReactMarkdown>{sub.content || "—"}</ReactMarkdown>
                                   </div>
                                 </div>
                               ))
                             ) : reportSection.content ? (
                               <div className="rounded-lg bg-slate-50 border border-slate-100 p-2.5 text-xs text-slate-600 leading-relaxed prose prose-slate prose-xs max-w-none prose-p:my-1 prose-strong:text-slate-900 prose-li:my-0.5">
                                 <ReactMarkdown>{reportSection.content}</ReactMarkdown>
                               </div>
                             ) : (
                               <p className="text-[11px] text-slate-400 italic">No detail extracted for this section.</p>
                             )}
                           </div>
                         </div>
                       );
                     }

                     // Final fallback: stub from initialize
                     if (!hasManualContent) {
                       return (
                         <div className="relative mb-3">
                           <div className="absolute -left-2 top-0 bottom-0 w-0.5 bg-indigo-50 rounded-full" />
                           <p className="text-xs text-slate-600 leading-relaxed font-medium whitespace-pre-wrap">
                             {dbDraft || "Generate the AI report to populate this section."}
                           </p>
                         </div>
                       );
                     }
                     return null;
                   })()}

                   {/* Legal Advisor Manual Entry */}
                   {editingSection === section.id ? (
                     <div className="mb-6 p-4 bg-amber-50 rounded-xl border border-amber-200">
                       <label className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2 block">
                         Legal Advisor Manual Entry
                       </label>
                       <textarea
                         className="w-full p-3 text-sm border border-amber-200 rounded-lg bg-white focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
                         rows={4}
                         placeholder="Enter your professional observations, notes, or corrections..."
                         value={manualContent}
                         onChange={(e) => setManualContent(e.target.value)}
                       />
                       <div className="flex justify-end gap-2 mt-3">
                         <Button
                           variant="ghost"
                           size="sm"
                           className="text-slate-500"
                           onClick={() => { setEditingSection(null); setManualContent(""); }}
                         >
                           Cancel
                         </Button>
                         <Button
                           size="sm"
                           className="bg-amber-600 hover:bg-amber-700 text-white"
                           onClick={() => addAdvisorNote.mutate({ sectionId: section.id, note: manualContent })}
                           disabled={addAdvisorNote.isPending || !manualContent.trim()}
                         >
                           {addAdvisorNote.isPending ? "Adding..." : "Add Note"}
                         </Button>
                       </div>
                     </div>
                   ) : null}

                   <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-[9px] h-7 px-3 font-bold uppercase tracking-wider rounded-lg border-amber-200 text-amber-700 hover:bg-amber-50"
                        onClick={() => setEditingSection(section.id)}
                      >
                        + Legal Advisor Note
                      </Button>
                      <Button
                        variant={section.is_accepted ? "outline" : "default"}
                        size="sm"
                        className={cn(
                          "text-[9px] h-7 px-4 font-black uppercase tracking-widest rounded-lg transition-all",
                          section.is_accepted
                            ? "border-green-200 text-green-700 hover:bg-green-50"
                            : "bg-indigo-600 text-white hover:bg-indigo-700 shadow shadow-indigo-100"
                        )}
                        onClick={() => updateSection.mutate({
                          sectionId: section.id,
                          content: section.final_content || section.ai_draft,
                          accepted: !section.is_accepted
                        })}
                      >
                        {section.is_accepted ? "REVOKE ACCEPTANCE" : "ACCEPT AI DRAFT"}
                      </Button>
                   </div>
                </div>
             </div>
             );
          })}
       </div>
    </div>
  );
}

// Map a DB section.type to the corresponding parsed report section (1-8 + FINAL VERDICT).
function findReportSectionForType(type: string, reportSections: any[]): any | null {
  if (!type || !reportSections || reportSections.length === 0) return null;
  const t = type.toLowerCase();

  // Map types → markdown section number
  const typeToNumber: Record<string, string> = {
    possession_revenue: "1",
    land_nature: "2",
    tn_land_reforms: "3",
    title_flow_ec: "4",
    legal_protections: "5",
    acquisitions_notices: "6",
    lis_pendens: "7",
    documents_checklist: "8",
    final_verdict: "F",
  };

  // Direct lookup first
  for (const [key, num] of Object.entries(typeToNumber)) {
    if (t === key) {
      const found = reportSections.find((s) => String(s.number) === num);
      if (found) return found;
    }
  }
  // Fuzzy fallback by partial match
  const fuzzy: Array<[string, string]> = [
    ["possession", "1"], ["land_nature", "2"], ["tn_land", "3"],
    ["title_flow", "4"], ["legal_protect", "5"], ["acquisition", "6"],
    ["lis_pendens", "7"], ["documents", "8"], ["final", "F"],
  ];
  for (const [needle, num] of fuzzy) {
    if (t.includes(needle)) {
      const found = reportSections.find((s) => String(s.number) === num);
      if (found) return found;
    }
  }
  return null;
}

function HierarchyTab({ parcelId, auditResults, isAuditLoading, hierarchyPreview, setHierarchyPreview }: { parcelId: string, auditResults: any, isAuditLoading: boolean, hierarchyPreview: any, setHierarchyPreview: (v: any) => void }) {
  const [globalHierarchy, setGlobalHierarchy] = useState<any>(null);
  const [loadingGlobal, setLoadingGlobal] = useState(false);
  const [hierarchySearch, setHierarchySearch] = useState("");
  const [activeSideTab, setActiveSideTab] = useState<"summary" | "notes" | "chat">("summary");
  const [scrollToPage, setScrollToPage] = useState<{ page: number; timestamp: number } | undefined>(undefined);
  // Replaces the inline 550px-tall PDF iframe that was embedded directly in
  // the Summary tab. The deed PDF now lives in a draggable floating popup
  // so the right-side card stays compact and the user can move the document
  // anywhere on screen while reading the summary metadata next to it.
  const [isPdfPopupOpen, setIsPdfPopupOpen] = useState(false);
  const pdfPopupDragControls = useDragControls();

  // Auto-close the floating PDF popup whenever the user:
  //   - selects a different node (hierarchyPreview.docNo changes), OR
  //   - closes the entire side panel (hierarchyPreview becomes null).
  // Without this the popup would keep showing the old doc's PDF while the
  // side panel's metadata updated to the new doc — confusing and easy to
  // miss-read.
  useEffect(() => {
    setIsPdfPopupOpen(false);
  }, [hierarchyPreview?.docNo]);
  

  const requestId = auditResults?.request_id;
  const valResults = auditResults?.validation_results || [];

  useEffect(() => {
    if (requestId) {
      setGlobalHierarchy(null);
      fetchGlobalHierarchy();
    }
  }, [requestId, parcelId]);


  const fetchGlobalHierarchy = async () => {
    setLoadingGlobal(true);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/v1/get-global-hierarchy/${requestId}`);
      if (resp.ok) {
        const data = await resp.json();
        setGlobalHierarchy(data.react_flow_data);
      }
    } catch (e) {
      console.error("Failed to fetch global hierarchy:", e);
    } finally {
      setLoadingGlobal(false);
    }
  };

  const handleHierarchyNodeClick = (docNo: string, data: any) => {
    setHierarchyPreview({ docNo, data });
  };

  // Find the file path for the previewed document
  const selectedDocInfo = useMemo(() => {
    if (!hierarchyPreview) return null;
    return valResults.find((r: any) => r.document_number === hierarchyPreview.docNo);
  }, [hierarchyPreview, valResults]);

  if (isAuditLoading || loadingGlobal) return <div className="flex justify-center py-20"><RefreshCcw className="w-8 h-8 animate-spin text-indigo-500" /></div>;

  return (
    <div className="h-full flex flex-col space-y-4 animate-in fade-in duration-500 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-[800px] w-full rounded-[2.5rem] border border-slate-200 shadow-xl overflow-hidden bg-white">
            <ResizablePanel defaultSize={hierarchyPreview ? 65 : 100} minSize={30}>
            <div className="h-full flex flex-col p-6 bg-slate-50/30 relative">
                <div className="mb-6 bg-indigo-600/5 p-6 rounded-[2rem] border border-indigo-600/10 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-white rounded-2xl shadow-sm border border-indigo-600/10">
                      <MapPin className="w-6 h-6 text-indigo-600" />
                    </div>
                    <div>
                      <h3 className="text-xl font-black text-indigo-900 tracking-tight">
                        Master Ownership Lineage Map
                      </h3>
                      <p className="text-xs text-slate-500 font-medium italic">Forensic lineage of property subdivisions and historical transfers.</p>
                    </div>
                  </div>
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <Input 
                            placeholder="Find SN / Doc No..." 
                            className="pl-10 w-64 bg-white border-slate-200 focus:ring-indigo-500 rounded-xl font-bold text-xs h-10 shadow-sm"
                            value={hierarchySearch}
                            onChange={(e) => setHierarchySearch(e.target.value)}
                        />
                      </div>
                      <div className="h-6 w-[1px] bg-slate-200 mx-1" />
                      <button 
                        onClick={async () => {
                          if (confirm("Are you sure you want to wipe all survey and ownership registry data for this parcel? This action cannot be undone.")) {
                              try {
                                  await landwiseApi.wipeSurveyData(parcelId);
                                  toast.success("Survey registry wiped. Re-run audit to repopulate.");
                                  window.location.reload();
                              } catch (e) {
                                  toast.error("Failed to wipe data.");
                              }
                          }
                        }}
                        className="flex items-center gap-2 px-6 py-2 bg-red-50 border border-red-100 rounded-xl text-[10px] font-black uppercase tracking-widest text-red-600 hover:bg-red-100 transition-all"
                      >
                         <X className="w-4 h-4" />
                         Wipe Survey Data
                      </button>
                    </div>
                </div>

                <div className="flex-1 bg-white border border-slate-100 rounded-[2rem] shadow-inner relative overflow-hidden">
                {globalHierarchy ? (
                    <ReactFlowHierarchy 
                      data={globalHierarchy} 
                      onNodeClick={handleHierarchyNodeClick}
                      searchTerm={hierarchySearch}
                    />
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center italic">
                    <RefreshCcw className="w-12 h-12 opacity-10 mb-4 animate-spin text-indigo-500" />
                    <p className="text-sm font-black uppercase tracking-widest">Constructing Lineage Network...</p>
                    </div>
                )}
                </div>
            </div>
            </ResizablePanel>

            {hierarchyPreview && <ResizableHandle withHandle className="bg-slate-100 w-1" />}

            {hierarchyPreview && (
            <ResizablePanel defaultSize={35} minSize={25}>
                <div className="h-full border-l bg-white flex flex-col animate-in slide-in-from-right duration-300 overflow-hidden">
                    {/* Tool Side Header Tabs */}
                    <div className="px-6 py-4 bg-white border-b border-slate-100 flex items-center justify-between">
                        <div className="flex items-center bg-slate-100/50 p-1 rounded-xl">
                            {(["summary", "notes", "chat"] as const).map((tab) => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveSideTab(tab)}
                                    className={cn(
                                        "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all",
                                        activeSideTab === tab 
                                            ? "bg-white text-indigo-600 shadow-sm" 
                                            : "text-slate-500 hover:text-indigo-600"
                                    )}
                                >
                                    {tab === "summary" ? "Summary" : tab === "notes" ? "Notes" : "Chatbot"}
                                </button>
                            ))}
                        </div>
                        <button onClick={() => setHierarchyPreview(null)} className="p-2 hover:bg-slate-50 rounded-xl transition-all text-slate-400 hover:text-indigo-600">
                           <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto scrollbar-thin">
                        {activeSideTab === "summary" && (
                            <div className="animate-in fade-in duration-500">
                                <div className="p-8 space-y-6">
                                    <div className="flex items-center justify-between">
                                        <Badge variant="outline" className="text-[10px] font-black uppercase bg-indigo-50 text-indigo-700 border-indigo-100 px-3 h-6">
                                            {hierarchyPreview.data.nature}
                                        </Badge>
                                        <span className="text-[10px] text-slate-400 font-black flex items-center gap-1 uppercase tracking-widest">
                                            <Calendar className="w-3.5 h-3.5" />
                                            {hierarchyPreview.data.date}
                                        </span>
                                    </div>

                                    <div className="grid grid-cols-1 gap-6 py-6 border-y border-slate-100">
                                        <div className="space-y-1.5">
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Executant (Seller)</span>
                                            <p className="text-sm font-black text-slate-900 leading-tight">{hierarchyPreview.data.executant}</p>
                                        </div>
                                        <div className="space-y-1.5">
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Claimant (Buyer)</span>
                                            <p className="text-sm font-black text-slate-900 leading-tight">{hierarchyPreview.data.claimant}</p>
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        <div className="flex items-center gap-3 text-sm">
                                            <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                                                <MapPin className="w-4 h-4 text-indigo-400" />
                                            </div>
                                            <span className="font-black text-slate-900">Survey No: {hierarchyPreview.data.survey_number}</span>
                                        </div>
                                        <div className="flex items-center gap-3 text-sm">
                                            <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center">
                                                <ShieldCheck className="w-4 h-4 text-green-500" />
                                            </div>
                                            <span className="font-black text-slate-900">Area: {hierarchyPreview.data.square_feet || hierarchyPreview.data.sq_feet}</span>
                                        </div>
                                    </div>
                                </div>
                                
                                {/* Preview Document button — replaces the inline 550px
                                    iframe that used to live here. Opens a draggable
                                    floating popup so the metadata stays visible while
                                    the user reads the source PDF. */}
                                <div className="px-6 pb-8">
                                    {selectedDocInfo?.file_path ? (
                                        <button
                                            onClick={() => setIsPdfPopupOpen(true)}
                                            className="w-full inline-flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 via-violet-600 to-blue-600 text-white font-black text-[11px] uppercase tracking-widest py-3 rounded-xl shadow-lg shadow-indigo-600/20 hover:shadow-xl hover:shadow-indigo-600/30 transition-all hover:-translate-y-0.5 active:translate-y-0"
                                            title="Open the source document in a draggable preview window"
                                        >
                                            <Eye className="w-4 h-4" />
                                            Preview Document
                                            <span className="text-[9px] font-bold opacity-70 ml-1">
                                                ({hierarchyPreview.docNo})
                                            </span>
                                        </button>
                                    ) : (
                                        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center space-y-3">
                                            <div className="w-10 h-10 mx-auto rounded-full bg-slate-100 flex items-center justify-center">
                                                <FileText className="w-5 h-5 text-slate-300" />
                                            </div>
                                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                                Forensic proof not available for this legacy record
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {activeSideTab === "notes" && (
                            <div className="p-8 animate-in slide-in-from-bottom-4 duration-500 space-y-8">
                                <div>
                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">PDF Annotations</h4>
                                    {/* Annotations list would dynamically pull from PdfAnnotator state in a real impl */}
                                    <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 text-center">
                                        <Info className="w-6 h-6 text-slate-300 mx-auto mb-2" />
                                        <p className="text-[10px] text-slate-500 font-medium">Use the "Summary" tab to draw area highlights or add text observations on the document.</p>
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Global Forensic Notes</h4>
                                    <textarea 
                                        className="w-full h-40 bg-white border border-slate-200 rounded-2xl p-4 text-xs focus:ring-2 focus:ring-indigo-500/20 outline-none transition-all placeholder:text-slate-300"
                                        placeholder="Add internal legal observations for this document..."
                                    />
                                    <button className="w-full py-3 bg-indigo-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-indigo-600/10 hover:shadow-xl transition-all">
                                        Save Observations
                                    </button>
                                </div>
                            </div>
                        )}

                        {activeSideTab === "chat" && (
                            <div className="h-full animate-in slide-in-from-right-4 duration-500 flex flex-col">
                                <div className="flex-1">
                                    <DocChat 
                                        docNo={hierarchyPreview.docNo} 
                                        requestId={requestId} 
                                        parcelId={parcelId}
                                        onPageClick={(page) => {
                                            setScrollToPage({ page, timestamp: Date.now() });
                                            setActiveSideTab("summary");
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </ResizablePanel>
            )}
        </ResizablePanelGroup>

        {/* ─── Floating draggable PDF preview ───────────────────────────────
            Mounted at the tab root, not inside the ResizablePanel, so it
            floats above the layout and the user can drag it anywhere on
            screen. Same pattern as the floating annotations panel in
            AnalysisDashboard.tsx. Only renders when the user explicitly
            opens it via the "Preview Document" button. */}
        <AnimatePresence>
          {isPdfPopupOpen && selectedDocInfo?.file_path && hierarchyPreview && (
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
              className="fixed top-24 right-12 z-[100] w-[640px] max-w-[92vw] h-[80vh] rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/30 overflow-hidden flex flex-col select-none"
            >
              {/* Drag handle — only this strip initiates a drag (dragListener={false}) */}
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
                      {hierarchyPreview.docNo}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setIsPdfPopupOpen(false)}
                  className="p-1.5 hover:bg-white rounded-lg transition-all text-slate-400 hover:text-indigo-600 shrink-0"
                  title="Close preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {/* PDF body fills the remaining vertical space */}
              <div className="flex-1 min-h-0 bg-slate-900 relative">
                <PdfAnnotator
                  url={getFileUrl(selectedDocInfo.file_path)}
                  docId={hierarchyPreview.docNo}
                  parcelId={parcelId}
                  scrollToPage={scrollToPage}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
    </div>
  );
}

function OwnershipAuditTab({ parcelId, auditResults, isAuditLoading }: { parcelId: string, auditResults: any, isAuditLoading: boolean }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "survey" | "owner">("all");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const ecData = auditResults?.ec_final || [];
  const totalTx = ecData.length;

  // Group by Survey Number
  const surveyGroups = React.useMemo(() => {
    // ─── helpers (fix the three audit bugs from the previous turn) ───────

    // 1) Multi-date EC strings like "27-Feb-2008 | 27-Feb-2008 | 27-Feb-2008"
    //    break native `new Date(...)` → Invalid Date. Take the FIRST token
    //    (execution date) — that's what the EC's "Date of Registration"
    //    column anchors against and what the rest of the app sorts by.
    const parseEcDateMs = (raw: any): number => {
      if (!raw) return 0;
      const s = String(raw).split(/\s*\|\s*/)[0].trim();
      if (!s) return 0;
      // Native Date handles "27-Feb-2008", "27 Feb 2008", "2008-02-27" cleanly
      const t = Date.parse(s);
      if (!Number.isNaN(t)) return t;
      // DD/MM/YYYY or DD-MM-YYYY day-first fallback
      const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (m) {
        const [, dd, mm, yy] = m;
        const yyyy = yy.length === 2 ? `20${yy}` : yy;
        const t2 = Date.parse(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`);
        if (!Number.isNaN(t2)) return t2;
      }
      return 0;
    };

    // 2) Only TRANSFER-type natures actually change ownership. Mortgages,
    //    receipts, POAs, attachments, lis-pendens etc. must NOT hijack the
    //    "current owner" pointer just because they have a later date.
    const TRANSFER_PATTERNS = [
      "sale", "conveyance", "settlement", "partition", "gift",
      "release deed", "exchange", "absolute sale",
      "சத்த விக்கிரய", "விற்பனை", "தான பத்திர", "செட்டில்மெண்ட்",
      "பாகப்பிரிவின",
    ];
    const isTransfer = (rec: any): boolean => {
      const n = String(rec.nature_of_document || rec.nature || "").toLowerCase();
      if (!n) return false;
      return TRANSFER_PATTERNS.some(p => n.includes(p));
    };

    // 3) Name normalization + multi-person splitting. Stops `262 "unique
    //    entities"` from being an artefact of formatting noise — same
    //    person written as "A. ராஜகோபால் (முதல்வர்)", "A. ராஜகோபால்",
    //    or as an array item collapses to a single key. AND a single
    //    string with multiple names ("A, B" / "A & B" / "A / B") gets
    //    split into individual persons.
    const HONORIFIC_RE = /(?:^|\s)(மரபு|திரு|திருமதி|Mr\.?|Mrs\.?|Smt\.?|Sri\.?)(?=\s|\.|$)/gi;
    const normalizeOnePerson = (raw: string): string =>
      String(raw)
        .replace(/\([^)]*\)/g, " ")                 // strip role tags: (முதல்வர்), (முகவர்), (POA), etc.
        .replace(HONORIFIC_RE, " ")                 // strip honorifics — works for Tamil chars (no \b)
        .replace(/[.,;:'"`]/g, " ")                 // strip punctuation
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    // Person-level splitter: handles arrays, comma-separated strings,
    // "A and B", "A & B", "A / B", pipe-separated multi-name fields,
    // AND the EC's "NAME1 (role) NAME2 (role)" pattern where the role
    // parenthetical is itself the boundary between two people. The
    // splitter consumes role tags as separators BEFORE the normalizer
    // strips them; the normalizer is left only with single-person text.
    const splitToPersons = (raw: any): string[] => {
      if (!raw) return [];
      const parts = Array.isArray(raw) ? raw : [raw];
      const flat: string[] = [];
      const SENTINEL = ""; // any char unlikely to appear in real names
      parts.forEach((p: any) => {
        if (p === null || p === undefined) return;
        // Replace every parenthetical role tag with the sentinel — the
        // tag is consumed as the boundary, not kept inside the name.
        const withBoundaries = String(p).replace(/\s*\([^)]*\)\s*/g, SENTINEL);
        // Now split on the sentinel + every conventional list separator.
        withBoundaries
          .split(new RegExp(`${SENTINEL}|\\s*[,&/|]\\s*|\\s+(?:and|மற்றும்)\\s+`, "i"))
          .forEach((piece) => {
            const n = normalizeOnePerson(piece);
            if (n) flat.push(n);
          });
      });
      return flat;
    };
    const addPersons = (set: Set<string>, raw: any) => {
      for (const p of splitToPersons(raw)) set.add(p);
    };

    const groups: Record<string, any> = {};
    ecData.forEach((rec: any) => {
      const sn = rec.survey_number || "Unknown";
      if (!groups[sn]) {
        groups[sn] = {
          survey_no: sn,
          records: [],
          unique_owners: new Set<string>(),  // every distinct person ever (normalized)
          unique_buyers: new Set<string>(),  // distinct buyers in TRANSFER txs only — better proxy for "owners over time"
          last_transfer: null,                // latest TRANSFER (not encumbrance)
          last_any: null,                     // latest of any kind (for display when no transfer exists)
          transfer_count: 0,
          encumbrance_count: 0,
        };
      }
      const g = groups[sn];
      g.records.push(rec);

      // Normalized name set: never lumps a person's name variants twice.
      addPersons(g.unique_owners, rec.buyers);
      addPersons(g.unique_owners, rec.sellers);
      if (isTransfer(rec)) addPersons(g.unique_buyers, rec.buyers);

      const t = parseEcDateMs(rec.date);
      // Latest of ANY kind (display fallback for surveys with zero transfers)
      const tAny = g.last_any ? parseEcDateMs(g.last_any.date) : 0;
      if (!g.last_any || t > tAny) g.last_any = rec;

      // Latest TRANSFER only (the legally correct "current owner" anchor)
      if (isTransfer(rec)) {
        g.transfer_count += 1;
        const tTr = g.last_transfer ? parseEcDateMs(g.last_transfer.date) : 0;
        if (!g.last_transfer || t > tTr) g.last_transfer = rec;
      } else {
        g.encumbrance_count += 1;
      }
    });

    // Sort records within each group by execution date (asc)
    Object.values(groups).forEach((g: any) => {
      g.records.sort((a: any, b: any) => parseEcDateMs(a.date) - parseEcDateMs(b.date));
      // If no transfer ever happened, fall back to last_any so the row
      // still shows something — but the UI badge below labels this case.
      if (!g.last_transfer) g.last_transfer = g.last_any;
    });

    return Object.values(groups).sort((a: any, b: any) => a.survey_no.localeCompare(b.survey_no));
  }, [ecData]);

  // Defensive stringifier — EC entries store `buyers` and `sellers` as
  // ARRAYS (e.g. ["Vajjiram", "Jeganathan"]), not strings, so the previous
  // `(r.buyers || "").toLowerCase()` crashed the component the moment the
  // user typed anything into the search box: a non-empty array falls
  // through the `||`, then `.toLowerCase()` doesn't exist on arrays.
  // Treat array / string / null / number all uniformly as one lowercase
  // search-target string.
  const toSearchString = (v: any): string => {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.filter(Boolean).join(" ").toLowerCase();
    return String(v).toLowerCase();
  };

  const filteredGroups = surveyGroups.filter((g: any) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    if (filterMode === "survey") return toSearchString(g.survey_no).includes(term);
    if (filterMode === "owner") {
      return g.records.some((r: any) =>
        toSearchString(r.buyers).includes(term) ||
        toSearchString(r.sellers).includes(term)
      );
    }
    // "all" mode
    return (
      toSearchString(g.survey_no).includes(term) ||
      g.records.some((r: any) =>
        toSearchString(r.buyers).includes(term) ||
        toSearchString(r.sellers).includes(term) ||
        toSearchString(r.document_number).includes(term)
      )
    );
  });

  if (isAuditLoading) return <div className="flex justify-center py-20"><RefreshCcw className="w-8 h-8 animate-spin text-indigo-500" /></div>;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative rounded-2xl p-3 sm:p-4 text-white overflow-hidden shadow-lg shadow-indigo-900/20"
      >
        {/* Layered gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900" />
        {/* Animated aurora blobs */}
        <div className="pointer-events-none absolute inset-0 opacity-50">
          <div className="absolute -top-40 right-0 w-96 h-96 bg-gradient-to-br from-indigo-500/30 to-violet-500/30 rounded-full blur-3xl animate-blob-slow" />
          <div className="absolute -bottom-40 -left-20 w-96 h-96 bg-gradient-to-br from-blue-500/20 to-indigo-500/20 rounded-full blur-3xl animate-blob" />
        </div>
        {/* Subtle grid */}
        <div
          className="absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />

        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <div className="relative shrink-0">
              <div className="w-8 h-8 bg-gradient-to-br from-violet-500 via-indigo-500 to-blue-600 rounded-lg flex items-center justify-center shadow shadow-indigo-500/40 ring-1 ring-white/20">
                <Users className="w-4 h-4 text-white" strokeWidth={2.5} />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base sm:text-lg font-display font-extrabold tracking-tight leading-tight">
                Ownership <span className="bg-gradient-to-r from-indigo-300 via-blue-200 to-violet-300 bg-clip-text text-transparent">Distribution Audit</span>
              </h3>
              <p className="text-indigo-200/70 text-[10px] font-medium">Unique owner statistics per survey number (EC Extract)</p>
            </div>
            <Badge className="bg-indigo-500/20 text-indigo-200 border-indigo-400/40 uppercase font-bold text-[9px] tracking-[0.18em] px-2 h-5 inline-flex items-center gap-1 shrink-0">
              <span className="w-1 h-1 rounded-full bg-indigo-300 animate-pulse-glow" />
              {surveyGroups.length} Parcels
            </Badge>
          </div>

          <div className="flex flex-col md:flex-row gap-2 items-stretch md:items-center">
            <div className="relative flex-1 max-w-2xl group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-indigo-300/60 group-focus-within:text-indigo-300 transition-colors z-10" />
              <input
                type="text"
                placeholder="Search survey, owner, or doc no..."
                className="relative w-full bg-indigo-950/60 backdrop-blur-md border border-indigo-400/20 rounded-lg py-1.5 pl-9 pr-3 text-xs text-white placeholder:text-indigo-300/40 focus:ring-1 focus:ring-indigo-400/40 focus:border-indigo-400/60 outline-none transition-all"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="flex items-center bg-indigo-950/70 backdrop-blur-md rounded-lg border border-indigo-400/20 p-0.5 shrink-0 self-start md:self-auto">
              {(["all", "survey", "owner"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setFilterMode(mode)}
                  className={cn(
                    "relative px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors",
                    filterMode === mode
                      ? "text-white"
                      : "text-indigo-300/70 hover:text-indigo-100"
                  )}
                >
                  {filterMode === mode && (
                    <motion.span
                      layoutId="ownership-filter-active"
                      transition={{ type: "spring", stiffness: 380, damping: 30 }}
                      className="absolute inset-0 rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 shadow shadow-indigo-500/40"
                    />
                  )}
                  <span className="relative z-10">{mode}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Table */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden"
      >
        {/* Top accent strip */}
        <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500" />
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[680px]">
          <thead>
            <tr className="bg-gradient-to-r from-slate-50 via-indigo-50/30 to-slate-50 text-left border-b border-slate-100">
              <th className="px-3 sm:px-4 py-2.5 text-[9px] font-bold text-slate-500 uppercase tracking-wider">Survey No</th>
              <th className="px-3 sm:px-4 py-2.5 text-[9px] font-bold text-slate-500 uppercase tracking-wider">Current Owner (Latest EC)</th>
              <th className="px-3 sm:px-4 py-2.5 text-[9px] font-bold text-slate-500 uppercase tracking-wider text-center">Transactions</th>
              <th className="px-3 sm:px-4 py-2.5 text-[9px] font-bold text-slate-500 uppercase tracking-wider text-center">Total Owners</th>
              <th className="px-3 sm:px-4 py-2.5 text-[9px] font-bold text-slate-500 uppercase tracking-wider text-right">Last Transfer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredGroups.map((group: any, idx: number) => {
              const isExpanded = expandedRow === group.survey_no;
              return (
                <React.Fragment key={idx}>
                  <tr 
                    className={cn(
                      "transition-colors cursor-pointer group",
                      isExpanded ? "bg-indigo-50/40" : "hover:bg-slate-50/50"
                    )}
                    onClick={() => setExpandedRow(isExpanded ? null : group.survey_no)}
                  >
                    <td className="px-3 sm:px-4 py-2.5 font-black text-slate-900 text-sm">{group.survey_no}</td>
                    <td className="px-3 sm:px-4 py-2.5">
                       <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-green-50 flex items-center justify-center border border-green-100 shrink-0">
                             <Users className="w-3 h-3 text-green-600" />
                          </div>
                          <div className="min-w-0">
                             <p className="font-bold text-xs text-slate-900 leading-tight truncate">{group.last_transfer?.buyers || "N/A"}</p>
                             <p className="text-[8px] text-slate-400 uppercase font-bold tracking-wider">Latest EC entry · not chain-verified</p>
                          </div>
                       </div>
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 text-center">
                       <div className="inline-flex flex-col items-center leading-tight">
                          <Badge className="bg-emerald-50 text-emerald-700 border-emerald-100 font-black text-[9px] px-1.5 h-4">
                             {group.transfer_count} transfers
                          </Badge>
                          <span className="text-[8px] text-slate-400 font-medium tracking-tight mt-0.5">
                             + {group.encumbrance_count} encumbr.
                          </span>
                       </div>
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 text-center">
                       <div className="flex flex-col items-center leading-tight" title={`${group.unique_buyers.size} distinct buyer(s) in transfer deeds; ${group.unique_owners.size} distinct person(s) across every role`}>
                          <span className="text-xs font-black text-slate-900">{group.unique_buyers.size || group.unique_owners.size}</span>
                          <span className="text-[8px] text-slate-400 font-black uppercase tracking-tight">
                             {group.unique_buyers.size ? "Owners (hist.)" : "Persons"}
                          </span>
                       </div>
                    </td>
                    <td className="px-3 sm:px-4 py-2.5 text-right">
                       <div className="flex items-center justify-end gap-1.5">
                         <div className="leading-tight">
                           <p className="text-[10px] font-black text-slate-900 tabular-nums">{group.last_transfer?.date || "N/A"}</p>
                           {group.last_transfer?.document_number && (
                             <p className="text-[9px] text-indigo-600 font-bold">Doc: {group.last_transfer.document_number}</p>
                           )}
                         </div>
                         <ChevronDown className={cn(
                           "w-3.5 h-3.5 text-slate-400 transition-transform duration-300 shrink-0",
                           isExpanded && "rotate-180 text-indigo-600"
                         )} />
                       </div>
                    </td>
                  </tr>

                  {/* Expanded Detail Row */}
                  {isExpanded && (
                    <tr>
                      <td colSpan={5} className="p-0">
                        <div className="bg-slate-50/80 border-t border-indigo-100 animate-in slide-in-from-top-2 duration-300">
                          <div className="grid grid-cols-1 lg:grid-cols-5 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
                            {/* Left: Chronological Ownership Lineage */}
                            <div className="lg:col-span-3 p-6 space-y-4">
                              <div className="flex items-center gap-2 mb-4">
                                <FileText className="w-4 h-4 text-indigo-600" />
                                <h4 className="text-xs font-black text-slate-900 uppercase tracking-widest">
                                  Chronological Ownership Lineage (EC Transactions)
                                </h4>
                              </div>

                              <div className="space-y-3 max-h-[400px] overflow-y-auto scrollbar-thin pr-2">
                                {group.records.map((rec: any, rIdx: number) => (
                                  <div key={rIdx} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
                                    {/* Transaction Header */}
                                    <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
                                      <span className="text-xs font-bold text-slate-600">{rec.date || "N/A"}</span>
                                      <span className="text-[10px] font-black text-indigo-600 uppercase tracking-wider">Doc: {rec.document_number || "N/A"}</span>
                                    </div>
                                    {/* Nature */}
                                    <div className="px-4 pt-2 pb-1">
                                      <p className="text-[10px] text-slate-500 font-bold">{rec.nature_of_document || rec.nature || "Sale Deed"}</p>
                                      <div className="flex gap-1 mt-1">
                                        <Badge variant="outline" className="text-[8px] h-4 px-1.5 bg-green-50 text-green-700 border-green-200">Includes</Badge>
                                        <Badge variant="outline" className="text-[8px] h-4 px-1.5 bg-blue-50 text-blue-700 border-blue-200">👤 {group.unique_owners.size}</Badge>
                                        {(rec.property_extent || rec.square_feet) && <Badge variant="outline" className="text-[8px] h-4 px-1.5">📐 {rec.property_extent || rec.square_feet}</Badge>}
                                      </div>
                                    </div>
                                    {/* FROM → TO */}
                                    <div className="px-4 py-3">
                                      <div className="bg-slate-50 rounded-lg p-3 space-y-2">
                                        <div className="flex items-start gap-2">
                                          <span className="text-[9px] font-black text-slate-400 uppercase w-10 shrink-0 pt-0.5">From</span>
                                          <p className="text-xs font-bold text-slate-800 leading-snug">{rec.sellers || rec.executant || "N/A"}</p>
                                        </div>
                                        <div className="w-10 flex justify-center">
                                          <ArrowRight className="w-3 h-3 text-indigo-400 rotate-90" />
                                        </div>
                                        <div className="flex items-start gap-2">
                                          <span className="text-[9px] font-black text-indigo-600 uppercase w-10 shrink-0 pt-0.5">To</span>
                                          <p className="text-xs font-black text-indigo-700 leading-snug">{rec.buyers || rec.claimant || "N/A"}</p>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Right: Ownership Integrity Note */}
                            <div className="lg:col-span-2 p-6">
                              <div className="flex items-center gap-2 mb-4">
                                <ShieldCheck className="w-4 h-4 text-teal-600" />
                                <h4 className="text-xs font-black text-teal-700 uppercase tracking-widest">
                                  Ownership Integrity Note
                                </h4>
                              </div>
                              <div className="bg-teal-50/50 border border-teal-200/50 rounded-xl p-5 space-y-3">
                                <p className="text-xs text-slate-600 leading-relaxed">
                                  <strong className="text-slate-900">{group.transfer_count}</strong> transfer deed{group.transfer_count === 1 ? "" : "s"} (Sale / Conveyance / Settlement / Gift / Partition)
                                  {group.encumbrance_count > 0 && <> plus <strong className="text-slate-900">{group.encumbrance_count}</strong> non-transfer entr{group.encumbrance_count === 1 ? "y" : "ies"} (mortgages, receipts, POAs, attachments)</>}
                                  &nbsp;found for survey&nbsp;<strong className="text-slate-900">{group.survey_no}</strong>.
                                  &nbsp;Current owner is read from the latest <strong>transfer</strong> deed only — non-transfer entries do not change ownership.
                                </p>
                                <div className="border-t border-teal-200/50 pt-3 space-y-2">
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-slate-500 font-medium">Current Owner</span>
                                    <span className="font-bold text-slate-900 truncate max-w-[180px]" title={group.last_transfer?.buyers || "N/A"}>{group.last_transfer?.buyers || "N/A"}</span>
                                  </div>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-slate-500 font-medium">Transfers / Total</span>
                                    <span className="font-bold text-slate-900">{group.transfer_count} / {group.records.length}</span>
                                  </div>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-slate-500 font-medium" title="Distinct buyers in transfer deeds. Each person de-duplicated across name variants (role suffixes, honorifics, punctuation).">Owners (historical)</span>
                                    <span className="font-bold text-slate-900">{group.unique_buyers.size}</span>
                                  </div>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-slate-500 font-medium" title="Every distinct person across BOTH buyer and seller sides, across all transactions (transfers + encumbrances). Larger than 'Owners (historical)' because banks, agents, predecessors etc. count here too.">All Parties Ever</span>
                                    <span className="font-bold text-slate-900">{group.unique_owners.size}</span>
                                  </div>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-slate-500 font-medium">Last Transfer</span>
                                    <span className="font-bold text-slate-900 truncate max-w-[180px]" title={group.last_transfer?.date || "N/A"}>{group.last_transfer?.date || "N/A"}</span>
                                  </div>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-slate-500 font-medium">First Activity</span>
                                    <span className="font-bold text-slate-900 truncate max-w-[180px]" title={group.records[0]?.date || "N/A"}>{group.records[0]?.date || "N/A"}</span>
                                  </div>
                                </div>
                                {group.transfer_count > 20 && (
                                  <div className="mt-3 p-2.5 bg-amber-50 border border-amber-200/50 rounded-lg">
                                    <p className="text-[10px] text-amber-700 font-bold flex items-center gap-1.5">
                                      <AlertTriangle className="w-3 h-3 shrink-0" />
                                      High transfer frequency — {group.transfer_count} transfers across {group.unique_buyers.size} distinct buyer{group.unique_buyers.size === 1 ? "" : "s"}. Often indicates a developer / batch-sale subdivision; manual review recommended.
                                    </p>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
        {filteredGroups.length === 0 && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center justify-center py-16 px-4"
          >
            <div className="relative w-20 h-20 mb-4">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-400 to-violet-500 rounded-full blur-2xl opacity-25 animate-pulse-glow" />
              <div className="relative w-20 h-20 bg-gradient-to-br from-white to-indigo-50 rounded-full flex items-center justify-center shadow-inner border border-indigo-100 ring-4 ring-white animate-float">
                <Users className="w-9 h-9 text-indigo-300" strokeWidth={1.6} />
              </div>
            </div>
            <p className="text-sm font-display font-bold text-slate-700">No ownership records found</p>
            <p className="text-xs text-slate-400 mt-1.5 font-medium">Run analysis or adjust your search filters</p>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}

function RisksTab({ requestId, onOpenDocAnalysis }: { requestId?: string; onOpenDocAnalysis?: (docNo: string) => void }) {
  if (!requestId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-6 bg-slate-50/50 border-2 border-dashed border-slate-200 rounded-[3rem]">
        <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center shadow-sm">
          <ShieldAlert className="w-8 h-8 text-slate-300" />
        </div>
        <div className="text-center">
          <h3 className="text-xl font-bold text-slate-900">Health Score Not Generated</h3>
          <p className="text-sm text-slate-500 mt-2 max-w-xs mx-auto">Please trigger the Legal AI Analysis to compute the Title Health Score for this parcel.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="mb-8">
        <h2 className="text-3xl font-black text-slate-900 tracking-tight">AI Title Health Score</h2>
        <p className="text-slate-500 font-medium mt-1">Automated risk assessment of the property title chain — designed for legal professionals and banks.</p>
      </div>
      <RiskScoreCard
        requestId={requestId}
        onOpenDocAnalysis={onOpenDocAnalysis}
      />
    </div>
  );
}


