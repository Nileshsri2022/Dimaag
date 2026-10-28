/**
 * Service-worker message router: the single boundary between the UI (side
 * panel, options) and the graph pipeline.
 *
 * INGEST: guardrail first (sensitive URL + no confirmation → the caller
 * resends with `sensitiveConfirmed: true`), then LLM settings, then extraction
 * and a merge into the local graph. Page text is passed through
 * `wrapUntrustedPageText` HERE, before any LLM sees it — no exceptions.
 *
 * ASK: budgeted keyword retrieval from the store, prompt assembly, one chat
 * call. The answer is returned to the caller and never written into the graph
 * (verify-only posture); history is echoed through unchanged.
 *
 * STATS: store counters for the options page.
 *
 * handleRequest never throws: downstream failures (network, storage) surface
 * as `{ ok: false, error }` with an actionable message.
 */

import { chunkText } from "../lib/chunker";
import { EXTRACTION_CHUNK_TOKENS, validateExtraction } from "../lib/extraction";
import { isSensitive } from "../lib/guardrail";
import type { LlmSettings } from "../lib/llmClient";
import { qaMessages, wrapUntrustedPageText, type ChatMessage } from "../lib/prompts";
import type { GraphStore, IngestInput, SourceType } from "../lib/types";

export interface RouterDeps {
  store: () => Promise<GraphStore>;
  llm: () => Promise<LlmSettings | null>; // resolves the user's LLM settings or null
  chat: (s: LlmSettings, messages: ChatMessage[]) => Promise<string>;
  extract: (
    s: LlmSettings,
    pageText: string,
    fetchImpl?: typeof fetch,
  ) => Promise<{ entities: unknown[]; edges: unknown[] }>;
}

export interface IngestPayload {
  url: string;
  title: string;
  text: string;
  sourceType: SourceType;
  sensitiveConfirmed: boolean;
}

export interface AskPayload {
  question: string;
  history: ChatMessage[];
}

export type Req =
  | { type: "INGEST"; payload: IngestPayload }
  | { type: "ASK"; payload: AskPayload }
  | { type: "STATS" };

export type IngestResult =
  | { ok: false; needsSensitiveConfirm: true }
  | { ok: false; error: string }
  | {
      ok: true;
      report: {
        documentId?: string;
        chunkCount: number;
        entityCount: number;
        edgeCount: number;
        errors: string[];
      };
    };

export type AskResult =
  | { ok: false; error: string }
  | { ok: true; answer: string; citations: { [i: number]: { chunkId: string; text: string } } };

export type StatsResult = {
  ok: true;
  stats: { documents: number; chunks: number; entities: number; edges: number };
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function ingest(payload: IngestPayload, deps: RouterDeps): Promise<IngestResult> {
  // Guardrail first: the UI shows the warning and resends with confirmation.
  if (isSensitive(payload.url) && !payload.sensitiveConfirmed) {
    return { ok: false, needsSensitiveConfirm: true };
  }

  const settings = await deps.llm();
  if (!settings) {
    return { ok: false, error: "LLM not connected" };
  }

  // The untrusted-content wrapper is applied exactly once, here, before any
  // LLM call. The same wrapped text is what gets chunked for the store, so
  // evidenceChunkIdx numbering (which extractDocument derives from chunking
  // this text) stays aligned with the stored chunks.
  const wrapped = wrapUntrustedPageText(payload.text);
  const raw = await deps.extract(settings, wrapped);

  const errors: string[] = [];
  // extractDocument flags partial results (schema failures after retry) via an
  // optional `errors` field; surfaced in the report, never swallowed.
  const rawErrors = (raw as { errors?: unknown }).errors;
  if (Array.isArray(rawErrors)) {
    errors.push(...rawErrors.filter((e): e is string => typeof e === "string"));
  }

  // Coerce to the IngestInput shapes: invalid items are dropped (mirroring the
  // extraction module's own validation), a wholesale schema failure is flagged.
  const validated = validateExtraction(raw);
  if (!validated) {
    errors.push("extraction: invalid schema after retry");
  }

  const input: IngestInput = {
    document: {
      url: payload.url,
      title: payload.title,
      sourceType: payload.sourceType,
      capturedAt: Date.now(),
    },
    chunks: chunkText(wrapped, { maxTokens: EXTRACTION_CHUNK_TOKENS }),
    entities: validated?.entities ?? [],
    edges: validated?.edges ?? [],
  };

  const report = await (await deps.store()).addDocument(input);
  return {
    ok: true,
    report: {
      documentId: report.documentId,
      chunkCount: report.chunkCount,
      entityCount: report.entityCount,
      edgeCount: report.edgeCount,
      errors,
    },
  };
}

async function ask(payload: AskPayload, deps: RouterDeps): Promise<AskResult> {
  const settings = await deps.llm();
  if (!settings) {
    return { ok: false, error: "LLM not connected" };
  }

  const store = await deps.store();
  const subgraph = await store.search(payload.question, { maxTokens: 4000, maxChunks: 24 });
  const answer = await deps.chat(settings, qaMessages(payload.question, subgraph, payload.history));

  // [C<i>] tags in the prompt are numbered by position in subgraph.chunks
  // (see qaMessages), so citation i maps back to that chunk record.
  const citations: { [i: number]: { chunkId: string; text: string } } = {};
  subgraph.chunks.forEach((chunk, i) => {
    citations[i] = { chunkId: chunk.id, text: chunk.text };
  });

  return { ok: true, answer, citations };
}

export async function handleRequest(
  req: Req,
  deps: RouterDeps,
): Promise<IngestResult | AskResult | StatsResult> {
  try {
    switch (req.type) {
      case "INGEST":
        return await ingest(req.payload, deps);
      case "ASK":
        return await ask(req.payload, deps);
      case "STATS":
        return { ok: true, stats: await (await deps.store()).stats() };
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
