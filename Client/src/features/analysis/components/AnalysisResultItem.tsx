import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, AlertCircle, ShieldCheck, MapPin, ExternalLink, FileText, RotateCw } from "lucide-react";
import { TrustabilityScore } from "./TrustabilityScore";
import { cn } from "@/lib/utils";

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
  requires_extra_scrutiny?: boolean;
  scrutiny_reason?: string;
  comparisons: Comparison[];
  reason_for_failure: string;
  match_count: number;
  trustability_score?: number;
}

interface ResultItem {
  document_number: string;
  validation_result: ValidationResult;
  match: boolean;
  file_path: string;
}

interface ValidationResultItemProps {
  result: ResultItem;
  onSelect: () => void;
  onPageSelect: (page: number) => void;
  onOpenInMap?: (docNo: string) => void;
}

const getStatusIcon = (status: string) => {
  if (status.includes("NOT MATCHED")) {
    return <XCircle className="w-5 h-5 text-red-600" />;
  } else if (status.includes("PARTIAL")) {
    return <AlertCircle className="w-5 h-5 text-yellow-600" />;
  } else if (
    status.includes("SUPPLEMENTAL") ||
    status.includes("OVERLAP") ||
    status.includes("LINKED")
  ) {
    return <CheckCircle2 className="w-5 h-5 text-green-600" />;
  } else if (status.includes("MATCHED")) {
    return <CheckCircle2 className="w-5 h-5 text-green-600" />;
  }
  return <CheckCircle2 className="w-5 h-5 text-green-600" />;
};

const getStatusBadgeStyle = (status: string) => {
  if (status.includes("NOT MATCHED")) {
    return "bg-red-500 text-white border-red-600";
  } else if (status.includes("PARTIAL")) {
    return "bg-yellow-500 text-white border-yellow-600";
  } else if (
    status.includes("SUPPLEMENTAL") ||
    status.includes("OVERLAP") ||
    status.includes("LINKED")
  ) {
    return "bg-green-500 text-white border-green-600";
  } else if (status.includes("MATCHED")) {
    return "bg-green-500 text-white border-green-600";
  }
  return "bg-gray-500 text-white border-gray-600";
};

export function ValidationResultItem({
  result,
  onSelect,
  onPageSelect,
  onOpenInMap,
}: ValidationResultItemProps) {
  console.log("ValidationResultItem result:", result);

  if (!result || !result.validation_result) {
    console.error("ValidationResultItem: Invalid result object", result);
    return null;
  }
  return (
    <AccordionItem
      value={result.document_number}
      className="border rounded-lg mb-3 px-4 py-2"
    >
      <AccordionTrigger className="hover:no-underline" onClick={onSelect}>
        <div className="flex items-center justify-between w-full pr-4">
          <div className="flex flex-col items-start gap-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-base">
                {result.document_number}
              </span>
              <Badge
                className={`text-sm px-3 py-1 ${result.match
                  ? "bg-green-500 text-white border-green-600"
                  : "bg-red-500 text-white border-red-600"
                  }`}
              >
                {result.match ? "MATCH" : "REQUIRES MANUAL VERIFICATION"}
              </Badge>
            </div>
            <span className="text-sm text-muted-foreground">
              {result.validation_result.match_count || 0} /{" "}
              {result.validation_result.comparisons?.length || 0} fields matched
            </span>
            {result.validation_result.requires_extra_scrutiny && (
              <div className="flex items-center gap-1.5 mt-1 px-2 py-0.5 bg-amber-50 border border-amber-200 rounded-md text-[10px] text-amber-800 font-bold uppercase tracking-wider animate-pulse">
                <AlertCircle className="w-3 h-3" />
                Extra Scrutiny Required
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 pr-4">
            {onOpenInMap && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenInMap(result.document_number);
                }}
                className="flex items-center gap-1 px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-[10px] font-bold rounded-lg transition-all border border-primary/20 shadow-sm"
              >
                <MapPin className="w-3.5 h-3.5" />
                VIEW ON MAP
              </button>
            )}
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent>
        <div className="space-y-4 pt-3">
          {result.validation_result.requires_extra_scrutiny && (
            <div className="p-4 rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border-2 border-amber-200 shadow-sm space-y-2">
              <div className="flex items-center gap-2 text-amber-800 font-bold">
                <ShieldCheck className="w-5 h-5" />
                LEGAL HEIR SCRUTINY ALERT
              </div>
              <p className="text-sm text-amber-900 leading-relaxed font-medium">
                {result.validation_result.scrutiny_reason || "This document involves a family transfer (Settlement/Partition) which requires verification of Legal Heir Certificates and Death Certificates."}
              </p>
            </div>
          )}
          <TrustabilityScore
            score={result.validation_result.trustability_score}
          />
          {(result.validation_result.comparisons || [])
            .map((comparison, compIndex) => {
              // Strict logic: Only "MATCHED" is green. Everything else is red/warning.
              const isMatched =
                comparison.status.includes("MATCHED") &&
                !comparison.status.includes("NOT");

              return (
                <div
                  key={compIndex}
                  className={`p-4 rounded-lg border-2 ${isMatched
                    ? "bg-green-50 border-green-200"
                    : "bg-red-50 border-red-200"
                    } relative`}
                >
                  {/* Removed Plus icon as it might be confusing if we treat it as non-match */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex flex-col gap-1">
                      <span className="font-semibold text-base">
                        {comparison.field}
                      </span>
                      {comparison.page_number && (() => {
                        // Surfaces the AI's source citation. Clicking jumps the
                        // PDF iframe to this page so the lawyer sees the exact
                        // place the value was extracted from. Styled as a
                        // primary-coloured pill so it reads as an action, not
                        // a passive label.
                        const m = comparison.page_number?.match(/\d+/);
                        const pg = m ? Math.max(1, parseInt(m[0])) : null;
                        if (pg === null) return null;
                        return (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onPageSelect(pg);
                            }}
                            className="text-[10px] bg-primary/10 hover:bg-primary/20 active:bg-primary/30 text-primary border border-primary/30 px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 font-bold w-fit shadow-sm hover:shadow group"
                            title="Open the source PDF at this page"
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>Source · Page {pg}</span>
                            <span className="opacity-0 group-hover:opacity-100 transition-opacity text-[8px] uppercase tracking-wider">jump</span>
                          </button>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-2">
                      {isMatched ? (
                        <CheckCircle2 className="w-5 h-5 text-green-600" />
                      ) : (
                        <AlertCircle className="w-5 h-5 text-red-600" />
                      )}
                      <Badge
                        className={`text-sm px-2 py-1 ${isMatched
                          ? "bg-green-500 text-white border-green-600"
                          : "bg-red-500 text-white border-red-600"
                          }`}
                      >
                        {comparison.status}
                      </Badge>
                    </div>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="text-muted-foreground font-medium">
                        EC Value:{" "}
                      </span>
                      <span className="font-semibold">{comparison.ec_value}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground font-medium">
                        Metadata Value:{" "}
                      </span>
                      <span className="font-semibold">
                        {comparison.metadata_value}
                      </span>
                    </div>
                    <div className="pt-2 text-muted-foreground italic border-t border-border/50">
                      {comparison.reason}
                    </div>
                  </div>
                </div>
              );
            })}
          {result.validation_result.reason_for_failure &&
            result.validation_result.reason_for_failure !==
            "All fields consistent" && (
              <div className="p-3 rounded-lg bg-red-100 border-2 border-red-300">
                <span className="text-sm text-red-700 font-semibold">
                  Reason: {result.validation_result.reason_for_failure}
                </span>
              </div>
            )}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Compact row + detail components used by the redesigned Document Analysis
 * tab. The legacy `ValidationResultItem` above is kept for any other caller
 * that imports it; new layouts should prefer `DocumentRow` + `DocumentDetail`.
 * ────────────────────────────────────────────────────────────────────────── */

const trustChipStyle = (score?: number | null) => {
  if (score == null) return "bg-slate-100 text-slate-500 border-slate-200";
  if (score === 100) return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (score >= 95) return "bg-green-50 text-green-700 border-green-200";
  if (score >= 80) return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-red-50 text-red-700 border-red-200";
};

interface DocumentRowProps {
  result: ResultItem;
  isSelected: boolean;
  onSelect: () => void;
  onOpenInMap?: (docNo: string) => void;
}

export function DocumentRow({ result, isSelected, onSelect, onOpenInMap }: DocumentRowProps) {
  if (!result?.validation_result) return null;
  const vr = result.validation_result;
  const total = vr.comparisons?.length || 0;
  const matched = vr.match_count || 0;
  const ratio = total > 0 ? Math.round((matched / total) * 100) : 0;
  const trust = vr.trustability_score;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full text-left rounded-xl border transition-all relative overflow-hidden",
        "px-3 py-2.5 group",
        isSelected
          ? "border-brand-navy/40 bg-brand-blue-50/70 shadow-sm ring-1 ring-brand-navy/10"
          : "border-slate-200 bg-white hover:border-brand-navy/30 hover:bg-slate-50/60",
      )}
    >
      {isSelected && (
        <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-gradient-to-b from-brand-navy to-brand-navy-500" />
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-brand-navy/70 shrink-0" />
            <span className="font-mono text-xs font-bold text-slate-900 truncate" title={result.document_number}>
              {result.document_number}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <Badge
              className={cn(
                "text-[9px] h-4 px-1.5 font-extrabold uppercase tracking-wider border-0",
                result.match ? "bg-emerald-500 text-white" : "bg-red-500 text-white",
              )}
            >
              {result.match ? "Match" : "Review"}
            </Badge>
            {trust != null && (
              <Badge
                variant="outline"
                className={cn("text-[9px] h-4 px-1.5 font-bold border", trustChipStyle(trust))}
              >
                {trust}%
              </Badge>
            )}
            {vr.requires_extra_scrutiny && (
              <Badge className="text-[9px] h-4 px-1.5 bg-amber-100 text-amber-800 border-0 font-bold uppercase tracking-wider gap-0.5">
                <AlertCircle className="w-2.5 h-2.5" /> Scrutiny
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              ratio >= 95 ? "bg-emerald-500" : ratio >= 80 ? "bg-amber-500" : "bg-red-500",
            )}
            style={{ width: `${ratio}%` }}
          />
        </div>
        <span className="text-[10px] text-slate-500 font-mono shrink-0">
          {matched}/{total}
        </span>
      </div>

      {onOpenInMap && (
        <div className="mt-2 flex items-center justify-end">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onOpenInMap(result.document_number);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onOpenInMap(result.document_number);
              }
            }}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider bg-white border border-brand-navy/20 text-brand-navy hover:bg-brand-blue-50 transition-colors cursor-pointer"
          >
            <MapPin className="w-2.5 h-2.5" /> Map
          </span>
        </div>
      )}
    </button>
  );
}

interface DocumentDetailProps {
  result: ResultItem | undefined | null;
  onPageSelect: (page: number) => void;
}

export function DocumentDetail({ result, onPageSelect }: DocumentDetailProps) {
  if (!result || !result.validation_result) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center text-slate-400 px-6">
        <div className="w-12 h-12 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center mb-3">
          <FileText className="w-5 h-5 text-slate-300" />
        </div>
        <p className="text-sm font-bold text-slate-500">Select a document</p>
        <p className="text-[11px] mt-1 max-w-[220px]">
          Pick a deed on the left to see the AI's field-by-field forensic comparison.
        </p>
      </div>
    );
  }

  const vr = result.validation_result;
  const total = vr.comparisons?.length || 0;
  const matched = vr.match_count || 0;
  const trust = vr.trustability_score;
  const ratio = total > 0 ? Math.round((matched / total) * 100) : 0;

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-brand-blue-50/60 via-white to-white shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
              Forensic Verification
            </p>
            <p className="font-display font-extrabold text-base text-slate-900 truncate font-mono">
              {result.document_number}
            </p>
          </div>
          <Badge
            className={cn(
              "text-[10px] h-5 px-2 font-extrabold uppercase tracking-wider border-0",
              result.match ? "bg-emerald-500 text-white" : "bg-red-500 text-white",
            )}
          >
            {result.match ? "Matched" : "Manual review"}
          </Badge>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-3">
          <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-1.5">
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Fields</p>
            <p className="text-sm font-extrabold text-slate-900 font-mono leading-none mt-0.5">
              {matched}/{total}
            </p>
          </div>
          <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-1.5">
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Match</p>
            <p className="text-sm font-extrabold text-slate-900 font-mono leading-none mt-0.5">
              {ratio}%
            </p>
          </div>
          <div className={cn("rounded-lg border px-2.5 py-1.5", trustChipStyle(trust))}>
            <p className="text-[9px] font-bold uppercase tracking-widest opacity-70">Trust</p>
            <p className="text-sm font-extrabold font-mono leading-none mt-0.5">
              {trust != null ? `${trust}%` : "—"}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-2">
        {vr.requires_extra_scrutiny && (
          <div className="rounded-lg bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 p-3">
            <div className="flex items-center gap-1.5 text-amber-800 font-extrabold text-[11px] uppercase tracking-wider">
              <ShieldCheck className="w-3.5 h-3.5" />
              Legal heir scrutiny
            </div>
            <p className="text-[11px] text-amber-900 leading-relaxed mt-1">
              {vr.scrutiny_reason ||
                "This document involves a family transfer (Settlement/Partition) which requires verification of Legal Heir Certificates and Death Certificates."}
            </p>
          </div>
        )}

        {(vr.comparisons || []).map((comparison, i) => {
          const isMatched =
            comparison.status.includes("MATCHED") && !comparison.status.includes("NOT");
          const pageMatch = comparison.page_number?.match(/\d+/);
          const pg = pageMatch ? Math.max(1, parseInt(pageMatch[0])) : null;

          return (
            <div
              key={i}
              className={cn(
                "rounded-lg border p-3 transition-all",
                isMatched
                  ? "bg-emerald-50/40 border-emerald-200"
                  : "bg-red-50/40 border-red-200",
              )}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-extrabold uppercase tracking-wider text-slate-900">
                    {comparison.field}
                  </p>
                  {pg !== null && (
                    <button
                      onClick={() => onPageSelect(pg)}
                      className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-brand-navy/10 text-brand-navy hover:bg-brand-navy/20 transition-colors"
                      title={`Open page ${pg}`}
                    >
                      <ExternalLink className="w-2.5 h-2.5" /> Source · p{pg}
                    </button>
                  )}
                </div>
                <Badge
                  className={cn(
                    "text-[9px] h-4 px-1.5 font-extrabold uppercase tracking-wider border-0 shrink-0",
                    isMatched ? "bg-emerald-500 text-white" : "bg-red-500 text-white",
                  )}
                >
                  {comparison.status}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-md bg-white/70 border border-slate-200/70 px-2 py-1.5 min-w-0">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">EC</p>
                  <p className="font-semibold text-slate-800 truncate" title={comparison.ec_value}>
                    {comparison.ec_value || "—"}
                  </p>
                </div>
                <div className="rounded-md bg-white/70 border border-slate-200/70 px-2 py-1.5 min-w-0">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Metadata</p>
                  <p className="font-semibold text-slate-800 truncate" title={comparison.metadata_value}>
                    {comparison.metadata_value || "—"}
                  </p>
                </div>
              </div>

              {comparison.reason && (
                <p className="mt-2 text-[10px] italic text-slate-500 leading-snug border-t border-slate-200/70 pt-1.5">
                  {comparison.reason}
                </p>
              )}
            </div>
          );
        })}

        {vr.reason_for_failure && vr.reason_for_failure !== "All fields consistent" && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-2.5">
            <p className="text-[11px] font-bold text-red-700">
              <span className="uppercase tracking-wider">Reason · </span>
              <span className="font-medium">{vr.reason_for_failure}</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
