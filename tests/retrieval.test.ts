import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { bm25Rank } from "../src/lib/bm25";
import { assembleSubgraph, tokenize } from "../src/lib/retrieval";
import { createLocalStore } from "../src/lib/localStore";
import { tokenCount } from "../src/lib/chunker";
import type { IngestInput } from "../src/lib/types";

// Fresh IndexedDB instance per test so no data leaks between tests.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function page(
  url: string,
  title: string,
  capturedAt: number,
): IngestInput["document"] {
  return { url, title, sourceType: "page", capturedAt };
}

// Two documents: the first carries entities + one edge, the second exists so
// the ranked list can include chunks that pull nothing in.
const docA: IngestInput = {
  document: page("https://example.com/graph", "Graph notes", 1700000000000),
  chunks: [
    "Kestrel Labs builds the capture engine for the browser.", // A0
    "Ada joined Kestrel Labs to work on the graph store.", // A1
    "The subgraph assembler runs inside the service worker.", // A2
  ],
  entities: [
    { label: "Tool", name: "Kestrel Labs", properties: {}, evidenceChunkIdx: [0] },
    { label: "Person", name: "Ada", properties: {}, evidenceChunkIdx: [1] },
  ],
  edges: [
    {
      fromName: "Kestrel Labs",
      fromLabel: "Tool",
      toName: "Ada",
      toLabel: "Person",
      type: "built_by",
      evidenceChunkIdx: 1,
    },
  ],
};

const docB: IngestInput = {
  document: page("https://example.com/metrics", "Metrics", 1700000001000),
  chunks: [
    "Grafana dashboards visualize ingestion metrics.", // B0
    "Random notes about weather and coffee.", // B1
  ],
  entities: [
    { label: "Tool", name: "Grafana", properties: {}, evidenceChunkIdx: [0] },
  ],
  edges: [],
};

async function fixtureStore(): Promise<{ store: Awaited<ReturnType<typeof createLocalStore>>; ids: string[] }> {
  const store = await createLocalStore();
  await store.addDocument(docA);
  await store.addDocument(docB);
  const all = await store.exportAll();
  const byDoc = (url: string) =>
    all.chunks
      .filter((c) => c.documentId === all.documents.find((d) => d.url === url)!.id)
      .sort((x, y) => x.index - y.index)
      .map((c) => c.id);
  return {
    store,
    ids: [...byDoc("https://example.com/graph"), ...byDoc("https://example.com/metrics")],
  };
}

describe("tokenize", () => {
  it("(b) splits on non-alphanumerics, lowercases, drops len<2 and empties", () => {
    expect(tokenize("Kestrel Labs, Ltd.")).toEqual(["kestrel", "labs", "ltd"]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("bm25Rank", () => {
  it("(a) ranks the doc containing the unique query term first", () => {
    const docs = [
      { id: "d1", text: "The engine intakes are tuned for altitude." },
      { id: "d2", text: "Kestrel Labs ships a capture extension." },
      { id: "d3", text: "Plain notes about unrelated topics." },
    ];
    // d1/d3 share no query term: score 0 both, input order preserved on ties.
    expect(bm25Rank("kestrel", docs)).toEqual(["d2", "d1", "d3"]);
  });

  it("(a) ties preserve input doc order", () => {
    const docs = [
      { id: "x", text: "alpha beta" },
      { id: "y", text: "beta alpha" },
    ];
    expect(bm25Rank("gamma", docs)).toEqual(["x", "y"]);
  });
});

describe("assembleSubgraph", () => {
  it("(c) caps at maxChunks, keeps rank order, returns only connected entities/edges", async () => {
    const { store, ids } = await fixtureStore();
    const [a0, a1, a2, b0, b1] = ids;
    // Ranked with the entity-free chunk first: entities are matched from
    // chunk content, not from the rank list.
    const sg = await assembleSubgraph(store, [a2, a1, a0, b0, b1], {
      maxTokens: 100000,
      maxChunks: 3,
    });

    expect(sg.chunks.map((c) => c.id)).toEqual([a2, a1, a0]); // rank order, capped
    // Kestrel Labs + Ada matched by name tokens in the selected chunks, in
    // store order (first-seen); Grafana's token is absent.
    const entities = await store.listEntities();
    const kestrel = entities.find((e) => e.name === "Kestrel Labs")!;
    const ada = entities.find((e) => e.name === "Ada")!;
    expect(sg.entities.map((e) => e.id)).toEqual([kestrel.id, ada.id]);
    expect(sg.edges).toHaveLength(1);
    expect(sg.edges[0].from).toBe(kestrel.id);
    expect(sg.edges[0].to).toBe(ada.id);
    expect(sg.edges[0].type).toBe("built_by");
  });

  it("(c) enforces the token budget by dropping the lowest-ranked chunks", async () => {
    const store = await createLocalStore();
    // Five chunks of exactly 40 chars => 10 tokens each.
    await store.addDocument({
      document: page("https://example.com/budget", "Budget", 1700000002000),
      chunks: ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40), "e".repeat(40)],
      entities: [],
      edges: [],
    });
    const all = await store.exportAll();
    const ranked = all.chunks
      .sort((x, y) => x.index - y.index)
      .map((c) => c.id);

    const sg = await assembleSubgraph(store, ranked, { maxTokens: 25, maxChunks: 5 });
    expect(sg.chunks).toHaveLength(2); // 10 + 10 fits; the third would overflow
    expect(sg.chunks.map((c) => c.id)).toEqual([ranked[0], ranked[1]]);
    const total = sg.chunks.reduce((sum, c) => sum + tokenCount(c.text), 0);
    expect(total).toBeLessThanOrEqual(25);
  });

  it("does not add the selected chunk's document's other active chunks", async () => {
    const { store, ids } = await fixtureStore();
    const [, a1] = ids;
    const sg = await assembleSubgraph(store, [a1], { maxTokens: 100000, maxChunks: 5 });
    expect(sg.chunks.map((c) => c.id)).toEqual([a1]);
  });

  it("entity matching is token-intersection, not substring", async () => {
    const store = await createLocalStore();
    await store.addDocument({
      document: page("https://example.com/sub", "Substring", 1700000003000),
      chunks: ["Adalbert published the results."],
      entities: [{ label: "Person", name: "Ada", properties: {}, evidenceChunkIdx: [0] }],
      edges: [],
    });
    const chunkId = (await store.exportAll()).chunks[0].id;
    const sg = await assembleSubgraph(store, [chunkId], { maxTokens: 1000, maxChunks: 5 });
    // "adalbert" contains "ada" as a substring but not as a token.
    expect(sg.chunks.map((c) => c.id)).toEqual([chunkId]);
    expect(sg.entities).toEqual([]);
    expect(sg.edges).toEqual([]);
  });

  it("(d) superseded chunks never appear, even when ranked", async () => {
    const { store, ids } = await fixtureStore();
    const [, , , b0] = ids;
    // Re-capture doc A's URL: its old chunks become superseded.
    await store.addDocument({
      document: page("https://example.com/graph", "Graph notes (updated)", 1700000004000),
      chunks: ["Kestrel Labs released the v2 capture engine."],
      entities: [],
      edges: [],
    });
    const all = await store.exportAll();
    const supersededIds = all.chunks.filter((c) => c.superseded).map((c) => c.id);
    expect(supersededIds.length).toBeGreaterThan(0);

    const sg = await assembleSubgraph(
      store,
      [...supersededIds, b0],
      { maxTokens: 100000, maxChunks: 10 },
    );
    expect(sg.chunks.every((c) => !c.superseded)).toBe(true);
    expect(sg.chunks.map((c) => c.id)).toEqual([b0]);
  });
});

describe("LocalStore.search", () => {
  it("empty query returns an empty subgraph", async () => {
    const { store } = await fixtureStore();
    await expect(store.search("", { maxTokens: 4000, maxChunks: 24 })).resolves.toEqual({
      chunks: [],
      entities: [],
      edges: [],
    });
    await expect(store.search("!!! ???", { maxTokens: 4000, maxChunks: 24 })).resolves.toEqual({
      chunks: [],
      entities: [],
      edges: [],
    });
  });

  it("ranks matching chunks first, excludes superseded and zero-score chunks, includes entities + edges", async () => {
    const { store } = await fixtureStore();
    // Re-capture doc A: A0/A1/A2 superseded; the new chunk is the only active
    // one in doc A. Doc B's chunks share no query token => score 0.
    const second = await store.addDocument({
      document: page("https://example.com/graph", "Graph notes (updated)", 1700000004000),
      chunks: ["Ada shipped the kestrel release."],
      entities: [],
      edges: [],
    });
    const fresh = (await store.exportAll()).chunks
      .filter((c) => c.documentId === second.documentId)
      .map((c) => c.id);

    const sg = await store.search("kestrel", { maxTokens: 4000, maxChunks: 24 });
    expect(sg.chunks.every((c) => !c.superseded)).toBe(true);
    // "kestrel" appears in A0/A1 (superseded now) and the fresh chunk; the
    // weather chunk scores 0 and must not surface.
    expect(sg.chunks.map((c) => c.id)).toEqual(fresh);
    const entities = await store.listEntities();
    const ada = entities.find((e) => e.name === "Ada")!;
    const kestrel = entities.find((e) => e.name === "Kestrel Labs")!;
    // Chunk tokens (ada, kestrel) match both entity names.
    expect(sg.entities.map((e) => e.id).sort()).toEqual([ada.id, kestrel.id].sort());
    expect(sg.edges).toHaveLength(1); // built_by, both endpoints returned
  });

  it("a query that only hits an entity name still surfaces that entity's evidence chunks", async () => {
    const store = await createLocalStore();
    await store.addDocument({
      document: page("https://example.com/dash", "Dashboards", 1700000005000),
      chunks: [
        "Dashboards track the ingestion pipeline health.", // no "grafana" token
        "Random notes about weather and coffee.", // Grafana's evidence chunk
      ],
      entities: [{ label: "Tool", name: "Grafana", properties: {}, evidenceChunkIdx: [1] }],
      edges: [],
    });
    const all = await store.exportAll();
    const b1 = all.chunks.find((c) => c.index === 1 && c.superseded === false)!.id;

    // No chunk text contains the token "grafana"; only the entity name does,
    // so the name-match boost is the only thing that can surface evidence.
    const sg = await store.search("grafana", { maxTokens: 4000, maxChunks: 24 });
    expect(sg.chunks.map((c) => c.id)).toEqual([b1]);
    // Assembly rules: Grafana is neither mentioned in the selected chunk nor
    // connected by an edge, so it does not join the subgraph.
    expect(sg.entities).toEqual([]);
    expect(sg.edges).toEqual([]);
  });
});
