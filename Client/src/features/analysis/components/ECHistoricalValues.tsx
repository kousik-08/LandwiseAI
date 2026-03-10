import { useState } from "react";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, TrendingUp, AlertTriangle, CheckCircle2, History, IndianRupee } from "lucide-react";

interface ECValueRecord {
    document_no: string;
    area_sqft: number;
    actual_sell_value: number;
    guideline_value: number;
    sell_value_per_sqft: number;
    market_value_per_sqft: number;
    observation: string;
}

interface ECHistoricalValuesProps {
    data: ECValueRecord[];
    isLoading?: boolean;
}

export function ECHistoricalValues({ data, isLoading }: ECHistoricalValuesProps) {
    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center p-12 space-y-4">
                <Loader2 className="w-12 h-12 animate-spin text-primary opacity-50" />
                <p className="text-muted-foreground font-medium">Analyzing historical property values...</p>
            </div>
        );
    }

    if (!data || data.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-12 text-center bg-muted/20 rounded-2xl border-2 border-dashed">
                <History className="w-12 h-12 text-muted-foreground mb-4 opacity-20" />
                <h3 className="text-lg font-semibold">No Historical Transactions Found</h3>
                <p className="text-sm text-muted-foreground max-w-xs mx-auto mt-1">
                    No sale or transfer deeds were identified in the provided EC document.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card className="bg-primary/5 border-primary/10 shadow-sm">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-xs font-bold text-primary uppercase flex items-center gap-2">
                            <History className="w-3.5 h-3.5" />
                            Total Transactions
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-black text-slate-900">{data.length}</p>
                    </CardContent>
                </Card>
                <Card className="bg-green-50/50 border-green-100 shadow-sm">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-xs font-bold text-green-700 uppercase flex items-center gap-2">
                            <TrendingUp className="w-3.5 h-3.5" />
                            Avg. Sell Value / Sq.ft
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-black text-slate-900">
                            ₹{(data.reduce((acc, curr) => acc + (Number(curr.sell_value_per_sqft) || 0), 0) / data.length).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </p>
                    </CardContent>
                </Card>
                <Card className="bg-indigo-50/50 border-indigo-100 shadow-sm">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-xs font-bold text-indigo-700 uppercase flex items-center gap-2">
                            <IndianRupee className="w-3.5 h-3.5" />
                            Avg. Guideline / Sq.ft
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-black text-slate-900">
                            ₹{(data.reduce((acc, curr) => acc + (Number(curr.market_value_per_sqft) || 0), 0) / data.length).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </p>
                    </CardContent>
                </Card>
            </div>

            <div className="rounded-2xl border bg-card overflow-hidden shadow-xl">
                <Table>
                    <TableHeader className="bg-slate-900 hover:bg-slate-900 text-white">
                        <TableRow>
                            <TableHead className="text-white font-bold w-[150px]">Document No</TableHead>
                            <TableHead className="text-white font-bold">Area (Sq.ft)</TableHead>
                            <TableHead className="text-white font-bold">Sell Value</TableHead>
                            <TableHead className="text-white font-bold">Market Value</TableHead>
                            <TableHead className="text-white font-bold text-right">Value Gap</TableHead>
                            <TableHead className="text-white font-bold">Observation</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data.map((record, index) => {
                            const diff = record.sell_value_per_sqft - record.market_value_per_sqft;
                            const isGain = diff >= 0;

                            return (
                                <TableRow key={index} className="hover:bg-muted/50 transition-colors">
                                    <TableCell className="font-mono font-bold text-slate-600">
                                        {record.document_no}
                                    </TableCell>
                                    <TableCell className="font-medium">
                                        {(Number(record.area_sqft) || 0).toLocaleString()}
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className="font-bold text-slate-900">₹{(Number(record.actual_sell_value) || 0).toLocaleString('en-IN')}</span>
                                            <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-tighter">
                                                ₹{(Number(record.sell_value_per_sqft) || 0).toLocaleString()}/sq.ft
                                            </span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className="font-bold text-slate-500 line-clamp-1">₹{(Number(record.guideline_value) || 0).toLocaleString('en-IN')}</span>
                                            <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-tighter">
                                                ₹{(Number(record.market_value_per_sqft) || 0).toLocaleString()}/sq.ft
                                            </span>
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <Badge
                                            variant="outline"
                                            className={cn(
                                                "text-[10px] font-black",
                                                isGain ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"
                                            )}
                                        >
                                            {diff === 0 ? "NO GAP" : `${isGain ? "+" : ""}₹${(Number(diff) || 0).toLocaleString()}/sq.ft`}
                                        </Badge>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex items-center gap-2">
                                            {record.observation.toLowerCase().includes("sold at guideline") ? (
                                                <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                                            ) : (
                                                <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0" />
                                            )}
                                            <span className="text-xs font-semibold text-slate-700 leading-tight">
                                                {record.observation}
                                            </span>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}

function cn(...classes: any[]) {
    return classes.filter(Boolean).join(" ");
}
