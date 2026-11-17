/** navi-r1y6: `navi eval` — the measurement loop every model decision is
 * judged against. Runs each labeled query through the real pipeline
 * (analyze → federate → optional filter) and reports recall@k, MRR and the
 * queries that missed.
 *
 * The fixture is self-contained: a `navi.json` with a files corpus over its
 * sibling `docs/`, plus `labels.jsonl` beside it. No network, no new deps. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  ConfigError,
  createBuiltinAnalyzer,
  createBuiltinRegistry,
  createSearchEngine,
  formatIssues,
} from "#core/index.ts";
import type { CorpusCoverage, FilterDecision, ResolvedNaviConfig } from "#core/index.ts";

import { resolveConfig } from "./config.ts";
import { coverageNote } from "./coverage.ts";

export const DEFAULT_K = 5;
const LABELS_FILE = "labels.jsonl";
const FIXTURE = join("evals", "fixtures", "navi.json");

/** The demo fixture ships beside the package's `package.json`, so `navi eval`
 * works from any cwd once installed — the fixture's own paths are anchored to
 * it. A source checkout resolves to the repo root, a packed
 * install to the package root. */
export function defaultFixture(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const fixture = join(dir, FIXTURE);
  if (!existsSync(fixture)) {
    throw new ConfigError(fixture, "default eval fixture not found; pass --fixture <navi.json>");
  }
  return fixture;
}

export type FilterMode = "on" | "off" | "auto";
export const FILTER_MODES: readonly FilterMode[] = ["on", "off", "auto"];

export interface EvalCommandOptions {
  /** Pipeline config override; the fixture navi.json when omitted. */
  configFile?: string;
  /** Fixture navi.json; `labels.jsonl` sits beside it. */
  fixture?: string;
  /** Depth for recall@k and MRR. */
  k?: number;
  /** Filter the pipeline for this run: `auto` follows the config. */
  filter?: FilterMode;
  /** Machine-readable report. */
  json?: boolean;
}

const LabelSchema = z.strictObject({
  query: z.string().min(1),
  relevant: z.array(z.string().min(1)).min(1),
});
export type Label = z.infer<typeof LabelSchema>;

/** One JSONL line per query. Blank lines are tolerated; a bad line fails loud
 * with its line number (labels are ground truth, so silent skips would lie). */
export function loadLabels(file: string): Label[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(file, "file not found");
  }

  const labels: Label[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigError(file, `line ${index + 1}: ${detail}`);
    }
    const result = LabelSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigError(file, `line ${index + 1}: ${formatIssues(result.error, "labels")}`);
    }
    labels.push(result.data);
  });

  if (labels.length === 0) throw new ConfigError(file, "no labels");
  return labels;
}

/** Fraction of a query's relevant docs found in the top k. */
export function recallAt(expected: string[], retrieved: string[], k: number): number {
  if (expected.length === 0) return 1;
  const top = new Set(retrieved.slice(0, k));
  return expected.filter((id) => top.has(id)).length / expected.length;
}

/** 1 / rank of the first relevant hit, or 0 when none is in the top k. */
export function reciprocalRank(expected: string[], retrieved: string[], k: number): number {
  const relevant = new Set(expected);
  const at = retrieved.slice(0, k).findIndex((id) => relevant.has(id));
  return at === -1 ? 0 : 1 / (at + 1);
}

export interface QueryResult {
  query: string;
  expected: string[];
  retrieved: string[];
  recall: number;
  reciprocalRank: number;
  /** Per-corpus coverage, so a miss can say whether recall was
   * reduced by a cap or cold vectors. */
  coverage: Record<string, CorpusCoverage>;
}

/** How well the filter pruned. A false negative (dropped-relevant)
 * is the expensive mistake, so it is counted separately. */
export interface FilterReport {
  decisions: number;
  keptRelevant: number;
  droppedIrrelevant: number;
  droppedRelevant: number;
  accuracy: number;
}

export function scoreFilter(decisions: FilterDecision[], relevant: Set<string>): FilterReport {
  let keptRelevant = 0;
  let droppedIrrelevant = 0;
  let droppedRelevant = 0;

  for (const decision of decisions) {
    const isRelevant = relevant.has(`${decision.corpus}:${decision.id}`);
    if (isRelevant && decision.kept) keptRelevant += 1;
    if (!isRelevant && !decision.kept) droppedIrrelevant += 1;
    if (isRelevant && !decision.kept) droppedRelevant += 1;
  }

  return {
    decisions: decisions.length,
    keptRelevant,
    droppedIrrelevant,
    droppedRelevant,
    accuracy: filterAccuracy(decisions.length, keptRelevant, droppedIrrelevant),
  };
}

/** The one accuracy formula, for one query and for the run total. */
function filterAccuracy(
  decisions: number,
  keptRelevant: number,
  droppedIrrelevant: number,
): number {
  return decisions === 0 ? 1 : (keptRelevant + droppedIrrelevant) / decisions;
}

export interface EvalReport {
  k: number;
  queries: number;
  recallAtK: number;
  mrr: number;
  filter: FilterReport | null;
  misses: QueryResult[];
}

/** `off` strips the configured filter so the same fixture measures both
 * worlds; `on` demands one; `auto` runs whatever the config says. */
function applyFilterMode(config: ResolvedNaviConfig, mode: FilterMode): ResolvedNaviConfig {
  if (mode === "off") {
    const { filter: _filter, ...rest } = config;
    return rest;
  }
  if (mode === "on" && config.filter === undefined) {
    throw new Error("--filter on: the config has no filter section");
  }
  return config;
}

export async function evaluate(options: EvalCommandOptions = {}): Promise<string> {
  const fixture = options.fixture ?? defaultFixture();
  const labels = loadLabels(join(dirname(fixture), LABELS_FILE));
  const k = options.k ?? DEFAULT_K;
  const mode = options.filter ?? "auto";

  const { config } = resolveConfig(options.configFile ?? fixture);
  const runConfig = applyFilterMode(config, mode);
  const engine = await createSearchEngine(runConfig, createBuiltinRegistry());
  const analyzer = createBuiltinAnalyzer(runConfig);

  const results: QueryResult[] = [];
  let filterTotals = {
    decisions: 0,
    keptRelevant: 0,
    droppedIrrelevant: 0,
    droppedRelevant: 0,
  };
  let filterOn = false;

  for (const label of labels) {
    const situation = await analyzer.analyze({ text: label.query, kind: "user_prompt" });
    const result = await engine.searchDetailed(situation, { limit: k });
    const retrieved = result.hits.map((hit) => `${hit.corpus}:${hit.id}`);
    results.push({
      query: label.query,
      expected: label.relevant,
      retrieved,
      recall: recallAt(label.relevant, retrieved, k),
      reciprocalRank: reciprocalRank(label.relevant, retrieved, k),
      coverage: Object.fromEntries(
        result.rankings.flatMap((ranking) =>
          ranking.coverage === undefined ? [] : [[ranking.corpus, ranking.coverage]],
        ),
      ),
    });

    if (result.filter.enabled) {
      filterOn = true;
      const score = scoreFilter(result.filter.decisions, new Set(label.relevant));
      filterTotals = {
        decisions: filterTotals.decisions + score.decisions,
        keptRelevant: filterTotals.keptRelevant + score.keptRelevant,
        droppedIrrelevant: filterTotals.droppedIrrelevant + score.droppedIrrelevant,
        droppedRelevant: filterTotals.droppedRelevant + score.droppedRelevant,
      };
    }
  }

  const report: EvalReport = {
    k,
    queries: results.length,
    recallAtK: average(results.map((result) => result.recall)),
    mrr: average(results.map((result) => result.reciprocalRank)),
    filter: filterOn
      ? {
          ...filterTotals,
          accuracy: filterAccuracy(
            filterTotals.decisions,
            filterTotals.keptRelevant,
            filterTotals.droppedIrrelevant,
          ),
        }
      : null,
    misses: results.filter((result) => result.recall < 1),
  };

  return options.json === true ? formatJson(report) : formatHuman(report);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatHuman(report: EvalReport): string {
  const lines = [
    `navi eval: ${report.queries} queries, k=${report.k}`,
    `recall@${report.k}: ${report.recallAtK.toFixed(3)}`,
    `MRR:       ${report.mrr.toFixed(3)}`,
  ];

  if (report.filter === null) {
    lines.push("filter:    off");
  } else {
    const filter = report.filter;
    lines.push(
      `filter:    on — ${filter.decisions} decisions, kept-relevant ${filter.keptRelevant}, ` +
        `dropped-irrelevant ${filter.droppedIrrelevant}, accuracy ${filter.accuracy.toFixed(3)}`,
    );
    if (filter.droppedRelevant > 0) {
      lines.push(`           dropped-relevant ${filter.droppedRelevant} (false negatives)`);
    }
  }

  lines.push("", `misses (${report.misses.length}):`);
  if (report.misses.length === 0) {
    lines.push("  (none)");
  } else {
    for (const miss of report.misses) {
      const got = miss.retrieved.length > 0 ? miss.retrieved.join(", ") : "(no hits)";
      lines.push(`  "${miss.query}" expected ${miss.expected.join(", ")} → got ${got}`);
      // A miss names its coverage, so a truncated or cold sweep
      // is not read as "the document does not exist".
      for (const [corpus, coverage] of Object.entries(miss.coverage)) {
        lines.push(`    ${corpus}${coverageNote(coverage)}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatJson(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
