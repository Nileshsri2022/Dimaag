import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { createLocalStore } from "../src/lib/localStore";
import type { IngestInput } from "../src/lib/types";

// Fresh IndexedDB instance per test so no data leaks between tests.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function fixture(over: Partial<IngestInput> = {}): IngestInput {
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
    ...over,
  };
}

describe("createLocalStore", () => {
  it("(a) fresh add returns counts {chunks 2, entities 2, edges 1} and stats {1, 2, 2, 1}", async () => {
    const store = await createLocalStore();
    const res = await store.addDocument(fixture());
    expect(res.chunkCount).toBe(2);
    expect(res.entityCount).toBe(2);
    expect(res.edgeCount).toBe(1);
    expect(res.errors).toEqual([]);
    await expect(store.stats()).resolves.toEqual({
      documents: 1,
      chunks: 2,
      entities: 2,
      edges: 1,
    });
  });

  it("(a) second add of same-name entity remaps to the existing id and appends evidenceChunkIds", async () => {
    const store = await createLocalStore();
    await store.addDocument(fixture());
    const second = await store.addDocument(
      fixture({
        document: {
          url: "https://example.com/b",
          title: "Page B",
          sourceType: "page",
          capturedAt: 1700000001000,
        },
        chunks: ["Kestrel Labs ships v2."],
        entities: [
          // differs only in casing/whitespace -> same entityKey
          { label: "Tool", name: "  kestrel   LABS  ", evidenceChunkIdx: [0] },
          { label: "Person", name: "Bob", evidenceChunkIdx: [0] },
        ],
        edges: [],
      }),
    );
    // merged-in entity counts as 1
    expect(second.entityCount).toBe(2);
    expect(second.chunkCount).toBe(1);
    expect(second.edgeCount).toBe(0);

    const entities = await store.listEntities();
    expect(entities).toHaveLength(3); // Kestrel Labs merged (not duplicated) + Ada + Bob
    const kestrel = entities.find((e) => e.nameNormalized === "kestrel labs");
    expect(kestrel).toBeDefined();
    expect(kestrel!.label).toBe("Tool");
    expect(kestrel!.name).toBe("Kestrel Labs"); // existing entity wins on merge
    expect(kestrel!.evidenceChunkIds).toHaveLength(2); // original + appended from recapture

    const detail = await store.getEntityDetail(kestrel!.id);
    expect(detail).not.toBeNull();
    expect(detail!.chunks).toHaveLength(2);
  });

  it("(b) re-capture same URL supersedes old document and chunks, keeps old chunk ids", async () => {
    const store = await createLocalStore();
    const first = await store.addDocument(fixture());
    const second = await store.addDocument(
      fixture({
        document: {
          url: "https://example.com/a",
          title: "Page A (updated)",
          sourceType: "page",
          capturedAt: 1700000002000,
        },
        chunks: ["Kestrel Labs launched v2 today."],
        entities: [],
        edges: [],
      }),
    );
    expect(second.documentId).not.toBe(first.documentId);

    const all = await store.exportAll();
    expect(all.version).toBe(1);
    expect(all.documents).toHaveLength(2);

    const oldDoc = all.documents.find((d) => d.id === first.documentId)!;
    expect(oldDoc.supersededBy).toBe(second.documentId);
    const newDoc = all.documents.find((d) => d.id === second.documentId)!;
    expect(newDoc.supersededBy).toBeUndefined();
    expect(newDoc.title).toBe("Page A (updated)");

    const oldChunks = all.chunks.filter((c) => c.documentId === first.documentId);
    expect(oldChunks).toHaveLength(2); // IDs retained, retrievable
    expect(oldChunks.map((c) => c.superseded)).toEqual([true, true]);

    const newChunks = all.chunks.filter((c) => c.documentId === second.documentId);
    expect(newChunks).toHaveLength(1);
    expect(newChunks[0].superseded).toBe(false);
  });

  it("(c) getNeighbors returns directed edges and the entities on the other end", async () => {
    const store = await createLocalStore();
    await store.addDocument(fixture());
    const entities = await store.listEntities();
    const kestrel = entities.find((e) => e.label === "Tool")!;
    const ada = entities.find((e) => e.label === "Person")!;

    const fromKestrel = await store.getNeighbors(kestrel.id);
    expect(fromKestrel.edges).toHaveLength(1);
    expect(fromKestrel.edges[0].from).toBe(kestrel.id);
    expect(fromKestrel.edges[0].to).toBe(ada.id);
    expect(fromKestrel.edges[0].type).toBe("built_by");
    expect(fromKestrel.entities.map((e) => e.id)).toEqual([ada.id]);

    // direction is preserved when walking from the target
    const fromAda = await store.getNeighbors(ada.id);
    expect(fromAda.edges).toHaveLength(1);
    expect(fromAda.edges[0].from).toBe(kestrel.id);
    expect(fromAda.edges[0].to).toBe(ada.id);
    expect(fromAda.entities.map((e) => e.id)).toEqual([kestrel.id]);
  });

  it("(d) deleteAll leaves stats all zeros", async () => {
    const store = await createLocalStore();
    await store.addDocument(fixture());
    await store.deleteAll();
    await expect(store.stats()).resolves.toEqual({
      documents: 0,
      chunks: 0,
      entities: 0,
      edges: 0,
    });
  });

  it("edge referencing a missing entity name is skipped with a returned error string", async () => {
    const store = await createLocalStore();
    const res = await store.addDocument(
      fixture({
        edges: [
          {
            fromName: "Ghost",
            fromLabel: "Person",
            toName: "Ada",
            toLabel: "Person",
            type: "knows",
            evidenceChunkIdx: 0,
          },
        ],
      }),
    );
    expect(res.edgeCount).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]).toContain("Ghost");
    await expect(store.stats()).resolves.toEqual({
      documents: 1,
      chunks: 2,
      entities: 2,
      edges: 0,
    });
  });
});
