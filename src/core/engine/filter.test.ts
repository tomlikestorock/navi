/** The applicability filter over the ModelGateway seam.
 * A `TestFakeGateway` scripts every answer, so drop/keep discipline, batching,
 * topK, and the advisory degrade path are all exercised without a model. */

import { expect, test, vi } from "vite-plus/test";

import type {
  Corpus,
  CorpusConfig,
  CorpusSearchOptions,
  CorpusSearchResult,
  ModelProviderConfig,
  ResolvedNaviConfig,
  SearchEngine,
  Situation,
} from "#core/index.ts";
import {
  GatewayError,
  Registry,
  TestFakeGateway,
  createSearchEngine,
  emptySituation,
  z,
} from "#core/index.ts";
import type { FakeResponder } from "#core/models/fake.ts";

const situation: Situation = { ...emptySituation("force-push to main"), arenas: ["git"] };

/** In-memory corpus whose ranking is `options.ids`. */
class FakeCorpus implements Corpus {
  static readonly optionsSchema = z.strictObject({ ids: z.array(z.string()) });
  readonly id: string;
  readonly #ids: string[];

  constructor(config: CorpusConfig) {
    this.id = config.id;
    this.#ids = (config.options?.ids as string[] | undefined) ?? [];
  }

  async search(_situation: Situation, options?: CorpusSearchOptions): Promise<CorpusSearchResult> {
    const hits = this.#ids.slice(0, options?.limit ?? 10).map((id, index) => ({
      corpus: this.id,
      id,
      title: `Title ${id}`,
      excerpt: `Excerpt ${id}`,
      location: `/fake/${this.id}/${id}`,
      score: 1 - index * 0.1,
      matched_by: ["text:fake"],
    }));
    return { hits, coverage: { seen: this.#ids.length, dropped: 0 } };
  }
}

const provider: ModelProviderConfig = {
  id: "judge",
  model: "jev/tev1",
  preferSession: true,
  runner: { type: "systemone", baseUrl: "http://127.0.0.1:11434" },
  timeoutMs: 2000,
};

/** Config with the filter on; `ids` is the single corpus's ranking. */
function configFor(ids: string[], topK = 8): ResolvedNaviConfig {
  return {
    corpuses: [{ id: "a", type: "files", options: { ids }, baseDir: "/repo" }],
    models: [provider],
    filter: { provider: "judge", topK },
  };
}

async function engineFor(
  config: ResolvedNaviConfig,
  gateway: TestFakeGateway,
): Promise<SearchEngine> {
  const registry = new Registry();
  registry.register("files", FakeCorpus);
  return createSearchEngine(config, registry, { createGateway: () => gateway });
}

/** One answer per question: `no` for ids in `drop`, `yes` otherwise. */
function responder(drop: Record<string, number> = {}): FakeResponder {
  return (questions) =>
    questions.map((question) => ({
      id: question.id,
      answer: !(question.id in drop),
      confidence: drop[question.id] ?? 0.9,
    }));
}

test("drops only confident no answers, in one batched call", async () => {
  // a1: confident no → dropped. a2: yes. a3: unconfident no → kept.
  const gateway = new TestFakeGateway(responder({ "a:a1": 0.85, "a:a3": 0.3 }));
  const engine = await engineFor(configFor(["a1", "a2", "a3"]), gateway);

  const result = await engine.searchDetailed(situation);

  expect(result.hits.map((hit) => hit.id)).toEqual(["a2", "a3"]);
  expect(result.filter).toEqual({
    enabled: true,
    topK: 8,
    decisions: [
      { corpus: "a", id: "a1", answer: false, confidence: 0.85, kept: false },
      { corpus: "a", id: "a2", answer: true, confidence: 0.9, kept: true },
      { corpus: "a", id: "a3", answer: false, confidence: 0.3, kept: true },
    ],
  });

  // One call, carrying the Situation and each hit's title + excerpt.
  expect(gateway.calls).toHaveLength(1);
  expect(gateway.calls[0].text).toBe(situation.text);
  expect(gateway.calls[0].questions.map((question) => question.id)).toEqual([
    "a:a1",
    "a:a2",
    "a:a3",
  ]);
  expect(gateway.calls[0].questions[0].prompt).toContain("Title a1 — Excerpt a1");
  expect(gateway.calls[0].questions[0].prompt).toContain("Task: force-push to main");
});

test("all-yes answers pass every hit through untouched", async () => {
  const gateway = new TestFakeGateway(responder());
  const engine = await engineFor(configFor(["a1", "a2"]), gateway);

  const result = await engine.searchDetailed(situation);
  expect(result.hits.map((hit) => hit.id)).toEqual(["a1", "a2"]);
  expect(result.filter.decisions.every((decision) => decision.kept)).toBe(true);
});

test("a gateway error passes everything through and logs (advisory)", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const gateway = new TestFakeGateway(() => {
      throw new GatewayError("judge unreachable");
    });
    const engine = await engineFor(configFor(["a1", "a2"]), gateway);

    const result = await engine.searchDetailed(situation);

    expect(result.hits.map((hit) => hit.id)).toEqual(["a1", "a2"]);
    expect(result.filter.error).toBe("judge unreachable");
    expect(result.filter.decisions).toEqual([
      { corpus: "a", id: "a1", answer: null, confidence: null, kept: true },
      { corpus: "a", id: "a2", answer: null, confidence: null, kept: true },
    ]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('filter "judge"'));
  } finally {
    logged.mockRestore();
  }
});

test("a missing answer keeps the hit (include on uncertainty)", async () => {
  const gateway = new TestFakeGateway(() => []);
  const engine = await engineFor(configFor(["a1"]), gateway);

  const result = await engine.searchDetailed(situation);
  expect(result.hits.map((hit) => hit.id)).toEqual(["a1"]);
  expect(result.filter.decisions).toEqual([
    { corpus: "a", id: "a1", answer: null, confidence: null, kept: true },
  ]);
});

test("topK bounds the predicates; the unexamined overflow is not pruned", async () => {
  const gateway = new TestFakeGateway(responder({ "a:a1": 0.9 }));
  const engine = await engineFor(configFor(["a1", "a2", "a3", "a4"], 2), gateway);

  const result = await engine.searchDetailed(situation);

  expect(gateway.calls[0].questions.map((question) => question.id)).toEqual(["a:a1", "a:a2"]);
  expect(result.hits.map((hit) => hit.id)).toEqual(["a2", "a3", "a4"]);
  expect(result.filter.decisions.map((decision) => decision.id)).toEqual(["a1", "a2"]);
});

test("no filter section leaves the pipeline unchanged and never builds a gateway", async () => {
  const registry = new Registry();
  registry.register("files", FakeCorpus);
  const engine = await createSearchEngine(
    { corpuses: [{ id: "a", type: "files", options: { ids: ["a1"] }, baseDir: "/repo" }] },
    registry,
    {
      createGateway: () => {
        throw new Error("no gateway should be built");
      },
    },
  );

  const result = await engine.searchDetailed(situation);
  expect(result.hits.map((hit) => hit.id)).toEqual(["a1"]);
  expect(result.filter).toEqual({ enabled: false, topK: 0, decisions: [] });
});

test("an unknown or disabled filter provider fails loud at load", async () => {
  const registry = new Registry();
  registry.register("files", FakeCorpus);
  const unknown: ResolvedNaviConfig = {
    corpuses: [],
    filter: { provider: "nope", topK: 8 },
  };
  await expect(createSearchEngine(unknown, registry)).rejects.toThrow(
    /filter: references unknown model provider "nope"/,
  );

  const disabled: ResolvedNaviConfig = {
    corpuses: [],
    models: [{ ...provider, disabled: true }],
    filter: { provider: "judge", topK: 8 },
  };
  await expect(createSearchEngine(disabled, registry)).rejects.toThrow(
    /filter: model provider "judge" is disabled/,
  );
});
