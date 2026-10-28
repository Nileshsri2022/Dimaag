import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { createLocalStore } from "../src/lib/localStore";
import { graphExportToBlobUrl, parseGraphExport } from "../src/lib/exportImport";
import type { IngestInput } from "../src/lib/types";

// Fresh IndexedDB instance per test so no data leaks between tests.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

// jsdom does not implement createObjectURL; capture the Blob so tests can read
// the bytes that would end up in the download.
let liveBlob: Blob | null = null;
beforeEach(() => {
  liveBlob = null;
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    value: vi.fn((blob: Blob) => {
      liveBlob = blob;
      return "blob:fake-url";
    }),
    configurable: true,
    writable: true,
  });
});

function fixture(): IngestInput {
  return {
    document: {
      url: "https://example.com/a",
      title: "Page A",
      sourceType: "page",
      capturedAt: 1700000000000,
    },
    chunks: ["Kestrel Labs builds tools.", "Ada works at Kestrel Labs."],
    entities: [
      { label: "Tool", name: "Kestrel Labs", properties: { hq: "Berlin" }, evidenceChunkIdx: [0] },
      { label: "Person", name: "Ada", evidenceChunkIdx: [1] },
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
}

describe("graphExportToBlobUrl", () => {
  it("returns a blob URL whose content is pretty-printed JSON of the data", async () => {
    const store = await createLocalStore();
    await store.addDocument(fixture());
    const data = await store.exportAll();

    const url = graphExportToBlobUrl(data);
    expect(url).toContain("blob:");
    expect(liveBlob).not.toBeNull();
    expect(liveBlob!.type).toBe("application/json");

    const text = await liveBlob!.text();
    expect(JSON.parse(text)).toEqual(data);
    expect(text).toContain("\n  "); // JSON.stringify(data, null, 2)
  });
});

describe("parseGraphExport", () => {
  it("round-trips export of a known store with identical data", async () => {
    const store = await createLocalStore();
    await store.addDocument(fixture());
    const data = await store.exportAll();

    const parsed = parseGraphExport(JSON.stringify(data));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Deep-equal including extra index-only fields like entityKey on entities.
    expect(parsed.data).toEqual(data);
  });

  it("accepts a valid empty graph", () => {
    const parsed = parseGraphExport(
      JSON.stringify({ version: 1, documents: [], chunks: [], entities: [], edges: [] }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("rejects malformed JSON with a useful error", () => {
    const parsed = parseGraphExport("{not json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/JSON/i);
  });

  it("rejects version: 2", () => {
    const parsed = parseGraphExport(
      JSON.stringify({ version: 2, documents: [], chunks: [], entities: [], edges: [] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("version");
  });

  it("rejects when an array is missing", () => {
    const parsed = parseGraphExport(JSON.stringify({ version: 1, documents: [], chunks: [], entities: [] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("edges");
  });

  it("rejects items missing required document fields, naming the field", () => {
    const parsed = parseGraphExport(
      JSON.stringify({
        version: 1,
        documents: [{ id: "d1", url: "https://x", title: "T", sourceType: "page" }], // no capturedAt
        chunks: [],
        entities: [],
        edges: [],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("capturedAt");
  });

  it("rejects items with garbage-typed chunk fields", () => {
    const parsed = parseGraphExport(
      JSON.stringify({
        version: 1,
        documents: [],
        chunks: [{ id: "c1", documentId: "d1", text: 42, index: 0, superseded: false }],
        entities: [],
        edges: [],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("text");
  });

  it("accepts extra fields on records but requires entity/edge requireds", () => {
    const parsed = parseGraphExport(
      JSON.stringify({
        version: 1,
        documents: [],
        chunks: [{ id: "c1", documentId: "d1", text: "t", index: 0, superseded: false, extra: true }],
        // entity missing nameNormalized; edge missing evidenceChunkId
        entities: [{ id: "e1", label: "Tool", name: "K", evidenceChunkIds: ["c1"] }],
        edges: [{ id: "x1", from: "e1", to: "e1", type: "knows" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/nameNormalized|evidenceChunkId/);
  });
});
