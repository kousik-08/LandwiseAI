import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { landwiseApi } from "@/lib/landwise-api";
import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck,
  ShieldX,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Sparkles,
  CircleAlert,
  Calculator,
  FileText,
  Layers,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";

// ─── Types ──────────────────────────────────────────────────────────────────

interface RiskFactor {
  label: string;
  contribution: number;
  max: number;
  polarity: "positive" | "negative";
  detail: string;
  value_display: string;
}

interface TrustabilityBreakdown {
  raw_score: number;
  max_possible: number;
  points_earned: number;
  calculation: string;
}

interface DocumentDetail {
  doc_no: string;
  nature: string;
  match: boolean;
  trustability_score: number;
  trustability_breakdown?: TrustabilityBreakdown;
  validation_points: number;
  total_doc_contribution: number;
  requires_scrutiny: boolean;
  scrutiny_penalty: number;
  scrutiny_reason?: string;
  mismatches: string[];
  status: "PASS" | "FAIL" | "SCRUTINY";
}

interface GapDetail {
  start_year: number;
  end_year: number;
  gap_years: number;
  risk: "HIGH" | "MEDIUM";
  adjacent_documents: string[];
}

interface RiskScoreData {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  recommendation: string;
  ai_summary: string;
  ai_detailed_summary?: string;
  factors: RiskFactor[];
  metadata: {
    total_docs: number;
    passed_docs: number;
    failed_docs: number;
    avg_trustability: number;
    scrutiny_doc_count: number;
    lis_pendens_count: number;
    restricted_land_count: number;
    gap_count: number;
    nature_types: string[];
  };
  flags: {
    lis_pendens: any[];
    restricted_lands: any[];
    encumbrance_gaps: any[];
    scrutiny_docs: { doc_no: string; reason: string }[];
  };
  document_details?: DocumentDetail[];
  gap_details?: GapDetail[];
  request_id: string;
}

// ─── Factor Bar ───────────────────────────────────────────────────────────

function FactorBar({ factor, idx }: { factor: RiskFactor; idx: number }) {
  const isNeg = factor.polarity === "negative";
  const pct = Math.abs(
    (factor.contribution / (isNeg ? -factor.max : factor.max)) * 100,
  );
  const Icon = isNeg ? TrendingDown : TrendingUp;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: idx * 0.04, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-start gap-3 py-2.5 border-b border-slate-50 last:border-0 group"
    >
      <div
        className={cn(
          "mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-transform group-hover:scale-110",
          isNeg
            ? "bg-gradient-to-br from-red-50 to-rose-50 border border-red-100"
            : "bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-100",
        )}
      >
        <Icon className={cn("w-3.5 h-3.5", isNeg ? "text-red-500" : "text-emerald-500")} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-bold text-slate-700 truncate">
            {factor.label}
          </span>
          <span
            className={cn(
              "text-[10px] font-display font-extrabold ml-2 shrink-0 tabular-nums",
              isNeg ? "text-red-600" : "text-emerald-600",
            )}
          >
            {isNeg ? `−${Math.abs(factor.contribution)}` : `+${factor.contribution}`} pts
          </span>
        </div>
        <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ delay: 0.1 + idx * 0.04, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "h-full rounded-full bg-gradient-to-r",
              isNeg ? "from-red-400 to-rose-500" : "from-emerald-400 to-emerald-500",
            )}
          />
        </div>
        <p className="text-[9px] text-slate-400 mt-1 flex items-center justify-between gap-2">
          <span className="truncate">{factor.detail}</span>
          <span className="font-mono font-bold ml-1 shrink-0 text-slate-500">
            {factor.value_display}
          </span>
        </p>
      </div>
    </motion.div>
  );
}

// ─── Flag Section ─────────────────────────────────────────────────────────

function FlagSection({
  title,
  items,
  variant,
}: {
  title: string;
  items: {
    doc_no?: string;
    nature?: string;
    start_year?: number;
    end_year?: number;
    gap_years?: number;
    reason?: string;
  }[];
  variant: "red" | "amber" | "blue";
}) {
  if (!items.length) return null;
  const cls = {
    red: {
      bg: "bg-gradient-to-br from-red-50 via-rose-50/50 to-red-50/30",
      border: "border-red-200/70",
      text: "text-red-700",
      dot: "bg-red-500",
    },
    amber: {
      bg: "bg-gradient-to-br from-amber-50 via-orange-50/50 to-amber-50/30",
      border: "border-amber-200/70",
      text: "text-amber-700",
      dot: "bg-amber-500",
    },
    blue: {
      bg: "bg-gradient-to-br from-blue-50 via-indigo-50/50 to-blue-50/30",
      border: "border-blue-200/70",
      text: "text-blue-700",
      dot: "bg-blue-500",
    },
  }[variant];

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className={cn("rounded-xl border p-3 space-y-1.5", cls.bg, cls.border)}
    >
      <div className="flex items-center gap-2">
        <span className={cn("w-1.5 h-1.5 rounded-full animate-pulse-glow", cls.dot)} />
        <CircleAlert className={cn("w-3.5 h-3.5 shrink-0", cls.text)} />
        <span className={cn("text-[10px] font-bold uppercase tracking-[0.18em]", cls.text)}>
          {title}
        </span>
      </div>
      <div className="space-y-1">
        {items.slice(0, 5).map((item, i) => (
          <p key={i} className="text-[10px] font-medium leading-snug text-slate-700">
            {item.doc_no && <span className="font-bold">Doc: {item.doc_no} — </span>}
            {item.nature && `${item.nature}`}
            {item.start_year &&
              `${item.start_year}–${item.end_year} (${item.gap_years} yr gap)`}
            {item.reason && `${item.reason}`}
          </p>
        ))}
        {items.length > 5 && (
          <p className="text-[9px] italic opacity-70 text-slate-500">
            +{items.length - 5} more…
          </p>
        )}
      </div>
    </motion.div>
  );
}

// ─── Document Breakdown status helpers ────────────────────────────────────

function getStatusIcon(status: string) {
  switch (status) {
    case "PASS":
      return <ShieldCheck className="w-4 h-4 text-emerald-500" />;
    case "SCRUTINY":
      return <AlertTriangle className="w-4 h-4 text-amber-500" />;
    case "FAIL":
      return <ShieldX className="w-4 h-4 text-red-500" />;
    default:
      return <CircleAlert className="w-4 h-4 text-slate-400" />;
  }
}

function getStatusClass(status: string) {
  switch (status) {
    case "PASS":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "SCRUTINY":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "FAIL":
      return "bg-red-50 text-red-700 border-red-200";
    default:
      return "bg-slate-50 text-slate-600 border-slate-200";
  }
}

// ─── Document Breakdown (dropdown-driven) ─────────────────────────────────
// Instead of one long always-on table, the user picks a document number from a
// searchable dropdown and only then sees that single document's full breakdown
// (Nature · Validation · Trustability · Points · Issues · Status). Nothing is
// shown until a document is selected.

function DocFieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 border-b border-slate-50 last:border-0">
      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.14em] shrink-0 pt-0.5">
        {label}
      </span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

function DocumentBreakdownDetail({ doc }: { doc: DocumentDetail }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl border border-slate-100 bg-white overflow-hidden"
    >
      {/* Header: document number + status */}
      <div className="px-4 py-3 bg-gradient-to-r from-slate-50 via-indigo-50/30 to-slate-50 border-b border-slate-100 flex items-center justify-between gap-3">
        <span className="font-mono font-bold text-slate-800 text-sm truncate">
          {doc.doc_no}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {getStatusIcon(doc.status)}
          <Badge className={cn("text-[9px] h-5 px-1.5 border font-bold", getStatusClass(doc.status))}>
            {doc.status}
          </Badge>
        </div>
      </div>

      <div className="px-4 py-1">
        <DocFieldRow label="Nature">
          <span className="text-[11px] text-slate-600">{doc.nature || "—"}</span>
        </DocFieldRow>

        <DocFieldRow label="Validation">
          {doc.match ? (
            <span className="text-emerald-600 font-display font-extrabold tabular-nums text-[12px]">
              +{doc.validation_points} pts
            </span>
          ) : (
            <span className="text-red-500 font-display font-extrabold tabular-nums text-[12px]">
              0 pts
            </span>
          )}
        </DocFieldRow>

        <DocFieldRow label="Trustability">
          <div className="flex items-center justify-end gap-1.5">
            <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full bg-gradient-to-r",
                  doc.trustability_score >= 80
                    ? "from-emerald-400 to-emerald-500"
                    : doc.trustability_score >= 60
                      ? "from-amber-400 to-orange-500"
                      : "from-red-400 to-rose-500",
                )}
                style={{ width: `${doc.trustability_score}%` }}
              />
            </div>
            <span className="font-mono font-bold text-slate-700 text-[11px] tabular-nums">
              {doc.trustability_score}
            </span>
          </div>
          {doc.trustability_breakdown && (
            <div className="text-[9px] text-emerald-600 mt-0.5 font-bold">
              +{doc.trustability_breakdown.points_earned} pts
            </div>
          )}
        </DocFieldRow>

        <DocFieldRow label="Points">
          <span
            className={cn(
              "font-display font-extrabold tabular-nums text-[12px]",
              doc.total_doc_contribution >= 0 ? "text-emerald-600" : "text-red-500",
            )}
          >
            {doc.total_doc_contribution > 0 ? "+" : ""}
            {doc.total_doc_contribution}
          </span>
          {doc.scrutiny_penalty < 0 && (
            <div className="text-[9px] text-red-500 font-bold">{doc.scrutiny_penalty} pts</div>
          )}
        </DocFieldRow>

        <DocFieldRow label="Issues">
          {doc.mismatches.length > 0 ? (
            <div className="space-y-0.5">
              {doc.mismatches.map((mismatch, j) => (
                <p key={j} className="text-red-600 text-[10px] leading-snug">
                  • {mismatch}
                </p>
              ))}
            </div>
          ) : doc.requires_scrutiny ? (
            <p className="text-amber-600 text-[10px]">⚠ {doc.scrutiny_reason || "Requires scrutiny"}</p>
          ) : (
            <p className="text-emerald-600 text-[10px]">✓ No issues</p>
          )}
        </DocFieldRow>
      </div>

      {/* Scoring Legend */}
      <div className="p-3 bg-gradient-to-r from-slate-50 via-indigo-50/30 to-slate-50 border-t border-slate-100 text-[10px] text-slate-600">
        <div className="font-bold mb-1.5 text-slate-700 flex items-center gap-1.5">
          <Calculator className="w-3 h-3 text-indigo-500" />
          How Points Are Calculated:
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          <div>• <b>Validation:</b> 28 pts ÷ total docs <span className="text-emerald-600 font-bold">— if passed</span></div>
          <div>• <b>Trustability:</b> (trust_score/100) × (17 ÷ total docs) <span className="text-emerald-600 font-bold">— if passed</span></div>
          <div>• <b>Scrutiny Penalty:</b> -7 pts per flagged document</div>
          <div>• <b>Base Score:</b> 45 + sum of all document contributions</div>
        </div>
        <div className="mt-2 pt-2 border-t border-slate-200/70 text-[9px] text-slate-500 italic flex items-start gap-1.5">
          <CircleAlert className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />
          <span>Failed documents earn <b>0 points</b> regardless of OCR confidence — a high trust score on a mismatched deed cannot improve the title health.</span>
        </div>
      </div>
    </motion.div>
  );
}

function DocumentBreakdownSelector({ documents }: { documents: DocumentDetail[] }) {
  if (!documents.length) return null;

  // No document is selected by default — the breakdown stays hidden until the
  // user picks a document number from the dropdown.
  const [selectedDocNo, setSelectedDocNo] = useState<string>("");
  const docNos = documents.map((d) => d.doc_no);
  const selectedDoc = documents.find((d) => d.doc_no === selectedDocNo) ?? null;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-5 space-y-4">
      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.16em] flex items-center gap-1.5">
          <FileText className="w-3 h-3 text-indigo-500" />
          Select a document number
        </label>
        <SearchableSelect
          options={docNos}
          value={selectedDocNo}
          onChange={setSelectedDocNo}
          placeholder="Choose a document to view its breakdown…"
          searchPlaceholder="Search document number…"
          emptyText="No matching document."
        />
      </div>

      <AnimatePresence mode="wait">
        {selectedDoc ? (
          <DocumentBreakdownDetail key={selectedDoc.doc_no} doc={selectedDoc} />
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-8 text-center"
          >
            <Layers className="w-6 h-6 text-slate-300 mx-auto mb-2" />
            <p className="text-[11px] text-slate-400 font-medium">
              Pick a document number above to see its nature, validation,
              trustability, points, issues and status.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Gap Visualization ────────────────────────────────────────────────────

function GapVisualization({ gaps }: { gaps: GapDetail[] }) {
  if (!gaps.length) return null;
  const sortedGaps = [...gaps].sort((a, b) => a.start_year - b.start_year);

  return (
    <div className="space-y-3">
      {sortedGaps.map((gap, i) => {
        const high = gap.risk === "HIGH";
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "group rounded-2xl p-4 sm:p-5 border transition-all duration-300 hover:-translate-y-0.5",
              high
                ? "bg-gradient-to-br from-red-50/70 via-rose-50/20 to-white border-red-100 hover:shadow-[0_14px_34px_-14px_rgba(225,29,72,0.35)]"
                : "bg-gradient-to-br from-amber-50/70 via-orange-50/20 to-white border-amber-100 hover:shadow-[0_14px_34px_-14px_rgba(217,119,6,0.3)]",
            )}
          >
            <div className="flex items-center justify-between mb-3.5 flex-wrap gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className={cn(
                    "w-2 h-2 rounded-full animate-pulse-glow ring-4 shrink-0",
                    high ? "bg-red-500 ring-red-100" : "bg-amber-500 ring-amber-100",
                  )}
                />
                <span className="font-display font-extrabold text-slate-800 text-[13px] tracking-tight">
                  Gap {i + 1}
                </span>
                <span className="text-slate-300">·</span>
                <span className="font-mono text-[12px] text-slate-500 tabular-nums truncate">
                  {gap.start_year} → {gap.end_year}
                </span>
              </div>
              <Badge
                className={cn(
                  "text-[9px] h-5 px-2 font-bold uppercase tracking-[0.08em] inline-flex items-center gap-1.5 border shrink-0",
                  high
                    ? "bg-red-100/70 text-red-700 border-red-200"
                    : "bg-amber-100/70 text-amber-700 border-amber-200",
                )}
              >
                {high ? "High" : "Medium"} · {gap.gap_years} yrs
              </Badge>
            </div>

            {/* Timeline visual — anchored years (certain) flank the hazard-striped
                silent period in the middle (the unknown stretch). */}
            <div className="relative h-11 rounded-xl overflow-hidden mb-3 ring-1 ring-slate-200/70 bg-white">
              {/* Anchored year markers */}
              <div className="absolute left-0 top-0 bottom-0 w-[18%] bg-slate-50 border-r border-slate-200/60 flex items-center justify-center text-[10px] text-slate-700 font-mono font-bold tabular-nums">
                {gap.start_year}
              </div>
              <div className="absolute right-0 top-0 bottom-0 w-[18%] bg-slate-50 border-l border-slate-200/60 flex items-center justify-center text-[10px] text-slate-700 font-mono font-bold tabular-nums">
                {gap.end_year}
              </div>
              {/* Silent period */}
              <motion.div
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.2 + i * 0.05, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  left: "18%",
                  right: "18%",
                  transformOrigin: "left",
                  backgroundImage: high
                    ? "repeating-linear-gradient(45deg, rgba(254,202,202,0.95) 0 10px, rgba(252,165,165,0.55) 10px 20px)"
                    : "repeating-linear-gradient(45deg, rgba(253,230,138,0.95) 0 10px, rgba(252,211,77,0.55) 10px 20px)",
                }}
                className="absolute top-0 bottom-0 flex items-center justify-center"
              >
                <span
                  className={cn(
                    "text-[10px] font-bold tracking-tight px-2 py-0.5 rounded-md bg-white/70 backdrop-blur-sm",
                    high ? "text-red-800" : "text-amber-800",
                  )}
                >
                  Silent period · {gap.gap_years} yrs
                </span>
              </motion.div>
            </div>

            {gap.adjacent_documents.length > 0 && (
              <div className="flex items-center gap-2 text-[10px] text-slate-500 flex-wrap">
                <span className="font-bold uppercase tracking-[0.14em] text-slate-400">Near docs</span>
                {gap.adjacent_documents.map((doc, j) => (
                  <Badge
                    key={j}
                    variant="outline"
                    className="text-[9px] h-5 px-1.5 bg-white border-slate-200 font-mono text-slate-600 hover:border-slate-300 transition-colors"
                  >
                    {doc}
                  </Badge>
                ))}
              </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────

interface RiskScoreCardProps {
  requestId: string;
  // Jump to the Document Analysis tab focused on a specific document.
  onOpenDocAnalysis?: (docNo: string) => void;
}

export function RiskScoreCard({ requestId, onOpenDocAnalysis }: RiskScoreCardProps) {
  // Which detail section is currently shown. The Title Health Score card itself
  // lives on the Overview tab, so this tab is purely the drill-down sections,
  // surfaced one at a time as tabs instead of a long stack of collapsibles.
  const [activeTab, setActiveTab] = useState<string>("");

  // Routed through React Query (same ['risk-score', requestId] key the
  // dashboard uses) so the cockpit endpoint's setQueryData fully dedupes
  // this fetch. The previous raw useEffect+fetch couldn't reuse the
  // parent's cache and always triggered a duplicate network call on
  // every Risks-tab open.
  const { data: queryData, isLoading: loading, error: queryError } = useQuery<any>({
    queryKey: ['risk-score', requestId],
    queryFn: () => landwiseApi.getRiskScore(requestId),
    enabled: !!requestId,
  });
  const data: RiskScoreData | null = queryData?.data ?? null;
  const error: string | null = queryError
    ? (queryError instanceof Error ? queryError.message : "Failed to load risk score")
    : null;

  // Tab keys that actually have data to show — empty sections are hidden, so the
  // tab bar shape follows the parcel. The push order here IS the left-to-right
  // tab order (Score Factors → Gap Analysis → Risk Flags → Needs Attention →
  // Document Breakdown → Detailed Assessment) and the first available key is the
  // default-selected tab.
  const availableKeys = useMemo<string[]>(() => {
    if (!data) return [];
    const keys: string[] = [];
    if (data.factors.length > 0) keys.push("factors");
    if ((data.gap_details?.length ?? 0) > 0) keys.push("gaps");
    if (
      data.flags.lis_pendens.length > 0 ||
      data.flags.restricted_lands.length > 0 ||
      data.flags.encumbrance_gaps.length > 0 ||
      data.flags.scrutiny_docs.length > 0
    )
      keys.push("flags");
    if ((data.document_details ?? []).some((d) => !d.match)) keys.push("attention");
    if ((data.document_details?.length ?? 0) > 0) keys.push("documents");
    if (data.ai_detailed_summary) keys.push("detailed");
    return keys;
  }, [data]);

  // Keep the selected tab valid as data loads / changes; default to the first
  // (left-most) available tab.
  useEffect(() => {
    if (!availableKeys.length) return;
    if (!activeTab || !availableKeys.includes(activeTab)) {
      setActiveTab(availableKeys[0]);
    }
  }, [availableKeys, activeTab]);

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center py-20 space-y-5 bg-gradient-to-br from-white via-indigo-50/40 to-white rounded-2xl sm:rounded-3xl border border-slate-200 relative overflow-hidden"
      >
        <div className="pointer-events-none absolute inset-0 opacity-50">
          <div className="absolute -top-32 -left-20 w-72 h-72 rounded-full bg-gradient-to-br from-indigo-200/40 to-blue-200/40 blur-3xl animate-blob-slow" />
          <div className="absolute -bottom-32 -right-20 w-72 h-72 rounded-full bg-gradient-to-br from-violet-200/30 to-indigo-200/30 blur-3xl animate-blob" />
        </div>
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-400 to-blue-500 blur-2xl opacity-40 animate-pulse-glow" />
          <div className="relative w-20 h-20 border-4 border-indigo-100 border-t-indigo-500 rounded-full animate-spin" />
          <Sparkles className="w-7 h-7 text-indigo-500 absolute inset-0 m-auto animate-pulse-subtle" />
        </div>
        <p className="text-sm font-display font-bold text-slate-600 uppercase tracking-[0.22em]">
          Computing Title Health Score…
        </p>
      </motion.div>
    );
  }

  if (error) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="p-8 text-center bg-gradient-to-br from-red-50 via-rose-50/40 to-red-50/30 border-2 border-dashed border-red-200 rounded-2xl sm:rounded-3xl"
      >
        <div className="relative w-16 h-16 mx-auto mb-4">
          <div className="absolute inset-0 bg-red-300 rounded-full blur-2xl opacity-30" />
          <div className="relative w-16 h-16 bg-white rounded-2xl flex items-center justify-center shadow-sm border border-red-100">
            <ShieldX className="w-9 h-9 text-red-400" />
          </div>
        </div>
        <h3 className="text-lg font-display font-extrabold text-red-800">Risk Score Unavailable</h3>
        <p className="text-sm text-red-600 mt-1 font-medium">{error}</p>
      </motion.div>
    );
  }

  if (!data) return null;

  const totalFlagCount =
    data.flags.lis_pendens.length +
    data.flags.restricted_lands.length +
    data.flags.encumbrance_gaps.length +
    data.flags.scrutiny_docs.length;

  // Documents that did NOT pass validation — the "16/20 passed" leaves these
  // behind (matches metadata.failed_docs). We key off `match` (not status)
  // because a not-passed doc that ALSO needs scrutiny is tagged "SCRUTINY",
  // and we still want it surfaced here. Each carries its mismatch reasons; we
  // link into the Document Analysis tab for the full per-field breakdown.
  const failedDocs = (data.document_details ?? []).filter((d) => !d.match);
  const docDetails = data.document_details ?? [];
  const gapDetails = data.gap_details ?? [];

  // ── Tab definitions ──────────────────────────────────────────────────
  // The Title Health Score card itself lives on Overview; here each drill-down
  // section is a tab. Only tabs whose `key` is in `availableKeys` are shown.
  interface TabDef {
    key: string;
    label: string;
    icon: React.ReactNode;
    iconBg: string;
    bar: string;
    badge?: React.ReactNode;
    content: React.ReactNode;
  }

  const allTabs: TabDef[] = [
    {
      key: "attention",
      label: "Needs Attention",
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
      iconBg: "from-red-500 to-rose-600",
      bar: "bg-gradient-to-r from-red-500 to-rose-500",
      badge: (
        <Badge className="bg-red-50 text-red-700 border-red-200 hover:bg-red-50 text-[9px] h-5 px-2 font-bold inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-glow" />
          {failedDocs.length}
        </Badge>
      ),
      content: (
        <div className="bg-white rounded-2xl border border-red-200 shadow-sm overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-gradient-to-r from-red-50 via-rose-50/50 to-red-50/30 border-b border-red-100">
            <p className="text-[11px] text-slate-500 font-medium">
              {failedDocs.length} of {data.metadata.total_docs} document{failedDocs.length === 1 ? "" : "s"} did not pass validation
            </p>
          </div>
          <div className="divide-y divide-slate-100">
            {failedDocs.map((doc) => (
              <div
                key={doc.doc_no}
                className="px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-start gap-3 hover:bg-red-50/30 transition-colors"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-slate-900 font-mono">{doc.doc_no}</span>
                    {doc.nature && (
                      <Badge variant="outline" className="text-[9px] font-bold uppercase tracking-wide border-slate-200 text-slate-500">
                        {doc.nature}
                      </Badge>
                    )}
                    <Badge className="text-[9px] font-bold uppercase bg-red-100 text-red-700 hover:bg-red-100">Failed</Badge>
                    <span className="text-[10px] font-bold text-slate-400">Trust {doc.trustability_score}%</span>
                  </div>
                  {doc.mismatches && doc.mismatches.length > 0 ? (
                    <ul className="space-y-1">
                      {doc.mismatches.slice(0, 4).map((m, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[11px] text-slate-600 leading-snug">
                          <CircleAlert className="w-3 h-3 text-red-500 mt-0.5 shrink-0" />
                          <span>{m}</span>
                        </li>
                      ))}
                      {doc.mismatches.length > 4 && (
                        <li className="text-[10px] text-slate-400 italic pl-[18px]">
                          +{doc.mismatches.length - 4} more issue{doc.mismatches.length - 4 === 1 ? "" : "s"}
                        </li>
                      )}
                    </ul>
                  ) : (
                    <p className="text-[11px] text-slate-500 italic">
                      {doc.scrutiny_reason || "Did not match the encumbrance record."}
                    </p>
                  )}
                </div>
                {onOpenDocAnalysis && (
                  <button
                    onClick={() => onOpenDocAnalysis(doc.doc_no)}
                    className="self-start shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[10px] font-bold uppercase tracking-wide border border-red-200 text-red-600 bg-white hover:bg-red-50 hover:border-red-300 transition-all"
                    title="Open this document in Document Analysis"
                  >
                    Review
                    <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      key: "flags",
      label: "Risk Flags",
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
      iconBg: "from-red-500 to-rose-600",
      bar: "bg-gradient-to-r from-red-500 via-rose-500 to-orange-500",
      badge: (
        <Badge className="bg-red-50 text-red-700 border-red-200 hover:bg-red-50 text-[9px] h-5 px-2 font-bold inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-glow" />
          {totalFlagCount}
        </Badge>
      ),
      content: (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-5 space-y-2.5">
          <FlagSection title="Lis Pendens / Court Attachments" items={data.flags.lis_pendens} variant="red" />
          <FlagSection title="Panchami / Restricted Lands" items={data.flags.restricted_lands} variant="red" />
          <FlagSection title="Encumbrance Chain Gaps" items={data.flags.encumbrance_gaps} variant="amber" />
          <FlagSection title="Documents Requiring Extra Scrutiny" items={data.flags.scrutiny_docs} variant="blue" />
        </div>
      ),
    },
    {
      key: "factors",
      label: "Score Factors",
      icon: <Calculator className="w-3.5 h-3.5" />,
      iconBg: "from-indigo-500 to-blue-600",
      bar: "bg-gradient-to-r from-indigo-500 via-blue-500 to-violet-500",
      content: (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-5">
          <div className="divide-y divide-slate-50">
            {data.factors.map((f, i) => (
              <FactorBar key={f.label} factor={f} idx={i} />
            ))}
          </div>
        </div>
      ),
    },
    {
      key: "documents",
      label: "Document Breakdown",
      icon: <FileText className="w-3.5 h-3.5" />,
      iconBg: "from-blue-500 to-indigo-600",
      bar: "bg-gradient-to-r from-blue-500 via-indigo-500 to-blue-600",
      badge: (
        <Badge className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-50 text-[9px] h-5 px-2 font-bold inline-flex items-center gap-1.5">
          <Layers className="w-2.5 h-2.5" />
          {docDetails.length}
        </Badge>
      ),
      content: <DocumentBreakdownSelector documents={docDetails} />,
    },
    {
      key: "gaps",
      label: "Gap Analysis",
      icon: <TrendingDown className="w-3.5 h-3.5" />,
      iconBg: "from-amber-500 to-orange-500",
      bar: "bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600",
      badge: (
        <Badge className="bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50 text-[9px] h-5 px-2 font-bold inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse-glow" />
          {gapDetails.length}
        </Badge>
      ),
      content: (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-5">
          <GapVisualization gaps={gapDetails} />
        </div>
      ),
    },
    {
      key: "detailed",
      label: "Detailed Assessment",
      icon: <Sparkles className="w-3.5 h-3.5" />,
      iconBg: "from-violet-500 to-purple-600",
      bar: "bg-gradient-to-r from-violet-500 via-purple-500 to-indigo-500",
      content: (
        <div className="bg-gradient-to-br from-slate-50 to-indigo-50/30 rounded-2xl p-4 sm:p-5 border border-slate-200">
          <pre className="text-[11px] text-slate-700 whitespace-pre-wrap font-mono leading-relaxed">
            {data.ai_detailed_summary}
          </pre>
        </div>
      ),
    },
  ];

  // Order the visible tabs by `availableKeys` (the user-defined order) rather
  // than the `allTabs` declaration order.
  const tabs = availableKeys
    .map((k) => allTabs.find((t) => t.key === k))
    .filter((t): t is TabDef => !!t);

  if (tabs.length === 0) {
    return (
      <div className="p-8 text-center bg-white border border-slate-200 rounded-2xl">
        <p className="text-sm text-slate-500 font-medium">No risk detail available for this analysis yet.</p>
      </div>
    );
  }

  // Resolve the tab to show even before the sync effect runs, so there is no
  // empty first frame.
  const currentKey = availableKeys.includes(activeTab) ? activeTab : availableKeys[0];
  const currentTab = tabs.find((t) => t.key === currentKey) ?? tabs[0];

  return (
    <div className="space-y-4">
      {/* ── Tab selector (wrapping cards — fills the row, never scrolls
          sideways; clicking a card swaps the panel below) ──────────────── */}
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => {
          const active = t.key === currentKey;
          return (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              aria-pressed={active}
              className={cn(
                "group relative grow basis-[160px] min-w-[148px] flex items-center gap-2.5 px-3.5 py-3 rounded-2xl border text-left overflow-hidden transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-1",
                active
                  ? "border-slate-200/60 bg-white shadow-[0_6px_22px_-8px_rgba(79,70,229,0.32)] ring-1 ring-indigo-200/70"
                  : "border-slate-200/80 bg-white/60 hover:border-slate-300 hover:bg-white hover:shadow-sm",
              )}
            >
              {/* Active accent bar (uses each tab's own accent gradient) */}
              <span
                className={cn(
                  "absolute inset-x-0 bottom-0 h-[3px] origin-left transition-transform duration-300 ease-out",
                  t.bar,
                  active ? "scale-x-100" : "scale-x-0",
                )}
              />
              <span
                className={cn(
                  "w-8 h-8 rounded-xl flex items-center justify-center bg-gradient-to-br text-white shrink-0 transition-all duration-200 group-hover:scale-105",
                  t.iconBg,
                  active ? "opacity-100 shadow-sm" : "opacity-70 group-hover:opacity-90",
                )}
              >
                {t.icon}
              </span>
              <span
                className={cn(
                  "flex-1 min-w-0 text-[12.5px] font-bold leading-tight truncate transition-colors",
                  active ? "text-slate-900" : "text-slate-500 group-hover:text-slate-700",
                )}
              >
                {t.label}
              </span>
              {t.badge}
            </button>
          );
        })}
      </div>

      {/* ── Active panel ────────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        <motion.div
          key={currentKey}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          {currentTab.content}
        </motion.div>
      </AnimatePresence>

      {/* ── Nature Types Footer ──────────────────────────────────────── */}
      {data.metadata.nature_types.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="flex flex-wrap gap-1.5 px-1 items-center"
        >
          <span className="text-[9px] text-slate-400 font-bold uppercase tracking-[0.2em] inline-flex items-center gap-1.5">
            <Layers className="w-3 h-3" />
            Document Types:
          </span>
          {data.metadata.nature_types.slice(0, 12).map((n, i) => (
            <motion.div
              key={n}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.32 + i * 0.025, duration: 0.3 }}
            >
              <Badge
                variant="outline"
                className="text-[9px] h-5 px-2 bg-gradient-to-br from-white to-indigo-50/40 text-slate-600 border-slate-200 hover:border-indigo-200 transition-colors font-medium"
              >
                {n}
              </Badge>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
