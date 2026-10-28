import { describe, expect, it } from "vitest";
import { chunkText, tokenCount } from "../src/lib/chunker";
import type { LlmSettings } from "../src/lib/llmClient";
import type { ChatMessage } from "../src/lib/prompts";
import {
  BATCH_TOKENS,
  EXTRACTION_BUDGET_TOKENS,
  EXTRACTION_CHUNK_TOKENS,
  extractDocument,
  validateExtraction,
} from "../src/lib/extraction";

const SETTINGS: LlmSettings = {
  baseUrl: "https://api.test/v1",
  apiKey: "sk-test",
  model: "gpt-x",
};

const SENTENCE =
  "The quick brown fox jumps over the lazy dog near the riverbank at dawn. ";

function makePage(paragraphs: number, sentencesPerParagraph: number): string {
  const paragraph = Array.from({ length: sentencesPerParagraph }, () => SENTENCE).join("");
  return Array.from({ length: paragraphs }, () => paragraph).join("\n\n");
}

const VALID_SINGLE = {
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

// Fake `chat` at the fetch boundary: records the messages of every call and
// answers with content chosen by the callback (OpenAI response shape).
function fakeChat(content: (messages: ChatMessage[], callIdx: number) => string) {
  const calls: ChatMessage[][] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
    calls.push(body.messages);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: content(body.messages, calls.length - 1) } }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function userContent(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}

/** Global chunk indices tagged in a call's user message. */
function chunkTags(messages: ChatMessage[]): number[] {
  return [...userContent(messages).matchAll(/\[C(\d+)\]/g)].map((m) => Number(m[1]));
}

function isMergeCall(messages: ChatMessage[]): boolean {
  return messages[0]?.role === "system" && messages[0].content.includes("unifying");
}

// Batch-call responder: one entity per [C<n>] tag in the call's user message.
function batchEntityJson(messages: ChatMessage[]): string {
  const tags = chunkTags(messages);
  return JSON.stringify({
    entities: tags.map((n) => ({
      name: `E${n}`,
      label: "Thing",
      evidenceChunkIdx: [n],
    })),
    edges: [],
  });
}

// Merge-call responder: re-emit every entity the batch JSONs mentioned
// (the batch results arrive as stringified JSON data in the user message).
function mergeJson(messages: ChatMessage[]): string {
  const names = new Set<string>();
  for (const match of userContent(messages).matchAll(/"name":"(E\d+)"/g)) {
    names.add(match[1]);
  }
  return JSON.stringify({
    entities: [...names].map((name) => ({
      name,
      label: "Thing",
      evidenceChunkIdx: [Number(name.slice(1))],
    })),
    edges: [],
  });
}

function autoResponder(messages: ChatMessage[]): string {
  return isMergeCall(messages) ? mergeJson(messages) : batchEntityJson(messages);
}

describe("pinned constants", () => {
  it("match the plan verbatim", () => {
    expect(EXTRACTION_BUDGET_TOKENS).toBe(8000);
    expect(BATCH_TOKENS).toBe(6000);
    expect(EXTRACTION_CHUNK_TOKENS).toBe(500);
  });
});

describe("extractDocument", () => {
  it("(a) a page within the budget makes exactly one LLM call", async () => {
    const page = makePage(3, 2); // well under 8000 tokens
    expect(tokenCount(page)).toBeLessThanOrEqual(EXTRACTION_BUDGET_TOKENS);

    const { fetchImpl, calls } = fakeChat(() => JSON.stringify(VALID_SINGLE));
    const result = await extractDocument(SETTINGS, page, fetchImpl);

    expect(calls).toHaveLength(1);
    expect(result.entities).toEqual(VALID_SINGLE.entities);
    expect(result.edges).toEqual(VALID_SINGLE.edges);
    expect(result.errors).toBeUndefined();
    expect(chunkTags(calls[0])).toEqual([0]);
  });

  it("(b) an over-budget page makes multiple batch calls and ONE final merge call mentioning the unified extraction", async () => {
    const page = makePage(200, 6); // ~87k chars ≈ 22k tokens
    expect(tokenCount(page)).toBeGreaterThan(EXTRACTION_BUDGET_TOKENS);

    const { fetchImpl, calls } = fakeChat(autoResponder);
    const result = await extractDocument(SETTINGS, page, fetchImpl);

    const mergeCalls = calls.filter(isMergeCall);
    const batchCalls = calls.filter((c) => !isMergeCall(c));
    expect(batchCalls.length).toBeGreaterThanOrEqual(2); // multiple calls
    expect(mergeCalls).toHaveLength(1); // exactly ONE merge call
    expect(calls[calls.length - 1]).toBe(mergeCalls[0]); // merge is final
    expect(result.errors).toBeUndefined();

    // Batch calls carry GLOBAL chunk indices, consecutive within each batch.
    const batchTagSets = batchCalls.map(chunkTags);
    for (const tags of batchTagSets) {
      expect(tags.length).toBeGreaterThan(0);
      expect(tags).toEqual(Array.from({ length: tags.length }, (_, i) => tags[0] + i));
    }
    // Together the batches cover every chunk index — no silent truncation.
    const chunks = chunkText(page, { maxTokens: EXTRACTION_CHUNK_TOKENS });
    const covered = new Set(batchTagSets.flat());
    expect(covered.size).toBe(chunks.length);

    // The merge call: pinned system message, batch results as plain JSON data
    // (not re-wrapped page data).
    const merge = mergeCalls[0];
    expect(merge[0].content).toContain("unifying");
    expect(merge[0].content).toContain("same schema");
    const mergeUser = userContent(merge);
    expect(mergeUser).toContain("unified");
    expect(mergeUser).toMatch(/BATCH 1 chunks \[C0\.\.C\d+\]:/);
    expect(mergeUser).not.toContain("BEGIN_PAGE_DATA");

    // Merged result covers the full chunk range.
    const idxs = result.entities.flatMap((e) => e.evidenceChunkIdx);
    expect(new Set(idxs).size).toBe(chunks.length);
  });

  it("(d) Review Focus #3: a 50k-token page still yields evidence indices covering the full chunk range", async () => {
    const page = makePage(500, 6); // ~219k chars ≈ 55k tokens
    expect(tokenCount(page)).toBeGreaterThan(50000);

    const { fetchImpl, calls } = fakeChat(autoResponder);
    const result = await extractDocument(SETTINGS, page, fetchImpl);

    const chunks = chunkText(page, { maxTokens: EXTRACTION_CHUNK_TOKENS });
    expect(chunks.length).toBeGreaterThan(20);
    expect(result.errors).toBeUndefined();

    const idxs = new Set(result.entities.flatMap((e) => e.evidenceChunkIdx));
    expect(idxs.size).toBe(chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      expect(idxs.has(i)).toBe(true);
    }
  });
});

describe("validateExtraction", () => {
  it("(c) returns null when entities or edges are not arrays (or the input is not an object)", () => {
    expect(validateExtraction({ entities: "lots" })).toBeNull();
    expect(validateExtraction({})).toBeNull();
    expect(validateExtraction({ entities: [], edges: "none" })).toBeNull();
    expect(validateExtraction(null)).toBeNull();
    expect(validateExtraction("junk")).toBeNull();
    expect(validateExtraction(42)).toBeNull();
  });

  it("(c) keeps only the pinned fields — unknown fields like hacked are dropped, never stored", () => {
    const validated = validateExtraction({
      entities: [
        { name: "Ada", label: "Person", evidenceChunkIdx: [0], hacked: true },
      ],
      edges: [
        {
          fromName: "Ada",
          fromLabel: "Person",
          toName: "Engine",
          toLabel: "Machine",
          type: "designed",
          evidenceChunkIdx: 1,
          hacked: true,
        },
      ],
    });
    expect(validated).toEqual({
      entities: [{ name: "Ada", label: "Person", evidenceChunkIdx: [0] }],
      edges: [
        {
          fromName: "Ada",
          fromLabel: "Person",
          toName: "Engine",
          toLabel: "Machine",
          type: "designed",
          evidenceChunkIdx: 1,
        },
      ],
    });
  });

  it("drops an item missing name/label instead of rejecting the whole call", () => {
    const validated = validateExtraction({
      entities: [
        { label: "NoName", evidenceChunkIdx: [0] },
        { name: "", label: "EmptyName", evidenceChunkIdx: [1] },
        { name: "Keeper", label: "Person", evidenceChunkIdx: [2] },
      ],
      edges: [],
    });
    expect(validated).toEqual({
      entities: [{ name: "Keeper", label: "Person", evidenceChunkIdx: [2] }],
      edges: [],
    });
  });

  it("coerces an entity's non-array evidenceChunkIdx to []", () => {
    const validated = validateExtraction({
      entities: [{ name: "Ada", label: "Person", evidenceChunkIdx: "zero" }],
      edges: [],
    });
    expect(validated).toEqual({
      entities: [{ name: "Ada", label: "Person", evidenceChunkIdx: [] }],
      edges: [],
    });
  });

  it("filters non-integer/negative entries out of an entity's evidenceChunkIdx array", () => {
    const validated = validateExtraction({
      entities: [
        { name: "Ada", label: "Person", evidenceChunkIdx: [0, 1.5, -2, "3", 4] },
      ],
      edges: [],
    });
    expect(validated?.entities[0]?.evidenceChunkIdx).toEqual([0, 4]);
  });

  it("keeps an edge only when all six fields are present; non-integer evidenceChunkIdx drops the edge", () => {
    const good = {
      fromName: "Ada",
      fromLabel: "Person",
      toName: "Engine",
      toLabel: "Machine",
      type: "designed",
      evidenceChunkIdx: 3,
    };
    const validated = validateExtraction({
      entities: [],
      edges: [
        good,
        { fromName: "Ada", fromLabel: "Person", toName: "Engine", toLabel: "Machine", type: "designed" }, // idx missing
        { ...good, evidenceChunkIdx: 1.5 }, // non-integer
        { ...good, evidenceChunkIdx: -1 }, // negative
        { ...good, evidenceChunkIdx: Number.POSITIVE_INFINITY }, // non-finite
        { fromName: "Ada", fromLabel: "Person", toName: "Engine", toLabel: "Machine", evidenceChunkIdx: 5 }, // type missing
        { ...good, toName: 7 }, // wrong type
      ],
    });
    expect(validated).toEqual({ entities: [], edges: [good] });
  });
});

describe("schema-failure posture", () => {
  it("a failed batch response is retried once; success then carries no errors", async () => {
    const page = makePage(200, 6);
    const { fetchImpl, calls } = fakeChat((messages, callIdx) =>
      callIdx === 0 ? "not json" : autoResponder(messages),
    );

    const result = await extractDocument(SETTINGS, page, fetchImpl);

    expect(calls.filter(isMergeCall)).toHaveLength(1);
    expect(result.errors).toBeUndefined();
    expect(result.entities.length).toBeGreaterThan(0);
  });

  it("persistent batch failure yields a flagged partial result rather than throwing", async () => {
    const page = makePage(200, 6);
    const { fetchImpl, calls } = fakeChat(() => "not json");

    const result = await extractDocument(SETTINGS, page, fetchImpl);

    // Every batch got its original call plus exactly one retry.
    const batchCalls = calls.filter((c) => !isMergeCall(c));
    expect(batchCalls.length % 2).toBe(0);
    const batchCount = batchCalls.length / 2;
    expect(batchCount).toBeGreaterThanOrEqual(2);
    expect(calls.filter(isMergeCall)).toHaveLength(2); // merge also retried once

    expect(result.entities).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.errors).toEqual([
      ...Array.from(
        { length: batchCount },
        (_, i) => `batch ${i + 1}: invalid schema after retry`,
      ),
      "merge: invalid schema after retry",
    ]);
  });

  it("persistent failure on the single-call path returns empty with the pinned error", async () => {
    const page = makePage(3, 2);
    const { fetchImpl, calls } = fakeChat(() => "not json");

    const result = await extractDocument(SETTINGS, page, fetchImpl);

    expect(calls).toHaveLength(2); // original + one retry
    expect(result).toEqual({
      entities: [],
      edges: [],
      errors: ["extraction: invalid schema after retry"],
    });
  });

  it("a failed merge falls back to the un-unified batch results, flagged", async () => {
    const page = makePage(200, 6);
    const { fetchImpl, calls } = fakeChat((messages) =>
      isMergeCall(messages) ? "not json" : batchEntityJson(messages),
    );

    const result = await extractDocument(SETTINGS, page, fetchImpl);

    const chunks = chunkText(page, { maxTokens: EXTRACTION_CHUNK_TOKENS });
    expect(calls.filter(isMergeCall)).toHaveLength(2); // retried once
    expect(result.errors).toEqual(["merge: invalid schema after retry"]);
    // Partial: every batch entity survives, un-unified.
    const idxs = new Set(result.entities.flatMap((e) => e.evidenceChunkIdx));
    expect(idxs.size).toBe(chunks.length);
  });

  it("network failures throw — only schema problems are non-throwing", async () => {
    const page = makePage(3, 2);
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(extractDocument(SETTINGS, page, fetchImpl)).rejects.toThrow("boom");
  });
});
