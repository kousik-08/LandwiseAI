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
import {
    IndianRupee,
    Ruler,
    ArrowRightLeft,
    CheckCircle2,
    XCircle,
    AlertCircle
} from "lucide-react";
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
    comparisons: Comparison[];
}

interface ResultItem {
    document_number: string;
    validation_result: ValidationResult;
}

interface ValueComparisonAuditProps {
    results: ResultItem[];
}

export function ValueComparisonAudit({ results }: ValueComparisonAuditProps) {
    if (!results || results.length === 0) {
        return (
            <div className="p-8 text-center bg-muted/20 rounded-2xl border-2 border-dashed">
                <p className="text-muted-foreground">No validated documents available for comparison.</p>
            </div>
        );
    }

    const getStatusIcon = (status: string) => {
        if (status.includes("NOT MATCHED")) return <XCircle className="w-4 h-4 text-red-600" />;
        if (status.includes("PARTIAL")) return <AlertCircle className="w-4 h-4 text-yellow-600" />;
        return <CheckCircle2 className="w-4 h-4 text-green-600" />;
    };

    const getStatusBadgeClass = (status: string) => {
        if (status.includes("NOT MATCHED")) return "bg-red-50 text-red-700 border-red-200";
        if (status.includes("PARTIAL")) return "bg-yellow-50 text-yellow-700 border-yellow-200";
        return "bg-green-50 text-green-700 border-green-200";
    };

    return (
        <div className="space-y-12 animate-in fade-in duration-700">
            {/* Financial Value Comparison Table */}
            <section className="space-y-4">
                <div className="flex items-center gap-2 mb-2">
                    <div className="p-2 bg-primary/10 rounded-lg text-primary">
                        <IndianRupee className="w-5 h-5" />
                    </div>
                    <div>
                        <h3 className="text-xl font-bold text-slate-900">Financial Value Audit</h3>
                        <p className="text-sm text-slate-500">Cross-verifying Consideration Amount between EC and Sale Deed files</p>
                    </div>
                </div>

                <div className="rounded-2xl border bg-card overflow-hidden shadow-lg">
                    <Table>
                        <TableHeader className="bg-slate-900 hover:bg-slate-900">
                            <TableRow>
                                <TableHead className="text-white font-bold w-[200px]">Document No</TableHead>
                                <TableHead className="text-white font-bold">EC Value</TableHead>
                                <TableHead className="text-white font-bold">Deed (Metadata) Value</TableHead>
                                <TableHead className="text-white font-bold text-center">Status</TableHead>
                                <TableHead className="text-white font-bold">Audit Observation</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {results.map((result, idx) => {
                                const comp = result.validation_result.comparisons.find(
                                    c => c.field === "Market Value & Consideration"
                                );
                                if (!comp) return null;

                                return (
                                    <TableRow key={idx} className="hover:bg-muted/30 transition-colors">
                                        <TableCell className="font-bold text-slate-700">{result.document_number}</TableCell>
                                        <TableCell className="font-semibold text-slate-600">{comp.ec_value}</TableCell>
                                        <TableCell className="font-semibold text-slate-900">{comp.metadata_value}</TableCell>
                                        <TableCell className="text-center">
                                            <div className="flex justify-center">
                                                <Badge variant="outline" className={cn("text-[10px] font-black tracking-tighter", getStatusBadgeClass(comp.status))}>
                                                    {comp.status}
                                                </Badge>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-start gap-2 max-w-md">
                                                <div className="mt-0.5">{getStatusIcon(comp.status)}</div>
                                                <span className="text-xs text-slate-600 leading-snug italic">{comp.reason}</span>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            </section>

            {/* Property Extent/Area Comparison Table */}
            <section className="space-y-4">
                <div className="flex items-center gap-2 mb-2">
                    <div className="p-2 bg-indigo-500/10 rounded-lg text-indigo-600">
                        <Ruler className="w-5 h-5" />
                    </div>
                    <div>
                        <h3 className="text-xl font-bold text-slate-900">Property Area Audit</h3>
                        <p className="text-sm text-slate-500">Cross-verifying Land Extent / Square Feet between EC and Sale Deed files</p>
                    </div>
                </div>

                <div className="rounded-2xl border bg-card overflow-hidden shadow-lg">
                    <Table>
                        <TableHeader className="bg-indigo-900 hover:bg-indigo-900">
                            <TableRow>
                                <TableHead className="text-white font-bold w-[200px]">Document No</TableHead>
                                <TableHead className="text-white font-bold">EC Extent</TableHead>
                                <TableHead className="text-white font-bold">Deed (Metadata) Extent</TableHead>
                                <TableHead className="text-white font-bold text-center">Status</TableHead>
                                <TableHead className="text-white font-bold">Audit Observation</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {results.map((result, idx) => {
                                const comp = result.validation_result.comparisons.find(
                                    c => c.field === "Square Feet / Extent"
                                );
                                if (!comp) return null;

                                return (
                                    <TableRow key={idx} className="hover:bg-muted/30 transition-colors">
                                        <TableCell className="font-bold text-slate-700">{result.document_number}</TableCell>
                                        <TableCell className="font-semibold text-slate-600">{comp.ec_value}</TableCell>
                                        <TableCell className="font-semibold text-slate-900">{comp.metadata_value}</TableCell>
                                        <TableCell className="text-center">
                                            <div className="flex justify-center">
                                                <Badge variant="outline" className={cn("text-[10px] font-black tracking-tighter", getStatusBadgeClass(comp.status))}>
                                                    {comp.status}
                                                </Badge>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-start gap-2 max-w-md">
                                                <div className="mt-0.5">{getStatusIcon(comp.status)}</div>
                                                <span className="text-xs text-slate-600 leading-snug italic">{comp.reason}</span>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            </section>
        </div>
    );
}
