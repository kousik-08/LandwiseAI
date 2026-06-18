import React, {
    createContext,
    useContext,
    useState,
    useCallback,
    useMemo,
} from "react";

/**
 * Global state for the floating "Property AI Assistant" chat widget.
 *
 * The widget is mounted once in {@link AppShell} so it floats over every
 * protected page. Pages that have an active analysis (currently the timeline
 * inside the dashboard) publish their parcel/request context here via
 * {@link setAnalysisContext}; the widget reads it to know what to talk about.
 *
 * When no analysis context is active the widget stays usable but prompts the
 * user to select a property instead of sending a context-free question.
 *
 * Documents can be pushed into the conversation as silent context (feature:
 * "click a document to ask about it") via {@link addActiveDoc}. These render as
 * dismissible chips above the input and are merged into the backend `mentions`
 * field on send — exactly as if the user had typed `@<doc>`.
 */
interface AnalysisContextInput {
    requestId?: string;
    parcelId?: string;
    docNumbers?: string[];
}

interface ChatWidgetContextValue {
    // Current analysis context (published by the active page).
    requestId?: string;
    parcelId?: string;
    docNumbers: string[];
    /** True when there is an analysis to ask about (drives the prompt state). */
    hasContext: boolean;

    // Documents clicked into the conversation as silent context.
    activeDocs: string[];
    addActiveDoc: (doc: string) => void;
    removeActiveDoc: (doc: string) => void;
    clearActiveDocs: () => void;

    // Open / close state for the floating panel.
    isOpen: boolean;
    open: () => void;
    close: () => void;
    toggle: () => void;

    /** Pages call this to publish (or clear) the current analysis context. */
    setAnalysisContext: (ctx: AnalysisContextInput) => void;
}

const ChatWidgetContext = createContext<ChatWidgetContextValue | null>(null);

export const useChatWidget = (): ChatWidgetContextValue => {
    const ctx = useContext(ChatWidgetContext);
    if (!ctx) {
        throw new Error("useChatWidget must be used within a ChatWidgetProvider");
    }
    return ctx;
};

export const ChatWidgetProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const [requestId, setRequestId] = useState<string | undefined>(undefined);
    const [parcelId, setParcelId] = useState<string | undefined>(undefined);
    const [docNumbers, setDocNumbers] = useState<string[]>([]);
    const [activeDocs, setActiveDocs] = useState<string[]>([]);
    const [isOpen, setIsOpen] = useState(false);

    const addActiveDoc = useCallback((doc: string) => {
        const d = (doc || "").trim();
        if (!d) return;
        setActiveDocs((prev) => (prev.includes(d) ? prev : [...prev, d]));
    }, []);

    const removeActiveDoc = useCallback((doc: string) => {
        setActiveDocs((prev) => prev.filter((d) => d !== doc));
    }, []);

    const clearActiveDocs = useCallback(() => setActiveDocs([]), []);

    const open = useCallback(() => setIsOpen(true), []);
    const close = useCallback(() => setIsOpen(false), []);
    const toggle = useCallback(() => setIsOpen((v) => !v), []);

    const setAnalysisContext = useCallback((ctx: AnalysisContextInput) => {
        const nextRequestId = ctx.requestId || undefined;
        // Switching to a different analysis invalidates any picked documents.
        setRequestId((prev) => {
            if (prev !== nextRequestId) setActiveDocs([]);
            return nextRequestId;
        });
        setParcelId(ctx.parcelId || undefined);
        setDocNumbers(ctx.docNumbers || []);
    }, []);

    const value = useMemo<ChatWidgetContextValue>(
        () => ({
            requestId,
            parcelId,
            docNumbers,
            hasContext: !!requestId,
            activeDocs,
            addActiveDoc,
            removeActiveDoc,
            clearActiveDocs,
            isOpen,
            open,
            close,
            toggle,
            setAnalysisContext,
        }),
        [
            requestId,
            parcelId,
            docNumbers,
            activeDocs,
            addActiveDoc,
            removeActiveDoc,
            clearActiveDocs,
            isOpen,
            open,
            close,
            toggle,
            setAnalysisContext,
        ],
    );

    return (
        <ChatWidgetContext.Provider value={value}>
            {children}
        </ChatWidgetContext.Provider>
    );
};
