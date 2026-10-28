import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCapture, type CaptureDeps } from "../src/background/capture";
import type { RouterDeps } from "../src/background/router";
import type { LlmSettings } from "../src/lib/llmClient";
import type { GraphStore, IngestInput, Subgraph } from "../src/lib/types";

const SETTINGS: LlmSettings = {
  baseUrl: "https://api.test/v1",
  apiKey: "sk-test",
  model: "gpt-x",
};

const PAGE_TEXT = "Ada Lovelace designed the Analytical Engine. The Engine was mechanical.";
const SELECTION_TEXT = "The Analytical Engine was never completed in her lifetime.";

const TAB = { id: 7, url: "https://example.test/ada", title: "Ada Lovelace" } as chrome.tabs.Tab;

function fakeStore(): GraphStore & { added: IngestInput[] } {
  const added: IngestInput[] = [];
  return {
    added,
    addDocument: async (input) => {
      added.push(input);
      return { documentId: "doc-1", chunkCount: 12, entityCount: 34, edgeCount: 18, errors: [] };
    },
    listEntities: async () => [],
    getEntityDetail: async () => null,
    getNeighbors: async () => ({ entities: [], edges: [] }),
    search: async (): Promise<Subgraph> => ({ chunks: [], entities: [], edges: [] }),
    exportAll: async () => ({ version: 1, documents: [], chunks: [], entities: [], edges: [] }),
    importReplace: async () => {},
    deleteAll: async () => {},
    stats: async () => ({ documents: 1, chunks: 2, entities: 3, edges: 4 }),
  };
}

/** Router deps (llm/chat/extract/store) plus stubbed chrome.* capture access. */
function makeDeps(opts?: {
  tabs?: chrome.tabs.Tab[];
  readerResult?: unknown;
}): CaptureDeps & { added: IngestInput[]; executeScript: ReturnType<typeof vi.fn> } {
  const store = fakeStore();
  const executeScript = vi.fn(async () => [
    { result: opts?.readerResult ?? { title: "Ada Lovelace", text: PAGE_TEXT } },
  ]);
  return {
    store: async () => store,
    llm: async () => SETTINGS,
    chat: async () => {
      throw new Error("chat not expected in this test");
    },
    extract: async () => ({
      entities: [{ name: "Ada Lovelace", label: "Person", evidenceChunkIdx: [0] }],
      edges: [],
    }),
    queryTabs: vi.fn(async () => opts?.tabs ?? [TAB]),
    executeScript,
    added: store.added,
  };
}

/** Copies of deps with one field replaced, staying CaptureDeps-typed. */
function override(deps: CaptureDeps, patch: Partial<CaptureDeps>): CaptureDeps {
  return { ...deps, ...patch };
}

const PAGE_REQ = { type: "CAPTURE", payload: { sourceType: "page", sensitiveConfirmed: false } } as const;
const SELECTION_REQ = { type: "CAPTURE", payload: { sourceType: "selection", sensitiveConfirmed: false } } as const;

describe("handleCapture (background owns tabs.query + executeScript)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("page capture: queries the active tab, runs pageReader, then INGESTs url/title/text", async () => {
    const res = await handleCapture(PAGE_REQ, deps);

    expect(deps.queryTabs).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(deps.executeScript).toHaveBeenCalledTimes(1);
    const injection = deps.executeScript.mock.calls[0][0];
    expect(injection.target).toEqual({ tabId: 7 });

    expect(res).toEqual({
      ok: true,
      report: { documentId: "doc-1", chunkCount: 12, entityCount: 34, edgeCount: 18, errors: [] },
    });
    expect(deps.added).toHaveLength(1);
    expect(deps.added[0].document).toEqual({
      url: "https://example.test/ada",
      title: "Ada Lovelace",
      sourceType: "page",
      capturedAt: expect.any(Number),
    });
    // The router wraps untrusted page text before chunking; the raw text is
    // inside the wrapper, so it is a substring of the stored chunk.
    expect(deps.added[0].chunks.join("\n")).toContain(PAGE_TEXT);
  });

  it("selection capture: runs selectionReader, titles the document from the tab", async () => {
    const res = await handleCapture(SELECTION_REQ, override(deps, {
      executeScript: vi.fn(async () => [{ result: SELECTION_TEXT }]),
    }));

    expect(res).toEqual({
      ok: true,
      report: { documentId: "doc-1", chunkCount: 12, entityCount: 34, edgeCount: 18, errors: [] },
    });
    expect(deps.added).toHaveLength(1);
    expect(deps.added[0].document.sourceType).toBe("selection");
    expect(deps.added[0].chunks.join("\n")).toContain(SELECTION_TEXT);
  });

  it("falls back to currentWindow if lastFocusedWindow returns no tabs", async () => {
    const queryTabs = vi.fn(async (q: chrome.tabs.QueryInfo) => {
      if (q.lastFocusedWindow) return [];
      return [TAB];
    });
    const res = await handleCapture(PAGE_REQ, override(deps, { queryTabs }));

    expect(queryTabs).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
  });

  it("empty page text surfaces a clear failure and does not write to the store", async () => {
    const res = await handleCapture(PAGE_REQ, override(deps, {
      executeScript: vi.fn(async () => [{ result: null }]),
    }));

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/could not read/i) });
    expect(deps.added).toHaveLength(0);
  });

  it("empty selection surfaces a clear failure and does not write to the store", async () => {
    const res = await handleCapture(SELECTION_REQ, override(deps, {
      executeScript: vi.fn(async () => [{ result: "" }]),
    }));

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/no .*selection/i) });
    expect(deps.added).toHaveLength(0);
  });

  it("no active tab is a clean failure", async () => {
    const res = await handleCapture(PAGE_REQ, override(deps, { queryTabs: vi.fn(async () => []) }));

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/no active tab/i) });
    expect(deps.executeScript).not.toHaveBeenCalled();
  });

  it("executeScript failures (e.g. no host access) surface as { ok: false, error }", async () => {
    const res = await handleCapture(PAGE_REQ, override(deps, {
      executeScript: vi.fn(async () => {
        throw new Error("Cannot access contents of the page");
      }),
    }));

    expect(res).toEqual({ ok: false, error: "Cannot access contents of the page" });
    expect(deps.added).toHaveLength(0);
  });
});
