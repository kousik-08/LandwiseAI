import { useCallback, useRef } from "react";
import { API_BASE_URL } from "@/lib/api";

/**
 * Shared debounced note saver for hierarchy/timeline nodes.
 * Avoids relying on window-level timers and centralizes the API call.
 */
export function useDebouncedNoteSaver(delay = 1000) {
  const timerRef = useRef<number | null>(null);

  const saveNote = useCallback(
    (docNo: string, note: string) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }

      timerRef.current = window.setTimeout(async () => {
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
    },
    [delay],
  );

  return saveNote;
}

