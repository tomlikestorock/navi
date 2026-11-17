/** The `files` corpus — a directory tree of text files. */

import { statSync } from "node:fs";

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
import { filesOptionsSchema, type FilesOptions } from "./options.ts";
import { readFileIn, searchFiles } from "./search.ts";

/** Hits returned when the caller does not ask for a specific count. */
const DEFAULT_LIMIT = 10;

export class FilesCorpus implements Corpus {
  static readonly optionsSchema = filesOptionsSchema;

  readonly id: string;
  readonly #options: FilesOptions;
  readonly #root: string;
  readonly #embedding?: HybridEmbedding;
  /** A truncating cap is logged once per corpus, not per search. */
  #loggedTruncation = false;

  constructor(config: CorpusConfig, context: CorpusContext) {
    this.id = config.id;
    // Self-contained: parse through the one helper so a directly constructed
    // corpus throws the same formatted diagnostic the registry does.
    this.#options = parseOptions(filesOptionsSchema, config.options, `corpus "${config.id}"`);
    this.#root = context.resolvePath(this.#options.path);
    if (!statSync(this.#root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`corpus "${config.id}": files path is not a directory: ${this.#root}`);
    }
    this.#embedding = embeddingSetup(config, context, this.#options.embedEager);
  }

  async search(situation: Situation, options?: CorpusSearchOptions): Promise<CorpusSearchResult> {
    const limit = options?.limit ?? DEFAULT_LIMIT;
    const { hits, coverage } = await searchFiles(
      situation.text,
      this.#root,
      this.#options,
      limit,
      this.#embedding,
    );
    if (coverage.dropped > 0 && !this.#loggedTruncation) {
      this.#loggedTruncation = true;
      console.error(
        `corpus "${this.id}": maxFiles ${this.#options.maxFiles} dropped ${coverage.dropped} files`,
      );
    }
    return { hits: hits.map((hit) => ({ ...hit, corpus: this.id })), coverage };
  }

  async read(id: string): Promise<CorpusRead> {
    return readFileIn(this.#root, this.#options, this.id, id);
  }
}
