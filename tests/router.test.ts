import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/background/router";
import type { RouterDeps } from "../src/background/router";
import { EXTRACTION_CHUNK_TOKENS } from "../src/lib/extraction";
import { chunkText } from "../src/lib/chunker";
import type { LlmSettings } from "../src/lib/llmClient";
import { wrapUntrustedPageText, type ChatMessage } from "../src/lib/prompts";
import type { GraphStore, IngestInput, Subgraph } from "../src/lib/types";

const SETTINGS: LlmSettings = {
  baseUrl: "https://api.test/v1",
  apiKey: "sk-test",
  model: "gpt-x",
};

const PAGE = "Ada Lovelace designed the Analytical Engine.\n\nThe Engine was mechanical.";

const EXTRACT_OUT = {
  entities: [{ name: "Ada Lovelace", label: "Person", evidenceChunkIdx: [0] }],
  edges: [
    {
      fromName: "Ada Lovelace",
      fromLabel: "Person",
      toName: "Analytical Engine",
      toLabel: "Machine",
      type: "designed",
      evidenceChunkIdx: 0,
    },
  ],
};

const EMPTY_SUBGRAPH: Subgraph = { chunks: [], entities: [], edges: [] };

/** Fake store: records addDocument inputs, returns canned search/stats results. */
function fakeStore(subgraph: Subgraph = EMPTY_SUBGRAPH) {
  const added: IngestInput[] = [];
  const store: GraphStore = {
    addDocument: async (input) => {
      added.push(input);
      return {
        documentId: "doc-1",
        chunkCount: input.chunks.length,
        entityCount: input.entities.length,
        edgeCount: input.edges.length,
        errors: [],
      };
    },
    listEntities: async () => [],
    getEntityDetail: async () => null,
    getNeighbors: async () => ({ entities: [], edges: [] }),
    search: vi.fn(async () => subgraph),
    exportAll: async () => ({ version: 1, documents: [], chunks: [], entities: [], edges: [] }),
    importReplace: async () => {},
    deleteAll: async () => {},
    stats: async () => ({ documents: 1, chunks: 2, entities: 3, edges: 4 }),
  };
  return { store, added, search: store.search };
}

function makeDeps(opts: {
  settings?: LlmSettings | null;
  subgraph?: Subgraph;
  extract?: RouterDeps["extract"];
  chat?: RouterDeps["chat"];
}): RouterDeps & { added: IngestInput[]; search: ReturnType<typeof vi.fn> } {
  const { store, added, search } = fakeStore(opts.subgraph);
  return {
    store: async () => store,
    llm: async () => opts.settings === undefined ? SETTINGS : opts.settings,
    chat:
      opts.chat ??
      (async () => {
        throw new Error("chat not expected in this test");
      }),
    extract:
      opts.extract ??
      (async () => {
        throw new Error("extract not expected in this test");
      }),
    added,
    search,
  } as RouterDeps & { added: IngestInput[]; search: ReturnType<typeof vi.fn> };
}

describe("router: INGEST", () => {
  it("sensitive URL without confirmation → needsSensitiveConfirm, nothing extracted", async () => {
    let extractCalls = 0;
    const deps = makeDeps({
      extract: async () => {
        extractCalls++;
        return EXTRACT_OUT;
      },
    });
    const res = await handleRequest(
      {
        type: "INGEST",
        payload: {
          url: "https://mail.google.com/u/0",
          title: "Inbox",
          text: "private email body",
          sourceType: "page",
          sensitiveConfirmed: false,
        },
      },
      deps,
    );
    expect(res).toEqual({ ok: false, needsSensitiveConfirm: true });
    expect(extractCalls).toBe(0);
    expect(deps.added).toHaveLength(0);
  });

  it("happy path → wrapped text at the extract boundary, chunk-aligned IngestInput, report", async () => {
    const seen: { pageText?: string } = {};
    const deps = makeDeps({
      extract: async (_s, pageText) => {
        seen.pageText = pageText;
        return EXTRACT_OUT;
      },
    });
    const res = await handleRequest(
      {
        type: "INGEST",
        payload: {
          url: "https://example.com/doc",
          title: "Doc",
          text: PAGE,
          sourceType: "page",
          sensitiveConfirmed: false,
        },
      },
      deps,
    );

    // Review Focus #1: the router wraps page text before extract sees it.
    expect(seen.pageText).toBe(wrapUntrustedPageText(PAGE));
    expect(seen.pageText).toContain("BEGIN_PAGE_DATA");
    expect(seen.pageText).toContain("raw content");

    // The store receives chunks whose indices match extract's evidenceChunkIdx
    // numbering: chunkText of the SAME wrapped text with the SAME options.
    expect(deps.added).toHaveLength(1);
    const input = deps.added[0];
    expect(input.chunks).toEqual(
      chunkText(wrapUntrustedPageText(PAGE), { maxTokens: EXTRACTION_CHUNK_TOKENS }),
    );
    expect(input.document).toEqual({
      url: "https://example.com/doc",
      title: "Doc",
      sourceType: "page",
      capturedAt: expect.any(Number),
    });
    expect(input.entities[0]).toEqual({
      name: "Ada Lovelace",
      label: "Person",
      evidenceChunkIdx: [0],
    });
    expect(input.edges[0]).toEqual({
      fromName: "Ada Lovelace",
      fromLabel: "Person",
      toName: "Analytical Engine",
      toLabel: "Machine",
      type: "designed",
      evidenceChunkIdx: 0,
    });

    expect(res).toEqual({
      ok: true,
      report: {
        documentId: "doc-1",
        chunkCount: input.chunks.length,
        entityCount: 1,
        edgeCount: 1,
        errors: [],
      },
    });
  });

  it("flagged partial extraction errors surface in the report", async () => {
    const deps = makeDeps({
      extract: async () => ({ ...EXTRACT_OUT, errors: ["batch 1: invalid schema after retry"] }),
    });
    const res = await handleRequest(
      {
        type: "INGEST",
        payload: {
          url: "https://example.com/doc",
          title: "Doc",
          text: PAGE,
          sourceType: "page",
          sensitiveConfirmed: false,
        },
      },
      deps,
    );
    expect(res).toEqual({
      ok: true,
      report: {
        documentId: "doc-1",
        chunkCount: deps.added[0].chunks.length,
        entityCount: 1,
        edgeCount: 1,
        errors: ["batch 1: invalid schema after retry"],
      },
    });
  });

  it("settings null → 'LLM not connected', extract and store untouched", async () => {
    let extractCalls = 0;
    const deps = makeDeps({
      settings: null,
      extract: async () => {
        extractCalls++;
        return EXTRACT_OUT;
      },
    });
    const res = await handleRequest(
      {
        type: "INGEST",
        payload: {
          url: "https://example.com/doc",
          title: "Doc",
          text: PAGE,
          sourceType: "page",
          sensitiveConfirmed: false,
        },
      },
      deps,
    );
    expect(res).toEqual({ ok: false, error: "LLM not connected" });
    expect(extractCalls).toBe(0);
    expect(deps.added).toHaveLength(0);
  });

  it("extract throwing (network) → { ok: false, error }", async () => {
    const deps = makeDeps({ extract: async () => { throw new Error("network down"); } });
    const res = await handleRequest(
      {
        type: "INGEST",
        payload: {
          url: "https://example.com/doc",
          title: "Doc",
          text: PAGE,
          sourceType: "page",
          sensitiveConfirmed: false,
        },
      },
      deps,
    );
    expect(res).toEqual({ ok: false, error: "network down" });
  });

  it("non-Error throw is still stringified into the error message", async () => {
    const deps = makeDeps({ extract: async () => { throw "boom"; } });
    const res = await handleRequest(
      {
        type: "INGEST",
        payload: {
          url: "https://example.com/doc",
          title: "Doc",
          text: PAGE,
          sourceType: "page",
          sensitiveConfirmed: false,
        },
      },
      deps,
    );
    expect(res).toEqual({ ok: false, error: "boom" });
  });
});

describe("router: ASK", () => {
  it("empty subgraph → answer + empty citations, budgeted search, history echoed", async () => {
    const chatCalls: ChatMessage[][] = [];
    const deps = makeDeps({
      chat: async (_s, messages) => {
        chatCalls.push(messages);
        return "Not in the graph.";
      },
    });
    const history: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const res = await handleRequest(
      { type: "ASK", payload: { question: "What is X?", history } },
      deps,
    );
    expect(res).toEqual({ ok: true, answer: "Not in the graph.", citations: {} });
    expect(deps.search).toHaveBeenCalledWith("What is X?", {
      maxTokens: 4000,
      maxChunks: 24,
    });
    // History is echoed back unchanged into the chat messages (after system).
    expect(chatCalls[0][0].role).toBe("system");
    expect(chatCalls[0].slice(1, 1 + history.length)).toEqual(history);
    // The question reaches the chat as the final user message.
    expect(chatCalls[0][chatCalls[0].length - 1]).toEqual({
      role: "user",
      content: "What is X?",
    });
  });

  it("happy path → citations map [Ci] to the subgraph's chunk records", async () => {
    const subgraph: Subgraph = {
      chunks: [
        { id: "c0", documentId: "d0", text: "alpha text", index: 0, superseded: false },
        { id: "c1", documentId: "d0", text: "beta text", index: 1, superseded: false },
      ],
      entities: [],
      edges: [],
    };
    const deps = makeDeps({
      subgraph,
      chat: async () => "Alpha is alpha text [C0] and beta is beta text [C1].",
    });
    const res = await handleRequest(
      { type: "ASK", payload: { question: "What is alpha?", history: [] } },
      deps,
    );
    expect(res).toEqual({
      ok: true,
      answer: "Alpha is alpha text [C0] and beta is beta text [C1].",
      citations: {
        0: { chunkId: "c0", text: "alpha text" },
        1: { chunkId: "c1", text: "beta text" },
      },
    });
  });

  it("settings null → 'LLM not connected'", async () => {
    const deps = makeDeps({ settings: null });
    const res = await handleRequest(
      { type: "ASK", payload: { question: "What is X?", history: [] } },
      deps,
    );
    expect(res).toEqual({ ok: false, error: "LLM not connected" });
  });

  it("chat throwing (network) → { ok: false, error }", async () => {
    const deps = makeDeps({ chat: async () => { throw new Error("network down"); } });
    const res = await handleRequest(
      { type: "ASK", payload: { question: "What is X?", history: [] } },
      deps,
    );
    expect(res).toEqual({ ok: false, error: "network down" });
  });
});

describe("router: STATS", () => {
  it("returns the store's stats", async () => {
    const deps = makeDeps({});
    const res = await handleRequest({ type: "STATS" }, deps);
    expect(res).toEqual({ ok: true, stats: { documents: 1, chunks: 2, entities: 3, edges: 4 } });
  });
});

describe("router: LIST_ENTITIES", () => {
  it("returns the store's entity array", async () => {
    const fake = [{ id: "e1", name: "Ada", label: "Person", properties: {} }];
    const deps = makeDeps({});
    (deps.store as unknown as () => Promise<unknown>)();
    // stub listEntities
    const store = await deps.store();
    store.listEntities = async () => fake as never;
    const res = await handleRequest({ type: "LIST_ENTITIES" }, deps);
    expect(res).toEqual({ ok: true, entities: fake });
  });
});

describe("router: ENTITY_DETAIL", () => {
  it("returns detail for known id", async () => {
    const detail = { entity: { id: "e1", name: "Ada", label: "Person", properties: {} }, chunks: [{ id: "c1", text: "hi", superseded: false }] };
    const deps = makeDeps({});
    const store = await deps.store();
    store.getEntityDetail = async () => detail as never;
    const res = await handleRequest({ type: "ENTITY_DETAIL", payload: { id: "e1" } }, deps);
    expect(res).toEqual({ ok: true, detail });
  });
  it("returns null for unknown id", async () => {
    const deps = makeDeps({});
    const store = await deps.store();
    store.getEntityDetail = async () => null;
    const res = await handleRequest({ type: "ENTITY_DETAIL", payload: { id: "nope" } }, deps);
    expect(res).toEqual({ ok: true, detail: null });
  });
});
