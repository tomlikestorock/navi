import { expect, test } from "vite-plus/test";

import type { CorpusHit, SurfacingConfig } from "#core/index.ts";
import { formatHits } from "#core/index.ts";

import { applyPolicy, EMPTY_SEEN, type SeenState } from "./policy.ts";

function hit(id: string, extra: Partial<CorpusHit> = {}): CorpusHit {
  return {
    corpus: "docs",
    id,
    title: id,
    excerpt: `excerpt about ${id}`,
    location: `docs/${id}.md`,
    score: 0.9,
    matched_by: ["text:x"],
    ...extra,
  };
}

/** Run one hit through the pass for `turns` turns, returning what surfaced. */
function surfacing(
  target: CorpusHit,
  turns: number,
  config?: SurfacingConfig,
  model?: string,
  start: SeenState = EMPTY_SEEN,
): number[] {
  const shown: number[] = [];
  let seen = start;
  const startTurn = seen.turn;
  for (let index = 1; index <= turns; index += 1) {
    const result = applyPolicy([target], { config, model, seen, turn: startTurn + index });
    shown.push(result.hits.length);
    seen = result.seen;
  }
  return shown;
}

test("same-turn dedupe drops a duplicate identity, force included", () => {
  const forced = hit("force-push", { surfacing: { force: ["anthropic/x"] } });
  const result = applyPolicy([hit("force-push"), forced], {
    seen: EMPTY_SEEN,
    turn: 1,
    model: "anthropic/x",
  });
  expect(result.hits.map((candidate) => candidate.id)).toEqual(["force-push"]);
});

test("the seen-log caps repetitions per session", () => {
  expect(surfacing(hit("a"), 4)).toEqual([1, 1, 1, 0]);
  expect(surfacing(hit("a"), 3, { repetition: { perTurn: 1, perSession: 2 } })).toEqual([1, 1, 0]);
});

test("repeat: once shows a hit exactly once; eager ignores the session cap", () => {
  expect(surfacing(hit("a", { surfacing: { repeat: "once" } }), 3)).toEqual([1, 0, 0]);
  expect(surfacing(hit("a", { surfacing: { repeat: "eager" } }), 5)).toEqual([1, 1, 1, 1, 1]);
});

test("a second pass in the same turn still honors perTurn", () => {
  const first = applyPolicy([hit("a")], { seen: EMPTY_SEEN, turn: 1 });
  const repeat = applyPolicy([hit("a")], { seen: first.seen, turn: 1 });
  expect(repeat.hits).toEqual([]);

  const twice = applyPolicy([hit("a")], {
    config: { repetition: { perTurn: 2, perSession: 3 } },
    seen: first.seen,
    turn: 1,
  });
  expect(twice.hits.map((candidate) => candidate.id)).toEqual(["a"]);
  expect(twice.seen.entries[0]?.turnShows).toBe(2);
  expect(twice.seen.entries[0]?.shows).toBe(2);
});

test("force lifts the session cap for a matching model, never for another", () => {
  const forced = hit("a", { surfacing: { force: ["anthropic/x"] } });
  const seen: SeenState = {
    turn: 3,
    entries: [{ key: "docs:a", turn: 3, shows: 9, turnShows: 1, last: 0 }],
  };

  expect(applyPolicy([forced], { seen, turn: 4, model: "anthropic/x" }).hits).toHaveLength(1);
  expect(applyPolicy([forced], { seen, turn: 4, model: "openai/y" }).hits).toEqual([]);
  expect(applyPolicy([forced], { seen, turn: 4 }).hits).toEqual([]);
});

test("force overrides the budget; ordinary hits are truncated", () => {
  const budget: SurfacingConfig = { budget: { maxTokens: 1 } };
  const forced = hit("a", { surfacing: { force: ["*"] } });

  expect(
    applyPolicy([hit("a"), hit("b")], { config: budget, seen: EMPTY_SEEN, turn: 1 }).hits,
  ).toEqual([]);
  expect(
    applyPolicy([forced, hit("b")], { config: budget, seen: EMPTY_SEEN, turn: 1 }).hits,
  ).toEqual([forced]);
});

test("maxHits slices the ranking and maxTokens trims the tail", () => {
  const hits = [hit("a"), hit("b"), hit("c")];
  expect(
    applyPolicy(hits, { config: { budget: { maxHits: 2 } }, seen: EMPTY_SEEN, turn: 1 }).hits.map(
      (candidate) => candidate.id,
    ),
  ).toEqual(["a", "b"]);

  const twoBlocks = Math.ceil(formatHits(hits.slice(0, 2), "inject").length / 4);
  const trimmed = applyPolicy(hits, {
    config: { budget: { maxTokens: twoBlocks } },
    seen: EMPTY_SEEN,
    turn: 1,
  });
  expect(trimmed.hits.map((candidate) => candidate.id)).toEqual(["a", "b"]);
});

test("byModel rules are matched against the session's model ref", () => {
  const config: SurfacingConfig = {
    repetition: { perTurn: 1, perSession: 3 },
    byModel: {
      "*": { repetition: { perTurn: 1, perSession: 2 } },
      "anthropic/x": { repetition: { perTurn: 1, perSession: 1 } },
    },
  };

  expect(surfacing(hit("a"), 2, config, "anthropic/x")).toEqual([1, 0]);
  expect(surfacing(hit("a"), 3, config, "openai/y")).toEqual([1, 1, 0]);
  expect(surfacing(hit("a"), 3, config)).toEqual([1, 1, 0]);
});

test("byModel budgets are most-restrictive-wins", () => {
  const config: SurfacingConfig = {
    budget: { maxHits: 3 },
    byModel: { "anthropic/x": { budget: { maxHits: 1 } } },
  };
  expect(
    applyPolicy([hit("a"), hit("b"), hit("c")], {
      config,
      seen: EMPTY_SEEN,
      turn: 1,
      model: "anthropic/x",
    }).hits,
  ).toHaveLength(1);
  expect(
    applyPolicy([hit("a"), hit("b"), hit("c")], {
      config,
      seen: EMPTY_SEEN,
      turn: 1,
      model: "openai/y",
    }).hits,
  ).toHaveLength(3);
});

test("corpus defaults fill hits that declare nothing; a hit's own wins", () => {
  const corpuses = new Map([["docs", { force: ["anthropic/x"] }]]);
  const seen: SeenState = {
    turn: 1,
    entries: [{ key: "docs:a", turn: 1, shows: 9, turnShows: 1, last: 0 }],
  };

  const inherited = applyPolicy([hit("a")], {
    corpusSurfacing: corpuses,
    seen,
    turn: 2,
    model: "anthropic/x",
  });
  expect(inherited.hits).toHaveLength(1);

  const overridden = applyPolicy([hit("a", { surfacing: { repeat: "normal" } })], {
    corpusSurfacing: corpuses,
    seen,
    turn: 2,
    model: "anthropic/x",
  });
  expect(overridden.hits).toEqual([]);
});

test("only injected hits are recorded, in ranking order", () => {
  const result = applyPolicy([hit("a"), hit("b")], {
    config: { budget: { maxHits: 1 } },
    seen: EMPTY_SEEN,
    turn: 1,
  });
  expect(result.seen.turn).toBe(1);
  expect(result.seen.entries.map((entry) => entry.key)).toEqual(["docs:a"]);
  expect(result.seen.entries[0]).toMatchObject({ shows: 1, turnShows: 1, turn: 1 });
});
