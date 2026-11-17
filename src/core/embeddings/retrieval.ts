/** Retrieval math shared by every embeddable corpus.
 *
 * An embedded corpus ranks its documents twice — TF-IDF and cosine — and
 * fuses the two lists with RRF using the same `k` and primitive as the
 * engine's cross-corpus fusion; `fuseRanks` is the one RRF implementation. */

/** RRF smoothing constant, shared by the engine and the corpuses. */
export const RRF_K = 60;

/**
 * ponytail: brute-force cosine over float32 vectors is fine until a corpus
 * holds ~100k+ docs (5k docs × 384-dim ≈ 7.5MB — a millisecond scan). The
 * upgrade path then: sign-quantize to 1-bit per dim, Hamming pre-filter via
 * popcount, then float32 rescore of the top-k. Caveat from the HF
 * embedding-quantization benchmarks: binarization is model-dependent —
 * e5-base collapses to ~75% MTEB, all-MiniLM holds ~94%, mxbai-large ~96%
 * (with the rescore step). Add it only when a scan measurably hurts.
 */

/** Cosine similarity between two vectors; 0 when either has no magnitude.
 * Mismatched lengths cannot be compared — 0, never a throw: one bad cached
 * vector degrades its own document, not the search. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aNorm += a[index] * a[index];
    bNorm += b[index] * b[index];
  }
  return aNorm === 0 || bNorm === 0 ? 0 : dot / Math.sqrt(aNorm * bNorm);
}

/** One ranked input list; its label rides every contribution so the caller
 * can say which list placed an item. */
export interface RankList<T> {
  label: string;
  items: T[];
}

/** One item's term in the fused sum: its 1-based rank and 1/(k + rank). */
export interface RankContribution {
  list: string;
  rank: number;
  value: number;
}

/** One fused document: its RRF sum and each list's term in that sum. */
export interface FusedRank<T> {
  item: T;
  rrf: number;
  contributions: RankContribution[];
}

/** Reciprocal Rank Fusion over labeled ranked lists. Ties break on `keyOf` so
 * equal inputs always rank identically — the same determinism the engine
 * relies on. */
export function fuseRanks<T>(
  lists: Array<RankList<T>>,
  keyOf: (item: T) => string,
): Array<FusedRank<T>> {
  const merged = new Map<string, FusedRank<T>>();

  for (const { label, items } of lists) {
    items.forEach((item, index) => {
      const rank = index + 1;
      const value = 1 / (RRF_K + rank);
      const key = keyOf(item);
      const contribution = { list: label, rank, value };
      const entry = merged.get(key);
      if (entry === undefined) {
        merged.set(key, { item, rrf: value, contributions: [contribution] });
      } else {
        entry.rrf += value;
        entry.contributions.push(contribution);
      }
    });
  }

  return [...merged.values()].sort(
    (a, b) => b.rrf - a.rrf || keyOf(a.item).localeCompare(keyOf(b.item)),
  );
}
