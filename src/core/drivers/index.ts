/** Bootstrap: register every built-in corpus type and situation detector. */

import type { NaviConfig } from "../config/schema.ts";
import { Registry } from "../corpus/registry.ts";
import { createAnalyzer, type AnalyzerOptions } from "../situation/analyzer.ts";
import { DetectorRegistry } from "../situation/registry.ts";
import type { SituationAnalyzer } from "../situation/types.ts";
import { FilesCorpus } from "./corpus/files/corpus.ts";
import { WebCorpus } from "./corpus/web/corpus.ts";
import { CommandDetector } from "./situation/command.ts";
import { LexiconDetector } from "./situation/lexicon.ts";
import { ModelDetector } from "./situation/model.ts";
import { PathDetector } from "./situation/path.ts";
import { ToolDetector } from "./situation/tool.ts";

/** The one canonical bootstrap: every built-in corpus and detector is wired
 * here. Callers hand the result to the engine. */
export function createBuiltinRegistry(): Registry {
  const registry = new Registry();
  registerBuiltinCorpuses(registry);
  return registry;
}

export function registerBuiltinCorpuses(registry: Registry): void {
  registry.register("files", FilesCorpus);
  registry.register("web", WebCorpus);
}

export function createBuiltinDetectorRegistry(): DetectorRegistry {
  const registry = new DetectorRegistry();
  registerBuiltinDetectors(registry);
  return registry;
}

/** Registration order is the default fold order when the config omits the
 * analyzer section. */
export function registerBuiltinDetectors(registry: DetectorRegistry): void {
  registry.register("lexicon", LexiconDetector);
  registry.register("command", CommandDetector);
  registry.register("path", PathDetector);
  registry.register("tool", ToolDetector);
  // Last, so `low-confidence` reads the fold after every
  // deterministic detector. `when` defaults to "never".
  registry.register("model", ModelDetector);
}

/** The default analyzer: built-ins in canonical detector order unless the
 * config picks instances. The merged config also seeds the detector context
 * (gateway resolution); an absent config analyzes with no corpuses. */
export function createBuiltinAnalyzer(
  config: NaviConfig = { corpuses: [] },
  options: AnalyzerOptions = {},
): SituationAnalyzer {
  return createAnalyzer(config, createBuiltinDetectorRegistry(), options);
}
