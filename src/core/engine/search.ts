/** The federating search engine.
 *
 * Every enabled, configured corpus is queried; failures degrade to an empty
 * ranking and a log line, never an aborted search. Rankings fuse across
 * corpuses with Reciprocal Rank Fusion (k = 60) and the fused scores are
 * normalized back to 0..1. Formatting is a pure function of the hits.
 */

import type { NaviConfig, ResolvedNaviConfig } from "../config/schema.ts";
import { resolveModelProvider } from "../config/providers.ts";
import { createEmbeddingResolver } from "../corpus/registry.ts";
import type { Corpus, CorpusHit } from "../corpus/types.ts";
import type { EmbeddingFactory } from "../embeddings/embed.ts";
import { fuseRanks } from "../embeddings/retrieval.ts";
import type { Registry } from "../corpus/registry.ts";
import type { GatewayFactory, ModelGateway } from "../models/gateway.ts";
import { createRunnerGateway } from "../models/opencode.ts";
import type { Situation } from "../situation/types.ts";
import { hitKey } from "./format.ts";
import type {
  CorpusRanking,
  FederatedSearch,
  FilterDecision,
  FilterStage,
  FusedHit,
  SearchEngine,
  SearchOptions,
} from "./types.ts";

/** Top-k when the caller does not ask for a count. */
const DEFAULT_LIMIT = 5;
/** RRF smoothing constant, shared with the embedding tier: one RRF
 * primitive serves both the per-corpus and federated fusions. */
export { RRF_K } from "../embeddings/retrieval.ts";
/** Only a *confident* "no" drops a hit. Fixed and documented,
 * like the model detector's threshold — a false negative is the expensive
 * mistake, so uncertainty always keeps. */
const DROP_CONFIDENCE = 0.5;

export interface CreateSearchEngineOptions {
  /** The filter's gateway; tests inject a fake, standalone runs
   * default to a runner (same seam as the analyzer). */
  createGateway?: GatewayFactory;
  /** The embedding factory; tests inject a counting/fake
   * provider. Omitting it builds the real HTTP provider. */
  createEmbedding?: EmbeddingFactory;
}

/** The filter resolved at load: a config error (unknown/disabled provider)
 * fails here, not inside the advisory stage. */
interface FilterRuntime {
  provider: string;
  topK: number;
  gateway: ModelGateway;
}

/** Load every enabled corpus from the config, then return a ready engine.
 * The registry is bootstrapped by the caller: the engine has no
 * knowledge of concrete drivers. Disabled entries are skipped; an entry that
 * cannot be built throws (silent misses are the enemy). */
export async function createSearchEngine(
  config: ResolvedNaviConfig,
  registry: Registry,
  options: CreateSearchEngineOptions = {},
): Promise<SearchEngine> {
  // One provider resolver per run: corpora sharing an embedding id share one
  // provider. Each corpus carries its own anchor.
  const embeddings = createEmbeddingResolver(config, options.createEmbedding);
  const enabled = config.corpuses.filter((corpus) => corpus.disabled !== true);
  const corpuses = await Promise.all(
    enabled.map((corpus) => registry.load(corpus, { config, embeddings })),
  );
  const filter = filterRuntime(config, options.createGateway ?? createRunnerGateway);
  return new FederatedEngine(corpuses, filter);
}

/** Resolve the filter's provider when the config is loaded.
 * Unknown or disabled ids are config errors — loud, not an advisory degrade —
 * and resolve through the same lookup config validation uses. */
function filterRuntime(
  config: NaviConfig,
  createGateway: GatewayFactory,
): FilterRuntime | undefined {
  const filter = config.filter;
  if (filter === undefined) return undefined;

  const provider = resolveModelProvider(config, filter.provider, "filter");
  return { provider: filter.provider, topK: filter.topK, gateway: createGateway(provider) };
}

class FederatedEngine implements SearchEngine {
  readonly #corpuses: Corpus[];
  readonly #filter: FilterRuntime | undefined;

  constructor(corpuses: Corpus[], filter: FilterRuntime | undefined) {
    this.#corpuses = corpuses;
    this.#filter = filter;
  }

  async search(situation: Situation, options: SearchOptions = {}): Promise<CorpusHit[]> {
    return (await this.searchDetailed(situation, options)).hits;
  }

  async searchDetailed(
    situation: Situation,
    options: SearchOptions = {},
  ): Promise<FederatedSearch> {
    const limit = options.limit ?? DEFAULT_LIMIT;

    // Corpora need no knowledge of each other; query them concurrently and
    // let each failure stay local.
    const rankings = await Promise.all(
      this.#corpuses.map(async (corpus): Promise<CorpusRanking> => {
        try {
          const { hits, coverage } = await corpus.search(situation, { limit });
          return { corpus: corpus.id, hits, coverage };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.error(`corpus "${corpus.id}" search failed: ${reason}`);
          return { corpus: corpus.id, hits: [], error: reason };
        }
      }),
    );

    const { fused, hits } = fuse(rankings);
    // Prune the fused top-k before formatting. Advisory —
    // a degraded filter returns the untouched list.
    const filtered = await this.#applyFilter(hits, situation);
    return {
      rankings,
      fused: fused.slice(0, limit),
      hits: filtered.hits.slice(0, limit),
      filter: filtered.filter,
    };
  }

  async #applyFilter(
    hits: CorpusHit[],
    situation: Situation,
  ): Promise<{ hits: CorpusHit[]; filter: FilterStage }> {
    const filter = this.#filter;
    if (filter === undefined) return { hits, filter: { enabled: false, topK: 0, decisions: [] } };

    const candidates = hits.slice(0, filter.topK);
    const questions = candidates.map((hit) => ({
      id: hitKey(hit),
      prompt: predicateFor(hit, situation),
    }));

    let answers: Map<string, { answer: boolean; confidence: number }>;
    try {
      const batch = await filter.gateway.ask(questions, situation.text);
      answers = new Map(batch.map((answer) => [answer.id, answer]));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `filter "${filter.provider}": ${reason}; passing ${candidates.length} hits through`,
      );
      return {
        hits,
        filter: {
          enabled: true,
          topK: filter.topK,
          error: reason,
          decisions: candidates.map((hit) => decisionOf(hit)),
        },
      };
    }

    // Include on uncertainty: a missing, partial, or low-confidence answer
    // keeps the hit; only a confident "no" drops it.
    const decisions: FilterDecision[] = candidates.map((hit) => {
      const answer = answers.get(hitKey(hit));
      if (answer === undefined) return decisionOf(hit);
      return {
        corpus: hit.corpus,
        id: hit.id,
        answer: answer.answer,
        confidence: answer.confidence,
        kept: !(answer.answer === false && answer.confidence >= DROP_CONFIDENCE),
      };
    });

    const dropped = new Set(
      decisions.filter((decision) => !decision.kept).map(({ corpus, id }) => `${corpus}:${id}`),
    );
    return {
      hits: hits.filter((hit) => !dropped.has(hitKey(hit))),
      filter: { enabled: true, topK: filter.topK, decisions },
    };
  }
}

/** RRF across per-corpus rankings via the one shared primitive, then
 * normalize to 0..1. Ties break on `corpus:id` so identical inputs always
 * rank identically. */
function fuse(rankings: CorpusRanking[]): { fused: FusedHit[]; hits: CorpusHit[] } {
  const ranked = fuseRanks(
    rankings.map(({ corpus, hits }) => ({ label: corpus, items: hits })),
    hitKey,
  );
  const best = ranked[0]?.rrf ?? 1;
  const fused: FusedHit[] = ranked.map(({ item, rrf, contributions }) => ({
    hit: item,
    rrf,
    score: rrf / best,
    contributions: contributions.map(({ list, rank, value }) => ({ corpus: list, rank, value })),
  }));
  const hits = fused.map(({ hit, score }) => ({ ...hit, score }));
  return { fused, hits };
}

/** A hit the filter has no verdict on: kept, no answer (include on
 * uncertainty). */
function decisionOf(hit: CorpusHit): FilterDecision {
  return { corpus: hit.corpus, id: hit.id, answer: null, confidence: null, kept: true };
}

/** One predicate per candidate, carrying the hit's title and
 * excerpt plus the Situation as context. One batched call sends them all. */
function predicateFor(hit: CorpusHit, situation: Situation): string {
  const context = [
    `Task: ${situation.text}`,
    situation.arenas.length > 0 ? `Arenas: ${situation.arenas.join(", ")}` : "",
    situation.intent === null ? "" : `Intent: ${situation.intent}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return [
    "Is this document applicable to the current task right now?",
    `Document: ${hit.title} — ${hit.excerpt}`,
    context,
  ].join("\n\n");
}
