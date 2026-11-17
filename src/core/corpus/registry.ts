/** Driver registry — corpus kinds map to
 * classes; `custom` loads its class from the configured `module`. */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CorpusConfig, NaviConfig, ResolvedCorpusConfig } from "../config/schema.ts";
import { resolveConfiguredPath } from "../config/paths.ts";
import { resolveEmbeddingProvider } from "../config/providers.ts";
import { createEmbeddingProvider } from "../embeddings/embed.ts";
import type { EmbeddingFactory, EmbeddingProvider } from "../embeddings/embed.ts";
import { construct, TypeRegistry, type OptionsRecord, type TypeClass } from "../registry.ts";
import type { Corpus } from "./types.ts";

/** A resolved embedding provider plus the model id every vector
 * cache key is built from. Resolution caches both. */
export interface ResolvedEmbedding {
  provider: EmbeddingProvider;
  model: string;
}

/** Resolve an embedding provider id; built once per resolver and
 * cached, so corpora sharing an id share one provider. */
export type EmbeddingResolver = (id: string) => ResolvedEmbedding;

/** The standard setup context every corpus is constructed with. A corpus reads
 * the merged config it needs and resolves embedding providers here — no corpus
 * special-cases anything. */
export interface CorpusContext {
  /** The merged config — anything a corpus wants to read for itself. */
  readonly config: NaviConfig;
  /** Directory of the config file that declared this corpus. Always present at
   * load time, so relative path options never anchor at the process cwd. */
  readonly baseDir: string;
  /** Expand `~` and `${VAR}`, then resolve against `baseDir`.
   * Every config-declared path goes through here. */
  resolvePath(value: string): string;
  /** Resolve a named embedding provider; throws on unknown or disabled ids.
   * Resolution is lazy and cached: only referenced providers are ever built.
   * A corpus without `embed` never calls this. */
  embeddings(id: string): ResolvedEmbedding;
}

/** What `Registry.load` needs to build the setup context. `config` is the
 * merged config; `embeddings` is the run's shared resolver (a standalone load
 * gets a private one). */
export interface CorpusLoadOptions {
  config?: NaviConfig;
  embeddings?: EmbeddingResolver;
}

/** A corpus class: constructed synchronously (config is data, heavy setup is
 * lazy) with the standard invocation interface, and optionally declaring the
 * zod schema for `config.options`. */
export type CorpusClass<O extends OptionsRecord = OptionsRecord> = TypeClass<
  CorpusConfig,
  CorpusContext,
  Corpus,
  O
>;

/** One provider resolver per run — build it once and hand it to
 * every `load`, so corpora sharing a provider id share one provider. */
export function createEmbeddingResolver(
  config: NaviConfig = { corpuses: [] },
  createEmbedding: EmbeddingFactory = createEmbeddingProvider,
): EmbeddingResolver {
  const providers = new Map<string, ResolvedEmbedding>();

  return (id) => {
    const cached = providers.get(id);
    if (cached !== undefined) return cached;

    const providerConfig = resolveEmbeddingProvider(config, id, "embeddings");
    const resolved = {
      provider: createEmbedding(providerConfig),
      model: providerConfig.model,
    };
    providers.set(id, resolved);
    return resolved;
  };
}

export interface CorpusContextOptions {
  /** The corpus's declaring directory. */
  baseDir: string;
  /** The run's shared resolver; omit for one private to this context. */
  embeddings?: EmbeddingResolver;
}

/** The standard setup context for one corpus. Unknown or
 * disabled embedding ids throw through the one config lookup (unreachable
 * through config validation, but the seam stays loud). */
export function createCorpusContext(
  config: NaviConfig = { corpuses: [] },
  options: CorpusContextOptions,
): CorpusContext {
  const { baseDir } = options;
  return {
    config,
    baseDir,
    resolvePath: (value) => resolveConfiguredPath(baseDir, value),
    embeddings: options.embeddings ?? createEmbeddingResolver(config),
  };
}

/** The default registry: the shared type map plus corpus-only module loading
 * and the setup context. Creation functions take this concrete class, exactly
 * like DetectorRegistry — one seam, no parallel interface nothing implements. */
export class Registry extends TypeRegistry<CorpusConfig, CorpusContext, Corpus> {
  constructor() {
    super("corpus");
  }

  /** Resolve → validate `options` → construct with the setup context.
   * `baseDir` is the only anchor: config-declared corpora always carry one. */
  async load(config: ResolvedCorpusConfig, options: CorpusLoadOptions = {}): Promise<Corpus> {
    const cls = await this.#classFor(config);
    const ctx = createCorpusContext(options.config ?? { corpuses: [] }, {
      baseDir: config.baseDir,
      embeddings: options.embeddings,
    });
    return construct(cls, config, ctx, this.label(config));
  }

  /** Registered kinds win; `custom` imports its class from the
   * declared `module`, anchored at the config file's directory. Unknown kinds
   * fail loud — config validation rejects them before this point, so reaching
   * that branch is a bug. */
  async #classFor(config: ResolvedCorpusConfig): Promise<CorpusClass> {
    const registered = this.find(config.type);
    if (registered !== undefined) return registered;

    if (config.type === "custom") {
      if (config.module === undefined) {
        throw new Error(
          'corpus type "custom" requires a "module" (config validation reports this)',
        );
      }
      return loadCorpusModule(config.module, config.baseDir);
    }

    // Unreachable through a validated config: the schema's enum is the same
    // closed vocabulary. Kept loud for direct registry callers and plugins.
    throw this.unknownType(config.type);
  }
}

/** Import a corpus module and validate its export shape.
 * Every failure names the module so a bad config line is self-diagnosing. */
async function loadCorpusModule(module: string, anchor: string): Promise<CorpusClass> {
  let specifier = module;
  let loaded: unknown;
  try {
    specifier = moduleSpecifier(module, anchor);
    loaded = await import(specifier);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`corpus module "${specifier}": cannot load — ${reason}`);
  }

  const candidate = (loaded as { default?: unknown }).default;
  if (
    typeof candidate !== "function" ||
    (candidate as { optionsSchema?: unknown }).optionsSchema === undefined
  ) {
    throw new Error(
      `corpus module "${specifier}": default export must be a CorpusClass ` +
        `(a constructor with a static optionsSchema)`,
    );
  }
  return candidate as CorpusClass;
}

/** `./` and `../` are files next to the declaring config; any
 * other module is a package read through the running installation's export
 * map with the `import` condition. */
function moduleSpecifier(module: string, anchor: string): string {
  if (module.startsWith("./") || module.startsWith("../")) {
    return pathToFileURL(resolve(anchor, module)).href;
  }
  return import.meta.resolve(module);
}
