import { useState, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { API_BASE_URL } from "@/lib/api";
import { FileDropZone } from "./FileDropZone";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { StreamingMessages, StreamLog, StreamStep } from "./StreamingMessages";
import { ValidationResults } from "@/components/ValidationResults";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Upload, RotateCcw, Cloud, FolderOpen, FileUp } from "lucide-react";

type UploadState = "idle" | "uploading" | "complete" | "error";

const INITIAL_STEPS: StreamStep[] = [
  { id: "ec_extraction", label: "EC Extraction", status: "pending" },
  { id: "matching", label: "Document Matching", status: "pending" },
  {
    id: "sale_deed_extraction",
    label: "Sale Deed Extraction",
    status: "pending",
  },
  { id: "hierarchy", label: "Hierarchy Generation", status: "pending" },
  { id: "validation", label: "Validation", status: "pending" },
];

type InputType = "local_path" | "files" | "cloud";

export function UploadForm() {
  const [inputType, setInputType] = useState<InputType>("local_path");
  const [visualDebug, setVisualDebug] = useState<boolean>(false);

  // File upload state
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);

  const [ecPdfPath, setEcPdfPath] = useState<string>("");
  const [registrationDocsDir, setRegistrationDocsDir] = useState<string>("");
  const [transactionLimit, setTransactionLimit] = useState<string>("all");

  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [logs, setLogs] = useState<StreamLog[]>([]);
  const [steps, setSteps] = useState<StreamStep[]>(INITIAL_STEPS);
  const [resultData, setResultData] = useState<string>("");

  const addLog = useCallback((data: any) => {
    const log: StreamLog = {
      id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(7),
      type: (data.type === "log" || data.type === "sub_log" || data.type === "error" || data.type === "result") ? data.type : "log",
      message: data.message,
      step: data.step,
      timestamp: new Date(),
    };
    setLogs((prev) => [...prev, log]);
  }, []);

  const updateStep = useCallback(
    (stepId: string, updates: Partial<StreamStep>) => {
      setSteps((prev) =>
        prev.map((s) => (s.id === stepId ? { ...s, ...updates } : s)),
      );
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    // Validation
    if (inputType === "local_path") {
      if (!ecPdfPath.trim() || !registrationDocsDir.trim()) {
        alert(
          "Please provide both EC PDF path and Registration Documents directory",
        );
        return;
      }
    } else if (inputType === "files") {
      if (!pdfFile || !zipFile) {
        alert("Please upload both EC PDF file and Sale Deeds ZIP file");
        return;
      }
    } else if (inputType === "cloud") {
      alert("Cloud storage (S3/Azure Blob) is not yet available");
      return;
    }

    setUploadState("uploading");
    setLogs([]);
    setResultData("");
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: "pending" }))); // Reset steps

    try {
      let response: Response;

      if (inputType === "local_path") {
        // Send JSON with local paths
        const API_URL = API_BASE_URL;
        response = await fetch(`${API_URL}/api/v1/validate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "local_path",
            ec_pdf_path: ecPdfPath.trim(),
            registration_docs_dir: registrationDocsDir.trim(),
            stream: true,
            visual_debug: visualDebug,
            transaction_limit: transactionLimit === "all" ? 0 : parseInt(transactionLimit),
          }),
        });
      } else if (inputType === "files") {
        // Send multipart/form-data with files
        const formData = new FormData();
        formData.append("type", "files");
        formData.append("ec_pdf_file", pdfFile);
        formData.append("sale_deeds_zip", zipFile);
        formData.append("stream", "true");
        formData.append("visual_debug", String(visualDebug));
        formData.append("transaction_limit", transactionLimit === "all" ? "0" : transactionLimit);
        const API_URL = API_BASE_URL;
        response = await fetch(`${API_URL}/api/v1/validate`, {
          method: "POST",
          body: formData,
        });
      } else {
        throw new Error("Invalid input type");
      }

      if (!response.body) {
        throw new Error("ReadableStream not yet supported.");
      }

      const reader = response.body.getReader();
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

            // Route event types
            if (data.type === "step_start") {
              updateStep(data.step, { status: "running" });
            } else if (data.type === "step_complete") {
              updateStep(data.step, {
                status: data.status === "success" ? "success" : "failed",
                error: data.error,
              });
            } else if (data.type === "log" || data.type === "sub_log") {
              addLog(data);
            } else if (data.type === "partial_result") {
              setResultData(prev => {
                let current: any;
                try {
                  current = prev ? JSON.parse(prev) : { status: "processing", results: [] };
                } catch (e) {
                  current = { status: "processing", results: [] };
                }

                // Avoid duplicates if any
                if (current && Array.isArray(current.results)) {
                  const exists = current.results.some((r: any) => r.document_number === data.data?.document_number);
                  if (!exists) {
                    current.results = [...current.results, data.data];
                  }
                }
                return JSON.stringify(current);
              });
            } else if (data.type === "result") {
              setResultData(JSON.stringify(data.data, null, 2));
              addLog({ type: "result", message: "Processing Complete" });
            } else if (data.type === "error") {
              addLog({ type: "error", message: data.message });
              setUploadState("error");
            }
          } catch (e) {
            console.error("Error parsing JSON line:", line, e);
          }
        }
      }

      setUploadState("complete");
    } catch (error) {
      console.error(error);
      addLog({ type: "error", message: "Connection failed" });
      setUploadState("error");
    }
  }, [
    addLog,
    updateStep,
    inputType,
    ecPdfPath,
    registrationDocsDir,
    pdfFile,
    zipFile,
    visualDebug,
    transactionLimit,
  ]);

  const handleReset = useCallback(() => {
    setPdfFile(null);
    setZipFile(null);
    setEcPdfPath("");
    setRegistrationDocsDir("");
    setUploadState("idle");
    setLogs([]);
    setResultData("");
    setSteps(INITIAL_STEPS);
  }, []);

  // Parse results from resultData
  const parsedResults = useMemo(() => {
    if (!resultData) return null;
    try {
      const data = JSON.parse(resultData);
      // Handle nested structure: body.response.results
      if (data.body?.response?.results) {
        return data.body.response.results;
      }
      // Handle direct results array
      if (data.response?.results) {
        return data.response.results;
      }
      // Handle results at root
      if (Array.isArray(data.results)) {
        return data.results;
      }
      return null;
    } catch (e) {
      console.error("Error parsing results:", e);
      return null;
    }
  }, [resultData]);

  const redFlags = useMemo(() => {
    if (!resultData) return [];
    try {
      const data = JSON.parse(resultData);
      return data.red_flags || data.body?.response?.red_flags || data.response?.red_flags || [];
    } catch (e) {
      return [];
    }
  }, [resultData]);

  const hierarchyPath = useMemo(() => {
    if (!resultData) return null;
    try {
      const data = JSON.parse(resultData);
      return data.hierarchy_path || data.body?.response?.hierarchy_path || data.response?.hierarchy_path;
    } catch (e) {
      return null;
    }
  }, [resultData]);

  const requestId = useMemo(() => {
    if (!resultData) return null;
    try {
      const data = JSON.parse(resultData);
      return data.request_id || data.body?.response?.request_id || data.response?.request_id;
    } catch (e) {
      return null;
    }
  }, [resultData]);

  // Allow submit always for this test mode
  const canSubmit = uploadState === "idle";
  const isProcessing = uploadState === "uploading";
  const isComplete = uploadState === "complete" || uploadState === "error";

  const hasResults = parsedResults && parsedResults.length > 0;

  return (
    <div
      className={`w-full ${hasResults ? "" : "max-w-4xl"} mx-auto space-y-8`}
    >
      {/* Input Type Selection */}
      <div className="space-y-2">
        <Label htmlFor="input-type" className="text-base font-semibold">
          Input Type
        </Label>
        <Select
          value={inputType}
          onValueChange={(value) => setInputType(value as InputType)}
          disabled={isProcessing || isComplete}
        >
          <SelectTrigger id="input-type" className="w-full">
            <SelectValue placeholder="Select input type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local_path">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4" />
                <span>Local Path</span>
              </div>
            </SelectItem>
            <SelectItem value="files">
              <div className="flex items-center gap-2">
                <FileUp className="w-4 h-4" />
                <span>File Upload</span>
              </div>
            </SelectItem>
            <SelectItem value="cloud" disabled>
              <div className="flex items-center gap-2">
                <Cloud className="w-4 h-4" />
                <span>Cloud Storage (S3/Azure Blob) - Coming Soon</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Inputs Section */}
      {inputType === "local_path" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ec-pdf-path">EC PDF Path</Label>
            <Input
              id="ec-pdf-path"
              type="text"
              placeholder="e.g., inputs/47.pdf"
              value={ecPdfPath}
              onChange={(e) => setEcPdfPath(e.target.value)}
              disabled={isProcessing || isComplete}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="registration-docs-dir">
              Registration Documents Directory
            </Label>
            <Input
              id="registration-docs-dir"
              type="text"
              placeholder="e.g., inputs/Registration Document"
              value={registrationDocsDir}
              onChange={(e) => setRegistrationDocsDir(e.target.value)}
              disabled={isProcessing || isComplete}
            />
          </div>
        </div>
      )}

      {inputType === "files" && (
        <div className="grid gap-6 md:grid-cols-2">
          <FileDropZone
            accept="pdf"
            file={pdfFile}
            onFileChange={setPdfFile}
            disabled={isProcessing || isComplete}
          />
          <FileDropZone
            accept="zip"
            file={zipFile}
            onFileChange={setZipFile}
            disabled={isProcessing || isComplete}
          />
        </div>
      )}

      {inputType === "cloud" && (
        <div className="p-6 rounded-lg border border-dashed border-muted-foreground/50 bg-muted/30 text-center">
          <Cloud className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
          <p className="text-muted-foreground font-medium">
            Cloud storage integration (S3/Azure Blob) is coming soon
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Please use Local Path or File Upload options for now
          </p>
        </div>
      )}

      {/* Filter Options Section */}
      <div className="flex flex-wrap justify-center gap-6 pb-2">
        {/* Transaction Limit Filter */}
        <div className="flex flex-col gap-1.5 w-64">
          <Label htmlFor="tx-limit" className="text-xs font-bold text-slate-500 uppercase ml-1">Transaction Filter</Label>
          <Select
            value={transactionLimit}
            onValueChange={setTransactionLimit}
            disabled={isProcessing || isComplete}
          >
            <SelectTrigger id="tx-limit" className="h-11 rounded-xl border-slate-200 bg-white shadow-sm hover:border-primary/30 transition-all font-medium">
              <SelectValue placeholder="Select filter" />
            </SelectTrigger>
            <SelectContent className="rounded-xl border-slate-200 shadow-xl overflow-hidden">
              <SelectItem value="1" className="py-2.5 font-medium cursor-pointer focus:bg-primary/5">Latest Only (Current)</SelectItem>
              <SelectItem value="5" className="py-2.5 font-medium cursor-pointer focus:bg-primary/5">Last 5 Transactions</SelectItem>
              <SelectItem value="10" className="py-2.5 font-medium cursor-pointer focus:bg-primary/5">Last 10 Transactions</SelectItem>
              <SelectItem value="20" className="py-2.5 font-medium cursor-pointer focus:bg-primary/5">Last 20 Transactions</SelectItem>
              <SelectItem value="all" className="py-2.5 font-medium cursor-pointer focus:bg-primary/5">All Transactions (Unlimited)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Visual Debug Toggle Section (Modified for layout) */}
        <div
          className="flex items-center gap-4 bg-primary/5 hover:bg-primary/10 transition-colors px-6 py-2.5 rounded-2xl border border-primary/10 cursor-pointer group h-11 self-end"
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest('button') || target.closest('input')) return;
            setVisualDebug(!visualDebug);
          }}
        >
          <div className="relative flex items-center">
            <Checkbox
              id="visual-debug"
              checked={visualDebug}
              onCheckedChange={(checked) => setVisualDebug(checked as boolean)}
              disabled={isProcessing || isComplete}
              className="w-5 h-5 border-primary/30 data-[state=checked]:bg-primary data-[state=checked]:border-primary transition-all duration-300"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <div className="flex flex-col text-left">
            <Label
              htmlFor="visual-debug"
              className="text-sm font-bold text-slate-700 cursor-pointer group-hover:text-primary transition-colors leading-none"
              onClick={(e) => e.stopPropagation()}
            >
              Visual Intelligence Mode
            </Label>
            <span className="text-[10px] text-slate-500 font-medium">Auto-mismatch highlighting</span>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      {uploadState === "idle" && (
        <div className="flex justify-center">
          <Button
            size="lg"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="min-w-[200px] gap-2"
          >
            <Upload className="w-5 h-5" />
            Process Files (Streaming)
          </Button>
        </div>
      )}

      {/* Streaming Output */}
      {(isProcessing || isComplete) && (
        <div className="space-y-8 animate-fade-in w-full">
          <StreamingMessages
            logs={logs}
            steps={steps}
            isComplete={isComplete && resultData !== ""}
          />

          {/* Validation Results */}
          {parsedResults && parsedResults.length > 0 && (
            <div className="w-full">
              <ErrorBoundary>
                <ValidationResults
                  results={parsedResults}
                  red_flags={redFlags}
                  hierarchyPath={hierarchyPath}
                  requestId={requestId || undefined}
                />
              </ErrorBoundary>
            </div>
          )}

          {/* Result Textbox (fallback if no parsed results) */}
          {resultData && !parsedResults && (
            <div className="space-y-2 max-w-4xl mx-auto">
              <h3 className="text-lg font-semibold">Response Data</h3>
              <Textarea
                value={resultData}
                readOnly
                className="h-96 font-mono text-sm"
              />
            </div>
          )}

          {/* Reset Button */}
          {isComplete && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="lg"
                onClick={handleReset}
                className="gap-2"
              >
                <RotateCcw className="w-5 h-5" />
                Start Over
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
