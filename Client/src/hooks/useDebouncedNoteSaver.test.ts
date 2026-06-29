import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDebouncedNoteSaver } from "./useDebouncedNoteSaver";

// The Notes Hub saves per-node notes through a single shared debounced saver
// instance (HierarchyPage / SurveyTimeline each create ONE
// `useDebouncedNoteSaver()` and call it with whichever node's docNo the user
// edits). These tests pin down that editing two different nodes in quick
// succession must not lose either note.

describe("useDebouncedNoteSaver", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const bodyDocNo = (init: unknown): string =>
    JSON.parse((init as RequestInit).body as string).doc_no;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("persists notes for two different docs edited within the debounce window", () => {
    const { result } = renderHook(() => useDebouncedNoteSaver(1000));

    // User finishes a note on node A...
    result.current("docA", "note for A");
    // ...then 300ms later (inside the 1s window) edits a DIFFERENT node B.
    vi.advanceTimersByTime(300);
    result.current("docB", "note for B");

    // Let every debounce timer elapse.
    vi.advanceTimersByTime(2000);

    const savedDocNos = fetchMock.mock.calls.map(([, init]) => bodyDocNo(init));
    // Both edits must reach the server. With a single shared timer, editing B
    // cancels A's pending save, so "docA" is silently dropped.
    expect(savedDocNos).toContain("docB");
    expect(savedDocNos).toContain("docA");
  });

  it("coalesces rapid edits to the SAME doc into one save with the latest text", () => {
    const { result } = renderHook(() => useDebouncedNoteSaver(1000));

    result.current("docA", "v1");
    vi.advanceTimersByTime(200);
    result.current("docA", "v2");
    vi.advanceTimersByTime(200);
    result.current("docA", "v3");
    vi.advanceTimersByTime(2000);

    // Debounce intent preserved: one network call, carrying the final text.
    const sameDocCalls = fetchMock.mock.calls.filter(
      ([, init]) => bodyDocNo(init) === "docA",
    );
    expect(sameDocCalls).toHaveLength(1);
    expect(JSON.parse((sameDocCalls[0][1] as RequestInit).body as string).note).toBe("v3");
  });
});
