/** The corpus-module contract — everything `navi/core` ships.
 *
 * A custom corpus implements `Corpus` against these seven types and gets `z`
 * here, so it needs no other dependency. The CLI's internal wiring lives in
 * `index.ts`, which is never packed; keeping this file free of runtime imports
 * except zod makes `navi/core` usable where `node:fs` does not exist. */

export type { Corpus, CorpusHit, CorpusSearchOptions, CorpusSearchResult } from "./corpus/types.ts";
export type { CorpusContext } from "./corpus/registry.ts";
export type { CorpusConfig, HitSurfacing } from "./config/schema.ts";
export type { Situation } from "./situation/types.ts";

// The one runtime export: custom corpus modules parse their options with it.
export { z } from "zod";
