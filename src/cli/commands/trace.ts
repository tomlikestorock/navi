/** `navi trace "text"` — the pipeline with its seams
 * exposed. Three sections: per-detector-instance contributions before the
 * fold, per-corpus hits before fusion, and the fused ranking
 * with the RRF math that placed each hit. A debugging view, not a second
 * pipeline: it runs the same analyzer and engine the other commands use. */

import {
  RRF_K,
  createBuiltinAnalyzer,
  createBuiltinRegistry,
  createSearchEngine,
} from "#core/index.ts";
import type {
  CorpusRanking,
  DetailedAnalysis,
  DetectorContribution,
  FederatedSearch,
  FilterDecision,
  FilterStage,
  FusedHit,
  GatewayFactory,
  Situation,
} from "#core/index.ts";

import { toRawInput, type AnalyzeCommandOptions } from "./analyze.ts";
import { resolveConfig } from "./config.ts";
import { coverageNote } from "./coverage.ts";

export interface TraceCommandOptions extends AnalyzeCommandOptions {
  limit?: number;
  /** Machine shape: situation, contributions, pre-fusion corpuses, fused. */
  json?: boolean;
  /** Tests inject the gateway behind every provider. */
  createGateway?: GatewayFactory;
}

export async function trace(text: string, options: TraceCommandOptions = {}): Promise<string> {
  if (text.trim() === "") throw new Error('missing text: navi trace "text"');

  const { config } = resolveConfig(options.configFile);
  const analysis = await createBuiltinAnalyzer(config, {
    createGateway: options.createGateway,
  }).analyzeDetailed(toRawInput(text, options));
  const engine = await createSearchEngine(config, createBuiltinRegistry(), {
    createGateway: options.createGateway,
  });
  const result = await engine.searchDetailed(analysis.situation, { limit: options.limit });

  return options.json === true ? formatJson(analysis, result) : formatHuman(analysis, result);
}

function formatHuman(analysis: DetailedAnalysis, result: FederatedSearch): string {
  const lines = ["contributions (before the fold)"];

  for (const contribution of analysis.contributions) {
    lines.push(...contributionLines(contribution));
  }

  lines.push("", "corpuses (before fusion)");
  for (const ranking of result.rankings) {
    lines.push(...rankingLines(ranking));
  }

  lines.push("", `fused (RRF k=${RRF_K})`);
  if (result.fused.length === 0) {
    lines.push("  (no matches)");
  } else {
    result.fused.forEach((entry, index) => lines.push(fusedLine(entry, index)));
  }

  lines.push("", ...filterLines(result.filter));

  return `${lines.join("\n")}\n`;
}

/** Per candidate kept/dropped with its answer and
 * confidence, or a single line when no filter is configured. */
function filterLines(filter: FilterStage): string[] {
  if (!filter.enabled) return ["filter disabled"];

  const lines = [`filter (topK ${filter.topK})`];
  if (filter.error !== undefined) {
    lines.push(`  degraded: ${filter.error} — passed everything through`);
  }
  for (const decision of filter.decisions) {
    lines.push(`  ${decision.corpus}:${decision.id}  ${verdict(decision)}`);
  }
  return lines;
}

function verdict({ kept, answer, confidence }: FilterDecision): string {
  const label = kept ? "kept" : "dropped";
  if (answer === null) return `${label} (no answer)`;
  return `${label} (${answer ? "yes" : "no"}, ${confidence?.toFixed(2) ?? "—"})`;
}

/** One instance's claim: the fields it added, or that it stayed silent. */
function contributionLines({ detector, type, contribution }: DetectorContribution): string[] {
  const label = `  ${detector} (${type})`;
  if (contribution === null) return [`${label}: no contribution`];

  const claims = claimsOf(contribution);
  return [`${label}:`, ...claims.map((claim) => `    ${claim}`)];
}

function claimsOf(contribution: Partial<Situation>): string[] {
  const claims: string[] = [];
  for (const field of ["kinds", "arenas", "patterns", "paths", "tools"] as const) {
    const values = contribution[field];
    if (values !== undefined && values.length > 0) {
      claims.push(`${field}: ${values.join(", ")}`);
    }
  }
  if (contribution.intent != null) claims.push(`intent: ${contribution.intent}`);
  if (contribution.confidence !== undefined) {
    claims.push(`confidence: ${contribution.confidence}`);
  }
  return claims.length > 0 ? claims : ["(empty contribution)"];
}

function rankingLines(ranking: CorpusRanking): string[] {
  if (ranking.error !== undefined) {
    return [`  ${ranking.corpus}: failed (${ranking.error})`];
  }
  // Coverage rides every corpus line, so "no hits" is never
  // mistaken for "nothing there".
  const label = `  ${ranking.corpus}${coverageNote(ranking.coverage)}`;
  if (ranking.hits.length === 0) return [`${label}: no hits`];

  const lines = [label];
  for (const hit of ranking.hits) {
    lines.push(`    ${hit.id}  score ${hit.score.toFixed(3)}  matched_by: ${list(hit.matched_by)}`);
  }
  return lines;
}

/** One fused hit: its normalized score, the RRF sum, and each corpus's term. */
function fusedLine({ hit, rrf, score, contributions }: FusedHit, index: number): string {
  const terms = contributions
    .map(({ corpus, rank }) => `${corpus} #${rank} 1/${RRF_K + rank}`)
    .join(" + ");
  return `  ${index + 1}. ${hit.corpus}:${hit.id}  rrf ${rrf.toFixed(6)} (${terms})  score ${score.toFixed(3)}`;
}

function formatJson(analysis: DetailedAnalysis, result: FederatedSearch): string {
  const shape = {
    situation: analysis.situation,
    contributions: analysis.contributions,
    corpuses: result.rankings,
    fused: result.fused.map(({ hit, rrf, score, contributions }) => ({
      corpus: hit.corpus,
      id: hit.id,
      rrf,
      score,
      contributions,
    })),
    filter: result.filter,
  };
  return `${JSON.stringify(shape, null, 2)}\n`;
}

function list(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "—";
}
