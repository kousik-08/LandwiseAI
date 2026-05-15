import React, { useState, useRef, useEffect } from "react";
import { Send, Bot, User, Loader2, MessageSquare, X, Trash2, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import { API_BASE_URL } from "@/lib/api";

interface Message {
    role: "user" | "assistant";
    content: string;
}

interface DocChatProps {
    docNo: string;
    requestId?: string;
    parcelId?: string;
    onClose?: () => void;
    onPageClick?: (page: number) => void;
}

const DocChat: React.FC<DocChatProps> = ({ docNo, requestId, parcelId, onClose, onPageClick }) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    const storageKey = `chat_history_v3_${docNo}_${requestId || 'global'}`;
    const [isLoaded, setIsLoaded] = useState(false);

    // Load initial messages from sessionStorage
    useEffect(() => {
        const saved = sessionStorage.getItem(storageKey);
        if (saved) {
            try {
                setMessages(JSON.parse(saved));
            } catch (e) {
                console.error("Failed to parse saved chat", e);
            }
        }
        setIsLoaded(true);
    }, [storageKey]);

    // Save messages to sessionStorage whenever they change
    useEffect(() => {
        if (isLoaded) {
            sessionStorage.setItem(storageKey, JSON.stringify(messages));
        }
    }, [messages, storageKey, isLoaded]);

    // Auto scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, isLoading]);

    const handleSendMessage = async () => {
        if (!input.trim() || isLoading) return;

        const userMessage: Message = { role: "user", content: input };
        setMessages((prev) => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);

        try {
            const formData = new FormData();
            formData.append("doc_no", docNo);
            if (requestId) formData.append("request_id", requestId);
            if (parcelId) formData.append("parcel_id", parcelId);
            formData.append("message", input);
            formData.append("history", JSON.stringify(messages.slice(-6))); // Send last 3 rounds

            const API_URL = API_BASE_URL;
            const response = await fetch(`${API_URL}/api/v1/chat-with-doc`, {
                method: "POST",
                body: formData,
            });

            if (!response.ok) throw new Error("Failed to get response");

            const data = await response.json();
            const assistantMessage: Message = {
                role: "assistant",
                content: data.response
            };
            setMessages((prev) => [...prev, assistantMessage]);
        } catch (error) {
            console.error("Chat Error:", error);
            setMessages((prev) => [
                ...prev,
                { role: "assistant", content: "⚠️ Sorry, I encountered an error. Please try again or check if the document is available in the vault." }
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
        <Card className={cn(
            "border-primary/20 shadow-xl overflow-hidden flex flex-col transition-all duration-500 ease-in-out glass-ui",
            isExpanded
                // z-[200] sits above PdfAnnotator's TEXT/DRAW toggle (z-100) and the
                // Single-PDF-Matching button (z-30) so the floating chatbot doesn't
                // get pierced by PDF chrome from the panel underneath.
                ? "fixed bottom-4 right-4 w-[min(620px,calc(100vw-2rem))] h-[min(780px,calc(100vh-2rem))] z-[200]"
                : "h-full w-full border-none shadow-none"
        )}>
            <CardHeader className="bg-primary/95 backdrop-blur-sm py-3 px-5 flex flex-row items-center justify-between space-y-0">
                <div className="flex items-center gap-2.5">
                    <div className="p-1.5 bg-white/20 rounded shadow-inner">
                        <MessageSquare className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[10px] text-white/70 font-bold uppercase tracking-widest">Legal AI Assistant</span>
                        <span className="text-sm font-bold text-white">Chatting about #{docNo}</span>
                    </div>
                </div>
                <div className="flex items-center gap-0.5">
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-white hover:bg-white/10 rounded-full"
                        onClick={() => setIsExpanded(!isExpanded)}
                        title={isExpanded ? "Collapse chat" : "Pop out larger chat"}
                    >
                        {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                    </Button>
                    {onClose && (
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-white hover:bg-white/10 rounded-full"
                            onClick={onClose}
                        >
                            <X className="w-4 h-4" />
                        </Button>
                    )}
                </div>
            </CardHeader>

            <CardContent className="flex-1 overflow-y-auto p-5 space-y-5 chat-scrollbar bg-white/40" ref={scrollRef}>
                {messages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-center space-y-3 opacity-60">
                        <div className="p-5 bg-primary/5 rounded-full">
                            <Bot className="w-10 h-10 text-primary" />
                        </div>
                        <div className="space-y-1">
                            <p className="text-base font-bold text-slate-700">How can I help you with this deed?</p>
                            <p className="text-xs text-slate-500 max-w-[260px]">Ask about boundary details, area calculations, executant hierarchy or date specifics.</p>
                        </div>
                        <div className="flex flex-wrap justify-center gap-1.5 pt-2">
                            {["Summary", "Executants", "Area Details"].map(btn => (
                                <Button
                                    key={btn}
                                    variant="outline"
                                    className="text-[10px] h-7 px-2.5 py-0 border-primary/20 text-primary hover:bg-primary/5"
                                    onClick={() => { setInput(`Give me a ${btn.toLowerCase()} of this document.`); }}
                                >
                                    {btn}
                                </Button>
                            ))}
                        </div>
                    </div>
                )}

                {messages.map((msg, i) => {
                    const isUser = msg.role === "user";
                    return (
                    <div
                        key={i}
                        className={cn(
                            "flex flex-col max-w-[85%] animate-in fade-in slide-in-from-bottom-2 duration-300",
                            isUser ? "ml-auto items-end" : "mr-auto items-start"
                        )}
                    >
                        <div className={cn(
                            "p-3.5 rounded-2xl text-sm leading-relaxed shadow-sm",
                            isUser
                                ? "bg-primary text-primary-foreground rounded-tr-none"
                                : "bg-white text-slate-800 rounded-tl-none border border-slate-200"
                        )}>
                            <ReactMarkdown
                                components={{
                                    // Page citations render as in-bubble jump buttons
                                    a: ({ node, ...props }) => {
                                        if (props.href?.startsWith("#page-")) {
                                            const page = parseInt(props.href.replace("#page-", ""));
                                            return (
                                                <button
                                                    onClick={() => onPageClick?.(page)}
                                                    className={cn(
                                                        "inline-flex items-center gap-1 px-1.5 py-0.5 font-bold rounded hover:bg-primary/30 transition-colors mx-0.5",
                                                        isUser
                                                            ? "bg-white/20 text-white hover:bg-white/30"
                                                            : "bg-primary/10 text-primary"
                                                    )}
                                                >
                                                    <Maximize2 className="w-3 h-3" />
                                                    {props.children}
                                                </button>
                                            );
                                        }
                                        return <a {...props} />;
                                    },
                                    p: ({ node, ...props }) => (
                                        <p {...props} className="m-0 mb-2 last:mb-0" />
                                    ),
                                    ul: ({ node, ...props }) => (
                                        <ul {...props} className="list-disc pl-5 my-2 space-y-1" />
                                    ),
                                    ol: ({ node, ...props }) => (
                                        <ol {...props} className="list-decimal pl-5 my-2 space-y-1" />
                                    ),
                                    li: ({ node, ...props }) => (
                                        <li {...props} className="leading-relaxed" />
                                    ),
                                    code: ({ node, ...props }) => (
                                        <code
                                            {...props}
                                            className={cn(
                                                "px-1 py-0.5 rounded text-[12px] font-mono",
                                                isUser ? "bg-white/20 text-white" : "bg-slate-100 text-slate-800",
                                            )}
                                        />
                                    ),
                                    strong: ({ node, ...props }) => (
                                        <strong {...props} className="font-bold" />
                                    ),
                                }}
                            >
                                {msg.content.replace(/\[\[Page:(\d+)\]\]/g, "[Page $1](#page-$1)")}
                            </ReactMarkdown>
                        </div>
                        <span className="text-[9px] text-slate-400 mt-1 uppercase font-bold tracking-widest">
                            {isUser ? "You" : "AI Assistant"}
                        </span>
                    </div>
                    );
                })}

                {isLoading && (
                    <div className="flex flex-col items-start mr-auto max-w-[80%] animate-pulse">
                        <div className="bg-slate-100 p-3.5 rounded-2xl rounded-tl-none border border-slate-200 flex items-center gap-2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                            <span className="text-xs text-slate-500 font-medium italic">Analyzing deed...</span>
                        </div>
                    </div>
                )}
            </CardContent>

            <CardFooter className="p-3.5 border-t bg-slate-50/50">
                <form
                    className="flex w-full items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); handleSendMessage(); }}
                >
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-slate-400 hover:text-red-500 shrink-0"
                        onClick={clearChat}
                        disabled={messages.length === 0}
                        title="Clear conversation"
                    >
                        <Trash2 className="w-4 h-4" />
                    </Button>

                    {onClose && (
                        <Button
                            type="button"
                            variant="secondary"
                            className="h-9 px-3 text-[11px] font-bold shrink-0 hover:bg-slate-200"
                            onClick={onClose}
                        >
                            Cancel
                        </Button>
                    )}
                    <Input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Ask about this document..."
                        className="h-10 text-sm flex-1 bg-white border-primary/10 transition-all focus:ring-1 focus:ring-primary/30"
                        disabled={isLoading}
                    />
                    <Button
                        disabled={!input.trim() || isLoading}
                        size="icon"
                        className="h-10 w-10 shrink-0 transition-transform active:scale-95 bg-primary hover:bg-primary/90"
                    >
                        <Send className="w-4 h-4" />
                    </Button>
                </form>
            </CardFooter>
        </Card>
    );
};

export default DocChat;
