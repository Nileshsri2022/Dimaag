/**
 * Retrieval: query tokenization and budgeted subgraph assembly.
 *
 * `tokenize` is the single token rule used everywhere in retrieval (BM25
 * scoring, entity-name matching): lowercase, split on non-alphanumerics, drop
 * tokens shorter than 2 characters.
 *
 * `assembleSubgraph` turns a ranked chunk-id list (BM25 rank order, highest
 * first) into a `Subgraph` within a token budget: chunks are capped at
 * `maxChunks` and the token budget is enforced by dropping the lowest-ranked
 * (tail) chunks first. Entities are the ones named/mentioned in the selected
 * chunks (token intersection, not substring) plus entities joined by an edge
 * whose evidence chunk was selected; each matched entity is expanded one hop
 * via `getNeighbors`. Returned edges keep only pairs whose both endpoints are
 * in the returned entity set.
 */

import { tokenCount } from "./chunker";
import type { Chunk, Edge, Entity, GraphStore, Subgraph } from "./types";

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

export async function assembleSubgraph(
  store: GraphStore,
  rankedChunkIds: string[],
  opts: { maxTokens: number; maxChunks: number },
): Promise<Subgraph> {
  // Empty query → empty Subgraph, no wasted store calls.
  if (rankedChunkIds.length === 0 || opts.maxChunks <= 0 || opts.maxTokens <= 0) {
    return { chunks: [], entities: [], edges: [] };
  }

  // The GraphStore surface has no direct chunk fetch; exportAll is the one
  // call that exposes chunk records (v1 is sized for hundreds of pages).
  const all = await store.exportAll();

  const chunkById = new Map(all.chunks.map((c) => [c.id, c]));
  const selected: Chunk[] = [];
  const selectedIds = new Set<string>();
  let totalTokens = 0;
  for (const id of rankedChunkIds) {
    if (selected.length >= opts.maxChunks) break;
    if (selectedIds.has(id)) continue; // dedupe ranked input
    const chunk = chunkById.get(id);
    if (!chunk || chunk.superseded) continue; // superseded never surfaces
    const tokens = tokenCount(chunk.text);
    if (totalTokens + tokens > opts.maxTokens) break; // tail (lowest rank) dropped
    selected.push(chunk);
    selectedIds.add(id);
    totalTokens += tokens;
  }

  if (selected.length === 0) {
    return { chunks: [], entities: [], edges: [] };
  }

  // Entities named/mentioned in the selected chunks: any token of the
  // entity's name must appear as a chunk token (intersection, not substring).
  const chunkTokens = new Set<string>();
  for (const chunk of selected) {
    for (const t of tokenize(chunk.text)) chunkTokens.add(t);
  }

  const entityById = new Map(all.entities.map((e) => [e.id, e]));
  const matched: Entity[] = [];
  const seenEntities = new Set<string>();
  const addEntity = (id: string) => {
    if (seenEntities.has(id)) return;
    const entity = entityById.get(id);
    if (!entity) return;
    seenEntities.add(id);
    matched.push(entity);
  };

  for (const entity of all.entities) {
    if (tokenize(entity.name).some((t) => chunkTokens.has(t))) {
      addEntity(entity.id);
    }
  }
  // Entities joined by an edge whose evidence is one of the selected chunks.
  for (const edge of all.edges) {
    if (selectedIds.has(edge.evidenceChunkId)) {
      addEntity(edge.from);
      addEntity(edge.to);
    }
  }

  // One hop from every matched entity; collects neighbor entities and edges.
  const edgeById = new Map<string, Edge>();
  for (const entity of [...matched]) {
    const { entities: neighbors, edges } = await store.getNeighbors(entity.id);
    for (const neighbor of neighbors) addEntity(neighbor.id);
    for (const edge of edges) edgeById.set(edge.id, edge); // dedupe by id
  }

  // Edges only between returned entities.
  const edges = [...edgeById.values()].filter(
    (edge) => seenEntities.has(edge.from) && seenEntities.has(edge.to),
  );

  return { chunks: selected, entities: matched, edges };
}
