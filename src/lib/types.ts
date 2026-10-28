export type SourceType = "page" | "selection";
export interface Document { id: string; url: string; title: string; sourceType: SourceType; capturedAt: number; supersededBy?: string; }
export interface Chunk { id: string; documentId: string; text: string; index: number; superseded: boolean; }
export interface Entity { id: string; label: string; name: string; nameNormalized: string; properties: Record<string, unknown>; evidenceChunkIds: string[]; }
export interface Edge { id: string; from: string; to: string; type: string; evidenceChunkId: string; properties?: Record<string, unknown>; }
export interface IngestInput { document: Omit<Document, "id">; chunks: string[]; entities: { label: string; name: string; properties?: Record<string, unknown>; evidenceChunkIdx: number[] }[]; edges: { fromName: string; fromLabel: string; toName: string; toLabel: string; type: string; evidenceChunkIdx: number; properties?: Record<string, unknown> }[]; }
export interface GraphExport { version: 1; documents: Document[]; chunks: Chunk[]; entities: Entity[]; edges: Edge[]; }
export interface Subgraph { chunks: Chunk[]; entities: Entity[]; edges: Edge[]; }
export interface GraphStore {
  addDocument(input: IngestInput): Promise<{ documentId: string; chunkCount: number; entityCount: number; edgeCount: number }>;
  listEntities(): Promise<Entity[]>;
  getEntityDetail(id: string): Promise<{ entity: Entity; chunks: Chunk[] } | null>; // chunks incl. superseded (labeled)
  getNeighbors(entityId: string): Promise<{ entities: Entity[]; edges: Edge[] }>;
  search(query: string, opts: { maxTokens: number; maxChunks: number }): Promise<Subgraph>;
  exportAll(): Promise<GraphExport>;
  importReplace(data: GraphExport): Promise<void>; // caller performs the confirmation
  deleteAll(): Promise<void>;
  stats(): Promise<{ documents: number; chunks: number; entities: number; edges: number }>;
}

export function entityKey(name: string, label: string): string {
  const normalized = name.trim().normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
  return `${label.toLowerCase()}::${normalized}`;
}
