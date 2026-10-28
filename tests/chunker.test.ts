import { describe, expect, it } from "vitest";
import { chunkText, tokenCount } from "../src/lib/chunker";

const SENTENCE =
  "The quick brown fox jumps over the lazy dog near the riverbank at dawn. ";
const CODE_LINE = "const value = compute(hash);";

function makeProse(paragraphs: number, sentences: number): string {
  const paragraph = Array.from({ length: sentences }, () => SENTENCE).join("");
  return Array.from({ length: paragraphs }, () => paragraph).join("\n\n");
}

function makeCode(paragraphs: number): string {
  const paragraph = Array.from({ length: 10 }, () => CODE_LINE).join("\n");
  return Array.from({ length: paragraphs }, () => paragraph).join("\n\n");
}

/**
 * Controller ruling for scenario (d): join the chunks after removing the
 * shared overlap prefix between consecutive chunks; the result must equal the
 * original text exactly. The overlap is measured in tokens (chars / 4), so the
 * prefix each non-first chunk shares with its predecessor is overlapTokens*4
 * characters long.
 */
function reconstruct(chunks: string[], overlapTokens: number): string {
  return (
    chunks[0] +
    chunks
      .slice(1)
      .map((chunk) => chunk.slice(overlapTokens * 4))
      .join("")
  );
}

describe("tokenCount", () => {
  it("approximates tokens as chars / 4, rounding up", () => {
    expect(tokenCount("")).toBe(0);
    expect(tokenCount("abcd")).toBe(1);
    expect(tokenCount("abcde")).toBe(2);
    expect(tokenCount("abcdefgh")).toBe(2);
  });
});

describe("chunkText", () => {
  it("(a) empty string -> [], short text -> single chunk", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("Hello world")).toEqual(["Hello world"]);
    // Exactly maxTokens*4 chars still fits in one chunk.
    expect(chunkText("a".repeat(200), { maxTokens: 50 })).toEqual([
      "a".repeat(200),
    ]);
  });

  it("(b) N long paragraphs split into multiple chunks, each <= maxTokens except a single final remainder", () => {
    const text = makeCode(4); // 4 paragraphs of 289 chars each
    const maxTokens = 60; // 240 chars
    const chunks = chunkText(text, { maxTokens, overlapTokens: 20 });

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks.slice(0, -1)) {
      expect(tokenCount(chunk)).toBeLessThanOrEqual(maxTokens);
    }
    // The last chunk is the single remainder: whatever is left over.
    expect(tokenCount(chunks[chunks.length - 1])).toBeLessThan(maxTokens);
  });

  it("(c) every chunk after the first starts with the previous chunk's trailing overlap", () => {
    const overlapTokens = 10;
    const overlapChars = overlapTokens * 4;
    const chunks = chunkText(makeProse(4, 5), {
      maxTokens: 50,
      overlapTokens,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith(chunks[i - 1].slice(-overlapChars))).toBe(
        true,
      );
    }
  });

  it("clamps overlapTokens >= maxTokens down to maxTokens - 1", () => {
    const chunks = chunkText(makeProse(2, 5), {
      maxTokens: 50,
      overlapTokens: 50, // clamped to 49 tokens = 196 chars
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith(chunks[i - 1].slice(-196))).toBe(true);
    }
  });

  it("(d) paragraph-split chunks reconstruct the original text exactly", () => {
    const text = "A".repeat(150) + "\n\n" + "B".repeat(150) + "\n\n" + "C".repeat(150);
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });

    // With a 200-char budget, each chunk should end on a paragraph separator.
    expect(chunks.length).toBe(3);
    expect(chunks[0].endsWith("\n\n")).toBe(true);
    expect(chunks[1].endsWith("\n\n")).toBe(true);
    expect(reconstruct(chunks, 10)).toBe(text);
  });

  it("(d) sentence-boundary fallback keeps chunks complete sentences", () => {
    const text = makeProse(1, 12); // one paragraph, no "\n\n", ~876 chars
    const maxTokens = 30; // 120 chars
    const chunks = chunkText(text, { maxTokens, overlapTokens: 5 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(tokenCount(chunk)).toBeLessThanOrEqual(maxTokens);
      // No paragraph break available, so non-final chunks end on a sentence.
      expect(chunk.endsWith(".")).toBe(true);
    }
    expect(reconstruct(chunks, 5)).toBe(text);
  });

  it("(d) hard cut wins for code-like stretches with no break candidates", () => {
    const text = makeCode(4);
    const chunks = chunkText(text, { maxTokens: 60, overlapTokens: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    // No paragraph break or sentence end in the first chunk's window: hard cut.
    expect(tokenCount(chunks[0])).toBe(60);
    expect(chunks[0].startsWith(CODE_LINE)).toBe(true);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith(chunks[i - 1].slice(-80))).toBe(true);
    }
    expect(reconstruct(chunks, 20)).toBe(text);
  });

  it("handles degenerate opts without looping: maxTokens < 1, negative overlap, overlap >= maxTokens", () => {
    expect(chunkText("abcdefghij", { maxTokens: 0 })).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
    expect(chunkText("abcdefghij", { maxTokens: 2, overlapTokens: -5 })).toEqual(
      ["abcdefgh", "ij"],
    );
    const chunks = chunkText("x".repeat(60), { maxTokens: 4, overlapTokens: 99 });
    for (const chunk of chunks) {
      expect(tokenCount(chunk)).toBeLessThanOrEqual(4);
    }
  });
});
