/** The one named-provider lookup.
 *
 * Every reference to a declared provider — corpus `embed`, the filter, a
 * detector's `options.provider` — resolves through here, whether it runs at
 * config-validation time or at runtime. One lookup means one message and one
 * error type (`ConfigError`) for the same broken reference. */

import type { EmbeddingProviderConfig, ModelProviderConfig, NaviConfig } from "./schema.ts";
import { ConfigError } from "./error.ts";

/** The effective config has no single file, so this is its location. */
const MERGED = "merged config";

/** A model provider by id, rejecting unknown and
 * disabled entries. `label` names the reference site, e.g. `filter`. */
export function resolveModelProvider(
  config: NaviConfig,
  id: string,
  label: string,
): ModelProviderConfig {
  const provider = config.models?.find((entry) => entry.id === id);
  if (provider === undefined) {
    throw new ConfigError(MERGED, `${label}: references unknown model provider "${id}"`);
  }
  if (provider.disabled === true) {
    throw new ConfigError(MERGED, `${label}: model provider "${id}" is disabled`);
  }
  return provider;
}

/** An embedding provider by id, rejecting unknown and disabled
 * entries. `label` names the reference site; `file` is the declaring file for
 * the diagnostic (the effective config when no single file declared it). */
export function resolveEmbeddingProvider(
  config: NaviConfig,
  id: string,
  label: string,
  file: string = MERGED,
): EmbeddingProviderConfig {
  const provider = config.embeddings?.find((entry) => entry.id === id);
  if (provider === undefined) {
    throw new ConfigError(file, `${label}: references unknown embedding provider "${id}"`);
  }
  if (provider.disabled === true) {
    throw new ConfigError(file, `${label}: embedding provider "${id}" is disabled`);
  }
  return provider;
}
