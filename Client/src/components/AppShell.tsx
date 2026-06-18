import React, { createContext, useContext, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { LogOut, Sparkles } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";
import OverallChat from "@/features/analysis/components/OverallChat";

interface AppShellProps {
  children: React.ReactNode;
  /** When true, the shell is fixed-position and the page renders edge-to-edge under it
   * (used by canvas-style pages like the map and hierarchy graph). */
  fullBleed?: boolean;
}

/**
 * Header slot — pages can inject UI between the brand and the logout button
 * so per-page tabs (Overview / PDF Vault / Document Analysis / …) sit in the
 * same row as the global brand instead of stacking below it.
 *
 * Usage from a page:
 *   const { setHeaderSlot } = useHeaderSlot();
 *   useEffect(() => {
 *     setHeaderSlot(<MyTabs … />);
 *     return () => setHeaderSlot(null);
 *   }, [tab, parcel]);
 */
interface HeaderSlotContextValue {
  setHeaderSlot: (node: React.ReactNode) => void;
}
const HeaderSlotContext = createContext<HeaderSlotContextValue>({
  setHeaderSlot: () => {},
});
export const useHeaderSlot = () => useContext(HeaderSlotContext);

/**
 * Ask AI context — lets any section publish the property it's showing so the
 * shell can host ONE global "Ask AI" assistant that follows the user across
 * every part of the app. Same inversion-of-control pattern as the header slot:
 * the chat lives in the shell; pages just feed it context.
 *
 * Usage from a page (publish while mounted, clear on unmount / when no parcel):
 *   const { setAskAiContext } = useAskAi();
 *   useEffect(() => {
 *     setAskAiContext(parcelId ? { requestId, parcelId, docNumbers } : null);
 *     return () => setAskAiContext(null);
 *   }, [requestId, parcelId, docNumbers]);
 *
 * The launcher only renders when a context is published, so sections with no
 * property in scope (login / landing / map) show nothing to chat about.
 */
export interface AskAiContextData {
  requestId?: string;
  parcelId?: string;
  /** Property document numbers — drives the @-mention autocomplete. */
  docNumbers: string[];
}
interface AskAiContextValue {
  setAskAiContext: (ctx: AskAiContextData | null) => void;
}
const AskAiContext = createContext<AskAiContextValue>({
  setAskAiContext: () => {},
});
export const useAskAi = () => useContext(AskAiContext);

const AppShell: React.FC<AppShellProps> = ({ children, fullBleed = false }) => {
  const { user, logout } = useAuth();
  const [headerSlot, setHeaderSlot] = useState<React.ReactNode>(null);
  const ctxValue = useMemo(() => ({ setHeaderSlot }), []);

  // Global Ask AI — context published by the active section, chat hosted here.
  const [askAiCtx, setAskAiCtx] = useState<AskAiContextData | null>(null);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const askAiCtxValue = useMemo(() => ({ setAskAiContext: setAskAiCtx }), []);

  return (
    <AskAiContext.Provider value={askAiCtxValue}>
    <HeaderSlotContext.Provider value={ctxValue}>
      <div className={cn("min-h-screen flex flex-col bg-background", fullBleed && "h-screen overflow-hidden")}>
        <motion.header
          initial={{ y: -16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            "border-b border-border bg-white/85 backdrop-blur-md z-50 shrink-0",
            fullBleed ? "fixed top-0 left-0 right-0" : "sticky top-0",
          )}
        >
          <div className="px-4 sm:px-6 py-2.5 flex items-center gap-4">
            {/* Brand */}
            <Link to="/" className="flex items-center gap-2 group shrink-0">
              <img
                src="/data-flow.png"
                alt="LandwiseAI"
                className="h-7 w-7 transition-transform group-hover:rotate-6"
              />
              <span className="hidden sm:block text-base font-display font-extrabold tracking-tight text-foreground">
                Land<span className="text-gradient-primary">wiseAI</span>
              </span>
            </Link>

            {/* Page-injected center slot (parcel breadcrumb + tabs + actions
                live here so they share one row with the brand + logout). */}
            <div className="flex-1 min-w-0 flex items-center gap-3">
              {headerSlot}
            </div>

            {/* Logout icon button. Replaces the previous WORKSPACE/VERIFY/HIERARCHY/MAP
                tab strip and the username dropdown — navigation now happens via the
                sidebar + per-page tabs above. */}
            {user && (
              <button
                onClick={() => logout()}
                title={`Sign out (${user.full_name})`}
                aria-label="Sign out"
                className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-slate-200 bg-white text-slate-500 hover:text-red-600 hover:border-red-300 hover:bg-red-50 transition-colors shrink-0"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        </motion.header>

        {/* Main content. fullBleed adds top padding so fixed header doesn't overlap. */}
        <main className={cn("flex-1 min-h-0", fullBleed && "pt-14 h-full overflow-hidden")}>
          {children}
        </main>

        {/* GLOBAL ASK AI — one assistant for the whole app. Rendered only when
            the active section publishes a property context, so it follows the
            user across the dashboard tabs, the hierarchy graph, etc., and stays
            out of the way on pages with no property loaded. */}
        {askAiCtx && (
          <>
            {!askAiOpen && (
              <button
                type="button"
                onClick={() => setAskAiOpen(true)}
                className="fixed bottom-4 right-4 z-[290] inline-flex items-center gap-2 h-11 pl-3.5 pr-4 rounded-full text-white text-sm font-bold shadow-xl shadow-indigo-500/30 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 transition-all animate-in fade-in slide-in-from-bottom-4 duration-300"
                title="Ask AI about this property"
              >
                <Sparkles className="w-4 h-4" />
                Ask AI
              </button>
            )}
            {askAiOpen && (
              <OverallChat
                requestId={askAiCtx.requestId}
                parcelId={askAiCtx.parcelId}
                docNumbers={askAiCtx.docNumbers}
                onClose={() => setAskAiOpen(false)}
              />
            )}
          </>
        )}
      </div>
    </HeaderSlotContext.Provider>
    </AskAiContext.Provider>
  );
};

export default AppShell;
