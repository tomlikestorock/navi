/** The `web` corpus — pages fetched from configured URLs. */

import type { CorpusConfig } from "../../../config/schema.ts";
import type { CorpusContext } from "../../../corpus/registry.ts";
import type {
  Corpus,
  CorpusSearchOptions,
  CorpusSearchResult,
  CorpusRead,
} from "../../../corpus/types.ts";
import { embeddingSetup } from "../../../embeddings/hybrid.ts";
import type { HybridEmbedding } from "../../../embeddings/hybrid.ts";
import type { Situation } from "../../../situation/types.ts";
import { parseOptions } from "../../../registry.ts";
import { webOptionsSchema, type WebOptions } from "./options.ts";
import { readPage } from "./pages.ts";
import { searchWeb } from "./search.ts";

/** Hits returned when the caller does not ask for a specific count. */
const DEFAULT_LIMIT = 10;

export class WebCorpus implements Corpus {
  static readonly optionsSchema = webOptionsSchema;

  readonly id: string;
  readonly #options: WebOptions;
  readonly #embedding?: HybridEmbedding;
  /** A truncating cap is logged once per corpus, not per search. */
  #loggedTruncation = false;

  constructor(config: CorpusConfig, context: CorpusContext) {
    this.id = config.id;
    // Self-contained: parse through the one helper so a directly constructed
    // corpus throws the same formatted diagnostic the registry does.
    this.#options = parseOptions(webOptionsSchema, config.options, `corpus "${config.id}"`);
    // Web has no eagerness knob: a fetch is the read moment, so every fetched
    // page warms.
    this.#embedding = embeddingSetup(config, context, true);
  }

  async search(situation: Situation, options?: CorpusSearchOptions): Promise<CorpusSearchResult> {
    const limit = options?.limit ?? DEFAULT_LIMIT;
    const { hits, coverage } = await searchWeb(
      situation.text,
      this.id,
      this.#options,
      limit,
      this.#embedding,
    );
    if (coverage.dropped > 0 && !this.#loggedTruncation) {
      this.#loggedTruncation = true;
      console.error(
        `corpus "${this.id}": maxPages ${this.#options.maxPages} dropped ${coverage.dropped} urls`,
      );
    }
    return { hits: hits.map((hit) => ({ ...hit, corpus: this.id })), coverage };
  }

  async read(id: string): Promise<CorpusRead> {
    return readPage(this.id, this.#options, id);
  }
}
