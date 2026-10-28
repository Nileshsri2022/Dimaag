import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
import {
  entityKey,
  type Chunk,
  type Document,
  type Edge,
  type Entity,
  type GraphExport,
  type GraphStore,
  type IngestInput,
} from "./types";
import { bm25Scores } from "./bm25";
import { assembleSubgraph, tokenize } from "./retrieval";

const DB_NAME = "dimaag";
const DB_VERSION = 1;

// Stored entity records carry the extra `entityKey` field required by the
// unique `by_key` index. Entity itself has no such property, so the value type
// is a superset here.
type EntityRecord = Entity & { entityKey: string };

interface DimaagDBSchema extends DBSchema {
  documents: { key: string; value: Document; indexes: { by_url: string } };
  chunks: { key: string; value: Chunk; indexes: { by_document: string } };
  entities: { key: string; value: EntityRecord; indexes: { by_key: string } };
  edges: {
    key: string;
    value: Edge;
    indexes: { by_from: string; by_to: string };
  };
}

const ALL_STORES = ["documents", "chunks", "entities", "edges"] as const;

function newId(): string {
  return crypto.randomUUID();
}

function normalizedFromKey(key: string): string {
  return key.substring(key.indexOf("::") + 2);
}

function chunkIdsFor(idxs: number[], chunkIds: string[]): string[] {
  return idxs
    .map((i) => chunkIds[i])
    .filter((id): id is string => typeof id === "string");
}

export async function createLocalStore(): Promise<GraphStore> {
  const db: IDBPDatabase<DimaagDBSchema> = await openDB<DimaagDBSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const documents = db.createObjectStore("documents", { keyPath: "id" });
      documents.createIndex("by_url", "url");

      const chunks = db.createObjectStore("chunks", { keyPath: "id" });
      chunks.createIndex("by_document", "documentId");

      const entities = db.createObjectStore("entities", { keyPath: "id" });
      entities.createIndex("by_key", "entityKey", { unique: true });

      const edges = db.createObjectStore("edges", { keyPath: "id" });
      edges.createIndex("by_from", "from");
      edges.createIndex("by_to", "to");
    },
  });

  // Run an async function over a transaction spanning all four stores.
  // idb v8 dropped the callback form of transaction(), so this reproduces it
  // with the explicit tx + tx.done pattern.
  async function runTx<Mode extends "readonly" | "readwrite", T>(
    mode: Mode,
    fn: (tx: IDBPTransaction<DimaagDBSchema, typeof ALL_STORES, Mode>) => Promise<T>,
  ): Promise<T> {
    const tx = db.transaction(ALL_STORES, mode);
    const done = tx.done;
    try {
      const result = await fn(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // tx may already be finished; nothing to do
      }
      await done.catch(() => {}); // settle the (likely rejected) done promise
      throw error;
    }
  }

  async function addDocument(input: IngestInput) {
    const { document: doc, chunks: chunkTexts, entities: entityInputs, edges: edgeInputs } = input;
    const errors: string[] = [];

    return runTx("readwrite", async (tx) => {
      const documentId = newId();

      // Re-capture: retire any prior documents for this URL before adding the new one.
      const priorDocs = await tx.objectStore("documents").index("by_url").getAll(doc.url);
      for (const prior of priorDocs) {
        if (prior.id === documentId) continue;
        await tx.objectStore("documents").put({ ...prior, supersededBy: documentId });
        const priorChunks = await tx.objectStore("chunks").index("by_document").getAll(prior.id);
        for (const priorChunk of priorChunks) {
          await tx.objectStore("chunks").put({ ...priorChunk, superseded: true });
        }
      }

      const documentRecord: Document = { ...doc, id: documentId };
      await tx.objectStore("documents").put(documentRecord);

      const chunkIds: string[] = [];
      for (let i = 0; i < chunkTexts.length; i++) {
        const chunk: Chunk = {
          id: newId(),
          documentId,
          text: chunkTexts[i],
          index: i,
          superseded: false,
        };
        chunkIds.push(chunk.id);
        await tx.objectStore("chunks").put(chunk);
      }

      for (const entityInput of entityInputs) {
        const key = entityKey(entityInput.name, entityInput.label);
        const existing = await tx.objectStore("entities").index("by_key").get(key);
        if (existing) {
          // Merge into the existing entity: reuse its id, append only new chunk ids.
          const appended = chunkIdsFor(entityInput.evidenceChunkIdx, chunkIds).filter(
            (id) => !existing.evidenceChunkIds.includes(id),
          );
          await tx.objectStore("entities").put({
            ...existing,
            evidenceChunkIds: [...existing.evidenceChunkIds, ...appended],
          });
        } else {
          const record: EntityRecord = {
            id: newId(),
            label: entityInput.label,
            name: entityInput.name,
            nameNormalized: normalizedFromKey(key),
            properties: entityInput.properties ?? {},
            evidenceChunkIds: chunkIdsFor(entityInput.evidenceChunkIdx, chunkIds),
            entityKey: key,
          };
          await tx.objectStore("entities").put(record);
        }
      }
      // Every input entity resolves to exactly one entity record; merged-in count as 1.
      const entityCount = entityInputs.length;

      let edgeCount = 0;
      for (const edgeInput of edgeInputs) {
        const fromKey = entityKey(edgeInput.fromName, edgeInput.fromLabel);
        const toKey = entityKey(edgeInput.toName, edgeInput.toLabel);
        const from = (await tx.objectStore("entities").index("by_key").get(fromKey))?.id;
        const to = (await tx.objectStore("entities").index("by_key").get(toKey))?.id;
        const evidenceChunkId = chunkIds[edgeInput.evidenceChunkIdx];

        if (!from || !to || typeof evidenceChunkId !== "string") {
          let reason: string;
          if (!from) {
            reason = `unresolved entity reference from "${edgeInput.fromName}" (${edgeInput.fromLabel})`;
          } else if (!to) {
            reason = `unresolved entity reference to "${edgeInput.toName}" (${edgeInput.toLabel})`;
          } else {
            reason = `evidenceChunkIdx ${edgeInput.evidenceChunkIdx} out of range`;
          }
          errors.push(`Skipped edge "${edgeInput.type}" (${edgeInput.fromName} -> ${edgeInput.toName}): ${reason}.`);
          continue;
        }

        const edge: Edge = {
          id: newId(),
          from,
          to,
          type: edgeInput.type,
          evidenceChunkId,
          properties: edgeInput.properties,
        };
        await tx.objectStore("edges").put(edge);
        edgeCount++;
      }

      return { documentId, chunkCount: chunkIds.length, entityCount, edgeCount, errors };
    });
  }

  const store: GraphStore = {
    addDocument,

    async listEntities() {
      return db.getAll("entities");
    },

    async getEntityDetail(id) {
      const entity = await db.get("entities", id);
      if (!entity) return null;
      const chunks = await Promise.all(
        entity.evidenceChunkIds.map((chunkId) => db.get("chunks", chunkId)),
      );
      return { entity, chunks: chunks.filter((c): c is Chunk => c !== undefined) };
    },

    async getNeighbors(entityId) {
      const [outgoing, incoming] = await Promise.all([
        db.getAllFromIndex("edges", "by_from", entityId),
        db.getAllFromIndex("edges", "by_to", entityId),
      ]);
      const edges = [...outgoing, ...incoming];
      const otherIds = new Set<string>();
      for (const edge of edges) {
        otherIds.add(edge.from === entityId ? edge.to : edge.from);
      }
      const entities = await Promise.all(
        [...otherIds].map((id) => db.get("entities", id) as Promise<EntityRecord | undefined>),
      );
      return {
        entities: entities.filter((e): e is EntityRecord => e !== undefined),
        edges,
      };
    },

    async search(query, opts) {
      // Empty query → empty Subgraph, no wasted calls.
      const queryTokens = tokenize(query);
      if (queryTokens.length === 0) {
        return { chunks: [], entities: [], edges: [] };
      }

      // The store holds only active and superseded records; superseded
      // chunks are excluded from ranking.
      const [allChunks, allEntities] = await Promise.all([
        db.getAll("chunks"),
        db.getAll("entities"),
      ]);
      const active = allChunks.filter((c) => !c.superseded);
      const activeById = new Map(active.map((c) => [c.id, c]));

      const scores = bm25Scores(query, active.map((c) => ({ id: c.id, text: c.text })));

      // Entity-name matches append the entity's active evidence chunks with
      // a rank boost: a flat bonus on top of each chunk's BM25 score.
      const queryTokenSet = new Set(queryTokens);
      const ENTITY_NAME_BONUS = 1;
      for (const entity of allEntities) {
        if (!tokenize(entity.name).some((t) => queryTokenSet.has(t))) continue;
        for (const chunkId of entity.evidenceChunkIds) {
          if (!activeById.has(chunkId)) continue;
          scores.set(chunkId, (scores.get(chunkId) ?? 0) + ENTITY_NAME_BONUS);
        }
      }

      // Rank order: score desc, ties keep store (insertion) order. Chunks
      // with no term and no entity boost (score 0) never surface.
      const ranked = [...scores.entries()]
        .filter(([, score]) => score > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);

      return assembleSubgraph(store, ranked, opts);
    },

    async exportAll(): Promise<GraphExport> {
      const [documents, chunks, entities, edges] = await Promise.all([
        db.getAll("documents"),
        db.getAll("chunks"),
        db.getAll("entities"),
        db.getAll("edges"),
      ]);
      return { version: 1, documents, chunks, entities, edges };
    },

    async importReplace(data) {
      // Caller performs the confirmation; this unconditionally replaces everything.
      await runTx("readwrite", async (tx) => {
        for (const name of ALL_STORES) {
          await tx.objectStore(name).clear();
        }
        for (const doc of data.documents) {
          await tx.objectStore("documents").put(doc);
        }
        for (const chunk of data.chunks) {
          await tx.objectStore("chunks").put(chunk);
        }
        for (const entity of data.entities) {
          // Recompute the index key so imported records are always indexed.
          await tx
            .objectStore("entities")
            .put({ ...entity, entityKey: entityKey(entity.name, entity.label) });
        }
        for (const edge of data.edges) {
          await tx.objectStore("edges").put(edge);
        }
      });
    },

    async deleteAll() {
      await runTx("readwrite", async (tx) => {
        for (const name of ALL_STORES) {
          await tx.objectStore(name).clear();
        }
      });
    },

    async stats() {
      return runTx("readonly", async (tx) => ({
        documents: await tx.objectStore("documents").count(),
        chunks: await tx.objectStore("chunks").count(),
        entities: await tx.objectStore("entities").count(),
        edges: await tx.objectStore("edges").count(),
      }));
    },
  };

  return store;
}
