import { useCallback, useRef } from "react";
import { API_BASE_URL } from "@/lib/api";

/**
 * Shared debounced note saver for hierarchy/timeline nodes.
 * Avoids relying on window-level timers and centralizes the API call.
 */
export function useDebouncedNoteSaver(delay = 1000) {
  // One timer PER docNo. A single shared timer meant that editing a different
  // node within the debounce window cancelled the previous node's pending
  // save, silently dropping that note. Keying by docNo lets each node debounce
  // independently while still coalescing rapid edits to the SAME node.
  const timersRef = useRef<Map<string, number>>(new Map());

  const saveNote = useCallback(
    (docNo: string, note: string) => {
      const pending = timersRef.current.get(docNo);
      if (pending !== undefined) {
        window.clearTimeout(pending);
      }

      const timer = window.setTimeout(async () => {
        timersRef.current.delete(docNo);
        try {
          await fetch(`${API_BASE_URL}/api/v1/save-node-note`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ doc_no: docNo, note }),
          });
        } catch (e) {
          console.error("Failed to save note:", e);
        }
      }, delay);

      timersRef.current.set(docNo, timer);
    },
    [delay],
  );

  return saveNote;
}

