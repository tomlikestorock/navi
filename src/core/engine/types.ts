/** Search engine interface and hit formatting. The engine federates across
 * corpuses; `ConcernHit` is now `CorpusHit`. */

import type { Situation } from "../situation/types.ts";
import type { CorpusCoverage, CorpusHit } from "../corpus/types.ts";

export interface SearchOptions {
  /** Top-k returned across all corpuses. Default 5. */
  limit?: number;
}

/** One corpus's pre-fusion ranking. `error` means the corpus search threw;
 * `hits` is then empty and the rest of the search continues,
 * with no coverage to report. */
export interface CorpusRanking {
  corpus: string;
  hits: CorpusHit[];
  /** What this corpus examined, so reduced recall (a cap, cold
   * vectors) is visible next to the hits. Absent when the corpus failed. */
  coverage?: CorpusCoverage;
  error?: string;
}

/** One corpus's RRF term for one fused hit: 1-based rank and 1/(k + rank). */
export interface FusionContribution {
  corpus: string;
  rank: number;
  value: number;
}

/** A fused hit plus the math that placed it: the unnormalized RRF sum, the
 * fused score normalized 0..1 (the sum over the best sum), and each corpus's
 * term in that sum. `hit.score` stays the corpus's own score. */
export interface FusedHit {
  hit: CorpusHit;
  rrf: number;
  score: number;
  contributions: FusionContribution[];
}

/** One filter predicate's verdict for one fused hit. */
export interface FilterDecision {
  corpus: string;
  id: string;
  /** The predicate answer; null when the filter degraded or did not answer. */
  answer: boolean | null;
  confidence: number | null;
  kept: boolean;
}

/** The applicability filter's view of the fused top-k. */
export interface FilterStage {
  /** False when no `filter` section is configured (today's behavior). */
  enabled: boolean;
  /** The fused-hit window the filter considered; 0 when disabled. */
  topK: number;
  /** Set when the gateway failed; everything passed through (advisory). */
  error?: string;
  /** One decision per candidate, in fused order. */
  decisions: FilterDecision[];
}

/** The federated search before and after fusion — the `navi trace` contract. */
export interface FederatedSearch {
  /** Every enabled corpus in config order, pre-fusion. Each ranking carries
   * its corpus's coverage, so a partial sweep is never read as
   * absence. */
  rankings: CorpusRanking[];
  /** Fused hits, best first, with their RRF math, cut to the limit. */
  fused: FusedHit[];
  /** The same fused hits as plain hits, scores normalized 0..1. */
  hits: CorpusHit[];
  /** Disabled when unconfigured. */
  filter: FilterStage;
}

/**
 * The engine interface. This is the federation seam: it queries
 * every configured corpus and fuses the results. Adding a corpus changes
 * nothing upstream.
 */
export interface SearchEngine {
  search(situation: Situation, options?: SearchOptions): Promise<CorpusHit[]>;
  /** Everything `search` computes, plus the pre-fusion rankings and the RRF
   * terms; `search` is this with only `hits` returned. */
  searchDetailed(situation: Situation, options?: SearchOptions): Promise<FederatedSearch>;
}
