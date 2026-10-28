/**
 * Adaptive extraction pipeline.
 *
 * A page within EXTRACTION_BUDGET_TOKENS goes out as one LLM call over its
 * chunks; a larger page is split into consecutive chunk batches of at most
 * BATCH_TOKENS, one call per batch, then exactly one merge call unifies the
 * batch results. No path truncates page text.
 *
 * Schema failures never throw: a response that fails validation is retried
 * once, and a persistent failure degrades to a flagged partial result
 * (`errors: string[]`) that the router surfaces in the report. Network
 * failures DO throw — they are chat's own errors.
 *
 * Note: page text arrives already wrapped (or not) by the caller — the router
 * applies `wrapUntrustedPageText` before calling. This module never wraps
 * again; per-chunk wrapping happens inside `extractionMessages`.
 */

import { chunkText, tokenCount } from "./chunker";
import { chat, type LlmSettings } from "./llmClient";
import { extractionMessages, type ChatMessage } from "./prompts";

/** Page ≤ budget → single call. */
export const EXTRACTION_BUDGET_TOKENS = 8000;
/** Consecutive chunks per batch in the multi-call path. */
export const BATCH_TOKENS = 6000;
/** chunkText maxTokens during ingest. */
export const EXTRACTION_CHUNK_TOKENS = 500;

export interface ExtractionEntity {
  name: string;
  label: string;
  evidenceChunkIdx: number[];
}

export interface ExtractionEdge {
  fromName: string;
  fromLabel: string;
  toName: string;
  toLabel: string;
  type: string;
  evidenceChunkIdx: number;
}

export interface ExtractionResult {
  entities: ExtractionEntity[];
  edges: ExtractionEdge[];
  errors?: string[];
}

interface ValidatedExtraction {
  entities: ExtractionEntity[];
  edges: ExtractionEdge[];
}

/**
 * Validates an extraction response. Top-level type failure (entities/edges
 * not both arrays, or the input not being an object) → null. Item-level:
 * an entity missing a non-empty name or label is dropped; a non-array
 * `evidenceChunkIdx` is coerced to [] and invalid entries are filtered out.
 * An edge is kept only when all six fields are present (strings typed as
 * strings) and `evidenceChunkIdx` is a finite integer ≥ 0. Output contains
 * ONLY the pinned fields — unknown fields like `hacked` are dropped.
 */
export function validateExtraction(json: unknown): ValidatedExtraction | null {
  if (typeof json !== "object" || json === null) return null;
  const raw = json as Record<string, unknown>;
  if (!Array.isArray(raw.entities) || !Array.isArray(raw.edges)) return null;

  const entities: ExtractionEntity[] = [];
  for (const item of raw.entities) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name === "") continue;
    if (typeof e.label !== "string" || e.label === "") continue;
    // Non-array → coerce to []; array entries must be finite integers ≥ 0.
    let evidenceChunkIdx: number[] = [];
    if (Array.isArray(e.evidenceChunkIdx)) {
      evidenceChunkIdx = e.evidenceChunkIdx.filter(
        (n): n is number =>
          typeof n === "number" && Number.isInteger(n) && n >= 0,
      );
    }
    entities.push({ name: e.name, label: e.label, evidenceChunkIdx });
  }

  const edges: ExtractionEdge[] = [];
  for (const item of raw.edges) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e.fromName !== "string" ||
      typeof e.fromLabel !== "string" ||
      typeof e.toName !== "string" ||
      typeof e.toLabel !== "string" ||
      typeof e.type !== "string" ||
      typeof e.evidenceChunkIdx !== "number" ||
      !Number.isInteger(e.evidenceChunkIdx) ||
      e.evidenceChunkIdx < 0
    ) {
      continue;
    }
    edges.push({
      fromName: e.fromName,
      fromLabel: e.fromLabel,
      toName: e.toName,
      toLabel: e.toLabel,
      type: e.type,
      evidenceChunkIdx: e.evidenceChunkIdx,
    });
  }

  return { entities, edges };
}

// The merge call's messages are pinned by the controller ruling (verbatim).
const MERGE_SYSTEM =
  "You are unifying entity/relationship extractions from multiple document parts. " +
  "Merge duplicates (same normalized name+label). Output ONLY JSON with the same schema: " +
  "entities (name, label, evidenceChunkIdx number[]) and edges " +
  "(fromName, fromLabel, toName, toLabel, type, evidenceChunkIdx). " +
  "Renumber evidenceChunkIdx to the indices given alongside each batch result.";

const MERGE_ASK = "Return the unified extraction. Output ONLY JSON.";

const SINGLE_RETRY_ERROR = "extraction: invalid schema after retry";

/** Unparseable response content counts as an invalid schema. */
function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * One LLM call with a single retry when the response fails validation.
 * Network errors propagate (chat's own errors); schema problems never throw.
 */
async function callWithRetry(
  s: LlmSettings,
  messages: ChatMessage[],
  fetchImpl: typeof fetch,
): Promise<ValidatedExtraction | null> {
  const first = validateExtraction(parseJson(await chat(s, messages, fetchImpl)));
  if (first) return first;
  return validateExtraction(parseJson(await chat(s, messages, fetchImpl)));
}

interface Batch {
  start: number; // first global chunk index
  end: number; // last global chunk index
  chunks: { index: number; text: string }[];
}

/** Greedy packing of consecutive chunks into batches of ≤ BATCH_TOKENS. */
function buildBatches(chunks: string[]): Batch[] {
  const batches: Batch[] = [];
  let current: Batch | null = null;
  let sum = 0;
  chunks.forEach((text, index) => {
    const tokens = tokenCount(text);
    if (current && sum + tokens > BATCH_TOKENS) {
      batches.push(current);
      current = null;
    }
    if (!current) {
      current = { start: index, end: index, chunks: [] };
      sum = 0;
    }
    current.chunks.push({ index, text });
    current.end = index;
    sum += tokens;
  });
  if (current) batches.push(current);
  return batches;
}

export async function extractDocument(
  s: LlmSettings,
  pageText: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtractionResult> {
  const chunks = chunkText(pageText, { maxTokens: EXTRACTION_CHUNK_TOKENS });

  if (tokenCount(pageText) <= EXTRACTION_BUDGET_TOKENS) {
    const messages = extractionMessages(
      chunks.map((text, index) => ({ index, text })),
    );
    const validated = await callWithRetry(s, messages, fetchImpl);
    if (!validated) {
      return { entities: [], edges: [], errors: [SINGLE_RETRY_ERROR] };
    }
    return { entities: validated.entities, edges: validated.edges };
  }

  // Over budget: consecutive chunks batched ≤ BATCH_TOKENS, one call per
  // batch, then ONE merge call. Batch responses carry GLOBAL chunk indices
  // (extractionMessages tags [C<globalIdx>]), so evidence indices are global
  // and directly become the store's evidenceChunkIdx.
  const batches = buildBatches(chunks);
  const batchResults: ValidatedExtraction[] = [];
  const errors: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const messages = extractionMessages(batches[i].chunks);
    const validated = await callWithRetry(s, messages, fetchImpl);
    if (!validated) {
      errors.push(`batch ${i + 1}: invalid schema after retry`);
      batchResults.push({ entities: [], edges: [] });
      continue;
    }
    batchResults.push(validated);
  }

  const mergeUser =
    batches
      .map(
        (batch, i) =>
          `BATCH ${i + 1} chunks [C${batch.start}..C${batch.end}]:\n${JSON.stringify(batchResults[i])}`,
      )
      .join("\n") + `\n\n${MERGE_ASK}`;
  const mergeMessages: ChatMessage[] = [
    { role: "system", content: MERGE_SYSTEM },
    { role: "user", content: mergeUser },
  ];

  const merged = await callWithRetry(s, mergeMessages, fetchImpl);
  if (!merged) {
    // Flagged partial: the un-unified batch results are still real data.
    errors.push("merge: invalid schema after retry");
    return {
      entities: batchResults.flatMap((r) => r.entities),
      edges: batchResults.flatMap((r) => r.edges),
      errors,
    };
  }

  const result: ExtractionResult = {
    entities: merged.entities,
    edges: merged.edges,
  };
  if (errors.length > 0) result.errors = errors;
  return result;
}
