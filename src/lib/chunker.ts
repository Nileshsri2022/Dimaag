/**
 * Text chunker.
 *
 * Token approximation (`tokens ~= chars / 4`, rounding up) lives here as
 * `tokenCount`; it is the single rule every budget in the codebase uses.
 *
 * `chunkText` splits text on paragraph boundaries ("\n\n"), falling back to
 * sentence boundaries (".", "!", "?" followed by whitespace or end of text),
 * falling back to a hard character cut (the case for code-like stretches with
 * no break candidates at all). Chunks are contiguous slices of the original
 * text: every chunk after the first re-includes the trailing overlap of its
 * predecessor, so removing the shared overlap prefix from each non-first chunk
 * and joining reconstructs the original text exactly.
 */

export interface ChunkerOptions {
  /** Maximum tokens per chunk. Defaults to 500. */
  maxTokens?: number;
  /** Tokens of trailing context re-included at the start of each chunk after the first. Defaults to 100 (must stay below `maxTokens`; clamped otherwise). */
  overlapTokens?: number;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_OVERLAP_TOKENS = 100;

export function tokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function chunkText(text: string, opts?: ChunkerOptions): string[] {
  let maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  let overlapTokens = opts?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  // Degenerate opts must not hang the splitter: at least one token per chunk,
  // overlap never negative, and strictly less than maxTokens.
  if (maxTokens < 1) maxTokens = 1;
  if (overlapTokens >= maxTokens) overlapTokens = maxTokens - 1;
  if (overlapTokens < 0) overlapTokens = 0;

  if (text === "") return [];

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  const chunks: string[] = [];
  // `cursor` is where the previous chunk's fresh content ended. Each chunk is
  // text.slice(cursor - overlapChars, end), so consecutive chunks share the
  // trailing `overlapChars` characters of the earlier one.
  let cursor = 0;
  while (cursor < text.length) {
    const chunkStart = Math.max(0, cursor - overlapChars);
    let end: number;
    if (text.length - chunkStart <= maxChars) {
      // Whatever is left fits in one final chunk.
      end = text.length;
    } else {
      end = findBreak(text, cursor, chunkStart + maxChars);
      // A break inside the overlap region would repeat content; when no break
      // lies past the cursor, fall back to a hard cut at the window's edge.
      if (end <= cursor) end = chunkStart + maxChars;
    }
    chunks.push(text.slice(chunkStart, end));
    cursor = end;
  }
  return chunks;
}

/**
 * End position for the next chunk: the last paragraph break in the search
 * window, else the last sentence break, else a hard cut at `hardEnd`. Only
 * positions past `cursor` count — a break there would not add new content.
 */
function findBreak(text: string, cursor: number, hardEnd: number): number {
  const paragraph = text.lastIndexOf("\n\n", hardEnd - 2);
  if (paragraph > cursor) return paragraph + 2;

  for (let i = hardEnd - 1; i > cursor; i--) {
    const char = text[i];
    if (char === "." || char === "!" || char === "?") {
      const after = text[i + 1];
      if (after === undefined || /\s/.test(after)) return i + 1;
    }
  }
  // Code-looking stretch with none of the break candidates: hard cut wins.
  return hardEnd;
}
