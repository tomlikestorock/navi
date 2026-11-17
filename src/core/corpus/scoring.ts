/** Shared TF-IDF scoring for text corpora (files, web). Drivers supply
 * matching documents and their term counts; this module only ranks. No index
 * and no embedding — ponytail: add an index when a scan measurably hurts. */

/** A document that matched at least one query term, awaiting ranking. */
export interface Match<T> {
  item: T;
  /** Occurrences per query term, same order as `terms`. */
  counts: number[];
  /** Document length in word tokens, for tf normalization. */
  words: number;
}

/** A ranked document: its driver item, matched terms and 0..1 score. */
export interface Ranked<T> {
  item: T;
  matchedTerms: string[];
  score: number;
}

/** Split the query into unique case-insensitive word terms. */
export function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

/** Occurrences of every term in already-lowercased text. */
export function countTerms(haystack: string, terms: string[]): number[] {
  return terms.map((term) => countOccurrences(haystack, term));
}

/** Document length in word tokens, floored at 1 so tf never divides by zero. */
export function wordCount(text: string): number {
  return Math.max(1, text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0);
}

/** First line containing any term, else the first non-empty line. */
export function excerptFor(content: string, terms: string[]): string {
  const lines = content.split(/\r?\n/);
  const matching = lines.find((line) => {
    const text = line.toLowerCase();
    return terms.some((term) => text.includes(term));
  });
  const first = lines.find((line) => line.trim() !== "");
  return (matching ?? first ?? "").trim();
}

/** Rank matches by TF-IDF and normalize scores to 0..1.
 *
 * A term found in nearly every document ("config") says less about a hit than
 * a rare one ("force-push"). Smoothed, so df = N still leaves a weight. tf is
 * count over document length: a big document stuffed with a common term must
 * not outrank a small one that is actually about it. `totalDocuments` is every
 * document examined, including non-matches, for the document frequency.
 *
 * ponytail: substring matching kept from the files driver — word boundaries
 * would stop "auth" matching "authentication"; upgrade if precision matters.
 */
export function rankMatches<T>(
  terms: string[],
  matches: Array<Match<T>>,
  totalDocuments: number,
  limit: number,
  byId: (a: T, b: T) => number,
): Array<Ranked<T>> {
  const idf = terms.map((_, index) => {
    const df = matches.filter((match) => match.counts[index] > 0).length;
    return Math.log((totalDocuments + 1) / (df + 1)) + 1;
  });

  const scored = matches.map(({ item, counts, words }) => {
    const matchedTerms: string[] = [];
    let rawScore = 0;
    counts.forEach((count, index) => {
      if (count === 0) return;
      matchedTerms.push(terms[index]);
      rawScore += (count / words) * idf[index];
    });
    return { item, matchedTerms, rawScore };
  });

  scored.sort((a, b) => b.rawScore - a.rawScore || byId(a.item, b.item));
  const top = scored.slice(0, limit);
  const best = top[0]?.rawScore ?? 1;
  return top.map(({ item, matchedTerms, rawScore }) => ({
    item,
    matchedTerms,
    score: rawScore / best,
  }));
}

function countOccurrences(haystack: string, term: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(term, from);
    if (at === -1) return count;
    count += 1;
    from = at + term.length;
  }
}
