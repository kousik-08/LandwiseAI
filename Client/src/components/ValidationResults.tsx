import { RotateCw, Search as SearchIcon, X, Filter } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ValidationResultItem } from "@/features/analysis/components/AnalysisResultItem";
import { SurveyTimeline } from "@/features/timeline/components/SurveyTimeline";
import { ReactFlowHierarchy } from "@/features/hierarchy/components/ReactFlowHierarchy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MapPin, ExternalLink, Loader2, FileText, Calendar, User, Users, ShieldCheck, TrendingUp } from "lucide-react";
import { ECHistoricalValues } from "@/features/analysis/components/ECHistoricalValues";
import { ValueComparisonAudit } from "@/features/analysis/components/ValueComparisonAudit";
import { SurveyOwnershipTable } from "@/components/SurveyOwnershipTable";
import { RiskScoreCard } from "@/features/analysis/components/RiskScoreCard";
import { useState, useEffect, useMemo, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { Copy, Download, Printer, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { API_BASE_URL } from "@/lib/api";

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
  valuation_details?: {
    actual_sell_value: number;
    guideline_value: number;
    area_sqft: number;
    sell_value_per_sqft: number;
    market_value_per_sqft: number;
  };
}

interface ResultItem {
  document_number: string;
  validation_result: ValidationResult;
  match: boolean;
  file_path: string;
}

interface ValidationResultsProps {
  results: ResultItem[];
  red_flags?: any[];
  hierarchyPath?: string | null;
  requestId?: string;
  onOpenInMap?: (docNo: string) => void;
}

export function ValidationResults({ results, red_flags = [], hierarchyPath, requestId, onOpenInMap }: ValidationResultsProps) {
  console.log("ValidationResults data:", results);

  const [activeTab, setActiveTab] = useState<"analysis" | "hierarchy" | "timeline" | "report" | "valuation" | "ownership" | "risk">("risk");
  const [selectedDocument, setSelectedDocument] = useState<string | null>(
    results.length > 0 ? results[0].document_number : null,
  );
  const [openAccordion, setOpenAccordion] = useState<string | undefined>(
    results.length > 0 ? results[0].document_number : undefined,
  );
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Filtered Results based on search
  const filteredResults = useMemo(() => {
    if (!searchQuery.trim()) return results;
    const query = searchQuery.toLowerCase();
    return results.filter(r => {
      const docNoMatch = r.document_number.toLowerCase().includes(query);
      const surveyMatch = r.validation_result?.comparisons?.some(c => 
        c.field.toLowerCase().includes("survey") && 
        (c.ec_value?.toLowerCase().includes(query) || c.metadata_value?.toLowerCase().includes(query))
      );
      return docNoMatch || surveyMatch;
    });
  }, [results, searchQuery]);

  // Report State
  const [report, setReport] = useState<{ report_md: string; report_url: string } | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);

  // Global Hierarchy State
  const [globalHierarchy, setGlobalHierarchy] = useState<any>(null);

  // Value Analysis State
  const [valuationData, setValuationData] = useState<any[] | null>(null);
  const [loadingValuation, setLoadingValuation] = useState(false);

  const combinedTrendData = useMemo(() => {
    const ecTrends = valuationData || [];
    const deedTrends = results
      .filter(r => r.validation_result?.valuation_details)
      .map(r => ({
        document_no: r.document_number,
        area_sqft: r.validation_result.valuation_details!.area_sqft,
        actual_sell_value: r.validation_result.valuation_details!.actual_sell_value,
        guideline_value: r.validation_result.valuation_details!.guideline_value,
        sell_value_per_sqft: r.validation_result.valuation_details!.sell_value_per_sqft,
        market_value_per_sqft: r.validation_result.valuation_details!.market_value_per_sqft,
        observation: "Directly extracted from deed file"
      }));

    const combined = [...ecTrends];
    deedTrends.forEach(dt => {
      if (!combined.find(et => et.document_no === dt.document_no)) {
        combined.push(dt);
      }
    });

    return combined;
  }, [valuationData, results]);

  // Auto-select first document when results stream in
  useEffect(() => {
    if (!selectedDocument && results.length > 0) {
      setSelectedDocument(results[0].document_number);
    }
  }, [results, selectedDocument]);
  const [loadingGlobal, setLoadingGlobal] = useState(false);
  const [hierarchyPreview, setHierarchyPreview] = useState<any>(null);

  useEffect(() => {
    if (activeTab === "hierarchy" && requestId && !globalHierarchy) {
      fetchGlobalHierarchy();
    }
    if (activeTab === "valuation" && requestId && !valuationData) {
      fetchValuationData();
    }
  }, [activeTab, requestId]);

  const fetchGlobalHierarchy = async () => {
    setLoadingGlobal(true);
    try {
      const API_URL = API_BASE_URL;
      const resp = await fetch(`${API_URL}/api/v1/get-global-hierarchy/${requestId}`);
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

  const fetchValuationData = async () => {
    setLoadingValuation(true);
    try {
      const formData = new FormData();
      if (requestId) {
        formData.append("request_id", requestId);
      }

      const resp = await fetch(`${API_BASE_URL}/api/v1/analyze-ec`, {
        method: "POST",
        body: formData // This automatically sets Content-Type to multipart/form-data
      });
      if (resp.ok) {
        const data = await resp.json();
        setValuationData(data.data);
      } else {
        toast.error("EC Historical Value analysis failed.");
      }
    } catch (e) {
      console.error("Failed to fetch valuation data:", e);
    } finally {
      setLoadingValuation(false);
    }
  };

  const handleGenerateReport = async () => {
    if (!requestId) return;
    setGeneratingReport(true);
    try {
      const API_URL = API_BASE_URL;
      const resp = await fetch(`${API_URL}/api/v1/generate-report/${requestId}`, {
        method: "POST",
      });
      if (resp.ok) {
        const data = await resp.json();
        setReport(data);
        toast.success("Legal Opinion Report generated successfully!");
      } else {
        toast.error("Failed to generate report");
      }
    } catch (e) {
      console.error("Error generating report:", e);
      toast.error("An error occurred while generating the report");
    } finally {
      setGeneratingReport(false);
    }
  };

  const handleHierarchyNodeClick = (docNo: string, data: any) => {
    setHierarchyPreview({ docNo, data });
  };

  if (!results) {
    return <div className="p-4 text-red-500">Error: No results data available.</div>;
  }

  const [refreshKey, setRefreshKey] = useState(Date.now());

  const selectedResult = results.find((r) => r.document_number === selectedDocument);
  const rawPdfUrl = selectedResult && selectedResult.file_path
    ? `${API_BASE_URL}/files/${selectedResult.file_path.replace(/\\/g, "/")}?t=${refreshKey}`
    : null;
  const pdfUrl = rawPdfUrl
    ? (selectedPage !== null ? `${rawPdfUrl}#page=${selectedPage === 0 ? 1 : selectedPage}&navpanes=0` : `${rawPdfUrl}#navpanes=0`)
    : null;

  const hierarchyUrl = hierarchyPath
    ? `${API_BASE_URL}/files/${hierarchyPath}`
    : null;

  const handleAccordionChange = (value: string | undefined) => {
    setOpenAccordion(value);
    if (value) setSelectedDocument(value);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] w-full border rounded-xl overflow-hidden bg-background shadow-2xl animate-in fade-in zoom-in duration-500">
      {/* Header Tabs */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-card space-x-4">
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setActiveTab("analysis")}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 ${activeTab === "analysis"
              ? "bg-primary text-primary-foreground shadow-lg scale-105"
              : "hover:bg-muted text-muted-foreground"
              }`}
          >
            Document Analysis
          </button>
          {requestId && (
            <button
              onClick={() => setActiveTab("hierarchy")}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 ${activeTab === "hierarchy"
                ? "bg-primary text-primary-foreground shadow-lg scale-105"
                : "hover:bg-muted text-muted-foreground"
                }`}
            >
              Master Lineage Map
            </button>
          )}
          {requestId && (
            <button
              onClick={() => setActiveTab("timeline")}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 ${activeTab === "timeline"
                ? "bg-primary text-primary-foreground shadow-lg scale-105"
                : "hover:bg-muted text-muted-foreground"
                }`}
            >
              Timeline Search
            </button>
          )}
          {requestId && (
            <button
              onClick={() => setActiveTab("report")}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 flex items-center gap-2 ${activeTab === "report"
                ? "bg-gradient-to-r from-indigo-600 to-primary text-primary-foreground shadow-lg scale-105"
                : "hover:bg-muted text-muted-foreground"
                }`}
            >
              <FileText className="w-4 h-4" />
              Legal Opinion
            </button>
          )}
          {requestId && (
            <button
              onClick={() => setActiveTab("valuation")}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 flex items-center gap-2 ${activeTab === "valuation"
                ? "bg-green-600 text-white shadow-lg scale-105"
                : "hover:bg-muted text-muted-foreground"
                }`}
            >
              <TrendingUp className="w-4 h-4" />
              Audit & Value
            </button>
          )}
          {requestId && (
            <button
              onClick={() => setActiveTab("ownership")}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 flex items-center gap-2 ${activeTab === "ownership"
                ? "bg-amber-600 text-white shadow-lg scale-105"
                : "hover:bg-muted text-muted-foreground"
                }`}
            >
              <Users className="w-4 h-4" />
              Ownership Audit
            </button>
          )}
          {requestId && (
            <button
              onClick={() => setActiveTab("risk")}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 flex items-center gap-2 ${activeTab === "risk"
                ? "bg-gradient-to-r from-rose-600 to-orange-500 text-white shadow-lg scale-105"
                : "hover:bg-muted text-muted-foreground"
                }`}
            >
              🛡️ Risk Score
            </button>
          )}
        </div>
        <div className="text-xs text-muted-foreground font-mono">
          {results.length} Documents Processed
        </div>
      </div>

      <div className="flex-1 overflow-hidden relative">
        {/* Analysis Tab Content */}
        {activeTab === "analysis" && (
          <div className="h-full animate-in slide-in-from-left duration-500">
            <ResizablePanelGroup direction="horizontal" className="w-full">
              <ResizablePanel defaultSize={45} minSize={30}>
                <div className="h-full overflow-y-auto p-6 scrollbar-thin">
                  <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                    <span className="w-2 h-6 bg-primary rounded-full" />
                    Validation Details
                  </h2>
                  <Accordion
                    type="single"
                    collapsible
                    className="w-full space-y-3"
                    value={openAccordion}
                    onValueChange={handleAccordionChange}
                  >
                    {results.map((result) => (
                      <ValidationResultItem
                        key={result.document_number}
                        result={result}
                        onSelect={() => {
                          setSelectedDocument(result.document_number);
                          setSelectedPage(null);
                        }}
                        onPageSelect={(page) => {
                          setSelectedDocument(result.document_number);
                          setSelectedPage(page);
                        }}
                        onOpenInMap={onOpenInMap}
                      />
                    ))}
                  </Accordion>
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle />

              <ResizablePanel defaultSize={55} minSize={40}>
                <div className="h-full flex flex-col bg-muted/20">
                  {pdfUrl ? (
                    <>
                      <div className="p-4 border-b bg-card/50 backdrop-blur-md sticky top-0 z-10">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <h3 className="font-bold text-lg">{selectedResult?.document_number}</h3>
                            <button
                              onClick={() => setRefreshKey(Date.now())}
                              className="p-1.5 hover:bg-muted rounded-full transition-colors text-slate-400 hover:text-primary"
                              title="Force Refresh PDF"
                            >
                              <RotateCw className="w-4 h-4" />
                            </button>
                          </div>
                          <Badge
                            className={`px-3 py-1 text-xs font-bold ${selectedResult?.match
                              ? "bg-green-500/10 text-green-600 border-green-200"
                              : "bg-red-500/10 text-red-600 border-red-200"
                              }`}
                            variant="outline"
                          >
                            {selectedResult?.match ? "MATCHED" : "MANUAL REVIEW"}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex-1 p-4">
                        <iframe
                          key={`${pdfUrl}-${selectedPage}-${refreshKey}`}
                          src={pdfUrl}
                          className="w-full h-full border rounded-xl shadow-inner bg-white"
                          title={`PDF Viewer - ${selectedResult?.document_number}`}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted-foreground animate-pulse">
                      <div className="text-center">
                        <p className="text-xl font-semibold">Select a document</p>
                      </div>
                    </div>
                  )}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        )}

        {/* Hierarchy Tab Content - NEW INTERACTIVE GLOBAL VIEW */}
        {activeTab === "hierarchy" && (
          <div className="h-full w-full animate-in slide-in-from-right duration-500 overflow-hidden">
            <ResizablePanelGroup direction="horizontal" className="h-full w-full">
              <ResizablePanel defaultSize={hierarchyPreview ? 70 : 100} minSize={30}>
                <div className="h-full flex flex-col p-4 bg-muted/10 relative">
                  <div className="mb-4 bg-primary/5 p-4 rounded-xl border border-primary/10 flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-bold text-primary flex items-center gap-2">
                        <MapPin className="w-5 h-5" />
                        Master Ownership Lineage
                      </h3>
                      <p className="text-sm text-muted-foreground">Comprehensive visualization of all documents and survey subdivisions</p>
                    </div>
                    {hierarchyUrl && (
                      <a
                        href={hierarchyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-4 py-2 bg-card border rounded-lg text-xs font-semibold hover:bg-muted transition-colors shadow-sm flex items-center gap-2"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Static Report
                      </a>
                    )}
                  </div>

                  <div className="flex-1 bg-white border rounded-xl shadow-inner relative overflow-hidden">
                    {hierarchyUrl ? (
                      <iframe
                        src={hierarchyUrl}
                        className="w-full h-full border-none"
                        title="Master Lineage Map"
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center italic">
                        <Loader2 className="w-12 h-12 opacity-10 mb-4 animate-spin" />
                        <p className="text-sm font-medium">Preparing hierarchy visualization...</p>
                      </div>
                    )}
                  </div>
                </div>
              </ResizablePanel>

              {hierarchyPreview && <ResizableHandle withHandle />}

              {hierarchyPreview && (
                <ResizablePanel defaultSize={30} minSize={20}>
                  <div className="h-full border-l bg-card flex flex-col">
                    <div className="p-4 bg-primary text-primary-foreground flex items-center justify-between">
                      <h3 className="font-bold flex items-center gap-2">
                        <FileText className="w-4 h-4" />
                        {hierarchyPreview.docNo}
                      </h3>
                      <button onClick={() => setHierarchyPreview(null)} className="hover:bg-white/20 p-1 rounded transition-colors">
                        <RotateCw className="w-4 h-4 rotate-45" />
                      </button>
                    </div>
                    <div className="p-6 space-y-4 overflow-y-auto scrollbar-thin">
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className="text-[10px] font-bold uppercase">{hierarchyPreview.data.nature}</Badge>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {hierarchyPreview.data.date}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-4 py-4 border-y border-slate-100 italic">
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase">Executant</span>
                          <p className="text-xs font-bold text-slate-800 leading-tight">{hierarchyPreview.data.executant}</p>
                        </div>
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase">Claimant</span>
                          <p className="text-xs font-bold text-slate-800 leading-tight">{hierarchyPreview.data.claimant}</p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs">
                          <MapPin className="w-4 h-4 text-primary/60" />
                          <span className="font-semibold">Survey Number: {hierarchyPreview.data.survey_number}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <ShieldCheck className="w-4 h-4 text-green-600" />
                          <span className="font-semibold">Area: {hierarchyPreview.data.square_feet}</span>
                        </div>
                      </div>

                      <div className="pt-4">
                        <button
                          onClick={() => {
                            setSelectedDocument(hierarchyPreview.docNo);
                            setActiveTab("analysis");
                          }}
                          className="w-full py-2 bg-primary text-primary-foreground rounded-lg font-bold text-sm shadow-md hover:shadow-lg transition-all active:scale-95"
                        >
                          View Document Details
                        </button>
                      </div>
                    </div>
                  </div>
                </ResizablePanel>
              )}
            </ResizablePanelGroup>
          </div>
        )}

        {/* Survey Timeline Search Tab */}
        {activeTab === "timeline" && requestId && (
          <div className="h-full w-full overflow-y-auto animate-in slide-in-from-bottom duration-500">
            <div className="p-6">
              <SurveyTimeline requestId={requestId} results={results} />
            </div>
          </div>
        )}

        {/* Legal Opinion Report Tab Content */}
        {activeTab === "report" && (
          <div className="h-full w-full overflow-y-auto animate-in fade-in duration-700 bg-slate-50/50">
            <div className="max-w-4xl mx-auto p-8">
              {!report && !generatingReport && (
                <div className="flex flex-col items-center justify-center min-h-[400px] text-center space-y-6 bg-white border-2 border-dashed border-slate-200 rounded-3xl p-12 shadow-sm">
                  <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center">
                    <Sparkles className="w-10 h-10 text-primary animate-pulse" />
                  </div>
                  <div>
                    <h3 className="text-2xl font-bold text-slate-900">AI Report Generator</h3>
                    <p className="text-slate-500 max-w-md mx-auto mt-2">
                      Compile all validation results, ownership history, and red flags into a formal Legal Opinion Report instantly using AI.
                    </p>
                  </div>
                  <button
                    onClick={handleGenerateReport}
                    className="flex items-center gap-2 px-8 py-4 bg-primary text-primary-foreground rounded-2xl font-bold shadow-xl shadow-primary/20 hover:shadow-2xl hover:scale-105 active:scale-95 transition-all"
                  >
                    <Sparkles className="w-5 h-5" />
                    Draft Opinion Report
                  </button>
                </div>
              )}

              {generatingReport && (
                <div className="flex flex-col items-center justify-center min-h-[400px] space-y-6">
                  <div className="relative">
                    <div className="w-24 h-24 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
                    <Sparkles className="w-8 h-8 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                  </div>
                  <div className="text-center">
                    <h3 className="text-xl font-bold animate-pulse text-primary">Drafting Formal Opinion...</h3>
                    <p className="text-sm text-muted-foreground mt-2">Analyzing lineage patterns and cross-referencing discrepancies</p>
                  </div>
                  <div className="w-full max-w-xs h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-primary animate-progress-indeterminate" />
                  </div>
                </div>
              )}

              {report && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between mb-8">
                    <div>
                      <h2 className="text-3xl font-black text-slate-900">Legal Opinion Report</h2>
                      <p className="text-slate-500">Drafted by LandwiseAI AI Assistant</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(report.report_md);
                          toast.success("Report copied to clipboard");
                        }}
                        className="p-2 hover:bg-white rounded-xl border shadow-sm transition-all" title="Copy to Clipboard">
                        <Copy className="w-5 h-5 text-slate-600" />
                      </button>
                      <button
                        onClick={() => window.print()}
                        className="p-2 hover:bg-white rounded-xl border shadow-sm transition-all" title="Print Report">
                        <Printer className="w-5 h-5 text-slate-600" />
                      </button>
                      <a
                        href={`${API_BASE_URL}/${report.report_url}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-6 py-2 bg-slate-900 text-white rounded-xl font-bold shadow-lg hover:shadow-xl hover:bg-slate-800 transition-all"
                      >
                        <Download className="w-4 h-4" />
                        Download
                      </a>
                      <button
                        onClick={handleGenerateReport}
                        className="ml-2 p-2 hover:bg-white rounded-xl border shadow-sm transition-all"
                        title="Regenerate Report"
                      >
                        <RotateCw className="w-5 h-5 text-slate-600" />
                      </button>
                    </div>
                  </div>

                  <Card className="border-none shadow-2xl rounded-3xl overflow-hidden bg-white">
                    <CardHeader className="bg-slate-900 text-white p-8">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <div className="w-10 h-10 bg-white/10 rounded-lg flex items-center justify-center">
                            <FileText className="w-6 h-6" />
                          </div>
                          <div>
                            <CardTitle className="text-xl">AI-DRIVEN TITLE VERIFICATION</CardTitle>
                            <p className="text-xs text-slate-400 font-mono">REQ-ID: {requestId}</p>
                          </div>
                        </div>
                        <div className="px-4 py-1.5 bg-green-500/20 border border-green-500/30 rounded-full">
                          <span className="text-xs font-bold text-green-400 uppercase tracking-widest">Formal Draft</span>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-12">
                      <div className="prose prose-slate max-w-none 
                        prose-headings:text-slate-900 prose-headings:font-black
                        prose-h1:text-4xl prose-h2:text-2xl prose-h2:mt-12 prose-h2:mb-6 prose-h2:border-b prose-h2:pb-2
                        prose-strong:text-indigo-600 prose-strong:font-bold
                        prose-p:text-slate-600 prose-p:leading-relaxed
                        prose-li:text-slate-600
                        prose-hr:border-slate-100
                      ">
                        <ReactMarkdown>{report.report_md}</ReactMarkdown>
                      </div>
                    </CardContent>
                  </Card>

                  <div className="text-center py-12">
                    <p className="text-xs text-slate-400 italic">
                      Disclaimer: This report is generated by AI for informational purposes only. It should be reviewed and signed by a qualified legal professional before use in legal transactions.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Value Analysis Tab Content */}
        {activeTab === "valuation" && (
          <div className="h-full w-full overflow-y-auto animate-in fade-in duration-700 p-8">
            <div className="max-w-6xl mx-auto space-y-12">
              <div className="mb-8">
                <h2 className="text-3xl font-black text-slate-900">Chain of Value Audit</h2>
                <p className="text-slate-500">Side-by-side comparison of Financial Values and Property Area across EC and Deed records</p>
              </div>

              <ValueComparisonAudit results={results} />

              <div className="mt-16 pt-12 border-t">
                <div className="mb-8">
                  <h2 className="text-3xl font-black text-slate-900">Historical Market Trends</h2>
                  <p className="text-slate-500">Holistic property valuation analysis across all recorded years (EC + Deed Records)</p>
                </div>
                <ECHistoricalValues data={combinedTrendData} isLoading={loadingValuation} />
              </div>
            </div>
          </div>
        )}
        {/* Ownership Audit Tab Content */}
        {activeTab === "ownership" && requestId && (
          <div className="h-full w-full overflow-y-auto animate-in fade-in duration-700 p-8">
            <div className="max-w-6xl mx-auto space-y-8">
              <div className="mb-4">
                <h2 className="text-3xl font-black text-slate-900 tracking-tight">Land Parcel Ownership Audit</h2>
                <p className="text-slate-500 font-medium">Distribution of unique owners and transaction history for every survey number and subdivision extracted from the EC.</p>
              </div>

              <SurveyOwnershipTable requestId={requestId} />
            </div>
          </div>
        )}

        {/* Risk Score Tab Content */}
        {activeTab === "risk" && requestId && (
          <div className="h-full w-full overflow-y-auto animate-in fade-in duration-700 p-8">
            <div className="max-w-4xl mx-auto space-y-6">
              <div>
                <h2 className="text-3xl font-black text-slate-900 tracking-tight">AI Title Health Score</h2>
                <p className="text-slate-500 font-medium mt-1">
                  Automated risk assessment of the property title chain using validated EC and deed data — designed for legal professionals and banks.
                </p>
              </div>
              <RiskScoreCard requestId={requestId} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
