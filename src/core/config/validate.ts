/** Schema validation of one config file. Driver
 * `optionsSchema` validation is the registry's job (bean navi-ruse). */

import type { NaviConfig } from "./schema.ts";
import type { SourceLocation } from "./jsonc.ts";
import { formatIssues } from "../zod-issues.ts";
import { ConfigError } from "./error.ts";
import { resolveEmbeddingProvider, resolveModelProvider } from "./providers.ts";
import { NaviConfigSchema } from "./schema.ts";

/** Where a node of the parsed file sits, when the caller parsed it with
 * `parseJsonc` (diagnostics carry the line). */
export type Locator = (path: ReadonlyArray<string | number>) => SourceLocation | null;

/** Validate a parsed config file and narrow it to `NaviConfig`.
 * Throws `ConfigError` naming the file and the offending field(s). */
export function validateConfig(value: unknown, file: string, locate?: Locator): NaviConfig {
  const result = NaviConfigSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(file, formatIssues(result.error));
  }

  // Cross-entry checks: cheaper and clearer as a Set than a schema refinement.
  // Corpus, detector, and model-provider ids share one namespace each; the
  // merge keys by id.
  checkDuplicateIds(result.data.corpuses, ["corpuses"], file, locate);
  checkDuplicateIds(result.data.analyzer?.detectors ?? [], ["analyzer", "detectors"], file, locate);
  checkDuplicateIds(result.data.models ?? [], ["models"], file, locate);
  checkDuplicateIds(result.data.embeddings ?? [], ["embeddings"], file, locate);

  return result.data;
}

/** On the *effective* config, every corpus `embed` must name a
 * declared, enabled embedding provider. Per-file validation cannot see a global
 * provider referenced from the project file, so this runs after merge.
 * `origin` names the declaring file for the diagnostic. */
export function validateEmbedReferences(
  config: NaviConfig,
  origin: Map<string, string> = new Map(),
): void {
  for (const corpus of config.corpuses) {
    if (corpus.embed === undefined) continue;
    resolveEmbeddingProvider(
      config,
      corpus.embed,
      `corpus "${corpus.id}" embed`,
      origin.get(corpus.id) ?? "merged config",
    );
  }
}

/** The filter's provider must name a declared, enabled model
 * provider. Runs on the effective config like `embed` references, since the
 * provider may live in the other config file. */
export function validateFilterProvider(config: NaviConfig): void {
  if (config.filter !== undefined) {
    resolveModelProvider(config, config.filter.provider, "filter");
  }
}

function checkDuplicateIds(
  entries: readonly { id: string }[],
  path: ReadonlyArray<string | number>,
  file: string,
  locate?: Locator,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      return;
    }
    const at = locate?.([...path, index, "id"]);
    const where = at === null || at === undefined ? "" : ` at line ${at.line}, column ${at.column}`;
    throw new ConfigError(file, `${path.join(".")}: duplicate id "${entry.id}"${where}`);
  });
}
