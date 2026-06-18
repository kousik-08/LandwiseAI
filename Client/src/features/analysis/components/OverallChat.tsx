import React, { useState, useRef, useEffect, useMemo } from "react";
import { Send, Bot, Loader2, MessageSquare, X, Trash2, Sparkles, AtSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import { API_BASE_URL } from "@/lib/api";

interface Message {
    role: "user" | "assistant";
    content: string;
}

interface OverallChatProps {
    requestId?: string;
    parcelId?: string;
    /** All document numbers in the property — drives @-mention autocomplete. */
    docNumbers: string[];
    onClose?: () => void;
    /** Documents clicked into the conversation as silent context (rendered as
     *  dismissible chips and merged into `mentions` on send). */
    activeDocs?: string[];
    onRemoveActiveDoc?: (doc: string) => void;
    /** False when no analysis is active — disables sending and prompts the user
     *  to pick a property first. */
    hasContext?: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const OverallChat: React.FC<OverallChatProps> = ({
    requestId,
    parcelId,
    docNumbers,
    onClose,
    activeDocs = [],
    onRemoveActiveDoc,
    hasContext = true,
}) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // @-mention dropdown state
    const [mentionOpen, setMentionOpen] = useState(false);
    const [mentionQuery, setMentionQuery] = useState("");
    const [mentionStart, setMentionStart] = useState(0);
    const [mentionIndex, setMentionIndex] = useState(0);

    const storageKey = `overall_chat_v1_${requestId || "global"}`;
    const [isLoaded, setIsLoaded] = useState(false);

    // Load / persist history (same pattern as DocChat).
    useEffect(() => {
        const saved = sessionStorage.getItem(storageKey);
        if (saved) {
            try { setMessages(JSON.parse(saved)); } catch (e) { console.error("Failed to parse overall chat", e); }
        }
        setIsLoaded(true);
    }, [storageKey]);

    useEffect(() => {
        if (isLoaded) sessionStorage.setItem(storageKey, JSON.stringify(messages));
    }, [messages, storageKey, isLoaded]);

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [messages, isLoading]);

    // Recompute the active @-token from the input + caret position.
    const refreshMention = (value: string, caret: number) => {
        const before = value.slice(0, caret);
        const at = before.lastIndexOf("@");
        if (at === -1) { setMentionOpen(false); return; }
        if (at > 0 && !/\s/.test(before[at - 1])) { setMentionOpen(false); return; }
        const query = before.slice(at + 1);
        if (/\s/.test(query)) { setMentionOpen(false); return; }
        setMentionStart(at);
        setMentionQuery(query);
        setMentionIndex(0);
        setMentionOpen(true);
    };

    const filtered = useMemo(() => {
        if (!mentionOpen) return [];
        const q = norm(mentionQuery);
        const list = q ? docNumbers.filter((d) => norm(d).includes(q)) : docNumbers;
        return list.slice(0, 50);
    }, [mentionOpen, mentionQuery, docNumbers]);

    const selectMention = (doc: string) => {
        const caret = inputRef.current?.selectionStart ?? input.length;
        const before = input.slice(0, mentionStart);
        const after = input.slice(caret);
        const next = `${before}@${doc} ${after}`;
        setInput(next);
        setMentionOpen(false);
        setTimeout(() => {
            const pos = (before + `@${doc} `).length;
            inputRef.current?.focus();
            inputRef.current?.setSelectionRange(pos, pos);
        }, 0);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (mentionOpen && filtered.length > 0) {
            if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((i) => (i + 1) % filtered.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((i) => (i - 1 + filtered.length) % filtered.length); return; }
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectMention(filtered[mentionIndex]); return; }
            if (e.key === "Escape") { e.preventDefault(); setMentionOpen(false); return; }
        }
    };

    const extractMentions = (text: string): string[] => {
        const out: string[] = [];
        const re = /@([^\s@]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) out.push(m[1].replace(/[.,;]+$/, ""));
        return Array.from(new Set(out));
    };

    const handleSendMessage = async () => {
        if (!input.trim() || isLoading) return;
        if (mentionOpen) { setMentionOpen(false); }

        const text = input;
        const userMessage: Message = { role: "user", content: text };
        setMessages((prev) => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);

        // Documents clicked into context behave exactly like typed @-mentions.
        const mergedMentions = Array.from(
            new Set([...activeDocs, ...extractMentions(text)]),
        );

        try {
            const formData = new FormData();
            formData.append("message", text);
            if (requestId) formData.append("request_id", requestId);
            if (parcelId) formData.append("parcel_id", parcelId);
            formData.append("history", JSON.stringify(messages.slice(-6)));
            formData.append("mentions", JSON.stringify(mergedMentions));

            const response = await fetch(`${API_BASE_URL}/api/v1/chat-overall`, {
                method: "POST",
                body: formData,
            });
            if (!response.ok) throw new Error("Failed to get response");
            const data = await response.json();
            setMessages((prev) => [...prev, { role: "assistant", content: data.response }]);
        } catch (error) {
            console.error("Overall chat error:", error);
            setMessages((prev) => [
                ...prev,
                { role: "assistant", content: "⚠️ Sorry, I encountered an error. Please try again." },
            ]);
        } finally {
            setIsLoading(false);
        }
    };

    const clearChat = () => {
        setMessages([]);
        sessionStorage.removeItem(storageKey);
    };

    return (
        <Card className="fixed bottom-4 right-4 w-[min(440px,calc(100vw-2rem))] h-[min(620px,calc(100vh-2rem))] z-[300] border-primary/20 shadow-2xl overflow-hidden flex flex-col glass-ui animate-in slide-in-from-bottom-4 fade-in duration-300">
            <CardHeader className="bg-gradient-to-r from-indigo-600 to-violet-600 py-3 px-4 flex flex-row items-center justify-between space-y-0">
                <div className="flex items-center gap-2.5">
                    <div className="p-1.5 bg-white/20 rounded shadow-inner">
                        <Sparkles className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[10px] text-white/70 font-bold uppercase tracking-widest">Property AI Assistant</span>
                        <span className="text-sm font-bold text-white">Ask about this property</span>
                    </div>
                </div>
                {onClose && (
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-white hover:bg-white/10 rounded-full" onClick={onClose}>
                        <X className="w-4 h-4" />
                    </Button>
                )}
            </CardHeader>

            <CardContent className="flex-1 overflow-y-auto p-4 space-y-4 chat-scrollbar bg-white/50" ref={scrollRef}>
                {messages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-center space-y-3 opacity-70">
                        <div className="p-4 bg-primary/5 rounded-full">
                            <Bot className="w-9 h-9 text-primary" />
                        </div>
                        {hasContext ? (
                            <div className="space-y-1">
                                <p className="text-sm font-bold text-slate-700">Ask anything about this property</p>
                                <p className="text-xs text-slate-500 max-w-[260px]">
                                    Click a document or type <span className="font-mono font-bold text-primary">@</span> to reference it,
                                    then ask about ownership flow, mismatches, or the chain of transactions.
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-1">
                                <p className="text-sm font-bold text-slate-700">Ask me anything</p>
                                <p className="text-xs text-slate-500 max-w-[260px]">
                                    I can help with Indian property law, encumbrance certificates and how to
                                    use LandwiseAI. Open a property's analysis to ask about its specific documents.
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {messages.map((msg, i) => {
                    const isUser = msg.role === "user";
                    return (
                        <div key={i} className={cn("flex flex-col max-w-[88%] animate-in fade-in slide-in-from-bottom-2 duration-300", isUser ? "ml-auto items-end" : "mr-auto items-start")}>
                            <div className={cn("p-3 rounded-2xl text-sm leading-relaxed shadow-sm", isUser ? "bg-primary text-primary-foreground rounded-tr-none" : "bg-white text-slate-800 rounded-tl-none border border-slate-200")}>
                                <ReactMarkdown
                                    components={{
                                        p: ({ node, ...props }) => <p {...props} className="m-0 mb-2 last:mb-0" />,
                                        ul: ({ node, ...props }) => <ul {...props} className="list-disc pl-5 my-2 space-y-1" />,
                                        ol: ({ node, ...props }) => <ol {...props} className="list-decimal pl-5 my-2 space-y-1" />,
                                        li: ({ node, ...props }) => <li {...props} className="leading-relaxed" />,
                                        strong: ({ node, ...props }) => <strong {...props} className="font-bold" />,
                                        code: ({ node, ...props }) => (
                                            <code {...props} className={cn("px-1 py-0.5 rounded text-[12px] font-mono", isUser ? "bg-white/20 text-white" : "bg-slate-100 text-slate-800")} />
                                        ),
                                    }}
                                >
                                    {msg.content}
                                </ReactMarkdown>
                            </div>
                            <span className="text-[9px] text-slate-400 mt-1 uppercase font-bold tracking-widest">{isUser ? "You" : "AI Assistant"}</span>
                        </div>
                    );
                })}

                {isLoading && (
                    <div className="flex flex-col items-start mr-auto max-w-[80%] animate-pulse">
                        <div className="bg-slate-100 p-3 rounded-2xl rounded-tl-none border border-slate-200 flex items-center gap-2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                            <span className="text-xs text-slate-500 font-medium italic">Reviewing the chain...</span>
                        </div>
                    </div>
                )}
            </CardContent>

            <CardFooter className="p-3 border-t bg-slate-50/50 flex-col items-stretch gap-0 relative">
                {/* @-mention dropdown floats above the input */}
                {mentionOpen && (
                    <div className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto custom-scrollbar bg-white rounded-xl border border-primary/20 shadow-2xl z-[10] animate-in fade-in slide-in-from-bottom-1 duration-150">
                        <div className="px-3 py-1.5 text-[9px] font-extra-bold uppercase tracking-wider text-slate-400 border-b flex items-center gap-1">
                            <AtSign className="w-3 h-3" /> Documents
                        </div>
                        {filtered.length === 0 ? (
                            <div className="px-3 py-3 text-xs text-slate-400 italic">No document found</div>
                        ) : (
                            filtered.map((doc, idx) => (
                                <button
                                    key={doc}
                                    type="button"
                                    onMouseDown={(e) => { e.preventDefault(); selectMention(doc); }}
                                    onMouseEnter={() => setMentionIndex(idx)}
                                    className={cn(
                                        "w-full text-left px-3 py-2 text-xs font-mono font-bold flex items-center gap-2 transition-colors",
                                        idx === mentionIndex ? "bg-primary/10 text-primary" : "text-slate-700 hover:bg-slate-50"
                                    )}
                                >
                                    <MessageSquare className="w-3 h-3 opacity-60" />
                                    {doc}
                                </button>
                            ))
                        )}
                    </div>
                )}

                {/* Active document context — chips for documents clicked into the
                    conversation. Invisible in the input, but sent as mentions. */}
                {activeDocs.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 mb-2">
                        <span className="text-[9px] font-extra-bold uppercase tracking-wider text-slate-400">Context</span>
                        {activeDocs.map((doc) => (
                            <span
                                key={doc}
                                className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-mono font-bold border border-primary/20"
                            >
                                {doc}
                                {onRemoveActiveDoc && (
                                    <button
                                        type="button"
                                        onClick={() => onRemoveActiveDoc(doc)}
                                        className="rounded-full hover:bg-primary/20 p-0.5 transition-colors"
                                        title={`Remove ${doc} from context`}
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                )}

                <form className="flex w-full items-center gap-2" onSubmit={(e) => { e.preventDefault(); handleSendMessage(); }}>
                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-slate-400 hover:text-red-500 shrink-0" onClick={clearChat} disabled={messages.length === 0} title="Clear conversation">
                        <Trash2 className="w-4 h-4" />
                    </Button>
                    <Input
                        ref={inputRef}
                        value={input}
                        onChange={(e) => { setInput(e.target.value); refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
                        onKeyDown={handleKeyDown}
                        onClick={(e) => refreshMention((e.target as HTMLInputElement).value, (e.target as HTMLInputElement).selectionStart ?? 0)}
                        placeholder={hasContext ? "Ask about the property… type @ for a document" : "Ask me anything…"}
                        className="h-10 text-sm flex-1 bg-white border-primary/10 transition-all focus:ring-1 focus:ring-primary/30"
                        disabled={isLoading}
                    />
                    <Button disabled={!input.trim() || isLoading} size="icon" className="h-10 w-10 shrink-0 transition-transform active:scale-95 bg-primary hover:bg-primary/90">
                        <Send className="w-4 h-4" />
                    </Button>
                </form>
            </CardFooter>
        </Card>
    );
};

export default OverallChat;
