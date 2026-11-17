/** `navi search "text"` — analyze the text, then
 * federate every enabled corpus for the resulting Situation and print the
 * hits. A fixture Situation file may replace the analyze step. */

import { readFileSync } from "node:fs";

import {
  ConfigError,
  createSearchEngine,
  createBuiltinRegistry,
  formatHits,
  formatIssues,
  SituationSchema,
} from "#core/index.ts";
import type { CorpusHit, HitFormat, Situation } from "#core/index.ts";

import { analyzeToSituation, type AnalyzeCommandOptions } from "./analyze.ts";
import { resolveConfig } from "./config.ts";

export interface SearchCommandOptions extends AnalyzeCommandOptions {
  configFile?: string;
  limit?: number;
  /** Human-readable advisory block by default; raw hits for scripts. */
  json?: boolean;
  /** Read the Situation from this JSON file instead of analyzing text. */
  situation?: string;
}

/** Parse a fixture Situation: `text` required, every hint defaulted empty.
 * The file is outside the process, so it is validated here — no unchecked
 * spread into the engine. Diagnostics use the config error shape (file +
 * field), since a bad fixture is an operator error too. */
export function loadSituation(file: string): Situation {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const result = SituationSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(file, formatIssues(result.error, "situation"));
  }
  return result.data;
}

/** Shared pipeline for `navi search` and `navi pack`. */
export async function retrieve(
  text: string,
  options: SearchCommandOptions,
): Promise<{ hits: CorpusHit[]; format: (format: HitFormat) => string }> {
  const { config } = resolveConfig(options.configFile);
  const engine = await createSearchEngine(config, createBuiltinRegistry());
  const situation =
    options.situation === undefined
      ? await analyzeToSituation(text, config, options)
      : loadSituation(options.situation);
  const hits = await engine.search(situation, { limit: options.limit });
  return { hits, format: (format) => formatHits(hits, format) };
}

export async function search(text: string, options: SearchCommandOptions): Promise<string> {
  const { format } = await retrieve(text, options);
  return format(options.json === true ? "json" : "inject");
}
