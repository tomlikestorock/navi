/** Navi's internal barrel — the CLI's wiring, not a public surface.
 *
 * `navi/core` ships `contract.ts` instead; this file stays
 * repo-internal and is never packed. */

export type {
  AnalyzerConfig,
  NaviConfig,
  CorpusConfig,
  ResolvedCorpusConfig,
  ResolvedNaviConfig,
  DetectorConfig,
  EmbeddingProviderConfig,
  FilterConfig,
  HitSurfacing,
  ModelProviderConfig,
  RunnerConfig,
  SurfacingConfig,
  SurfacingRule,
} from "./config/schema.ts";
export {
  CORPUS_TYPES,
  CorpusConfigSchema,
  HitSurfacingSchema,
  RunnerConfigSchema,
  ModelProviderConfigSchema,
  EmbeddingProviderConfigSchema,
  SurfacingConfigSchema,
} from "./config/schema.ts";
export type { Answer, GatewayFactory, ModelGateway, PredicateQuestion } from "./models/gateway.ts";
export { AnswerSchema, GatewayError } from "./models/gateway.ts";
export { createOpencodeGateway, createRunnerGateway } from "./models/opencode.ts";
export { createSystemoneGateway } from "./models/systemone.ts";
export { TestFakeGateway } from "./models/fake.ts";
export type { EmbeddingProvider, EmbeddingFactory } from "./embeddings/embed.ts";
export { EmbeddingError, createEmbeddingProvider } from "./embeddings/embed.ts";
export { FakeEmbeddingProvider } from "./embeddings/fake.ts";
export type {
  Corpus,
  CorpusCoverage,
  CorpusSearchOptions,
  CorpusSearchResult,
  CorpusHit,
  CorpusRead,
} from "./corpus/types.ts";
export type {
  CorpusClass,
  CorpusContext,
  CorpusContextOptions,
  CorpusLoadOptions,
  EmbeddingResolver,
  ResolvedEmbedding,
} from "./corpus/registry.ts";
export { createCorpusContext } from "./corpus/registry.ts";
export type {
  Situation,
  SituationKind,
  RawInput,
  SituationDetector,
  SituationAnalyzer,
  DetectorContribution,
  DetailedAnalysis,
  DetectorContext,
} from "./situation/types.ts";
export { SituationSchema, SituationKindSchema, RawInputSchema } from "./situation/types.ts";
export type { DetectorClass } from "./situation/registry.ts";
export type { OptionsRecord, RegistryEntry, TypeClass } from "./registry.ts";
export { parseOptions, TypeRegistry } from "./registry.ts";
export type {
  SearchOptions,
  SearchEngine,
  FederatedSearch,
  CorpusRanking,
  FusedHit,
  FusionContribution,
  FilterStage,
  FilterDecision,
} from "./engine/types.ts";
export type { HitFormat } from "./engine/format.ts";
export { formatHits, hitKey } from "./engine/format.ts";

export { loadConfig, readConfigFile, discoverConfigPaths } from "./config/load.ts";
export type { ConfigPaths, LoadedConfig, LoadConfigOptions } from "./config/load.ts";
export { parseJsonc, readJsonc } from "./config/jsonc.ts";
export type { JsoncDocument, SourceLocation } from "./config/jsonc.ts";
export type { Locator } from "./config/validate.ts";
export { mergeConfigs } from "./config/merge.ts";
export type { ConfigSource, MergedConfig } from "./config/merge.ts";
export { formatIssues } from "./zod-issues.ts";
export { validateConfig } from "./config/validate.ts";
export { ConfigError } from "./config/error.ts";
export { Registry } from "./corpus/registry.ts";
export { DetectorRegistry } from "./situation/registry.ts";
export { emptySituation, createAnalyzer } from "./situation/analyzer.ts";
export type { AnalyzerOptions } from "./situation/analyzer.ts";
export {
  createBuiltinAnalyzer,
  createBuiltinDetectorRegistry,
  createBuiltinRegistry,
  registerBuiltinCorpuses,
  registerBuiltinDetectors,
} from "./drivers/index.ts";
export { createSearchEngine, RRF_K } from "./engine/search.ts";

// Custom corpus modules import zod here — one dependency story, no installs.
export { z } from "zod";
