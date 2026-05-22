import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, StickyNote, Search, X, Trash2, ArrowRight, FileText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface DocNote {
  id: string;
  text: string;
  page?: number | null;
  createdAt: number;
}

interface DocumentNotesPanelProps {
  docNumber: string | null;
  requestId?: string;
  onJumpToPage?: (page: number) => void;
}

const storageKey = (requestId: string | undefined, docNumber: string) =>
  `da-notes:${requestId || "no-req"}:${docNumber}`;

const loadNotes = (requestId: string | undefined, docNumber: string): DocNote[] => {
  try {
    const raw = localStorage.getItem(storageKey(requestId, docNumber));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is DocNote => n && typeof n.id === "string" && typeof n.text === "string");
  } catch {
    return [];
  }
};

const saveNotes = (requestId: string | undefined, docNumber: string, notes: DocNote[]) => {
  try {
    localStorage.setItem(storageKey(requestId, docNumber), JSON.stringify(notes));
  } catch (e) {
    console.warn("Failed to persist document notes", e);
  }
};

const formatTimestamp = (ts: number) => {
  try {
    return new Date(ts).toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
};

export function DocumentNotesPanel({ docNumber, requestId, onJumpToPage }: DocumentNotesPanelProps) {
  const [notes, setNotes] = useState<DocNote[]>([]);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftPage, setDraftPage] = useState<string>("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!docNumber) {
      setNotes([]);
      return;
    }
    setNotes(loadNotes(requestId, docNumber));
    setComposing(false);
    setDraft("");
    setDraftPage("");
    setQuery("");
  }, [docNumber, requestId]);

  const persistAndSet = useCallback(
    (next: DocNote[]) => {
      setNotes(next);
      if (docNumber) saveNotes(requestId, docNumber, next);
    },
    [docNumber, requestId],
  );

  const addNote = useCallback(() => {
    const text = draft.trim();
    if (!text) {
      toast.error("Note can't be empty");
      return;
    }
    const parsedPage = draftPage.trim() ? parseInt(draftPage.trim(), 10) : null;
    const page = parsedPage && Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : null;
    const note: DocNote = {
      id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      page,
      createdAt: Date.now(),
    };
    persistAndSet([note, ...notes]);
    setDraft("");
    setDraftPage("");
    setComposing(false);
    toast.success("Note saved");
  }, [draft, draftPage, notes, persistAndSet]);

  const deleteNote = useCallback(
    (id: string) => {
      if (!window.confirm("Delete this note?")) return;
      persistAndSet(notes.filter((n) => n.id !== id));
    },
    [notes, persistAndSet],
  );

  const visibleNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => n.text.toLowerCase().includes(q) || String(n.page ?? "").includes(q));
  }, [notes, query]);

  if (!docNumber) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 text-slate-400">
        <div className="w-12 h-12 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center mb-3">
          <StickyNote className="w-5 h-5 text-slate-300" />
        </div>
        <p className="text-sm font-bold text-slate-500">No document selected</p>
        <p className="text-[11px] mt-1 max-w-[220px]">Pick a deed on the left to view and add notes scoped to that document.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-amber-50/70 via-white to-white shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
            <StickyNote className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-display font-extrabold text-slate-900 leading-none">
              Document Notes
            </p>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.16em] mt-0.5 flex items-center gap-1.5 truncate">
              <FileText className="w-3 h-3 shrink-0" />
              <span className="font-mono truncate">{docNumber}</span>
              <span className="text-slate-300">·</span>
              <span>{notes.length} note{notes.length === 1 ? "" : "s"}</span>
            </p>
          </div>
          <button
            onClick={() => setComposing((c) => !c)}
            className={cn(
              "shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[10px] font-extrabold uppercase tracking-wider transition-all",
              composing
                ? "bg-slate-100 text-slate-600 hover:bg-slate-200"
                : "bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow hover:shadow-md active:scale-95",
            )}
          >
            {composing ? <X className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
            {composing ? "Cancel" : "New"}
          </button>
        </div>

        {composing && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/40 p-2.5 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Capture an observation, doubt, or follow-up for this deed…"
              className="w-full min-h-[72px] resize-none text-xs leading-relaxed bg-white border border-amber-200 rounded-md px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-amber-300/60 placeholder:text-slate-400"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Input
                value={draftPage}
                onChange={(e) => setDraftPage(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="Page #"
                className="h-7 w-20 text-[11px] bg-white"
                inputMode="numeric"
              />
              <button
                onClick={addNote}
                className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-[10px] font-extrabold uppercase tracking-wider bg-slate-900 text-white shadow hover:bg-slate-800 active:scale-95 transition-all"
              >
                Save note
              </button>
            </div>
          </div>
        )}

        {notes.length > 0 && (
          <div className="relative mt-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search this document's notes…"
              className="h-8 pl-8 pr-7 text-xs"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-2">
        {visibleNotes.length === 0 && notes.length === 0 && (
          <div className="text-center py-10 px-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center mb-3">
              <StickyNote className="w-5 h-5 text-slate-300" />
            </div>
            <p className="text-sm font-bold text-slate-600">No notes for this deed</p>
            <p className="text-[11px] text-slate-400 mt-1">
              Use <span className="font-bold text-amber-600">+ New</span> to record an observation. Notes are tied to this document and saved locally.
            </p>
          </div>
        )}

        {visibleNotes.length === 0 && notes.length > 0 && (
          <p className="text-center text-[11px] text-slate-400 italic py-6">No notes match your search.</p>
        )}

        {visibleNotes.map((note) => (
          <div
            key={note.id}
            className="group rounded-lg border border-slate-200 bg-white p-3 hover:border-amber-300 hover:shadow-sm transition-all"
          >
            <p className="text-xs leading-relaxed text-slate-800 whitespace-pre-wrap break-words">
              {note.text}
            </p>
            <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-slate-100">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[9px] text-slate-400 font-mono truncate">
                  {formatTimestamp(note.createdAt)}
                </span>
                {note.page && (
                  <Badge className="text-[8px] h-4 px-1.5 bg-slate-100 text-slate-600 border-0 font-bold uppercase tracking-wider">
                    pg {note.page}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {note.page && onJumpToPage && (
                  <button
                    onClick={() => onJumpToPage(note.page!)}
                    className="text-[9px] font-bold text-primary inline-flex items-center gap-0.5 px-1.5 py-1 rounded border border-primary/30 bg-white hover:bg-primary/5 transition-colors"
                    title={`Jump to page ${note.page}`}
                  >
                    <ArrowRight className="w-2.5 h-2.5" /> Open
                  </button>
                )}
                <button
                  onClick={() => deleteNote(note.id)}
                  className="text-[9px] font-bold text-red-500 inline-flex items-center gap-0.5 px-1.5 py-1 rounded border border-red-200 bg-white hover:bg-red-50 transition-colors"
                  title="Delete note"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-2 border-t border-slate-100 bg-slate-50/50 shrink-0">
        <p className="text-[9px] text-slate-400 font-bold uppercase tracking-[0.16em]">
          Saved locally · Per-document · {requestId ? "Scoped to current request" : "Unscoped"}
        </p>
      </div>
    </div>
  );
}
