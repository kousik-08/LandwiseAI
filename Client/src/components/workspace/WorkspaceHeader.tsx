/**
 * WorkspaceHeader / StatPill — the shared "Document Analysis" header design,
 * extracted so every workspace tab (Overview, Risk Score, Ownership Audit,
 * Legal Opinion, …) wears the same identity: a gradient icon tile, a title
 * with an optional REQ-style badge, an uppercase tracking subtitle, and an
 * optional right-hand slot for stat pills / progress.
 *
 * Rendered as a rounded card (not a full-bleed band) so it sits cleanly at the
 * top of the card-based tab layouts, while matching the Document Analysis band
 * one-for-one in iconography, type scale, and color.
 */
import React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Accent = "indigo" | "emerald" | "amber" | "violet" | "rose" | "slate";

const ACCENTS: Record<Accent, string> = {
  indigo: "border-indigo-200 bg-indigo-50 text-indigo-800",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  violet: "border-violet-200 bg-violet-50 text-violet-800",
  rose: "border-rose-200 bg-rose-50 text-rose-800",
  slate: "border-slate-200 bg-slate-50 text-slate-700",
};

/** The metric pill used in the Document Analysis header (TOTAL / MATCHED / …). */
export function StatPill({
  label,
  value,
  accent = "indigo",
}: {
  label: string;
  value: React.ReactNode;
  accent?: Accent;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] font-bold uppercase tracking-wider",
        ACCENTS[accent],
      )}
    >
      <span className="opacity-70">{label}</span>
      <span className="text-sm font-extrabold tabular-nums">{value}</span>
    </div>
  );
}

/** A thin labelled progress bar matching the Document Analysis header's. */
export function HeaderProgress({ label = "Progress", pct }: { label?: string; pct: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="flex flex-col items-end gap-1 min-w-[140px]">
      <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="w-32 h-1.5 rounded-full bg-slate-200 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="text-[10px] font-bold text-slate-700">{clamped}%</div>
    </div>
  );
}

export function WorkspaceHeader({
  icon: Icon,
  title,
  badge,
  subtitle,
  right,
  className,
}: {
  icon: LucideIcon;
  title: string;
  /** Small REQ-style chip beside the title. */
  badge?: string;
  subtitle: string;
  /** Right-hand content — stat pills, a progress bar, actions. */
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-slate-200 bg-white shadow-sm px-4 py-3 flex items-center justify-between gap-4 flex-wrap",
        className,
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-600 to-blue-600 flex items-center justify-center shadow-sm shadow-indigo-500/30 shrink-0">
          <Icon className="w-4 h-4 text-white" strokeWidth={2.5} />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-display font-extrabold text-slate-900 leading-tight flex items-center gap-2">
            {title}
            {badge && (
              <span className="text-[8px] uppercase tracking-[0.18em] font-bold text-indigo-600 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5">
                {badge}
              </span>
            )}
          </h2>
          <p className="text-[10px] text-slate-500 font-medium uppercase tracking-[0.14em]">{subtitle}</p>
        </div>
      </div>
      {right && <div className="flex items-center gap-3 flex-wrap">{right}</div>}
    </div>
  );
}

export default WorkspaceHeader;
