/** The zod schema is the single source of truth; the
 * TypeScript types are derived from it so they cannot drift. */

import { z } from "zod";

/** The closed type vocabulary. A typo fails at config time, not
 * at import time. */
export const CORPUS_TYPES = ["files", "web", "custom"] as const;

/** Per-hit surfacing metadata. Declarative only — core carries
 * it, the harness applies it. A corpus entry may declare the same block as
 * its own default for hits that declare none. */
export const HitSurfacingSchema = z.strictObject({
  /** Repetition sensitivity: `eager` ignores the session cap, `once` shows at
   * most once per session, `normal` uses the configured caps. */
  repeat: z.enum(["eager", "normal", "once"]).optional(),
  /** Model refs (`provider/id`, or `*`) that always see this hit. Lifts the
   * caps, budget and byModel rules — never the same-turn dedupe. */
  force: z.array(z.string().min(1)).optional(),
  /** Ranking weight; carried for drivers, core enforces nothing. */
  priority: z.number().optional(),
});

/** One caps+budget rule. `byModel` entries use this shape. */
export const SurfacingRuleSchema = z.strictObject({
  /** Repetition caps per hit identity (`corpus:id`). */
  repetition: z
    .strictObject({
      perTurn: z.number().int().min(1).default(1),
      perSession: z.number().int().min(1).default(3),
    })
    .optional(),
  /** One injection's ceiling. */
  budget: z
    .strictObject({
      maxHits: z.number().int().min(1).optional(),
      maxTokens: z.number().int().min(1).optional(),
    })
    .optional(),
});

/** The top-level `surfacing` section. Consumed by the harness
 * plugin only; defaults are always on, so an absent section still caps. */
export const SurfacingConfigSchema = SurfacingRuleSchema.extend({
  /** Rules matched against the session's model ref; `*` is the default. The
   * most restrictive matching rule wins, except a hit's `force`. */
  byModel: z.record(z.string(), SurfacingRuleSchema).optional(),
});

/** One corpus entry. `strictObject` rejects typo'd keys. */
export const CorpusConfigSchema = z
  .strictObject({
    /** Unique within the merged config. Lowercase letters, digits, hyphens. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Kind of searchable system this corpus wraps: the
     * built-in `files`/`web`, or `custom`, which names its class in `module`.
     * Always required — including on disable-only entries, which name the kind
     * they disable. */
    type: z.enum(CORPUS_TYPES),
    /** Where a `custom` corpus's CorpusClass lives. `./`/`../`
     * resolves against the declaring config file, bare names from
     * `node_modules`. Required iff `type` is `custom`. */
    module: z.string().min(1).optional(),
    /** Shown by `navi corpus list`. */
    description: z.string().optional(),
    /** Embedding provider id — a universal corpus capability,
     * hence top-level. Must name an entry in the `embeddings` section
     * (checked after merge); eagerness is driver-local. */
    embed: z.string().optional(),
    /** System-defined, including the locator (files.path, confluence.url, …);
     * validated against the class's options schema. */
    options: z.record(z.string(), z.unknown()).optional(),
    /** The corpus-wide default for hits that declare no
     * `surfacing` of their own. */
    surfacing: HitSurfacingSchema.optional(),
    /** Excludes the corpus without deleting its entry. */
    disabled: z.boolean().optional(),
  })
  // Cross-field, and the message names the corpus so a multi-entry
  // config points at the offending line.
  .superRefine((corpus, ctx) => {
    if (corpus.type === "custom" && corpus.module === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["module"],
        message: `corpus "${corpus.id}": type "custom" requires a "module"`,
      });
    }
    if (corpus.type !== "custom" && corpus.module !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["module"],
        message: `corpus "${corpus.id}": "module" is only valid for type "custom"`,
      });
    }
  });

/** One detector instance. Corpus-style; `id` and `type` are both
 * required — no id-defaults-to-type, so two instances of one type need
 * distinct ids and nothing else. */
export const DetectorConfigSchema = z.strictObject({
  /** Unique within the merged config; also the provenance id. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Registry vocabulary; resolves to a detector class. Deliberately an
   * open string: the registry is the authority, so a plugin can add a type.
   * `navi config check` rejects a type nothing registers. */
  type: z.string().min(1),
  description: z.string().optional(),
  /** Validated against the class's options schema. */
  options: z.record(z.string(), z.unknown()).optional(),
  /** Excludes the instance without deleting its entry. */
  disabled: z.boolean().optional(),
});

/** The analyzer section. An omitted `detectors` list is not an
 * empty one: omitted means one default instance per registered type. */
export const AnalyzerConfigSchema = z.strictObject({
  detectors: z.array(DetectorConfigSchema).optional(),
});

/** A model provider's transport. `model` is not here — it is
 * provider-level, so the session and the runner receive the same ref. Only
 * implemented transports are declared: a config cannot name one that always
 * throws (bean navi-dkof). */
export const RunnerConfigSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("opencode") }),
  /** The Jev-style decision API — structured answers, no
   * prompt-template parsing. */
  z.strictObject({
    type: z.literal("systemone"),
    /** POSTs to `${baseUrl}/v1/systemone`. */
    baseUrl: z.string().min(1),
  }),
]);

/** One named model provider, referenced by id. */
export const ModelProviderConfigSchema = z.strictObject({
  /** Unique within the merged config. Lowercase letters, digits, hyphens. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Provider/model ref, used by BOTH the session and runner paths. */
  model: z.string().min(1),
  /** Resolved at setup: the harness session when present. */
  preferSession: z.boolean().default(true),
  /** Transport only. */
  runner: RunnerConfigSchema,
  /** Bound on one `ask`; a timeout is a degrade, not a crash. */
  timeoutMs: z.number().int().min(100).default(10000),
  /** Excludes the provider without deleting its entry. */
  disabled: z.boolean().optional(),
});

/** One hosted embedding provider, referenced by id from a
 * corpus's `embed`. Local models (ollama, llama.cpp, vLLM, LM Studio) use the
 * same type — they all serve the OpenAI `/embeddings` protocol. */
export const EmbeddingProviderConfigSchema = z.strictObject({
  /** Unique within the merged config. Lowercase letters, digits, hyphens. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** The only transport in v1; unknown types fail at load. */
  type: z.literal("openai-compatible"),
  baseUrl: z.string().min(1),
  /** `${VAR}` refs allowed: navi never stores keys, here or in `models`. */
  apiKey: z.string().optional(),
  model: z.string().min(1),
  /** Bound on one `embed` call; a timeout is an error, not a hang. */
  timeoutMs: z.number().int().min(100).default(10000),
  /** Excludes the provider without deleting its entry. */
  disabled: z.boolean().optional(),
});

/** The applicability filter. Absent = off, which is today's
 * behavior. No separate gate: configured means every search runs it. */
export const FilterConfigSchema = z.strictObject({
  /** Id of a `models` entry; checked on the effective config, unknown ids
   * fail loud. */
  provider: z.string().min(1),
  /** Fused hits considered per search; the overflow is not pruned. */
  topK: z.number().int().min(1).max(20).default(8),
});

/** Top-level shape of one config file. */
export const NaviConfigSchema = z.strictObject({
  /** Optional schema reference for editor tooling. */
  $schema: z.string().optional(),
  /** The only required section. Further namespaces (engine, …) are added
   * top-level when they exist — nothing speculative now. */
  corpuses: z.array(CorpusConfigSchema),
  /** Optional, so existing configs are unaffected. */
  analyzer: AnalyzerConfigSchema.optional(),
  /** Named model providers, referenced by id. Optional and
   * lazily resolved — a configured-but-unused provider costs nothing. */
  models: z.array(ModelProviderConfigSchema).optional(),
  /** Named embedding providers, referenced by corpus `embed`.
   * Same merge/lazy rules as `models`. */
  embeddings: z.array(EmbeddingProviderConfigSchema).optional(),
  /** The applicability filter; omitted = off. */
  filter: FilterConfigSchema.optional(),
  /** Harness-only surfacing policy; defaults apply when omitted. */
  surfacing: SurfacingConfigSchema.optional(),
});

/** The editor-facing JSON Schema: zod's input schema plus
 * the one cross-field rule `superRefine` enforces but an object shape cannot
 * express — `module` exactly when `type` is `custom`. The emit
 * script and its guard test share this, so the committed file cannot drift. */
export function naviConfigJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(NaviConfigSchema, { io: "input" }) as unknown as {
    properties: { corpuses: { items: Record<string, unknown> } };
  } & Record<string, unknown>;

  schema.properties.corpuses.items = {
    ...schema.properties.corpuses.items,
    allOf: [
      {
        if: { properties: { type: { const: "custom" } } },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword
        then: { required: ["module"] },
        else: { not: { required: ["module"] } },
      },
    ],
  };
  return schema;
}

export type NaviConfig = z.infer<typeof NaviConfigSchema>;
export type CorpusConfig = z.infer<typeof CorpusConfigSchema>;
export type DetectorConfig = z.infer<typeof DetectorConfigSchema>;
export type AnalyzerConfig = z.infer<typeof AnalyzerConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
export type ModelProviderConfig = z.infer<typeof ModelProviderConfigSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderConfigSchema>;
export type FilterConfig = z.infer<typeof FilterConfigSchema>;
export type HitSurfacing = z.infer<typeof HitSurfacingSchema>;
export type SurfacingRule = z.infer<typeof SurfacingRuleSchema>;
export type SurfacingConfig = z.infer<typeof SurfacingConfigSchema>;

/** A corpus as resolved at load, anchored to the directory of the
 * config file that declared it. Required, so no corpus can silently fall back
 * to the process cwd. */
export type ResolvedCorpusConfig = CorpusConfig & { readonly baseDir: string };

/** The merged config after `loadConfig`/`mergeConfigs`: every corpus carries
 * its resolved anchor, so engines and drivers never guess one. */
export type ResolvedNaviConfig = Omit<NaviConfig, "corpuses"> & {
  readonly corpuses: ResolvedCorpusConfig[];
};
