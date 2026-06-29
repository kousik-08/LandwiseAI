import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { landwiseApi } from "@/lib/landwise-api";
import { toast } from "sonner";

type Issue = { text: string; severity: "Critical" | "Minor"; source_section?: string };
type Summary = {
  verdict: "Safe to Proceed" | "Proceed with Caution" | "Do Not Proceed";
  issues: Issue[];
  pros: { text: string }[];
  counts: { critical: number; minor: number; pros: number };
};

const VERDICT_STYLE: Record<string, string> = {
  "Safe to Proceed": "bg-emerald-50 border-emerald-200 text-emerald-800",
  "Proceed with Caution": "bg-amber-50 border-amber-200 text-amber-800",
  "Do Not Proceed": "bg-red-50 border-red-200 text-red-800",
};

export function OpinionSummaryCard({ parcelId }: { parcelId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["opinion-summary", parcelId],
    queryFn: () => landwiseApi.getOpinionSummary(parcelId),
    retry: false,
  });

  const regenerate = useMutation({
    mutationFn: () => landwiseApi.regenerateOpinionSummary(parcelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opinion-summary", parcelId] });
      toast.success("Opinion summary regenerated");
    },
    onError: () => toast.error("Could not regenerate summary"),
  });

  if (isLoading) {
    return <div className="h-32 rounded-xl border border-slate-200 bg-slate-50 animate-pulse" />;
  }

  if (isError || !data?.summary) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 flex items-center justify-between">
        <p className="text-sm text-slate-500">Opinion summary unavailable.</p>
        <button
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
          className="text-sm font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-50"
        >
          {regenerate.isPending ? "Generating…" : "Regenerate"}
        </button>
      </div>
    );
  }

  const s: Summary = data.summary;
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className={`px-5 py-3 border-b flex items-center justify-between ${VERDICT_STYLE[s.verdict] || ""}`}>
        <span className="font-black tracking-tight">{s.verdict}</span>
        <span className="text-xs font-semibold opacity-80">
          {s.counts.critical} Critical · {s.counts.minor} Minor · {s.counts.pros} Pros
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
        <div className="p-5 border-r border-slate-100">
          <h4 className="text-xs font-bold uppercase tracking-wide text-red-600 mb-2">⚠ Issues</h4>
          {s.issues.length === 0 ? (
            <p className="text-sm text-slate-400">None identified.</p>
          ) : (
            <ul className="space-y-2">
              {s.issues.map((i, idx) => (
                <li key={idx} className="text-sm text-slate-700 flex gap-2">
                  <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${i.severity === "Critical" ? "bg-red-500" : "bg-amber-400"}`} />
                  <span>
                    {i.text}
                    <span className="ml-2 text-[10px] font-bold uppercase text-slate-400">{i.severity}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="p-5">
          <h4 className="text-xs font-bold uppercase tracking-wide text-emerald-600 mb-2">✅ Pros</h4>
          {s.pros.length === 0 ? (
            <p className="text-sm text-slate-400">None identified.</p>
          ) : (
            <ul className="space-y-2">
              {s.pros.map((p, idx) => (
                <li key={idx} className="text-sm text-slate-700 flex gap-2">
                  <span className="mt-1 h-2 w-2 rounded-full shrink-0 bg-emerald-500" />
                  <span>{p.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
