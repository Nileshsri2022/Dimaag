/**
 * BM25-lite scoring over a docs list. Standard Okapi BM25 with the
 * parameters pinned by the plan: k1 = 1.5, b = 0.75, IDF computed from the
 * docs list itself, document length in tokens via the shared chars/4 rule
 * (`tokenCount`).
 */

import { tokenCount } from "./chunker";
import { tokenize } from "./retrieval";

const K1 = 1.5;
const B = 0.75;

export interface Bm25Doc {
  id: string;
  text: string;
}

/**
 * Per-doc BM25 score for the query terms. Terms are the unique tokens of the
 * query; docs that contain none score 0 (and stay out of the ranking — an
 * entity-name boost can later lift them, see LocalStore.search).
 */
export function bm25Scores(query: string, docs: Bm25Doc[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (docs.length === 0) return scores;

  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return scores;

  const n = docs.length;
  const docTokens = docs.map((d) => tokenize(d.text));
  const docLen = docs.map((d) => Math.max(1, tokenCount(d.text)));
  const avgLen = docLen.reduce((sum, len) => sum + len, 0) / n;

  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>(
    terms.map((t) => {
      const dft = df.get(t) ?? 0;
      return [t, Math.log(1 + (n - dft + 0.5) / (dft + 0.5))];
    }),
  );

  docs.forEach((doc, i) => {
    const tf = new Map<string, number>();
    for (const token of docTokens[i]) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    const len = docLen[i];
    let score = 0;
    for (const term of terms) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) continue;
      const weight = (freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * len) / avgLen));
      score += idf.get(term)! * weight;
    }
    scores.set(doc.id, score);
  });

  return scores;
}

/**
 * Doc ids by BM25 score, descending. Stable: ties keep the input doc order.
 */
export function bm25Rank(query: string, docs: Bm25Doc[]): string[] {
  const scores = bm25Scores(query, docs);
  return docs
    .map((doc, index) => ({ id: doc.id, score: scores.get(doc.id) ?? 0, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.id);
}
