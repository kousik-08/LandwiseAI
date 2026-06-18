
import React, { useMemo, useCallback, useState, useEffect } from 'react';
import ReactFlow, {
    Background,
    Controls,
    MiniMap,
    Node,
    Edge,
    ConnectionMode,
    ReactFlowProvider,
    Handle,
    Position,
    useReactFlow,
} from 'reactflow';
import { Plus, Minus, Info, FileText, User, MapPin, Minimize2, Ruler } from "lucide-react";
import 'reactflow/dist/style.css';
import './FlowStyles.css';
import { Badge } from "@/components/ui/badge";

import { motion, AnimatePresence } from 'framer-motion';
import { cn } from "@/lib/utils";

// Normalize a document number for tolerant matching against validation
// results ("3765/2008" -> "37652008"). Mirrors the server _normalize_docno.
const normDocNo = (s: any): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Custom Node Component to support Collapse/Expand and Tooltip
const HierarchyNode = ({ data, id }: any) => {
    const isCollapsed = data.isCollapsed;
    const hasChildren = data.hasChildren;
    const [showTooltip, setShowTooltip] = useState(false);

    return (
        <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{
                type: "spring",
                stiffness: 260,
                damping: 20,
                delay: Math.random() * 0.5 // Subtle staggering
            }}
            className={`relative group h-full w-full ${data.className || ''}`}
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
        >
            <div className="hierarchy-node-content">
                {/* Tooltip */}
                {showTooltip && data.document_number && (
                    <div className="absolute z-[2000] bottom-full left-1/2 -translate-x-1/2 mb-3 w-72 bg-slate-900 text-white rounded-xl shadow-2xl p-4 border border-white/10 backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 duration-200 pointer-events-none">
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-white/10">
                            {data.document_number === 'NO TRANSACTION FOUND' ? (
                                <Info className="w-4 h-4 text-primary" />
                            ) : (
                                <FileText className="w-4 h-4 text-primary" />
                            )}
                            <span className="font-bold text-sm tracking-tight">{data.document_number === 'NO TRANSACTION FOUND' ? 'Hierarchy Context' : 'Document Details'}</span>
                        </div>

                        <div className="space-y-2.5 text-left">
                            {data.document_number !== 'NO TRANSACTION FOUND' && (
                                <div className="flex justify-between items-start gap-4">
                                    <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider shrink-0">Doc No</span>
                                    <span className="text-xs font-mono text-primary font-bold">{data.document_number}</span>
                                </div>
                            )}
                            <div className="flex justify-between items-start gap-4">
                                <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider shrink-0">S.No</span>
                                <span className="text-xs text-white truncate">{data.survey_number}</span>
                            </div>
                            <div className="flex justify-between items-start gap-4">
                                <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider shrink-0">Nature</span>
                                <span className="text-xs text-white line-clamp-2 text-right">{data.nature}</span>
                            </div>
                            {data.document_number !== 'NO TRANSACTION FOUND' && (
                                <>
                                    <div className="flex justify-between items-start gap-4">
                                        <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider shrink-0">Executant</span>
                                        <span className="text-xs text-white line-clamp-1 text-right">{data.executant}</span>
                                    </div>
                                    <div className="flex justify-between items-start gap-4">
                                        <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider shrink-0">Claimant</span>
                                        <span className="text-xs text-white line-clamp-1 text-right">{data.claimant}</span>
                                    </div>
                                    <div className="flex justify-between items-start gap-4 pt-1">
                                        <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider shrink-0">Area</span>
                                        <div className="flex items-center gap-1 bg-white/5 px-2 py-0.5 rounded text-xs font-bold text-primary">
                                            <Ruler className="w-3 h-3" />
                                            {data.sq_feet}
                                        </div>
                                    </div>
                                </>
                            )}
                            {data.notes && (
                                <div className="mt-2 pt-2 border-t border-white/5">
                                    <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block mb-1">Note</span>
                                    <span className="text-[11px] text-slate-300 italic leading-snug block">{data.notes}</span>
                                </div>
                            )}
                        </div>
                        {/* Tooltip Arrow */}
                        <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-slate-900" />
                    </div>
                )}

                {/* Connection Handles */}
                <Handle type="target" position={Position.Top} className="opacity-0" />

                {/* Expand/collapse pill — anchored inside the top-right corner
                    so it's always visible (the previous absolute -bottom-3
                    button was easy to miss against the dashed edges). Only
                    rendered when this node actually has descendants. */}
                {hasChildren && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            data.onToggleCollapse(id);
                        }}
                        className={cn(
                            "absolute top-1.5 right-1.5 z-50 inline-flex items-center gap-1 h-6 px-2 rounded-full text-[10px] font-extra-bold uppercase tracking-wider shadow-md transition-all hover:scale-[1.05] active:scale-[0.96]",
                            isCollapsed
                                ? "bg-gradient-to-r from-emerald-500 to-teal-600 text-white"
                                : "bg-white text-slate-700 border border-slate-300 hover:border-primary hover:text-primary",
                        )}
                        title={isCollapsed ? `Expand ${data.childCount ?? ""} child node${data.childCount === 1 ? "" : "s"}` : "Collapse children"}
                    >
                        {isCollapsed ? <Plus className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                        <span>{data.childCount ?? ""}</span>
                    </button>
                )}

                <div className="flex flex-col">
                    <div className="whitespace-pre-wrap text-[11px] leading-relaxed pr-10">
                        {data.label}
                    </div>
                </div>

                <Handle type="source" position={Position.Bottom} className="opacity-0" />

                {/* Visual Indicator for Collapsed State (the small bar on the
                    bottom edge that hints "more below"). */}
                {isCollapsed && hasChildren && (
                    <div className="absolute -bottom-1 left-4 right-4 h-1 bg-primary/20 rounded-full blur-[1px]" />
                )}
            </div>
        </motion.div>
    );
};

const nodeTypes = {
    default: HierarchyNode,
};

interface ReactFlowHierarchyProps {
    data: {
        nodes: Node[];
        edges: Edge[];
    };
    // Optional second arg carries full node data (used by Timeline Search)
    // Third arg = viewport click position, so callers can anchor a popup at the
    // clicked node. Optional — existing callers ignore it.
    onNodeClick: (docNo: string, data?: any, position?: { x: number; y: number }) => void;
    onNotesChange?: (docNo: string, notes: string) => void;
    searchTerm?: string;
    // Validation results (keyed by document_number, each with a `match`
    // boolean). Lets the graph tint a node GREEN when its document matched
    // and RED when it mismatched. Optional — absent = no match coloring.
    validationResults?: any[];
}

const ReactFlowHierarchyInner: React.FC<ReactFlowHierarchyProps> = ({ data, onNodeClick, onNotesChange, searchTerm, validationResults }) => {
    const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
    const { nodes: initialNodes, edges: initialEdges } = data;
    const { fitView } = useReactFlow();

    // Initialize collapse state based on data volume
    useEffect(() => {
        const initialCollapsed = new Set<string>();

        // Define threshold: If nodes are few (approx <= 10 transactions plus metadata nodes), show all
        const shouldCollapse = initialNodes.length > 15;

        if (shouldCollapse) {
            initialNodes.forEach(node => {
                // Collapse nodes at Level 1 and below if they have children
                if (node.data && node.data.level >= 1) {
                    const hasDescendants = initialEdges.some(e => e.source === node.id);
                    if (hasDescendants) {
                        initialCollapsed.add(node.id);
                    }
                }
            });
        }

        setCollapsedNodes(initialCollapsed);

        // ReactFlow needs to measure node dimensions before fitView can position
        // the viewport. On a fresh data load (e.g. timeline search) the first
        // attempt fires before measurements settle and the canvas appears blank
        // until the user clicks the "centralize" control. Retry across a few
        // animation frames + a fallback timeout to handle that race.
        if (initialNodes.length === 0) return;

        let cancelled = false;
        let attempts = 0;
        const maxAttempts = 8;

        const tryFit = () => {
            if (cancelled) return;
            attempts += 1;
            try {
                fitView({ padding: 0.2, duration: attempts === 1 ? 0 : 600 });
            } catch {
                /* ignore — instance may not yet be ready */
            }
            if (attempts < maxAttempts) {
                requestAnimationFrame(tryFit);
            }
        };

        // Two rAFs ensures ReactFlow has committed nodes and measured them
        const raf1 = requestAnimationFrame(() => requestAnimationFrame(tryFit));
        // Final safety pass after typical layout settles
        const t = window.setTimeout(() => {
            try { fitView({ padding: 0.2, duration: 600 }); } catch { /* noop */ }
        }, 450);

        return () => {
            cancelled = true;
            cancelAnimationFrame(raf1);
            clearTimeout(t);
        };
    }, [initialNodes, initialEdges, fitView]);

    const onToggleCollapse = useCallback((nodeId: string) => {
        setCollapsedNodes((prev) => {
            const next = new Set(prev);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }, []);

    const hiddenNodeIds = useMemo(() => {
        const hidden = new Set<string>();
        const hideDescendants = (parentId: string) => {
            const childEdges = initialEdges.filter(e => e.source === parentId);
            childEdges.forEach(edge => {
                hidden.add(edge.target);
                hideDescendants(edge.target);
            });
        };
        collapsedNodes.forEach(nodeId => {
            hideDescendants(nodeId);
        });
        return hidden;
    }, [collapsedNodes, initialEdges]);

    // Pre-compute direct child counts per node so the toggle pill can show
    // "+ 6" / "− 6" instead of just the icon. Single linear scan over edges.
    const childCountByParent = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const e of initialEdges) {
            counts[e.source] = (counts[e.source] || 0) + 1;
        }
        return counts;
    }, [initialEdges]);

    // Build a doc-number -> matched(boolean) lookup from validation results so
    // each node can be tinted by its match status. Tolerates the top-level
    // `match` flag and the nested `validation_result.match` shape.
    const matchByDoc = useMemo(() => {
        const map: Record<string, boolean> = {};
        (validationResults || []).forEach((r: any) => {
            const key = normDocNo(r?.document_number ?? r?.doc_no);
            if (!key) return;
            const matched = r?.match ?? r?.validation_result?.match ?? r?.validation?.match;
            if (typeof matched === 'boolean') map[key] = matched;
        });
        return map;
    }, [validationResults]);

    const processedNodes = useMemo(() => {
        const lowerSearch = searchTerm?.toLowerCase() || "";
        return initialNodes.map(node => {
            const childCount = childCountByParent[node.id] || 0;
            const hasChildren = childCount > 0;
            const matches = lowerSearch && (
                node.data?.document_number?.toLowerCase().includes(lowerSearch) ||
                node.data?.survey_number?.toLowerCase().includes(lowerSearch) ||
                node.data?.claimant?.toLowerCase().includes(lowerSearch) ||
                node.data?.executant?.toLowerCase().includes(lowerSearch)
            );

            // Validation match status for this node's document (if any).
            const docKey = normDocNo(node.data?.document_number);
            const matchStatus = docKey in matchByDoc
                ? (matchByDoc[docKey] ? "matched" : "mismatch")
                : undefined;

            return {
                ...node,
                hidden: hiddenNodeIds.has(node.id),
                className: cn(
                    node.className,
                    matchStatus === "matched" ? "node-matched" : "",
                    matchStatus === "mismatch" ? "node-mismatch" : "",
                    matches ? "ring-4 ring-yellow-400 ring-offset-4 shadow-2xl scale-110 z-[5000]" : "",
                    lowerSearch && !matches ? "opacity-30 grayscale" : ""
                ),
                data: {
                    ...node.data,
                    className: node.className, // Pass style class to custom node
                    hasChildren,
                    childCount,
                    isCollapsed: collapsedNodes.has(node.id),
                    onToggleCollapse,
                    isHighlighted: matches,
                    matchStatus
                }
            };
        });
    }, [initialNodes, initialEdges, hiddenNodeIds, collapsedNodes, onToggleCollapse, searchTerm, childCountByParent, matchByDoc]);

    // Bulk expand/collapse helpers used by the toolbar pill in the legend.
    const collapseAll = useCallback(() => {
        const all = new Set<string>();
        for (const e of initialEdges) all.add(e.source);
        setCollapsedNodes(all);
    }, [initialEdges]);
    const expandAll = useCallback(() => {
        setCollapsedNodes(new Set());
    }, []);

    const processedEdges = useMemo(() => {
        return initialEdges.map(edge => ({
            ...edge,
            hidden: hiddenNodeIds.has(edge.target) || hiddenNodeIds.has(edge.source),
            animated: !collapsedNodes.has(edge.source),
        }));
    }, [initialEdges, hiddenNodeIds, collapsedNodes]);

    const handleNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
        if (node.data && node.data.document_number) {
            onNodeClick(node.data.document_number, node.data, { x: event.clientX, y: event.clientY });
        }
    }, [onNodeClick]);

    return (
        <div className="w-full h-full min-h-[500px] bg-slate-50/50 relative">
            {/* Bulk expand/collapse controls. The "Deed Registry (TN)" deed-type
                legend was removed — node colours are now driven by validation
                match status (green = matched, red = mismatch), not deed type, so
                the old colour key no longer reflects what the user sees. */}
            <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
                <div className="bg-white/95 backdrop-blur shadow-xl border p-2 rounded-2xl flex items-center gap-1">
                    <button
                        onClick={expandAll}
                        className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-md text-[9px] font-extra-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors"
                        title="Expand every node"
                    >
                        <Plus className="w-3 h-3" />
                        Expand all
                    </button>
                    <button
                        onClick={collapseAll}
                        className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-md text-[9px] font-extra-bold uppercase tracking-wider bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100 transition-colors"
                        title="Collapse every parent node"
                    >
                        <Minus className="w-3 h-3" />
                        Collapse all
                    </button>
                </div>
            </div>

            <ReactFlow
                nodes={processedNodes}
                edges={processedEdges}
                onNodeClick={handleNodeClick}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.5 }}
                connectionMode={ConnectionMode.Loose}
                className="hierarchy-flow"
            >
                <Background gap={20} color="#e2e8f0" />
                <Controls />
                <MiniMap
                    nodeColor={(node) => {
                        if (node.className?.includes('sale')) return '#16a34a';
                        if (node.className?.includes('mortgage')) return '#dc2626';
                        if (node.className?.includes('gift')) return '#9333ea';
                        if (node.className?.includes('settlement')) return '#2563eb';
                        if (node.className?.includes('release')) return '#ea580c';
                        if (node.className?.includes('partition')) return '#0d9488';
                        if (node.className?.includes('power')) return '#4b5563';
                        return '#94a3b8';
                    }}
                    maskColor="rgba(248, 250, 252, 0.7)"
                />
            </ReactFlow>
        </div>
    );
};

export const ReactFlowHierarchy: React.FC<ReactFlowHierarchyProps> = (props) => {
    return (
        <ReactFlowProvider>
            <ReactFlowHierarchyInner {...props} />
        </ReactFlowProvider>
    );
};
