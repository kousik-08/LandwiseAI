import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { API_BASE_URL } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck,
  ShieldAlert,
  Shield,
  ShieldX,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Gavel,
  ChevronDown,
  Sparkles,
  LandPlot,
  CircleAlert,
  Calculator,
  FileText,
  Activity,
  Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

// ─── Grade Config ──────────────────────────────────────────────────────────

const GRADE_CONFIG = {
  A: {
    text: "text-emerald-600",
    softBg: "from-emerald-50 via-white to-emerald-50/30",
    border: "border-emerald-200",
    glow: "shadow-emerald-300/30",
    ring: "#10b981",
    ringSoft: "#34d399",
    track: "#d1fae5",
    label: "Excellent",
    Icon: ShieldCheck,
    gradient: "from-emerald-500 via-emerald-500 to-teal-600",
    pillBg: "bg-emerald-50",
    accent: "from-emerald-400 via-emerald-500 to-teal-500",
    blob: "from-emerald-200/40 to-teal-200/40",
  },
  B: {
    text: "text-blue-600",
    softBg: "from-blue-50 via-white to-indigo-50/30",
    border: "border-blue-200",
    glow: "shadow-blue-300/30",
    ring: "#3b82f6",
    ringSoft: "#60a5fa",
    track: "#dbeafe",
    label: "Good",
    Icon: ShieldCheck,
    gradient: "from-blue-500 via-indigo-500 to-blue-600",
    pillBg: "bg-blue-50",
    accent: "from-blue-400 via-indigo-500 to-blue-500",
    blob: "from-blue-200/40 to-indigo-200/40",
  },
  C: {
    text: "text-amber-600",
    softBg: "from-amber-50 via-white to-orange-50/30",
    border: "border-amber-200",
    glow: "shadow-amber-300/30",
    ring: "#f59e0b",
    ringSoft: "#fbbf24",
    track: "#fef3c7",
    label: "Moderate Risk",
    Icon: Shield,
    gradient: "from-amber-500 via-orange-500 to-amber-600",
    pillBg: "bg-amber-50",
    accent: "from-amber-400 via-orange-500 to-amber-500",
    blob: "from-amber-200/40 to-orange-200/40",
  },
  D: {
    text: "text-orange-600",
    softBg: "from-orange-50 via-white to-rose-50/30",
    border: "border-orange-200",
    glow: "shadow-orange-300/30",
    ring: "#f97316",
    ringSoft: "#fb923c",
    track: "#ffedd5",
    label: "High Risk",
    Icon: ShieldAlert,
    gradient: "from-orange-500 via-rose-500 to-red-500",
    pillBg: "bg-orange-50",
    accent: "from-orange-400 via-rose-500 to-orange-500",
    blob: "from-orange-200/40 to-rose-200/40",
  },
  F: {
    text: "text-red-600",
    softBg: "from-red-50 via-white to-rose-50/30",
    border: "border-red-200",
    glow: "shadow-red-300/30",
    ring: "#ef4444",
    ringSoft: "#f87171",
    track: "#fee2e2",
    label: "Critical",
    Icon: ShieldX,
    gradient: "from-red-500 via-rose-600 to-red-600",
    pillBg: "bg-red-50",
    accent: "from-red-400 via-rose-500 to-red-500",
    blob: "from-red-200/40 to-rose-200/40",
  },
};

// ─── Animated count-up ────────────────────────────────────────────────────

function useCountUp(target: number, duration = 1100) {
  const [val, setVal] = useState(0);
  useEffect(() => {
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

// ─── Gauge (SVG) ──────────────────────────────────────────────────────────

function GaugeDial({
  score,
  grade,
}: {
  score: number;
  grade: keyof typeof GRADE_CONFIG;
}) {
  const cfg = GRADE_CONFIG[grade];
  const animScore = useCountUp(score, 1300);

  // Half-arc geometry
  const size = 240;
  const stroke = 16;
  const cx = size / 2;
  const cy = size / 2 + 18;
  const radius = (size / 2) - stroke - 4;
  const circumference = Math.PI * radius;
  const dashOffset = circumference - (animScore / 100) * circumference;

  const gradId = `gauge-${grade}`;

  return (
    <div className="relative w-full max-w-[260px] mx-auto">
      <svg viewBox={`0 0 ${size} ${size * 0.78}`} className="w-full h-auto" style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={cfg.ringSoft} />
            <stop offset="100%" stopColor={cfg.ring} />
          </linearGradient>
          <filter id={`glow-${grade}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Track */}
        <path
          d={`M ${stroke + 4} ${cy} A ${radius} ${radius} 0 0 1 ${size - stroke - 4} ${cy}`}
          fill="none"
          stroke={cfg.track}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        {/* Fill */}
        <motion.path
          d={`M ${stroke + 4} ${cy} A ${radius} ${radius} 0 0 1 ${size - stroke - 4} ${cy}`}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: dashOffset }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
          filter={`url(#glow-${grade})`}
        />

        {/* Endpoint dot */}
        <motion.circle
          cx={cx + radius * Math.cos(Math.PI + (animScore / 100) * Math.PI)}
          cy={cy + radius * Math.sin(Math.PI + (animScore / 100) * Math.PI)}
          r={5}
          fill="white"
          stroke={cfg.ring}
          strokeWidth={3}
          initial={{ scale: 0 }}
          animate={{ scale: animScore > 0 ? 1 : 0 }}
          transition={{ delay: 0.6, duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
        />
      </svg>

      {/* Centered score readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pt-4 pointer-events-none">
        <motion.span
          key={animScore}
          initial={{ scale: 0.95, opacity: 0.6 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.2 }}
          className={cn("text-5xl sm:text-6xl font-display font-extrabold tabular-nums tracking-tight", cfg.text)}
        >
          {animScore}
        </motion.span>
        <span className="text-[10px] uppercase tracking-[0.22em] font-bold text-slate-400 mt-1">
          / 100
        </span>
      </div>
    </div>
  );
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

// ─── Document Detail Table ────────────────────────────────────────────────

function DocumentDetailTable({ documents }: { documents: DocumentDetail[] }) {
  if (!documents.length) return null;

  const getStatusIcon = (status: string) => {
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
  };

  const getStatusClass = (status: string) => {
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
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-100">
      <table className="w-full text-[11px] min-w-[680px]">
        <thead>
          <tr className="border-b border-slate-100 bg-gradient-to-r from-slate-50 via-indigo-50/30 to-slate-50">
            <th className="text-left py-2.5 px-3 font-bold text-slate-500 uppercase tracking-[0.14em] text-[10px]">Status</th>
            <th className="text-left py-2.5 px-3 font-bold text-slate-500 uppercase tracking-[0.14em] text-[10px]">Document No.</th>
            <th className="text-left py-2.5 px-3 font-bold text-slate-500 uppercase tracking-[0.14em] text-[10px]">Nature</th>
            <th className="text-center py-2.5 px-3 font-bold text-slate-500 uppercase tracking-[0.14em] text-[10px]">Validation</th>
            <th className="text-center py-2.5 px-3 font-bold text-slate-500 uppercase tracking-[0.14em] text-[10px]">Trustability</th>
            <th className="text-center py-2.5 px-3 font-bold text-slate-500 uppercase tracking-[0.14em] text-[10px]">Points</th>
            <th className="text-left py-2.5 px-3 font-bold text-slate-500 uppercase tracking-[0.14em] text-[10px]">Issues</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc, i) => (
            <motion.tr
              key={i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.025, duration: 0.3 }}
              className="border-b border-slate-50 hover:bg-indigo-50/30 transition-colors"
            >
              <td className="py-2.5 px-3">
                <div className="flex items-center gap-2">
                  {getStatusIcon(doc.status)}
                  <Badge className={cn("text-[9px] h-5 px-1.5 border font-bold", getStatusClass(doc.status))}>
                    {doc.status}
                  </Badge>
                </div>
              </td>
              <td className="py-2.5 px-3 font-mono font-bold text-slate-700">
                {doc.doc_no}
              </td>
              <td className="py-2.5 px-3 text-slate-600">{doc.nature}</td>
              <td className="py-2.5 px-3 text-center">
                {doc.match ? (
                  <div className="text-emerald-600 font-display font-extrabold tabular-nums">+{doc.validation_points}</div>
                ) : (
                  <div className="text-red-500 font-display font-extrabold tabular-nums">0</div>
                )}
                <div className="text-[9px] text-slate-400">pts</div>
              </td>
              <td className="py-2.5 px-3 text-center">
                <div className="flex items-center justify-center gap-1.5">
                  <div className="w-12 h-1.5 bg-slate-100 rounded-full overflow-hidden">
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
                  <span className="font-mono font-bold text-slate-700 text-[10px] tabular-nums">
                    {doc.trustability_score}
                  </span>
                </div>
                {doc.trustability_breakdown && (
                  <div className="text-[9px] text-emerald-600 mt-0.5 font-bold">
                    +{doc.trustability_breakdown.points_earned} pts
                  </div>
                )}
              </td>
              <td className="py-2.5 px-3 text-center">
                <div
                  className={cn(
                    "font-display font-extrabold tabular-nums",
                    doc.total_doc_contribution >= 0 ? "text-emerald-600" : "text-red-500",
                  )}
                >
                  {doc.total_doc_contribution > 0 ? "+" : ""}
                  {doc.total_doc_contribution}
                </div>
                {doc.scrutiny_penalty < 0 && (
                  <div className="text-[9px] text-red-500 font-bold">{doc.scrutiny_penalty} pts</div>
                )}
              </td>
              <td className="py-2.5 px-3">
                {doc.mismatches.length > 0 ? (
                  <div className="space-y-0.5">
                    {doc.mismatches.slice(0, 2).map((mismatch, j) => (
                      <p key={j} className="text-red-600 text-[10px] leading-snug">
                        • {mismatch}
                      </p>
                    ))}
                    {doc.mismatches.length > 2 && (
                      <p className="text-slate-400 text-[9px]">
                        +{doc.mismatches.length - 2} more
                      </p>
                    )}
                  </div>
                ) : doc.requires_scrutiny ? (
                  <p className="text-amber-600 text-[10px]">⚠ {doc.scrutiny_reason || "Requires scrutiny"}</p>
                ) : (
                  <p className="text-emerald-600 text-[10px]">✓ No issues</p>
                )}
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>

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
    </div>
  );
}

// ─── Gap Visualization ────────────────────────────────────────────────────

function GapVisualization({ gaps }: { gaps: GapDetail[] }) {
  if (!gaps.length) return null;
  const sortedGaps = [...gaps].sort((a, b) => a.start_year - b.start_year);

  return (
    <div className="space-y-3">
      {sortedGaps.map((gap, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06, duration: 0.35 }}
          className={cn(
            "rounded-xl p-4 border",
            gap.risk === "HIGH"
              ? "bg-gradient-to-br from-red-50 via-rose-50/40 to-red-50/30 border-red-200"
              : "bg-gradient-to-br from-amber-50 via-orange-50/40 to-amber-50/30 border-amber-200",
          )}
        >
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "w-2 h-2 rounded-full animate-pulse-glow",
                  gap.risk === "HIGH" ? "bg-red-500" : "bg-amber-500",
                )}
              />
              <span className="font-bold text-slate-700 text-[11px]">
                Gap {i + 1}: {gap.start_year} → {gap.end_year}
              </span>
            </div>
            <Badge
              className={cn(
                "text-[9px] h-5 px-2 font-bold inline-flex items-center gap-1.5",
                gap.risk === "HIGH"
                  ? "bg-red-100 text-red-700 border-red-200"
                  : "bg-amber-100 text-amber-700 border-amber-200",
              )}
            >
              {gap.gap_years} years
            </Badge>
          </div>

          {/* Timeline visual */}
          <div className="relative h-10 bg-white/60 rounded-lg overflow-hidden mb-2.5 ring-1 ring-slate-200/60">
            {/* Gap section */}
            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ delay: 0.2 + i * 0.05, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              style={{ left: "20%", right: "20%", transformOrigin: "center" }}
              className={cn(
                "absolute h-full flex items-center justify-center text-[9px] font-bold",
                gap.risk === "HIGH"
                  ? "bg-gradient-to-r from-red-200 via-red-300 to-red-200 text-red-900"
                  : "bg-gradient-to-r from-amber-200 via-amber-300 to-amber-200 text-amber-900",
              )}
            >
              <span className="opacity-90">Silent Period ({gap.gap_years} yrs)</span>
            </motion.div>

            {/* Year markers */}
            <div className="absolute left-0 top-0 bottom-0 w-[20%] bg-slate-100 flex items-center justify-center text-[9px] text-slate-600 font-mono font-bold">
              {gap.start_year}
            </div>
            <div className="absolute right-0 top-0 bottom-0 w-[20%] bg-slate-100 flex items-center justify-center text-[9px] text-slate-600 font-mono font-bold">
              {gap.end_year}
            </div>
          </div>

          {gap.adjacent_documents.length > 0 && (
            <div className="flex items-center gap-2 text-[10px] text-slate-500 flex-wrap">
              <span className="font-bold uppercase tracking-wider">Near docs:</span>
              {gap.adjacent_documents.map((doc, j) => (
                <Badge key={j} variant="outline" className="text-[9px] h-4 px-1.5 bg-white border-slate-200 font-mono">
                  {doc}
                </Badge>
              ))}
            </div>
          )}
        </motion.div>
      ))}
    </div>
  );
}

// ─── Collapsible Section ──────────────────────────────────────────────────

interface CollapsibleSectionProps {
  open: boolean;
  setOpen: (v: boolean) => void;
  title: string;
  icon: React.ReactNode;
  iconBg?: string;
  badge?: React.ReactNode;
  accent?: string;
  headerBg?: string;
  headerHover?: string;
  children: React.ReactNode;
  delay?: number;
}

function CollapsibleSection({
  open,
  setOpen,
  title,
  icon,
  iconBg = "from-indigo-500 to-blue-600",
  badge,
  accent = "from-indigo-500 via-blue-500 to-violet-500",
  headerBg,
  headerHover,
  children,
  delay = 0,
}: CollapsibleSectionProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="relative bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow"
    >
      <div className={cn("absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r opacity-0 transition-opacity", accent, open && "opacity-100")} />
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "w-full flex items-center justify-between px-4 sm:px-5 py-3.5 transition-colors text-left",
          headerBg || "bg-white",
          headerHover || "hover:bg-slate-50",
        )}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center bg-gradient-to-br text-white shadow-sm shrink-0", iconBg)}>
            {icon}
          </div>
          <span className="font-bold text-sm text-slate-900 truncate">{title}</span>
          {badge}
        </div>
        <motion.div
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="shrink-0"
        >
          <ChevronDown className="w-4 h-4 text-slate-400" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div className="px-4 sm:px-5 pb-4 pt-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Hero Stat Tile ───────────────────────────────────────────────────────

function HeroStat({
  label,
  value,
  icon,
  theme,
  delay = 0,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  theme: "emerald" | "blue" | "amber" | "slate";
  delay?: number;
}) {
  const themes = {
    emerald: {
      ring: "from-emerald-500 to-emerald-600",
      text: "text-emerald-700",
      soft: "from-emerald-50 to-white",
      border: "border-emerald-200",
      shadow: "hover:shadow-emerald-100",
    },
    blue: {
      ring: "from-blue-500 to-indigo-600",
      text: "text-blue-700",
      soft: "from-blue-50 to-white",
      border: "border-blue-200",
      shadow: "hover:shadow-blue-100",
    },
    amber: {
      ring: "from-amber-500 to-orange-500",
      text: "text-amber-700",
      soft: "from-amber-50 to-white",
      border: "border-amber-200",
      shadow: "hover:shadow-amber-100",
    },
    slate: {
      ring: "from-slate-400 to-slate-500",
      text: "text-slate-600",
      soft: "from-slate-50 to-white",
      border: "border-slate-200",
      shadow: "hover:shadow-slate-100",
    },
  }[theme];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -3 }}
      className={cn(
        "relative bg-gradient-to-br border rounded-xl p-3 text-center overflow-hidden transition-all hover:shadow-lg",
        themes.soft,
        themes.border,
        themes.shadow,
      )}
    >
      <div className={cn("absolute -top-8 -right-8 w-20 h-20 rounded-full opacity-20 blur-xl bg-gradient-to-br", themes.ring)} />
      <div className="relative">
        <div className={cn("w-7 h-7 mx-auto mb-1.5 rounded-lg bg-gradient-to-br flex items-center justify-center text-white shadow-sm", themes.ring)}>
          {icon}
        </div>
        <p className={cn("text-lg sm:text-xl font-display font-extrabold tabular-nums", themes.text)}>{value}</p>
        <p className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.16em] mt-0.5">
          {label}
        </p>
      </div>
    </motion.div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────

interface RiskScoreCardProps {
  requestId: string;
}

export function RiskScoreCard({ requestId }: RiskScoreCardProps) {
  const [data, setData] = useState<RiskScoreData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFactors, setShowFactors] = useState(false);
  const [showFlags, setShowFlags] = useState(false);
  const [showDocumentDetails, setShowDocumentDetails] = useState(false);
  const [showGapDetails, setShowGapDetails] = useState(false);
  const [showDetailedSummary, setShowDetailedSummary] = useState(false);

  useEffect(() => {
    const fetchScore = async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await fetch(`${API_BASE_URL}/api/v1/get-risk-score/${requestId}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        setData(json.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load risk score");
      } finally {
        setLoading(false);
      }
    };
    if (requestId) fetchScore();
  }, [requestId]);

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

  const cfg = GRADE_CONFIG[data.grade];
  const GradeIcon = cfg.Icon;

  const hasAnyFlags =
    data.flags.lis_pendens.length > 0 ||
    data.flags.restricted_lands.length > 0 ||
    data.flags.encumbrance_gaps.length > 0 ||
    data.flags.scrutiny_docs.length > 0;

  const totalFlagCount =
    data.flags.lis_pendens.length +
    data.flags.restricted_lands.length +
    data.flags.encumbrance_gaps.length +
    data.flags.scrutiny_docs.length;

  return (
    <div className="space-y-4">
      {/* ── Hero Card ─────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "relative border rounded-2xl sm:rounded-3xl overflow-hidden shadow-xl",
          cfg.border,
          cfg.glow,
        )}
      >
        {/* Top gradient strip */}
        <div className={cn("absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r z-10", cfg.accent)} />

        <div className="relative bg-white">
          <div className="flex flex-col md:flex-row">
            {/* Left — Gauge */}
            <div className={cn("relative flex flex-col items-center justify-center p-6 sm:p-8 md:w-72 lg:w-80 shrink-0 bg-gradient-to-br overflow-hidden", cfg.softBg)}>
              {/* Background flourish */}
              <div className="pointer-events-none absolute inset-0 opacity-50">
                <div className={cn("absolute -top-20 -left-20 w-60 h-60 rounded-full blur-3xl animate-blob-slow bg-gradient-to-br", cfg.blob)} />
                <div className={cn("absolute -bottom-20 -right-20 w-60 h-60 rounded-full blur-3xl animate-blob bg-gradient-to-br", cfg.blob)} />
              </div>

              <div className="relative">
                <GaugeDial score={data.score} grade={data.grade} />
              </div>

              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ delay: 0.7, duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
                className={cn(
                  "relative mt-3 inline-flex items-center gap-2 px-4 py-1.5 rounded-full border font-display font-bold text-sm shadow-sm",
                  cfg.pillBg,
                  cfg.border,
                  cfg.text,
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full animate-pulse-glow", cfg.text.replace("text-", "bg-"))} />
                <GradeIcon className="w-4 h-4" />
                <span>Grade {data.grade} · {cfg.label}</span>
              </motion.div>
            </div>

            {/* Right — Details */}
            <div className="flex-1 p-5 sm:p-6 lg:p-7 space-y-4 lg:space-y-5 min-w-0">
              {/* Header */}
              <div className="flex items-start gap-3">
                <motion.div
                  initial={{ scale: 0.6, rotate: -15, opacity: 0 }}
                  animate={{ scale: 1, rotate: 0, opacity: 1 }}
                  transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
                  className="relative shrink-0"
                >
                  <div className={cn("absolute inset-0 rounded-xl blur-md opacity-40 -z-10 animate-pulse-glow bg-gradient-to-br", cfg.gradient)} />
                  <div className={cn("w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-lg ring-1 ring-white/30", cfg.gradient)}>
                    <LandPlot className="w-5 h-5 text-white" strokeWidth={2.5} />
                  </div>
                </motion.div>
                <div className="min-w-0">
                  <h2 className="text-xl sm:text-2xl font-display font-extrabold text-slate-900 tracking-tight">
                    Title <span className="text-gradient-primary">Health Score</span>
                  </h2>
                  <p className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                    REQ-ID: <span className="text-slate-500">{data.request_id}</span>
                  </p>
                </div>
              </div>

              {/* Stats Row */}
              <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
                <HeroStat
                  label="Docs Passed"
                  value={`${data.metadata.passed_docs}/${data.metadata.total_docs}`}
                  icon={<ShieldCheck className="w-3.5 h-3.5" />}
                  theme="emerald"
                  delay={0.15}
                />
                <HeroStat
                  label="Avg Trust"
                  value={`${data.metadata.avg_trustability}%`}
                  icon={<Activity className="w-3.5 h-3.5" />}
                  theme="blue"
                  delay={0.22}
                />
                <HeroStat
                  label="Scrutiny Docs"
                  value={`${data.metadata.scrutiny_doc_count}`}
                  icon={<AlertTriangle className="w-3.5 h-3.5" />}
                  theme={data.metadata.scrutiny_doc_count > 0 ? "amber" : "slate"}
                  delay={0.29}
                />
              </div>

              {/* AI Risk Assessment */}
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                className="relative bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950 rounded-2xl p-4 sm:p-5 space-y-2.5 overflow-hidden shadow-lg shadow-slate-900/20"
              >
                {/* Sparkle blobs */}
                <div className="pointer-events-none absolute inset-0 opacity-60">
                  <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-gradient-to-br from-violet-500/20 to-indigo-500/20 blur-3xl animate-blob-slow" />
                  <div className="absolute -bottom-12 -left-12 w-40 h-40 rounded-full bg-gradient-to-br from-blue-500/15 to-violet-500/15 blur-3xl animate-blob" />
                </div>
                <div className="relative flex items-center gap-2">
                  <div className="relative">
                    <div className="absolute inset-0 bg-violet-500 rounded-md blur-md opacity-50 animate-pulse-glow" />
                    <div className="relative w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-md">
                      <Sparkles className="w-3.5 h-3.5 text-white" />
                    </div>
                  </div>
                  <span className="text-[10px] font-bold text-violet-300 uppercase tracking-[0.22em]">
                    AI Risk Assessment
                  </span>
                </div>
                <p className="relative text-xs sm:text-sm text-slate-200 leading-relaxed font-medium">
                  {data.ai_summary}
                </p>
              </motion.div>

              {/* Recommendation Banner */}
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.45, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                className={cn(
                  "relative flex items-start gap-3 p-3.5 rounded-xl border bg-gradient-to-r overflow-hidden",
                  cfg.softBg,
                  cfg.border,
                )}
              >
                <div className={cn("w-8 h-8 rounded-lg bg-gradient-to-br flex items-center justify-center shrink-0 shadow-sm", cfg.gradient)}>
                  <Gavel className="w-4 h-4 text-white" />
                </div>
                <div className="min-w-0">
                  <p className={cn("text-[10px] font-bold uppercase tracking-[0.18em]", cfg.text)}>
                    Legal Recommendation
                  </p>
                  <p className="text-xs sm:text-sm text-slate-700 font-medium mt-0.5 leading-snug">
                    {data.recommendation}
                  </p>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ── Risk Flags ─────────────────────────────────────────────────── */}
      {hasAnyFlags && (
        <CollapsibleSection
          open={showFlags}
          setOpen={setShowFlags}
          title="Risk Flags Detected"
          icon={<AlertTriangle className="w-4 h-4" />}
          iconBg="from-red-500 to-rose-600"
          accent="from-red-500 via-rose-500 to-orange-500"
          headerBg="bg-gradient-to-r from-red-50 via-rose-50/50 to-red-50/30"
          headerHover="hover:from-red-100 hover:via-rose-100/60 hover:to-red-100/40"
          badge={
            <Badge className="bg-white text-red-700 border-red-200 hover:bg-white text-[9px] h-5 px-2 font-bold inline-flex items-center gap-1.5 ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-glow" />
              {totalFlagCount} {totalFlagCount === 1 ? "issue" : "issues"}
            </Badge>
          }
          delay={0.05}
        >
          <div className="space-y-2.5">
            <FlagSection
              title="Lis Pendens / Court Attachments"
              items={data.flags.lis_pendens}
              variant="red"
            />
            <FlagSection
              title="Panchami / Restricted Lands"
              items={data.flags.restricted_lands}
              variant="red"
            />
            <FlagSection
              title="Encumbrance Chain Gaps"
              items={data.flags.encumbrance_gaps}
              variant="amber"
            />
            <FlagSection
              title="Documents Requiring Extra Scrutiny"
              items={data.flags.scrutiny_docs}
              variant="blue"
            />
          </div>
        </CollapsibleSection>
      )}

      {/* ── Score Factor Breakdown ─────────────────────────────────────── */}
      <CollapsibleSection
        open={showFactors}
        setOpen={setShowFactors}
        title="Score Factor Breakdown"
        icon={<Calculator className="w-4 h-4" />}
        iconBg="from-indigo-500 to-blue-600"
        accent="from-indigo-500 via-blue-500 to-violet-500"
        delay={0.1}
      >
        <div className="divide-y divide-slate-50">
          {data.factors.map((f, i) => (
            <FactorBar key={f.label} factor={f} idx={i} />
          ))}
        </div>
      </CollapsibleSection>

      {/* ── Document Breakdown ────────────────────────────────────────── */}
      {data.document_details && data.document_details.length > 0 && (
        <CollapsibleSection
          open={showDocumentDetails}
          setOpen={setShowDocumentDetails}
          title="Document Breakdown"
          icon={<FileText className="w-4 h-4" />}
          iconBg="from-blue-500 to-indigo-600"
          accent="from-blue-500 via-indigo-500 to-blue-600"
          badge={
            <Badge className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-50 text-[9px] h-5 px-2 font-bold inline-flex items-center gap-1.5 ml-1">
              <Layers className="w-2.5 h-2.5" />
              {data.document_details.length} docs
            </Badge>
          }
          delay={0.15}
        >
          <DocumentDetailTable documents={data.document_details} />
        </CollapsibleSection>
      )}

      {/* ── Gap Analysis ──────────────────────────────────────────────── */}
      {data.gap_details && data.gap_details.length > 0 && (
        <CollapsibleSection
          open={showGapDetails}
          setOpen={setShowGapDetails}
          title="Gap Analysis"
          icon={<TrendingDown className="w-4 h-4" />}
          iconBg="from-amber-500 to-orange-500"
          accent="from-amber-500 via-orange-500 to-amber-600"
          badge={
            <Badge className="bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50 text-[9px] h-5 px-2 font-bold inline-flex items-center gap-1.5 ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse-glow" />
              {data.gap_details.length} {data.gap_details.length === 1 ? "gap" : "gaps"}
            </Badge>
          }
          delay={0.2}
        >
          <GapVisualization gaps={data.gap_details} />
        </CollapsibleSection>
      )}

      {/* ── Detailed Assessment ──────────────────────────────────────── */}
      {data.ai_detailed_summary && (
        <CollapsibleSection
          open={showDetailedSummary}
          setOpen={setShowDetailedSummary}
          title="Detailed Assessment"
          icon={<Sparkles className="w-4 h-4" />}
          iconBg="from-violet-500 to-purple-600"
          accent="from-violet-500 via-purple-500 to-indigo-500"
          delay={0.25}
        >
          <div className="bg-gradient-to-br from-slate-50 to-indigo-50/30 rounded-xl p-4 border border-slate-200">
            <pre className="text-[11px] text-slate-700 whitespace-pre-wrap font-mono leading-relaxed">
              {data.ai_detailed_summary}
            </pre>
          </div>
        </CollapsibleSection>
      )}

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
