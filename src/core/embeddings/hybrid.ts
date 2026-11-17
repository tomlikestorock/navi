/** The one hybrid retriever every embeddable corpus shares.
 *
 * A corpus ranks its documents twice — TF-IDF and cosine — and fuses the two
 * lists with RRF. Both text drivers reduce to "scan documents, map the ranked
 * result to a hit": lexical ranking, embedding setup, read-through warming,
 * fusion, normalization and the degrade path live here once.
 *
 * Read-through (the default) embeds only the documents a search retrieved,
 * but the vector ranking covers every scanned document that already has a
 * cached vector — including one this query never matched lexically. That is
 * what lets a previous search's warm add recall instead of merely reordering
 * the lexical hit list. */

import { appendJsonl } from "../cache.ts";
import type { CorpusConfig } from "../config/schema.ts";
import type { CorpusContext } from "../corpus/registry.ts";
import { excerptFor, rankMatches } from "../corpus/scoring.ts";
import type { Match, Ranked } from "../corpus/scoring.ts";
import { loadVectors, vectorCacheFile, vectorKey } from "./cache.ts";
import type { CachedVector } from "./cache.ts";
import type { EmbeddingProvider } from "./embed.ts";
import { cosine, fuseRanks } from "./retrieval.ts";

/** Texts per provider call. Arrays, never per-document calls. */
const EMBED_BATCH = 100;

/** A corpus's resolved embedding setup. `eager` warms every
 * document on the first search; false reads through only what it retrieves. */
export interface HybridEmbedding {
  corpusId: string;
  provider: EmbeddingProvider;
  /** Provider model id — part of every cache key. */
  model: string;
  eager: boolean;
}

/** The documents one scan produced, plus the accessors the retriever needs. */
export interface HybridCorpus<T> {
  /** Every scanned document, lexical match or not: a cached vector still
   * ranks it even when this query matched no term. */
  documents: T[];
  /** Lexical matches with per-term counts, from the same scan. */
  matches: Array<Match<T>>;
  /** Documents examined (including non-matches), for the idf. */
  totalDocuments: number;
  /** Stable document id — the fusion key. */
  idOf: (item: T) => string;
  /** Content hashed into the vector cache key (web salts with its url). */
  keyTextOf: (item: T) => string;
  /** Text handed to the embedding provider. */
  textOf: (item: T) => string;
}

/** One ranked document, ready for a driver's corpus-hit mapping. */
export interface HybridHit<T> {
  item: T;
  excerpt: string;
  /** 0..1, normalized by the top fused score. */
  score: number;
  /** Lexical terms then vector similarity, e.g. ["text:force", "vector:0.970"]. */
  matchedBy: string[];
}

/** A ranking plus how much of the corpus the vector tier could
 * reach. `vectors` is absent when the corpus is not embedded. */
export interface HybridRanking<T> {
  hits: Array<HybridHit<T>>;
  vectors?: { covered: number; cold: number };
}

/** Resolve a corpus's embedding provider once through the
 * shared context. A corpus without `embed` never touches the provider. */
export function embeddingSetup(
  config: CorpusConfig,
  context: CorpusContext,
  eager = false,
): HybridEmbedding | undefined {
  if (config.embed === undefined) return undefined;

  const { provider, model } = context.embeddings(config.embed);
  return { corpusId: config.id, provider, model, eager };
}

/** Rank every document: lexical only without an embedding setup, otherwise
 * lexical fused with cosine. A provider or cache failure degrades to the
 * lexical hits, never an empty corpus; the
 * degraded result reports every document cold, so the loss of vector recall
 * is visible rather than silent. */
export async function rankHybrid<T>(
  query: string,
  terms: string[],
  corpus: HybridCorpus<T>,
  limit: number,
  embedding?: HybridEmbedding,
): Promise<HybridRanking<T>> {
  const lexical = rankMatches(terms, corpus.matches, corpus.totalDocuments, limit, (a, b) =>
    corpus.idOf(a).localeCompare(corpus.idOf(b)),
  );
  if (embedding === undefined) {
    return { hits: lexical.map((entry) => lexicalHit(entry, corpus, terms)) };
  }

  try {
    return await fuse(query, terms, corpus, lexical, limit, embedding);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`corpus "${embedding.corpusId}": embedding failed: ${reason}`);
    return {
      hits: lexical.map((entry) => lexicalHit(entry, corpus, terms)),
      vectors: { covered: 0, cold: corpus.documents.length },
    };
  }
}

/** Embed the query, warm what this search needs, then fuse
 * the lexical and cosine rankings with RRF. */
async function fuse<T>(
  query: string,
  terms: string[],
  corpus: HybridCorpus<T>,
  lexical: Array<Ranked<T>>,
  limit: number,
  embedding: HybridEmbedding,
): Promise<HybridRanking<T>> {
  const cacheFile = vectorCacheFile(embedding.corpusId);
  const vectors = loadVectors(cacheFile);
  const keyOf = (item: T) => vectorKey(embedding.model, corpus.keyTextOf(item));

  const [queryVector] = await embedding.provider.embed([query]);
  if (queryVector === undefined) throw new Error("provider returned no query vector");

  // Read-through embeds only the documents this search retrieved; eager warms
  // the whole corpus on the first search (a documented one-time delay).
  const retrieved = new Set(lexical.map((entry) => corpus.idOf(entry.item)));
  const targets = corpus.documents.filter(
    (item) =>
      corpus.textOf(item).trim() !== "" &&
      !vectors.has(keyOf(item)) &&
      (embedding.eager || retrieved.has(corpus.idOf(item))),
  );

  for (let start = 0; start < targets.length; start += EMBED_BATCH) {
    const batch = targets.slice(start, start + EMBED_BATCH);
    const embedded = await embedding.provider.embed(batch.map((item) => corpus.textOf(item)));
    const entries: CachedVector[] = batch.map((item, index) => ({
      key: keyOf(item),
      vector: embedded[index],
    }));
    for (const entry of entries) vectors.set(entry.key, entry.vector);
    appendJsonl(cacheFile, entries);
  }

  // Every scanned document with a cached vector joins the ranking, matched
  // lexically or not: that is the recall a read-through warm buys.
  let covered = 0;
  const vectorRanked = corpus.documents
    .flatMap((item) => {
      const vector = vectors.get(keyOf(item));
      if (vector === undefined) return [];
      covered += 1;
      const score = cosine(queryVector, vector);
      // A non-positive cosine is no similarity at all; surfacing it would add
      // noise once a warm cache holds every document (eager mode).
      return score > 0 ? [{ item, score }] : [];
    })
    .sort((a, b) => b.score - a.score || corpus.idOf(a.item).localeCompare(corpus.idOf(b.item)))
    .slice(0, limit);

  const fused = fuseRanks(
    [
      { label: "text", items: lexical.map((entry) => entry.item) },
      { label: "vector", items: vectorRanked.map((entry) => entry.item) },
    ],
    corpus.idOf,
  ).slice(0, limit);

  const lexicalById = new Map(lexical.map((entry) => [corpus.idOf(entry.item), entry]));
  const vectorById = new Map(vectorRanked.map((entry) => [corpus.idOf(entry.item), entry]));
  const best = fused[0]?.rrf ?? 1;
  const hits = fused.map(({ item, rrf }) => {
    const text = lexicalById.get(corpus.idOf(item));
    const vector = vectorById.get(corpus.idOf(item));
    return {
      item,
      excerpt: excerptFor(corpus.textOf(item), terms),
      score: rrf / best,
      matchedBy: [
        ...(text?.matchedTerms ?? []).map((term) => `text:${term}`),
        ...(vector === undefined ? [] : [`vector:${vector.score.toFixed(3)}`]),
      ],
    };
  });
  return { hits, vectors: { covered, cold: corpus.documents.length - covered } };
}

/** One lexical ranking as a hit, for lexically-ranked and degraded results. */
function lexicalHit<T>(entry: Ranked<T>, corpus: HybridCorpus<T>, terms: string[]): HybridHit<T> {
  return {
    item: entry.item,
    excerpt: excerptFor(corpus.textOf(entry.item), terms),
    score: entry.score,
    matchedBy: entry.matchedTerms.map((term) => `text:${term}`),
  };
}
