import { useEffect, useRef } from "react";
import { Loader2, CheckCircle2, AlertCircle, Info, Circle, History, FileSearch, ShieldCheck, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// Types matching the backend events
export interface StreamLog {
  id: string;
  type: "log" | "sub_log" | "error" | "result";
  message?: string;
  step?: string;
  timestamp: Date;
}

export interface StreamStep {
  id: string;
  label: string;
  status: "pending" | "running" | "success" | "failed";
  error?: string;
}

interface StreamingMessagesProps {
  logs: StreamLog[];
  steps: StreamStep[];
  isComplete: boolean;
}

export function StreamingMessages({ logs, steps, isComplete }: StreamingMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, steps]);

  // Get current active step
  const activeStep = steps.find(s => s.status === "running")?.id;

  return (
    <div className="w-full max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-6">

      {/* Left Column: Progress Steps with advanced animations */}
      <div className="md:col-span-1 space-y-4">
        <div className="bg-card border border-primary/10 rounded-2xl p-6 shadow-xl shadow-primary/5 bg-gradient-to-b from-white to-slate-50/50">
          <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
            <Zap className="w-3 h-3 text-primary" />
            Process Engine
          </h3>
          <div className="space-y-6">
            {steps.map((step, index) => {
              const isActive = step.status === "running";
              const isFinished = step.status === "success";
              const isError = step.status === "failed";

              return (
                <div key={step.id} className="relative flex flex-col gap-1">
                  {/* Connecting Line */}
                  {index < steps.length - 1 && (
                    <div className={cn(
                      "absolute left-3.5 top-8 w-[2px] h-8 bg-slate-100 -ml-px transition-all duration-700",
                      isFinished && "bg-green-500/30"
                    )} />
                  )}

                  <div className="flex items-center gap-4 group">
                    <div className={cn(
                      "relative flex items-center justify-center w-7 h-7 rounded-full border-2 transition-all duration-500 z-10",
                      step.status === "pending" && "border-slate-200 bg-white",
                      isActive && "border-primary bg-primary/20 scale-110 shadow-lg shadow-primary/20",
                      isFinished && "border-green-500 bg-green-500/10",
                      isError && "border-destructive bg-destructive/10",
                    )}>
                      {step.status === "pending" && <Circle className="w-3 h-3 text-slate-300" />}
                      {isActive && <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />}
                      {isFinished && <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />}
                      {isError && <AlertCircle className="w-3.5 h-3.5 text-destructive" />}

                      {/* Pulse effect for active step */}
                      {isActive && (
                        <div className="absolute inset-0 rounded-full bg-primary/30 animate-ping -z-10" />
                      )}
                    </div>

                    <div className="flex flex-col">
                      <span className={cn(
                        "text-xs font-bold transition-all duration-300",
                        step.status === "pending" && "text-slate-400 font-medium",
                        isActive && "text-primary tracking-tight",
                        isFinished && "text-slate-700",
                        isError && "text-destructive"
                      )}>
                        {step.label}
                      </span>
                      {isActive && (
                        <span className="text-[8px] text-primary/70 animate-pulse uppercase font-extrabold tracking-widest">
                          Processing...
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Special Scanning Animation for EC/Sale Deed Extraction */}
                  {isActive && (step.id === "ec_extraction" || step.id === "sale_deed_extraction") && (
                    <div className="ml-11 mt-2 bg-slate-100 rounded-lg p-2 border border-dashed border-slate-300 animate-in fade-in slide-in-from-left-2 overflow-hidden relative">
                      <div className="flex items-center gap-2 mb-1">
                        <FileSearch className="w-3 h-3 text-primary animate-bounce" />
                        <span className="text-[9px] font-semibold text-primary/80">AI Scanning Layout...</span>
                      </div>
                      <div className="w-full h-1 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-primary animate-progress-indeterminate" />
                      </div>
                      <div className="absolute top-0 left-0 w-full h-[1px] bg-primary/40 shadow-[0_0_8px_rgba(59,130,246,0.6)] animate-scan-line" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Status Badge */}
        <div className={cn(
          "rounded-2xl p-4 flex items-center justify-between border-2 transition-all duration-500",
          isComplete ? "bg-green-50 border-green-200" : "bg-primary/5 border-primary/10 animate-pulse"
        )}>
          <div className="flex items-center gap-3">
            <div className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center",
              isComplete ? "bg-green-500 text-white" : "bg-primary text-white"
            )}>
              {isComplete ? <ShieldCheck className="w-4 h-4" /> : <Loader2 className="w-4 h-4 animate-spin" />}
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider leading-none">Status</p>
              <p className={cn("text-sm font-black", isComplete ? "text-green-700" : "text-primary")}>
                {isComplete ? "VERIFIED" : "ANALYZING"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Right Column: High-tech Execution Logs */}
      <div className="md:col-span-3">
        <div className="bg-white border border-primary/10 rounded-2xl p-6 shadow-xl shadow-primary/5 h-[500px] flex flex-col relative overflow-hidden group">
          {/* Subtle background glow */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-[100px] -z-10 group-hover:bg-primary/10 transition-all duration-1000" />

          <div className="flex items-center justify-between mb-6 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
              <div className="flex flex-col">
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-[0.1em]">Engine Terminal</h3>
                <span className="text-[8px] text-slate-400 font-mono tracking-tighter">INTELLIGENCE V2.4 // REAL-TIME ANALYTICS</span>
              </div>
            </div>
            {isComplete ? (
              <Badge variant="outline" className="text-[9px] border-green-200 text-green-600 bg-green-50 font-mono px-2 py-0">RUN_SUCCESS</Badge>
            ) : (
              <Badge variant="outline" className="text-[9px] border-primary/20 text-primary bg-primary/5 font-mono px-2 py-0">EXECUTING...</Badge>
            )}
          </div>

          <div
            ref={containerRef}
            className="flex-1 overflow-y-auto space-y-1.5 pr-2 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent font-mono text-xs selection:bg-primary/10"
          >
            {logs.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3">
                <Loader2 className="w-5 h-5 animate-spin opacity-20" />
                <p className="text-[10px] uppercase font-bold tracking-widest opacity-40 text-slate-500">Initializing Neural Pipeline...</p>
              </div>
            )}
            {logs.map((log) => (
              <div key={log.id} className={cn(
                "group py-1 border-l pl-3 transition-colors duration-200",
                log.type === "log" && "border-slate-100 hover:border-primary/30 text-slate-700",
                log.type === "sub_log" && "border-transparent text-slate-400 ml-4",
                log.type === "error" && "border-destructive/30 text-destructive bg-destructive/5 px-2 rounded-r-md",
                log.type === "result" && "border-green-500/30 text-green-600 font-bold bg-green-50/50 px-2 rounded-r-md mt-2"
              )}>
                <div className="flex items-start gap-3">
                  <span className="opacity-40 text-[9px] mt-0.5 shrink-0 tabular-nums text-slate-500">[{log.timestamp.toLocaleTimeString([], { hour12: false })}]</span>
                  <span className="break-all leading-relaxed whitespace-pre-wrap">
                    {log.type === "result" ? <span className="text-green-500 mr-2">✓</span> : null}
                    {log.message || JSON.stringify(log)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-slate-50 flex items-center justify-between text-[8px] font-mono text-slate-400 uppercase tracking-widest">
            <span>TERMINAL_ID: {Math.random().toString(36).substring(7).toUpperCase()}</span>
            <span>UTF-8 // DEEP_SEARCH_ENABLED</span>
          </div>
        </div>
      </div>
    </div>
  );
}
