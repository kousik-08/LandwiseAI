import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface TrustabilityScoreProps {
  score?: number | null;
}

export function TrustabilityScore({ score }: TrustabilityScoreProps) {
  if (score === undefined || score === null) return null;

  let text = "";
  let colorClass = "";
  let description = "";

  if (score < 80) {
    text = "Not Trustable";
    colorClass = "bg-red-500 hover:bg-red-600 border-red-600";
    description = "Score is below 80, indicating significant discrepancies.";
  } else if (score >= 80 && score < 95) {
    text = "Needs Verification";
    colorClass = "bg-orange-500 hover:bg-orange-600 border-orange-600";
    description = "Score is between 80-95, manual verification is recommended.";
  } else if (score >= 95 && score < 100) {
    text = "Trustable";
    colorClass = "bg-green-500 hover:bg-green-600 border-green-600";
    description = "Score is between 95-99, high confidence in data.";
  } else if (score === 100) {
    text = "Valid & Verified";
    colorClass = "bg-emerald-600 hover:bg-emerald-700 border-emerald-700";
    description = "Perfect score! All data matches exactly.";
  }

  return (
    <div className="flex flex-col gap-1 items-start mt-2 mb-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-muted-foreground">
          Trustability Score:
        </span>
        <Badge
          className={cn("text-base px-3 py-1 text-white", colorClass)}
          variant="outline"
        >
          {score}% | {text}
        </Badge>
      </div>
      <span className="text-xs text-muted-foreground italic pl-1">
        {description}
      </span>
    </div>
  );
}
