/** `navi analyze "text"` — run the situation
 * analyzer and print the Situation as JSON. This is the CLI fixture surface
 * for the online path. */

import { createBuiltinAnalyzer } from "#core/index.ts";
import type { NaviConfig, RawInput, Situation, SituationKind } from "#core/index.ts";

import { resolveConfig } from "./config.ts";

export interface AnalyzeCommandOptions {
  /** Read this config file alone instead of global + project discovery. */
  configFile?: string;
  /** Turn kind; `user_prompt` when the caller does not say. */
  kind?: SituationKind;
  paths?: string[];
  tool?: string;
}

/** Fold CLI flags into the RawInput the analyzer consumes. */
export function toRawInput(text: string, options: AnalyzeCommandOptions = {}): RawInput {
  const input: RawInput = { text, kind: options.kind ?? "user_prompt" };
  if (options.paths !== undefined) input.paths = options.paths;
  if (options.tool !== undefined) input.tool = options.tool;
  return input;
}

/** The shared analyze step of the analyze → search → format pipeline.
 * The merged config's `analyzer` section picks the detector instances;
 * the caller passes it so discovery runs once. */
export async function analyzeToSituation(
  text: string,
  config: NaviConfig,
  options: AnalyzeCommandOptions = {},
): Promise<Situation> {
  return createBuiltinAnalyzer(config).analyze(toRawInput(text, options));
}

export async function analyze(text: string, options: AnalyzeCommandOptions = {}): Promise<string> {
  if (text.trim() === "") throw new Error('missing text: navi analyze "text"');
  const { config } = resolveConfig(options.configFile);
  return `${JSON.stringify(await analyzeToSituation(text, config, options), null, 2)}\n`;
}
