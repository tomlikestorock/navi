/** Effective config = merge(global, project), global → project. */

import { dirname } from "node:path";

import type {
  AnalyzerConfig,
  DetectorConfig,
  EmbeddingProviderConfig,
  FilterConfig,
  ModelProviderConfig,
  NaviConfig,
  ResolvedCorpusConfig,
  ResolvedNaviConfig,
  SurfacingConfig,
} from "./schema.ts";
import { validateEmbedReferences, validateFilterProvider } from "./validate.ts";

/** One parsed config file, tagged with where it came from. Sources are
 * passed in merge order (global first), so the last one wins. */
export interface ConfigSource {
  file: string;
  config: NaviConfig;
}

export interface MergedConfig {
  /** Every corpus carries the directory of the file that declared it, so
   * relative path options resolve against it. */
  config: ResolvedNaviConfig;
  /** Corpus id → the file that declared the winning entry (provenance diagnostics). */
  origin: Map<string, string>;
}

/**
 * Merge the sources. Corpuses, analyzer detectors, model providers, and
 * embedding providers are matched by `id`: a later entry replaces an earlier
 * one wholesale (no deep merge of `options`), and new entries append in
 * config order. `disabled` is just data — it survives replacement untouched.
 * Provenance is recorded while merging, so
 * nothing has to re-read the files to find out which one won. Each corpus is
 * anchored to its declaring file's directory here, once.
 *
 * Duplicate ids *within* one file are rejected by `validateConfig`, so the
 * merged id set is unique by construction: replacement is keyed by id. The
 * effective config is also where cross-section checks run: a corpus's `embed`
 * may reference a provider declared in another file. */
export function mergeConfigs(...sources: Array<ConfigSource | null>): MergedConfig {
  const merged = new Map<string, ResolvedCorpusConfig>();
  const detectors = new Map<string, DetectorConfig>();
  const modelProviders = new Map<string, ModelProviderConfig>();
  const embeddingProviders = new Map<string, EmbeddingProviderConfig>();
  const origin = new Map<string, string>();
  let analyzer: AnalyzerConfig | undefined;
  let models: ModelProviderConfig[] | undefined;
  let embeddings: EmbeddingProviderConfig[] | undefined;
  let filter: FilterConfig | undefined;
  let surfacing: SurfacingConfig | undefined;
  let $schema: string | undefined;

  for (const source of sources) {
    if (source === null) continue;
    for (const corpus of source.config.corpuses) {
      merged.set(corpus.id, { ...corpus, baseDir: dirname(source.file) });
      origin.set(corpus.id, source.file);
    }
    const declared = source.config.analyzer;
    if (declared !== undefined) {
      analyzer ??= {};
      if (declared.detectors !== undefined) {
        // Presence, not length: an explicit empty list means "no detectors",
        // which differs from an omitted section ("the defaults").
        analyzer.detectors = mergeKeyed(detectors, declared.detectors);
      }
    }
    if (source.config.models !== undefined) {
      models = mergeKeyed(modelProviders, source.config.models);
    }
    if (source.config.embeddings !== undefined) {
      embeddings = mergeKeyed(embeddingProviders, source.config.embeddings);
    }
    // A single top-level section: the later file replaces the earlier one.
    filter = source.config.filter ?? filter;
    surfacing = source.config.surfacing ?? surfacing;
    $schema = source.config.$schema ?? $schema;
  }

  const config: ResolvedNaviConfig = { corpuses: [...merged.values()] };
  if ($schema !== undefined) config.$schema = $schema;
  if (analyzer !== undefined) config.analyzer = analyzer;
  if (models !== undefined) config.models = models;
  if (embeddings !== undefined) config.embeddings = embeddings;
  if (filter !== undefined) config.filter = filter;
  if (surfacing !== undefined) config.surfacing = surfacing;
  validateEmbedReferences(config, origin);
  validateFilterProvider(config);
  return { config, origin };
}

/** Later entries replace earlier ones by `id`; new ids append in config order.
 * The same rule for every keyed section. */
function mergeKeyed<T extends { id: string }>(target: Map<string, T>, entries: readonly T[]): T[] {
  for (const entry of entries) target.set(entry.id, entry);
  return [...target.values()];
}
