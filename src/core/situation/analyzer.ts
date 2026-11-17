/** The folding analyzer. Detector instances come from config.
 *
 * Detectors see the input and everything earlier detectors have already
 * claimed; the analyzer keeps the fold rules in one place so no detector can
 * remove, blank, or lower another's claim. Contributions are additive:
 * arrays append with dedupe, confidence is the max over contributors, and a
 * detector that disagrees contributes nothing (returns `null`).
 */

import type { NaviConfig } from "../config/schema.ts";
import { resolveModelProvider } from "../config/providers.ts";
import type { GatewayFactory, ModelGateway } from "../models/gateway.ts";
import { createRunnerGateway } from "../models/opencode.ts";
import type { DetectorRegistry } from "./registry.ts";
import type {
  DetailedAnalysis,
  DetectorContext,
  DetectorContribution,
  RawInput,
  Situation,
  SituationAnalyzer,
  SituationDetector,
} from "./types.ts";

/** One configured detector instance: the provenance id plus its detector. */
interface DetectorInstance {
  id: string;
  detector: SituationDetector;
}

/** The setup seam: tests inject a fake, the OpenCode plugin
 * injects its session gateway, and standalone runs default to a runner. */
export interface AnalyzerOptions {
  createGateway?: GatewayFactory;
}

/** An honest empty Situation: text only, no claims. */
export function emptySituation(text: string): Situation {
  return {
    text,
    kinds: [],
    arenas: [],
    patterns: [],
    paths: [],
    tools: [],
    intent: null,
    confidence: 0,
    detectors: [],
  };
}

/** Build an analyzer from the merged config. The
 * `analyzer.detectors` order is the fold order; disabled instances are
 * skipped, and an omitted section builds one default instance per registered
 * type. Every instance is constructed with the same detector context. */
export function createAnalyzer(
  config: NaviConfig,
  registry: DetectorRegistry,
  options: AnalyzerOptions = {},
): SituationAnalyzer {
  const ctx = detectorContext(config, options.createGateway ?? createRunnerGateway);
  const instances = instancesOf(config, registry, ctx);

  return {
    async analyze(input: RawInput | RawInput[]): Promise<Situation> {
      return (await run(instances, input)).situation;
    },
    analyzeDetailed(input: RawInput | RawInput[]): Promise<DetailedAnalysis> {
      return run(instances, input);
    },
  };
}

/** `gateway(id)` resolves lazily and caches. An unreferenced
 * provider is never built; an unknown or disabled id is a config error at the
 * moment a detector asks for it, through the same lookup validation uses. */
function detectorContext(config: NaviConfig, createGateway: GatewayFactory): DetectorContext {
  const gateways = new Map<string, ModelGateway>();

  return {
    config,
    gateway(id) {
      const cached = gateways.get(id);
      if (cached !== undefined) return cached;

      const gateway = createGateway(resolveModelProvider(config, id, "detector"));
      gateways.set(id, gateway);
      return gateway;
    },
  };
}

/** One analyze pass: run every instance over every turn, keeping the raw
 * contributions so callers can see the pipeline before the fold. */
async function run(
  instances: DetectorInstance[],
  input: RawInput | RawInput[],
): Promise<DetailedAnalysis> {
  const turns = Array.isArray(input) ? input : [input];
  const situation = emptySituation(turns.map((turn) => turn.text).join("\n\n"));
  const contributions: DetectorContribution[] = [];

  for (const turn of turns) {
    appendUnique(situation.kinds, [turn.kind]);
    for (const { id, detector } of instances) {
      const contribution = await detector.detect(turn, situation);
      contributions.push({ detector: id, type: detector.type, contribution });
      if (contribution === null) continue;
      fold(situation, id, detector.type, contribution);
    }
  }

  return { situation, contributions };
}

/** Config entries in fold order, or the defaults when the section (or its
 * list) is omitted — id defaults to type there. */
function instancesOf(
  config: NaviConfig,
  registry: DetectorRegistry,
  ctx: DetectorContext,
): DetectorInstance[] {
  const entries = config.analyzer?.detectors;
  if (entries === undefined) {
    return registry
      .types()
      .map((type) => ({ id: type, detector: registry.load({ id: type, type }, ctx) }));
  }

  return entries
    .filter((entry) => entry.disabled !== true)
    .map((entry) => ({ id: entry.id, detector: registry.load(entry, ctx) }));
}

/** Intent is the model detector's claim alone. A
 * non-model contribution is a detector bug: refuse it and say so, rather
 * than corrupting the Situation. */
function fold(
  situation: Situation,
  id: string,
  type: string,
  contribution: Partial<Situation>,
): void {
  appendUnique(situation.kinds, contribution.kinds);
  appendUnique(situation.arenas, contribution.arenas);
  appendUnique(situation.patterns, contribution.patterns);
  appendUnique(situation.paths, contribution.paths);
  appendUnique(situation.tools, contribution.tools);

  // Intent is model-only and not removable: the first non-null claim wins.
  if (contribution.intent != null) {
    if (type === "model") {
      if (situation.intent === null) situation.intent = contribution.intent;
    } else {
      console.error(`detector "${id}" (type "${type}"): intent is model-only; ignoring it`);
    }
  }
  if (contribution.confidence !== undefined) {
    situation.confidence = Math.max(situation.confidence, contribution.confidence);
  }

  // Provenance is the analyzer's to write, not the detector's.
  appendUnique(situation.detectors, [id]);
}

function appendUnique<T>(target: T[], values: readonly T[] | undefined): void {
  if (values === undefined) return;
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}
