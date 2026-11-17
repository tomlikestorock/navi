/** The surfacing policy pass — the one place repetition, caps,
 * budgets and model rules are enforced. Pure: it takes the candidates, the
 * session's seen-log and the session's model, and returns what to inject plus
 * the log to persist. The harness adapter owns storage and injection.
 *
 * Order: same-turn dedupe → caps → budget → byModel. byModel is resolved
 * first because it *supplies* the caps and budget it restricts; the effective
 * rule is the most restrictive match, and `force` is the one override that
 * beats everything except the dedupe. */

import type { CorpusHit, HitSurfacing, SurfacingConfig, SurfacingRule } from "#core/index.ts";
import { formatHits, hitKey } from "#core/index.ts";

/** One `corpus:id`'s history in this session. `turnShows` is
 * how many times it surfaced in `turn`; `shows` is the session total. */
export interface SeenEntry {
  key: string;
  turn: number;
  shows: number;
  turnShows: number;
  last: number;
}

/** The plugin's per-session log: the last turn number and one entry per hit. */
export interface SeenState {
  turn: number;
  entries: SeenEntry[];
}

export const EMPTY_SEEN: SeenState = { turn: 0, entries: [] };

export interface PolicyOptions {
  /** The `surfacing` config section; absent uses the always-on defaults. */
  config?: SurfacingConfig;
  /** The session's model ref (`provider/id`); undefined when unknown. */
  model?: string;
  /** Corpus-entry defaults for hits that declare no `surfacing` of their own. */
  corpusSurfacing?: ReadonlyMap<string, HitSurfacing>;
  /** The log as it was before this pass. */
  seen: SeenState;
  /** The caller's turn boundary (one admitted prompt). Callers pass
   * `seen.turn + 1`; passes sharing a turn reuse the value. */
  turn: number;
}

export interface PolicyResult {
  /** The hits to inject, in ranking order. */
  hits: CorpusHit[];
  /** The log to persist, with every injected hit recorded. */
  seen: SeenState;
}

const DEFAULT_PER_TURN = 1;
const DEFAULT_PER_SESSION = 3;
/** Rough tokens-per-character for the budget estimate. */
const CHARS_PER_TOKEN = 4;

interface Rule {
  perTurn: number;
  perSession: number;
  maxHits?: number;
  maxTokens?: number;
}

export function applyPolicy(hits: CorpusHit[], options: PolicyOptions): PolicyResult {
  const { turn } = options;
  const rule = resolveRule(options.config, options.model);
  const previous = new Map(options.seen.entries.map((entry) => [entry.key, entry]));
  const candidates = new Map<string, CorpusHit>();
  const forced = new Set<string>();
  const deferred: CorpusHit[] = [];

  for (const hit of hits) {
    const key = hitKey(hit);
    // 1. Same-turn dedupe, on the fused identity. Structural: nothing overrides it.
    if (candidates.has(key)) continue;
    candidates.set(key, hit);

    const surfacing = hit.surfacing ?? options.corpusSurfacing?.get(hit.corpus);
    if (isForced(surfacing?.force, options.model)) {
      forced.add(key);
      continue;
    }
    // 2. Repetition caps, per hit identity.
    if (!withinCaps(surfacing, previous.get(key), turn, rule)) continue;
    deferred.push(hit);
  }

  // 3. Budget per injection. Forced hits override it.
  const budgeted = new Set(applyBudget(deferred, rule).map(hitKey));
  const kept = [...candidates].filter(([key]) => forced.has(key) || budgeted.has(key));
  const result = kept.map(([, hit]) => hit);

  // 4. byModel was resolved into `rule` above; every injected hit is recorded
  // so the caps can see it next turn.
  const entries = new Map(previous);
  const now = Date.now();
  for (const hit of result) {
    const key = hitKey(hit);
    const entry = entries.get(key);
    entries.set(key, {
      key,
      turn,
      shows: (entry?.shows ?? 0) + 1,
      turnShows: entry?.turn === turn ? entry.turnShows + 1 : 1,
      last: now,
    });
  }

  return { hits: result, seen: { turn, entries: [...entries.values()] } };
}

/** Most restrictive of every rule that applies: the top-level section, `*`,
 * and the session's exact model ref. A knob that no rule sets keeps its
 * always-on default. */
function resolveRule(config: SurfacingConfig | undefined, model: string | undefined): Rule {
  const rules: SurfacingRule[] = config === undefined ? [] : [config];
  const star = config?.byModel?.["*"];
  if (star !== undefined) rules.push(star);
  const exact = model === undefined ? undefined : config?.byModel?.[model];
  if (exact !== undefined) rules.push(exact);

  return {
    perTurn: minOf(rules.map((rule) => rule.repetition?.perTurn)) ?? DEFAULT_PER_TURN,
    perSession: minOf(rules.map((rule) => rule.repetition?.perSession)) ?? DEFAULT_PER_SESSION,
    maxHits: minOf(rules.map((rule) => rule.budget?.maxHits)),
    maxTokens: minOf(rules.map((rule) => rule.budget?.maxTokens)),
  };
}

function minOf(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

/** `force` names model refs verbatim (or `*`); a known model must match. */
function isForced(force: string[] | undefined, model: string | undefined): boolean {
  if (force === undefined) return false;
  return force.includes("*") || (model !== undefined && force.includes(model));
}

/** `once` is stricter than any configured session cap; `eager` lifts the
 * session cap but not the turn cap. */
function withinCaps(
  surfacing: HitSurfacing | undefined,
  entry: SeenEntry | undefined,
  turn: number,
  rule: Rule,
): boolean {
  if (entry === undefined) return true;

  const repeat = surfacing?.repeat ?? "normal";
  const perSession =
    repeat === "once" ? 1 : repeat === "eager" ? Number.POSITIVE_INFINITY : rule.perSession;
  if (entry.shows >= perSession) return false;
  return entry.turn !== turn || entry.turnShows < rule.perTurn;
}

/** `maxHits` slices the ranking; `maxTokens` estimates the rendered block and
 * drops the tail until it fits. */
function applyBudget(hits: CorpusHit[], rule: Rule): CorpusHit[] {
  let kept = rule.maxHits === undefined ? hits : hits.slice(0, rule.maxHits);
  if (rule.maxTokens === undefined) return kept;

  while (kept.length > 0 && estimateTokens(kept) > rule.maxTokens) {
    kept = kept.slice(0, -1);
  }
  return kept;
}

function estimateTokens(hits: CorpusHit[]): number {
  return Math.ceil(formatHits(hits, "inject").length / CHARS_PER_TOKEN);
}
