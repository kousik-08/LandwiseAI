import { useState, useEffect, useMemo, useRef } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Users,
  History,
  UserCheck,
  Shield,
  ChevronDown,
  ChevronUp,
  Search,
  X,
  SlidersHorizontal,
  AlertTriangle,
  CheckCircle2,
  Lock,
  HelpCircle,
  GitBranch,
} from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

type AuditVerdict = "CLEAR" | "BROKEN_CHAIN" | "ENCUMBERED" | "INDETERMINATE";

interface ChainBreak {
  doc_no: string;
  date: string;
  nature: string;
  seller: string;
  expected_from: string[];
  reason: string;
}

interface OpenEncumbrance {
  doc_no: string;
  date: string;
  nature: string;
  creditor: string;
  borrower: string;
  released: boolean;
  release_doc_no: string | null;
}

interface PartitionEvent {
  doc_no: string;
  date: string;
  co_owners: string[];
}

interface LineageEntry {
  date: string;
  doc_no: string;
  nature: string;
  seller: string;
  buyer: string;
  involved_surveys?: string[];
  kind?: "transfer" | "encumbrance" | "encumbrance_release" | "other";
  is_current_owner_source?: boolean;
  chain_break?: boolean;
  chain_note?: string | null;
}

interface OwnershipRecord {
  survey_number: string;
  total_transactions: number;
  current_owner: string;
  current_owner_basis_doc?: string;
  unique_owners_count: number;
  unique_owners_list: string[];
  last_transaction_date: string;
  lineage?: LineageEntry[];
  audit?: {
    verdict: AuditVerdict;
    chain_breaks: ChainBreak[];
    open_encumbrances: OpenEncumbrance[];
    partition_events: PartitionEvent[];
    transfer_count: number;
    encumbrance_count: number;
  };
}

const VERDICT_STYLES: Record<AuditVerdict, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  CLEAR: {
    label: "Clear Title",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
    icon: CheckCircle2,
  },
  BROKEN_CHAIN: {
    label: "Broken Chain",
    className: "bg-red-50 text-red-700 border-red-200",
    icon: AlertTriangle,
  },
  ENCUMBERED: {
    label: "Encumbered",
    className: "bg-amber-50 text-amber-800 border-amber-200",
    icon: Lock,
  },
  INDETERMINATE: {
    label: "Indeterminate",
    className: "bg-slate-100 text-slate-600 border-slate-200",
    icon: HelpCircle,
  },
};

interface SurveyOwnershipTableProps {
  requestId: string;
}

// Highlight matching text in a string
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-yellow-200 text-yellow-900 rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

export function SurveyOwnershipTable({ requestId }: SurveyOwnershipTableProps) {
  const [data, setData] = useState<OwnershipRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  // Search state
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "survey" | "owner">("all");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/v1/get-survey-ownership/${requestId}`
        );
        if (!response.ok) throw new Error("Failed to fetch ownership data");
        const json = await response.json();
        setData(json.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "An unknown error occurred");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [requestId]);

  // ── Filtered rows (client-side) ────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data;

    return data.filter((row) => {
      const inSurvey = row.survey_number.toLowerCase().includes(q);
      const inOwner =
        row.current_owner.toLowerCase().includes(q) ||
        row.unique_owners_list.some((o) => o.toLowerCase().includes(q));
      const inDocNo = row.lineage?.some((tx) =>
        tx.doc_no.toLowerCase().includes(q)
      );

      if (activeFilter === "survey") return inSurvey;
      if (activeFilter === "owner") return inOwner;
      return inSurvey || inOwner || !!inDocNo;
    });
  }, [data, query, activeFilter]);

  // Auto-expand if exactly one result after search
  useEffect(() => {
    if (filtered.length === 1) setExpandedRow(filtered[0].survey_number);
    else setExpandedRow(null);
  }, [filtered]);

  // ── States ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-sm font-medium text-muted-foreground animate-pulse">
          Analyzing EC Ownership Chains...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center bg-red-50 border-2 border-dashed border-red-200 rounded-3xl">
        <Shield className="w-12 h-12 text-red-300 mx-auto mb-4" />
        <h3 className="text-lg font-bold text-red-800">Ownership Analysis Failed</h3>
        <p className="text-sm text-red-600 mt-1">{error}</p>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="p-12 text-center bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl">
        <Users className="w-12 h-12 text-slate-300 mx-auto mb-4" />
        <p className="text-sm font-medium text-slate-500">
          No ownership data available for this request.
        </p>
      </div>
    );
  }

  return (
    <Card className="border-none shadow-xl rounded-3xl overflow-hidden bg-white">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <CardHeader className="bg-slate-900 text-white p-6">
        <div className="flex flex-col gap-4">
          {/* Title row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/10 rounded-lg">
                <Users className="w-6 h-6 text-primary" />
              </div>
              <div>
                <CardTitle className="text-xl">Ownership Distribution Audit</CardTitle>
                <p className="text-xs text-slate-400 font-medium">
                  Consolidated unique owner statistics per survey number (EC Extract)
                </p>
              </div>
            </div>
            <Badge className="bg-primary/20 text-primary border-primary/30 uppercase tracking-widest text-[10px]">
              {filtered.length}/{data.length} Parcels
            </Badge>
          </div>

          {/* ── Search Bar ──────────────────────────────────────────────── */}
          <div className="flex items-center gap-2">
            {/* Input */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              <input
                ref={inputRef}
                id="ownership-search"
                type="text"
                placeholder="Search by survey number, owner name, or doc no…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full pl-9 pr-9 py-2.5 rounded-xl bg-white/10 border border-white/20 text-white placeholder:text-slate-400 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/60 focus:border-primary/60 transition-all"
              />
              {query && (
                <button
                  onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Filter pills */}
            <div className="flex items-center gap-1 bg-white/10 rounded-xl p-1 border border-white/10 shrink-0">
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400 ml-1" />
              {(["all", "survey", "owner"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setActiveFilter(f)}
                  className={`px-3 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${
                    activeFilter === f
                      ? "bg-primary text-white shadow"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Results hint */}
          {query && (
            <p className="text-[11px] text-slate-400">
              {filtered.length === 0
                ? `No results for "${query}"`
                : `${filtered.length} result${filtered.length !== 1 ? "s" : ""} for "${query}"`}
            </p>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {filtered.length === 0 ? (
          /* ── No Results State ──────────────────────────────────────────── */
          <div className="flex flex-col items-center justify-center py-20 space-y-4 bg-slate-50">
            <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center">
              <Search className="w-7 h-7 text-slate-300" />
            </div>
            <div className="text-center">
              <p className="font-bold text-slate-600">No matching survey numbers</p>
              <p className="text-sm text-slate-400 mt-1">
                Try searching for a different number or owner name
              </p>
            </div>
            <button
              onClick={() => setQuery("")}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-bold hover:bg-primary/90 transition-colors"
            >
              Clear Search
            </button>
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-slate-50">
              <TableRow className="hover:bg-transparent border-b border-slate-100">
                <TableHead className="w-[180px] font-bold text-slate-700">Survey No</TableHead>
                <TableHead className="font-bold text-slate-700">Current Owner (per Title Audit)</TableHead>
                <TableHead className="text-center font-bold text-slate-700">Title Audit</TableHead>
                <TableHead className="text-center font-bold text-slate-700">Transactions</TableHead>
                <TableHead className="text-center font-bold text-slate-700">Total Owners</TableHead>
                <TableHead className="text-right font-bold text-slate-700">Last Transfer</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => {
                const verdict = row.audit?.verdict ?? "INDETERMINATE";
                const verdictStyle = VERDICT_STYLES[verdict];
                const VerdictIcon = verdictStyle.icon;
                const ownerSourceClass =
                  verdict === "BROKEN_CHAIN"
                    ? "text-red-600"
                    : verdict === "ENCUMBERED"
                    ? "text-amber-700"
                    : verdict === "INDETERMINATE"
                    ? "text-slate-500"
                    : "text-emerald-600";
                return (
                <>
                  <TableRow
                    key={row.survey_number}
                    className={`group transition-colors border-b border-slate-50 ${
                      expandedRow === row.survey_number
                        ? "bg-primary/5"
                        : "hover:bg-slate-50/50"
                    }`}
                  >
                    <TableCell className="font-black text-slate-900 text-base">
                      <Highlight text={row.survey_number} query={query} />
                    </TableCell>
                    <TableCell className="max-w-[300px]">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <UserCheck className={cn("w-3.5 h-3.5 shrink-0", ownerSourceClass)} />
                          <span className="font-bold text-sm text-slate-800 line-clamp-1">
                            <Highlight text={row.current_owner} query={query} />
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400 font-medium uppercase tracking-tighter">
                          {row.current_owner_basis_doc
                            ? <>Per latest transfer deed&nbsp;<span className="font-mono text-slate-500">{row.current_owner_basis_doc}</span></>
                            : "Per latest transaction in EC"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] font-bold inline-flex items-center gap-1 px-2 h-6",
                          verdictStyle.className,
                        )}
                        title={
                          verdict === "BROKEN_CHAIN"
                            ? `${row.audit?.chain_breaks.length ?? 0} chain break(s) detected`
                            : verdict === "ENCUMBERED"
                            ? `${row.audit?.open_encumbrances.length ?? 0} open encumbrance(s)`
                            : verdict === "INDETERMINATE"
                            ? "No transfer deeds found in EC"
                            : "Continuous chain, no open encumbrances"
                        }
                      >
                        <VerdictIcon className="w-3 h-3" />
                        {verdictStyle.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant="outline"
                        className="bg-indigo-50 text-indigo-700 border-indigo-200 text-[10px] font-bold"
                      >
                        <History className="w-3 h-3 mr-1" />
                        {row.total_transactions}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="inline-flex flex-col items-center">
                        <span className="text-sm font-black text-slate-900">
                          {row.unique_owners_count}
                        </span>
                        <span className="text-[9px] font-bold text-slate-400 uppercase leading-none">
                          Unique Entities
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-bold text-slate-600 font-mono text-xs">
                      {row.last_transaction_date}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:bg-primary/10 hover:text-primary transition-all rounded-full"
                        onClick={() =>
                          setExpandedRow(
                            expandedRow === row.survey_number ? null : row.survey_number
                          )
                        }
                      >
                        {expandedRow === row.survey_number ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>

                  {/* ── Expanded Lineage ───────────────────────────────── */}
                  {expandedRow === row.survey_number && (
                    <TableRow className="bg-slate-50/50 hover:bg-slate-50/80 border-none transition-all animate-in fade-in slide-in-from-top-1">
                      <TableCell colSpan={7} className="p-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                          <div className="space-y-4">
                            <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                              <History className="w-4 h-4 text-primary" />
                              Chronological Ownership Lineage (EC Transactions)
                            </h4>
                            <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                              {row.lineage?.map((tx, idx) => {
                                const kind = tx.kind ?? "other";
                                const kindStyle =
                                  kind === "transfer"
                                    ? "border-l-4 border-l-emerald-400"
                                    : kind === "encumbrance"
                                    ? "border-l-4 border-l-amber-400"
                                    : kind === "encumbrance_release"
                                    ? "border-l-4 border-l-sky-400"
                                    : "border-l-4 border-l-slate-200";
                                const kindLabel =
                                  kind === "transfer"
                                    ? "Transfer of Title"
                                    : kind === "encumbrance"
                                    ? "Encumbrance (no transfer)"
                                    : kind === "encumbrance_release"
                                    ? "Encumbrance Release"
                                    : "Other";
                                return (
                                <div
                                  key={idx}
                                  className={cn(
                                    "bg-slate-50 p-4 rounded-xl border border-slate-100 flex flex-col gap-2 hover:border-primary/20 transition-all hover:shadow-sm",
                                    kindStyle,
                                    tx.is_current_owner_source && "ring-2 ring-emerald-300/60",
                                    tx.chain_break && "ring-2 ring-red-300/60 bg-red-50/40",
                                  )}
                                >
                                  <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] bg-white text-slate-600 font-mono font-bold shadow-sm"
                                    >
                                      {tx.date}
                                    </Badge>
                                    <div className="flex items-center gap-1">
                                      {tx.is_current_owner_source && (
                                        <Badge className="text-[8px] h-4 px-1.5 bg-emerald-600 text-white font-bold uppercase tracking-wider">
                                          Current Owner Source
                                        </Badge>
                                      )}
                                      <span className="text-[11px] font-black text-slate-400 bg-white px-2 py-0.5 rounded-md border border-slate-100">
                                        DOC:{" "}
                                        <Highlight text={tx.doc_no} query={query} />
                                      </span>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <div className="text-[11px] text-primary/80 font-black uppercase tracking-widest">{tx.nature}</div>
                                    <Badge
                                      variant="outline"
                                      className={cn(
                                        "text-[9px] h-4 px-1.5 font-bold uppercase tracking-wider",
                                        kind === "transfer" && "bg-emerald-50 text-emerald-700 border-emerald-200",
                                        kind === "encumbrance" && "bg-amber-50 text-amber-700 border-amber-200",
                                        kind === "encumbrance_release" && "bg-sky-50 text-sky-700 border-sky-200",
                                        kind === "other" && "bg-slate-100 text-slate-500 border-slate-200",
                                      )}
                                    >
                                      {kindLabel}
                                    </Badge>
                                  </div>

                                  {tx.chain_break && tx.chain_note && (
                                    <div className="flex items-start gap-2 p-2 rounded-md bg-red-50 border border-red-200 text-[10px] text-red-800 leading-snug">
                                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-600" />
                                      <span><strong className="uppercase tracking-wider">Chain break:</strong> {tx.chain_note}</span>
                                    </div>
                                  )}

                                  {/* Multi-survey badge */}
                                  {tx.involved_surveys && tx.involved_surveys.length > 1 && (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                      <span className="text-[9px] font-bold text-slate-400 uppercase self-center">Included:</span>
                                      {tx.involved_surveys.map(s => (
                                        <Badge key={s} variant="outline" className={cn("text-[8px] h-4 px-1 leading-none border-slate-200", s === row.survey_number ? "bg-primary/5 text-primary border-primary/20" : "bg-white text-slate-400")}>
                                          {s}
                                        </Badge>
                                      ))}
                                    </div>
                                  )}

                                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mt-1 text-sm bg-white p-3 rounded-lg border border-slate-100">
                                    <span className="text-[10px] uppercase font-bold text-slate-400 self-center">
                                      {kind === "encumbrance" ? "Borrower" : "From"}
                                    </span>
                                    <span
                                      className="font-bold text-slate-600 line-clamp-2"
                                      title={tx.seller || "N/A"}
                                    >
                                      <Highlight text={tx.seller || "N/A"} query={query} />
                                    </span>
                                    <span className="text-[10px] uppercase font-bold text-slate-400 self-center">
                                      {kind === "encumbrance" ? "Mortgagee" : "To"}
                                    </span>
                                    <span
                                      className="font-black text-slate-900 line-clamp-2"
                                      title={tx.buyer || "N/A"}
                                    >
                                      <Highlight text={tx.buyer || "N/A"} query={query} />
                                    </span>
                                  </div>
                                </div>
                                );
                              })}
                            </div>
                          </div>
                          {/* ── Audit Panel ─────────────────────────────── */}
                          <div className="space-y-3">
                            <div
                              className={cn(
                                "p-4 rounded-xl border space-y-2",
                                verdictStyle.className,
                              )}
                            >
                              <div className="flex items-center gap-2">
                                <VerdictIcon className="w-4 h-4" />
                                <h4 className="text-xs font-black uppercase tracking-widest">
                                  Title Audit: {verdictStyle.label}
                                </h4>
                              </div>
                              <p className="text-[11px] leading-relaxed">
                                {verdict === "CLEAR" && (
                                  <>The seller of every transfer deed appears as a buyer in a prior transfer for survey <strong>{row.survey_number}</strong>, and there are no open encumbrances on record.</>
                                )}
                                {verdict === "BROKEN_CHAIN" && (
                                  <>One or more transfer deeds were executed by a party that does not appear in any prior recorded transfer for this survey. This indicates either a missing intermediate document, a name discrepancy, or an unrecorded transfer that must be investigated before relying on the current owner.</>
                                )}
                                {verdict === "ENCUMBERED" && (
                                  <>Title appears continuous, but at least one mortgage or other encumbrance has not been released on the EC. The current owner holds the property subject to these charges.</>
                                )}
                                {verdict === "INDETERMINATE" && (
                                  <>The EC for this survey contains no transfer deeds (only encumbrances or other entries), so the current owner cannot be derived from registry records alone.</>
                                )}
                              </p>
                            </div>

                            {row.audit?.chain_breaks && row.audit.chain_breaks.length > 0 && (
                              <div className="bg-white p-3 rounded-xl border border-red-100 space-y-2">
                                <div className="flex items-center gap-1.5">
                                  <GitBranch className="w-3.5 h-3.5 text-red-600" />
                                  <span className="text-[10px] font-black uppercase tracking-widest text-red-700">
                                    Chain Breaks ({row.audit.chain_breaks.length})
                                  </span>
                                </div>
                                <ul className="space-y-1.5">
                                  {row.audit.chain_breaks.map((cb, i) => (
                                    <li key={i} className="text-[10px] leading-snug text-slate-700 bg-red-50/50 p-2 rounded-md border border-red-100">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="font-mono font-bold text-red-700">{cb.doc_no}</span>
                                        <span className="text-slate-500">{cb.date}</span>
                                      </div>
                                      <div className="mt-1">
                                        <span className="font-bold">Seller:</span> {cb.seller}
                                      </div>
                                      {cb.expected_from.length > 0 && (
                                        <div className="text-slate-600">
                                          <span className="font-bold">Expected from one of:</span> {cb.expected_from.join(", ")}
                                          {cb.expected_from.length >= 5 && "…"}
                                        </div>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {row.audit?.open_encumbrances && row.audit.open_encumbrances.length > 0 && (
                              <div className="bg-white p-3 rounded-xl border border-amber-100 space-y-2">
                                <div className="flex items-center gap-1.5">
                                  <Lock className="w-3.5 h-3.5 text-amber-600" />
                                  <span className="text-[10px] font-black uppercase tracking-widest text-amber-700">
                                    Open Encumbrances ({row.audit.open_encumbrances.length})
                                  </span>
                                </div>
                                <ul className="space-y-1.5">
                                  {row.audit.open_encumbrances.map((enc, i) => (
                                    <li key={i} className="text-[10px] leading-snug text-slate-700 bg-amber-50/50 p-2 rounded-md border border-amber-100">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="font-mono font-bold text-amber-800">{enc.doc_no}</span>
                                        <span className="text-slate-500">{enc.date}</span>
                                      </div>
                                      <div className="mt-1 text-slate-700">
                                        <span className="font-bold">{enc.nature}</span> in favour of <strong>{enc.creditor}</strong>
                                        {enc.borrower && enc.borrower !== "N/A" && (
                                          <> by {enc.borrower}</>
                                        )}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {row.audit?.partition_events && row.audit.partition_events.length > 0 && (
                              <div className="bg-white p-3 rounded-xl border border-slate-200 space-y-2">
                                <div className="flex items-center gap-1.5">
                                  <Users className="w-3.5 h-3.5 text-indigo-600" />
                                  <span className="text-[10px] font-black uppercase tracking-widest text-indigo-700">
                                    Partition Events ({row.audit.partition_events.length})
                                  </span>
                                </div>
                                <ul className="space-y-1.5">
                                  {row.audit.partition_events.map((p, i) => (
                                    <li key={i} className="text-[10px] leading-snug text-slate-700 bg-indigo-50/40 p-2 rounded-md border border-indigo-100">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="font-mono font-bold text-indigo-700">{p.doc_no}</span>
                                        <span className="text-slate-500">{p.date}</span>
                                      </div>
                                      <div className="mt-1 text-slate-700">
                                        Title split among {p.co_owners.length} co-owner{p.co_owners.length === 1 ? "" : "s"}: {p.co_owners.join(", ")}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            <p className="text-[10px] text-slate-400 italic leading-relaxed">
                              Audit derived from {row.audit?.transfer_count ?? 0} transfer deed{(row.audit?.transfer_count ?? 0) === 1 ? "" : "s"} and {row.audit?.encumbrance_count ?? 0} encumbrance entr{(row.audit?.encumbrance_count ?? 0) === 1 ? "y" : "ies"} across {row.total_transactions} EC transactions for survey <strong>{row.survey_number}</strong>. Name matching is conservative — a flagged break may be a registry transliteration discrepancy rather than a true gap; verify before relying on it.
                            </p>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
