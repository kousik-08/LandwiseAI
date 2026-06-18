import React from "react";
import { Sparkles } from "lucide-react";
import { useChatWidget } from "@/context/ChatWidgetContext";
import OverallChat from "@/features/analysis/components/OverallChat";

/**
 * Floating Property AI Assistant.
 *
 * Mounted once in {@link AppShell} so it lives in the bottom-right corner of
 * every protected page. The collapsed launcher toggles the {@link OverallChat}
 * panel; all chat context (current parcel/request, picked documents) is read
 * from {@link useChatWidget}.
 */
const ChatWidget: React.FC = () => {
    const {
        requestId,
        parcelId,
        docNumbers,
        hasContext,
        activeDocs,
        removeActiveDoc,
        isOpen,
        open,
        close,
    } = useChatWidget();

    return (
        <>
            {!isOpen && (
                <button
                    onClick={open}
                    title="Ask the property AI assistant"
                    aria-label="Open property AI assistant"
                    className="fixed bottom-4 right-4 z-[300] inline-flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-indigo-600 via-violet-600 to-indigo-600 text-white shadow-2xl shadow-violet-500/40 ring-1 ring-white/20 hover:scale-105 active:scale-95 transition-transform animate-in fade-in zoom-in-90 duration-300"
                >
                    <Sparkles className="w-6 h-6" />
                </button>
            )}

            {isOpen && (
                <OverallChat
                    requestId={requestId}
                    parcelId={parcelId}
                    docNumbers={docNumbers}
                    activeDocs={activeDocs}
                    onRemoveActiveDoc={removeActiveDoc}
                    hasContext={hasContext}
                    onClose={close}
                />
            )}
        </>
    );
};

export default ChatWidget;
