/** The Corpus interface and the generic hit shape. */

import type { HitSurfacing } from "../config/schema.ts";
import type { Situation } from "../situation/types.ts";

/** What one search actually examined.
 *
 * Coverage rides the result, not the hits — a hit says "here is a document",
 * coverage says "and here is how much of the corpus never got a chance".
 * `dropped > 0` and `cold_count > 0` are the two ways recall is reduced
 * without an error, so a reader can never mistake a partial sweep for absence.
 * Vector fields are absent when the corpus is not embedded or the embedding
 * tier failed. */
export interface CorpusCoverage {
  /** Documents examined after caps (files read, pages fetched). */
  seen: number;
  /** Documents a safety cap (maxFiles/maxPages) excluded before examination. */
  dropped: number;
  /** Documents the vector tier could rank this search (embedded corpuses). */
  vector_hits?: number;
  /** Documents with no vector, hence invisible to cosine recall. */
  cold_count?: number;
}

/** One corpus's answer: its ranked hits and the coverage behind them. */
export interface CorpusSearchResult {
  hits: CorpusHit[];
  coverage: CorpusCoverage;
}

/** A corpus: any searchable system. No assumptions about structure. */
export interface Corpus {
  readonly id: string;
  search(situation: Situation, options?: CorpusSearchOptions): Promise<CorpusSearchResult>;
  /**
   * By-id lookup: the full content behind one hit. Optional — a
   * corpus that cannot serve its own content (an API without a read endpoint,
   * an opaque system) omits it, and callers must handle absence.
   *
   * The corpus owns its locator rules, so `read` and `search` cannot disagree
   * about where content lives. Throws when the id is unknown, outside the
   * corpus, or not part of what this corpus's scan would surface.
   */
  read?(id: string): Promise<CorpusRead>;
}

/** The content behind a hit, plus its canonical location (path or URL). */
export interface CorpusRead {
  content: string;
  location: string;
}

export interface CorpusSearchOptions {
  limit?: number;
}

/** One result from a corpus, normalized for fusion and formatting. */
export interface CorpusHit {
  /** Corpus id — provenance. */
  corpus: string;
  /** Corpus-local identifier: slug, path, hash — corpus-defined. */
  id: string;
  title: string;
  /** Self-contained snippet; the injection unit. */
  excerpt: string;
  /** Where the full content lives: path or URL, read on demand only. */
  location: string;
  /** 0..1, normalized by the corpus. */
  score: number;
  /** Mandatory explainability, e.g. ["pattern:force-push"]. */
  matched_by: string[];
  /** Declarative surfacing metadata. Core carries it and
   * enforces nothing; the corpus default applies only when this is absent. */
  surfacing?: HitSurfacing;
}
