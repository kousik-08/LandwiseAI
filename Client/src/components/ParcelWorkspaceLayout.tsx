/**
 * ParcelWorkspaceLayout — the dark left-sidebar shell used whenever a
 * parcel is selected inside LegalDashboard.
 *
 * Replaces the previous in-header tab strip (Overview / PDF Vault /
 * Document Analysis / …) with a vertical workspace nav on the left. The
 * top-bar content (search, parcel pills, register survey, notes hub, user)
 * is injected separately into AppShell's existing headerSlot from the
 * parent — see LegalDashboard's setHeaderSlot useEffect.
 *
 * Acts purely as a presentation layer — the parent still owns activeTab,
 * selectedParcelId, etc. This component is just the chrome around them.
 */
import React from "react";
import { cn } from "@/lib/utils";
import {
    LayoutDashboard,
    FolderOpen,
    FileSearch,
    Clock,
    Users,
    AlertTriangle,
    ShieldCheck,
    StickyNote,
} from "lucide-react";

interface ParcelWorkspaceLayoutProps {
    /** Active workspace tab (overview / pdf-vault / documents / timeline / ownership-audit / risks / opinion). */
    activeTab: string;
    setActiveTab: (tab: string) => void;

    /** Opens the parcel-wide Notes Hub dialog (it's an action, not a tab). */
    onNotesHubClick?: () => void;

    /** Active-survey card content at the top of the dark sidebar. */
    activeSurveyLabel?: string;
    activeSurveySubtitle?: string;

    /** Tab content. */
    children: React.ReactNode;
}

interface NavItem {
    id: string;
    label: string;
    sublabel: string;
    icon: React.ComponentType<{ className?: string }>;
}

// Primary workspace nav — IDs map 1:1 to LegalDashboard's activeTab values so
// the rest of the dashboard doesn't need to change. Notes Hub sits at the end
// of this group as an action (handled separately, not an activeTab).
const WORKSPACE_ITEMS: NavItem[] = [
    { id: "overview", label: "Overview", sublabel: "Title health summary", icon: LayoutDashboard },
    { id: "documents", label: "Document Analysis", sublabel: "AI extraction & review", icon: FileSearch },
    { id: "timeline", label: "Timeline", sublabel: "Chronological chain", icon: Clock },
    { id: "ownership-audit", label: "Ownership Audit", sublabel: "Chain of ownership", icon: Users },
    { id: "risks", label: "Risk Score", sublabel: "Encumbrance risk", icon: AlertTriangle },
    { id: "opinion", label: "Legal Opinion", sublabel: "Advisory verdict", icon: ShieldCheck },
];

// Document-store nav, pinned to the bottom under its own "Documents" heading.
const DOCUMENT_ITEMS: NavItem[] = [
    { id: "pdf-vault", label: "Document Repository", sublabel: "All survey documents", icon: FolderOpen },
];

const ParcelWorkspaceLayout: React.FC<ParcelWorkspaceLayoutProps> = ({
    activeTab,
    setActiveTab,
    onNotesHubClick,
    activeSurveyLabel,
    activeSurveySubtitle,
    children,
}) => {
    // Shared row renderer so the workspace tabs, the Notes Hub action, and the
    // bottom Documents group all read identically.
    const renderNavRow = (
        item: { id: string; label: string; sublabel: string; icon: NavItem["icon"] },
        opts: { active: boolean; onClick: () => void },
    ) => {
        const Icon = item.icon;
        const { active, onClick } = opts;
        return (
            <button
                key={item.id}
                type="button"
                onClick={onClick}
                className={cn(
                    "w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all duration-200 group active:scale-[0.98]",
                    active
                        ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/30"
                        : "text-slate-300 hover:bg-slate-800/70 hover:text-white",
                )}
            >
                <Icon
                    className={cn(
                        "w-4 h-4 shrink-0 mt-0.5 transition-colors",
                        active ? "text-white" : "text-slate-400 group-hover:text-indigo-300",
                    )}
                />
                <div className="min-w-0">
                    <div className="text-xs font-bold leading-tight">{item.label}</div>
                    <div
                        className={cn(
                            "text-[9px] mt-0.5 leading-tight truncate",
                            active ? "text-indigo-100/80" : "text-slate-500 group-hover:text-slate-400",
                        )}
                    >
                        {item.sublabel}
                    </div>
                </div>
            </button>
        );
    };

    return (
        <div className="h-full w-full flex bg-slate-50 overflow-hidden">
            {/* Dark workspace sidebar */}
            <aside className="shrink-0 w-56 bg-slate-900 text-slate-100 flex flex-col">
                <div className="px-4 py-4 border-b border-slate-800">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center text-[10px] font-extrabold">
                            LW
                        </div>
                        <div className="min-w-0">
                            <div className="text-sm font-display font-extrabold tracking-tight leading-tight truncate">
                                LandwiseAI
                            </div>
                            <div className="text-[9px] uppercase tracking-[0.16em] font-bold text-indigo-300/80 leading-none">
                                Legal Intelligence
                            </div>
                        </div>
                    </div>
                    {activeSurveyLabel && (
                        <div className="rounded-lg bg-slate-800/70 border border-slate-700/60 px-2.5 py-2">
                            <div className="text-[8px] uppercase tracking-[0.18em] font-bold text-indigo-300/80 mb-0.5">
                                Active Survey
                            </div>
                            <div className="text-sm font-bold text-white leading-tight">{activeSurveyLabel}</div>
                            {activeSurveySubtitle && (
                                <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                                    {activeSurveySubtitle}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Primary workspace nav + Notes Hub action (top group), with the
                    Documents store pinned to the bottom under its own heading. */}
                <div className="flex-1 overflow-y-auto px-2 py-3 flex flex-col">
                    <div className="space-y-0.5">
                        <div className="px-2 pb-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">
                            Workspace
                        </div>
                        {WORKSPACE_ITEMS.map(item =>
                            renderNavRow(item, {
                                active: activeTab === item.id,
                                onClick: () => setActiveTab(item.id),
                            }),
                        )}
                        {onNotesHubClick &&
                            renderNavRow(
                                {
                                    id: "notes-hub",
                                    label: "Annotations",
                                    sublabel: "Annotations across every PDF",
                                    icon: StickyNote,
                                },
                                { active: false, onClick: onNotesHubClick },
                            )}
                    </div>

                    <div className="pt-3 space-y-0.5">
                        <div className="px-2 pt-2 pb-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500 border-t border-slate-800/80">
                            Documents
                        </div>
                        {DOCUMENT_ITEMS.map(item =>
                            renderNavRow(item, {
                                active: activeTab === item.id,
                                onClick: () => setActiveTab(item.id),
                            }),
                        )}
                    </div>
                </div>
            </aside>

            {/* Tab content */}
            <main className="flex-1 min-w-0 overflow-auto bg-slate-50">
                {children}
            </main>
        </div>
    );
};

export default ParcelWorkspaceLayout;
