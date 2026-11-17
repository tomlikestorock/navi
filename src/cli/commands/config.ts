/** `navi config show` and `navi config check`.
 * Thin shells: resolution and validation live in core. */

import {
  ConfigError,
  createBuiltinAnalyzer,
  createBuiltinRegistry,
  createSearchEngine,
  loadConfig,
  mergeConfigs,
  readConfigFile,
} from "#core/index.ts";
import type { ResolvedNaviConfig } from "#core/index.ts";

export interface ResolvedConfig {
  /** Every corpus carries its resolved `baseDir`. */
  config: ResolvedNaviConfig;
  /** Files actually read, global first. */
  files: string[];
}

/** The effective config. `configFile` bypasses global + project discovery so
 * the CLI can be pointed at a fixture; discovery is the default path. */
export function resolveConfig(configFile?: string): ResolvedConfig {
  if (configFile !== undefined) {
    const config = readConfigFile(configFile);
    if (config === null) throw new ConfigError(configFile, "file not found");
    // Merge the single file through the same effective-config path, so
    // cross-section checks and anchoring run here too.
    const merged = mergeConfigs({ file: configFile, config });
    return { config: merged.config, files: [configFile] };
  }

  return loadConfig();
}

/** Effective merged config as JSON. `baseDir` is internal resolution state, so
 * it is stripped: the output stays a valid input config. */
export function configShow(configFile?: string): string {
  const { config } = resolveConfig(configFile);
  const shown = {
    ...config,
    corpuses: config.corpuses.map(({ baseDir: _baseDir, ...declared }) => declared),
  };
  return `${JSON.stringify(shown, null, 2)}\n`;
}

/** Config-level validation, plus "every enabled corpus and detector can be
 * built" (something that cannot exist is an operator error).
 * Registry failures are re-shaped as `ConfigError`, so an unknown detector
 * type or bad driver options reads like every other config diagnostic — the
 * file, then the detail. Returns a one-line report. */
export async function configCheck(configFile?: string): Promise<string> {
  const { config, files } = resolveConfig(configFile);

  try {
    // Building the engine is the check: it loads every enabled corpus through
    // the same registry and load phase the CLI uses, so the two cannot drift.
    await createSearchEngine(config, createBuiltinRegistry());

    // The analyzer half of the same discipline: every configured detector
    // instance must resolve and pass its options schema. The
    // registry is the detector type vocabulary, so an unknown type dies here.
    createBuiltinAnalyzer(config);
  } catch (error) {
    throw new ConfigError(
      files.join(", ") || "config",
      error instanceof Error ? error.message : String(error),
    );
  }

  const enabled = config.corpuses.filter((corpus) => corpus.disabled !== true).length;
  const disabled = config.corpuses.length - enabled;
  const sources = files.length > 0 ? `read ${files.join(", ")}` : "no config files found";
  return `config ok: ${enabled} enabled, ${disabled} disabled; ${sources}\n`;
}
