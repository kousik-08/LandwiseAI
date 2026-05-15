import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, AlertCircle, ShieldCheck, MapPin, ExternalLink } from "lucide-react";
import { TrustabilityScore } from "./TrustabilityScore";

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
