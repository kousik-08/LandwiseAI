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
                            <FileText className="w-4 h-4 text-primary" />
                            <span className="font-bold text-sm tracking-tight">Document Details</span>
                        </div>

                        <div className="space-y-2.5 text-left">
                            <div className="flex justify-between items-start gap-4">
                                <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider shrink-0">Doc No</span>
                                <span className="text-xs font-mono text-primary font-bold">{data.document_number}</span>
                            </div>
                            <div className="flex justify-between items-start gap-4">
                                <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider shrink-0">S.No</span>
                                <span className="text-xs text-white truncate">{data.survey_number}</span>
                            </div>
                            <div className="flex justify-between items-start gap-4">
                                <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider shrink-0">Nature</span>
                                <span className="text-xs text-white line-clamp-2 text-right">{data.nature}</span>
                            </div>
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
                        </div>
                        {/* Tooltip Arrow */}
                        <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-slate-900" />
                    </div>
                )}

                {/* Connection Handles */}
                <Handle type="target" position={Position.Top} className="opacity-0" />

                <div className="flex flex-col">
                    <div className="whitespace-pre-wrap text-[11px] leading-relaxed">
                        {data.label}
                    </div>

                    {hasChildren && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                data.onToggleCollapse(id);
                            }}
                            className="absolute -bottom-3 left-1/2 -translate-x-1/2 w-6 h-6 rounded-full bg-white border-2 border-primary text-primary flex items-center justify-center hover:bg-primary hover:text-white transition-all shadow-md z-50"
                        >
                            {isCollapsed ? <Plus className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                        </button>
                    )}
                </div>

                <Handle type="source" position={Position.Bottom} className="opacity-0" />

                {/* Visual Indicator for Collapsed State */}
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
    onNodeClick: (docNo: string) => void;
    onNotesChange?: (docNo: string, notes: string) => void;
}

const ReactFlowHierarchyInner: React.FC<ReactFlowHierarchyProps> = ({ data, onNodeClick, onNotesChange }) => {
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

        setTimeout(() => {
            fitView({ padding: 0.2, duration: 800 });
        }, 100);
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

    const processedNodes = useMemo(() => {
        return initialNodes.map(node => {
            const hasChildren = initialEdges.some(e => e.source === node.id);
            return {
                ...node,
                hidden: hiddenNodeIds.has(node.id),
                data: {
                    ...node.data,
                    className: node.className, // Pass style class to custom node
                    hasChildren,
                    isCollapsed: collapsedNodes.has(node.id),
                    onToggleCollapse
                }
            };
        });
    }, [initialNodes, initialEdges, hiddenNodeIds, collapsedNodes, onToggleCollapse]);

    const processedEdges = useMemo(() => {
        return initialEdges.map(edge => ({
            ...edge,
            hidden: hiddenNodeIds.has(edge.target) || hiddenNodeIds.has(edge.source),
            animated: !collapsedNodes.has(edge.source),
        }));
    }, [initialEdges, hiddenNodeIds, collapsedNodes]);

    const handleNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
        if (node.data && node.data.document_number) {
            onNodeClick(node.data.document_number);
        }
    }, [onNodeClick]);

    return (
        <div className="w-full h-full min-h-[500px] bg-slate-50/50 relative">
            {/* Legend / Overlay */}
            <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
                <div className="bg-white/95 backdrop-blur shadow-xl border p-4 rounded-2xl flex flex-col gap-3 min-w-[200px]">
                    <span className="text-[10px] font-black tracking-[0.1em] text-slate-400 uppercase border-b pb-2">Deed Registry (TN)</span>
                    <div className="grid grid-cols-1 gap-2">
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-green-500 border border-green-700 shadow-sm" />
                            <span className="text-[10px] font-bold text-slate-600">SALE DEED</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-red-500 border border-red-700 shadow-sm" />
                            <span className="text-[10px] font-bold text-slate-600">MORTGAGE / HYPOTHECATION</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-purple-500 border border-purple-700 shadow-sm" />
                            <span className="text-[10px] font-bold text-slate-600">GIFT DEED</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-blue-500 border border-blue-700 shadow-sm" />
                            <span className="text-[10px] font-bold text-slate-600">SETTLEMENT DEED</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-orange-500 border border-orange-700 shadow-sm" />
                            <span className="text-[10px] font-bold text-slate-600">RELEASE DEED</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-teal-500 border border-teal-700 shadow-sm" />
                            <span className="text-[10px] font-bold text-slate-600">PARTITION DEED</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-slate-500 border border-slate-700 shadow-sm" />
                            <span className="text-[10px] font-bold text-slate-600">POWER OF ATTORNEY</span>
                        </div>
                    </div>
                    <div className="mt-2 pt-2 border-t flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 opacity-70">
                            <div className="w-3 h-3 rounded-full border-2 border-primary border-dashed" />
                            <span className="text-[9px] font-medium text-slate-500 italic">SURVEY BRANCH</span>
                        </div>
                        <div className="flex items-center gap-2 opacity-70">
                            <Plus className="w-3 h-3 text-primary" />
                            <span className="text-[9px] font-medium text-slate-500 italic">EXPAND LAYER</span>
                        </div>
                    </div>
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
