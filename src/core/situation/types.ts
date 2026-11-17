/** The Situation Struct.
 *
 * The zod schemas are the single source of truth; the exported types are
 * `z.infer` derivations so they cannot drift. */

import { z } from "zod";

import type { NaviConfig } from "../config/schema.ts";
import type { ModelGateway } from "../models/gateway.ts";

/** The kind of one turn in the analyzed content. */
export const SituationKindSchema = z.enum([
  "user_prompt", // a turn from the user
  "tool_call", // a tool invocation the agent is about to make
  "subagent_task", // a task prompt being handed to a subagent
]);
export type SituationKind = z.infer<typeof SituationKindSchema>;

/** Raw input to the analyzer, as captured by a harness adapter or CLI. */
export const RawInputSchema = z.object({
  text: z.string(),
  /** Kind of this single triggering event. When several turns are passed,
   * each RawInput carries its own kind; the analyzer folds them into
   * `Situation.kinds`. */
  kind: SituationKindSchema,
  /** Filesystem signals, e.g. from a tool call. */
  paths: z.array(z.string()).optional(),
  /** Tool-type signal, e.g. "bash". */
  tool: z.string().optional(),
});
export type RawInput = z.infer<typeof RawInputSchema>;

/**
 * Everything the analyzer claims about the text.
 *
 * Only `text` is required. Every other field is a *hint*:
 * search must behave correctly when all of them are empty, and must treat
 * hints as weighted evidence, never as filters that can silently drop
 * concerns.
 *
 * `strictObject` rejects typo'd and unknown keys: a fixture is data from
 * outside the process and is validated at the trust boundary before it
 * reaches the engine.
 */
export const SituationSchema = z.strictObject({
  /** Raw text as received. Always present; the free-text fallback. */
  text: z.string(),
  /** Turn kinds present in the analyzed content. A multi-turn window
   * contributes several; empty means the content has no classified turns. */
  kinds: z.array(SituationKindSchema).default([]),

  /** Detected scopes, e.g. ["git", "deploy"]. May be empty. */
  arenas: z.array(z.string()).default([]),

  /** Literal tripwires matched by the lexicon detector, e.g. "force-push". */
  patterns: z.array(z.string()).default([]),

  /** Filesystem signals copied/derived from RawInput.paths. */
  paths: z.array(z.string()).default([]),

  /** Tool-type signals, e.g. ["bash"]. */
  tools: z.array(z.string()).default([]),

  /** Model-detector output. Null when no model detector is registered. */
  intent: z.string().nullable().default(null),

  /** 0..1. The analyzer's overall confidence in its own claims. */
  confidence: z.number().min(0).max(1).default(0),

  /** Which detector *instances* contributed which fields, as
   * config instance ids — so two instances of one type stay distinguishable. */
  detectors: z.array(z.string()).default([]),
});
export type Situation = z.infer<typeof SituationSchema>;

/** One detector instance's raw claim, before the fold. `detector`
 * is the config instance id, so two instances of one type stay distinct. */
export interface DetectorContribution {
  detector: string;
  /** The registry vocabulary is open: any registered detector type. */
  type: string;
  /** What this instance claimed for one turn, or null when it had nothing. */
  contribution: Partial<Situation> | null;
}

/** `analyzeDetailed`'s result: the folded Situation plus the raw claims that
 * produced it, in fold order (the `navi trace` contract). */
export interface DetailedAnalysis {
  situation: Situation;
  contributions: DetectorContribution[];
}

/** The analyzer interface. Adapters call this; nothing else does. */
export interface SituationAnalyzer {
  /** Runs all registered detectors in registration order, folding their
   * contributions into one Situation. Accepts a single event or several
   * turns; multi-turn input folds into one Situation. */
  analyze(input: RawInput | RawInput[]): Promise<Situation>;
  /** The same run, keeping each instance's pre-fold claim. Multi-turn input
   * reports one contribution per detector per turn, in execution order. */
  analyzeDetailed(input: RawInput | RawInput[]): Promise<DetailedAnalysis>;
}

/**
 * One situation driver. Detectors are the situation-side counterparts of
 * corpus drivers: each contributes what it can see, and
 * nothing more. Built-ins register at bootstrap; later detectors (model,
 * third-party) join the same pipeline.
 */
export interface SituationDetector {
  /** Detector type identity (registry vocabulary: the declared `type`, not the
   * instance id). The analyzer writes the configured *instance* id to
   * provenance; a detector never does. */
  readonly type: string;
  /**
   * Inspect the input (and what earlier detectors have already claimed) and
   * return a contribution, or `null` when this detector has nothing to add
   * for this input.
   */
  detect(input: RawInput, current: Situation): Promise<Partial<Situation> | null>;
}

/**
 * The standard setup context every detector instance is constructed with. No
 * detector special-cases anything: it reads the merged config it needs and
 * resolves its model gateway here.
 */
export interface DetectorContext {
  /** The merged config — anything a detector wants to read for itself. */
  readonly config: NaviConfig;
  /** Resolve a named model provider to its gateway; throws `ConfigError` on
   * unknown or disabled ids. Only referenced providers are ever built. */
  gateway(id: string): ModelGateway;
}
