import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { NaviConfig } from "#core/config/schema.ts";
import { TestFakeGateway, type FakeResponder } from "#core/models/fake.ts";
import { GatewayError, type Answer, type ModelGateway } from "#core/models/gateway.ts";
import { createAnalyzer, emptySituation } from "#core/situation/analyzer.ts";
import { DetectorRegistry } from "#core/situation/registry.ts";
import type { DetectorContext } from "#core/situation/types.ts";

import { createBuiltinAnalyzer, createBuiltinDetectorRegistry } from "../index.ts";
import { LexiconDetector, LEXICON } from "./lexicon.ts";
import { INTENTS, ModelDetector } from "./model.ts";

const text = "Please rotate the leaked credential";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function contextWith(gateway: ModelGateway): DetectorContext {
  return { config: { corpuses: [] }, gateway: () => gateway };
}

function detectorOf(
  options: Record<string, unknown>,
  gateway: ModelGateway,
  id = "brain",
): ModelDetector {
  return new ModelDetector({ id, type: "model", options }, contextWith(gateway));
}

/** YES at `confidence` for exactly `yesIds`; NO for the rest. */
function yesResponder(yesIds: string[], confidence = 0.9): FakeResponder {
  return (questions) =>
    questions.map((question) => ({
      id: question.id,
      answer: yesIds.includes(question.id),
      confidence,
    }));
}

/** A merged config with one `always`/`low-confidence` model instance last. */
function analyzerWith(
  gateway: TestFakeGateway,
  when: "always" | "low-confidence" = "always",
): ReturnType<typeof createAnalyzer> {
  const registry = new DetectorRegistry();
  registry.register("lexicon", LexiconDetector);
  registry.register("model", ModelDetector);

  const config: NaviConfig = {
    corpuses: [],
    analyzer: {
      detectors: [
        { id: "lexicon", type: "lexicon" },
        { id: "brain", type: "model", options: { when, provider: "p" } },
      ],
    },
    models: [
      {
        id: "p",
        model: "p/m",
        preferSession: true,
        runner: { type: "opencode" },
        timeoutMs: 1000,
      },
    ],
  };
  return createAnalyzer(config, registry, { createGateway: () => gateway });
}

test("never is the default: no contribution and no gateway call", async () => {
  const fake = new TestFakeGateway(yesResponder(["intent:other"]));
  const situation = emptySituation(text);

  await expect(
    detectorOf({}, fake).detect({ text, kind: "user_prompt" }, situation),
  ).resolves.toBeNull();
  await expect(
    detectorOf({ when: "never" }, fake).detect({ text, kind: "user_prompt" }, situation),
  ).resolves.toBeNull();
  expect(fake.calls).toEqual([]);
});

test("always makes one batched call with the lexicon's arenas and the intents", async () => {
  const fake = new TestFakeGateway(yesResponder([]));
  await detectorOf({ when: "always", provider: "p" }, fake).detect(
    { text, kind: "user_prompt" },
    emptySituation(text),
  );

  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].text).toBe(text);
  expect(fake.calls[0].questions.map((question) => question.id)).toEqual([
    ...LEXICON.map((arena) => `arena:${arena.name}`),
    ...INTENTS.map((intent) => `intent:${intent}`),
  ]);
});

test("matched arenas and the first intent in vocabulary order are contributed", async () => {
  const fake = new TestFakeGateway(
    yesResponder(["arena:git", "arena:security", "intent:other", "intent:rewrite-history"]),
  );

  const contribution = await detectorOf({ when: "always", provider: "p" }, fake).detect(
    { text, kind: "user_prompt" },
    emptySituation(text),
  );

  // "rewrite-history" precedes "other" in the vocabulary.
  expect(contribution).toEqual({
    arenas: ["git", "security"],
    intent: "rewrite-history",
    confidence: 0.9,
  });
});

test("a call with no matched predicate contributes nothing", async () => {
  const fake = new TestFakeGateway(yesResponder([]));
  await expect(
    detectorOf({ when: "always", provider: "p" }, fake).detect(
      { text, kind: "user_prompt" },
      emptySituation(text),
    ),
  ).resolves.toBeNull();
});

test("low-confidence runs below 0.5 and stays silent at or above it", async () => {
  const fake = new TestFakeGateway(yesResponder(["intent:other"]));
  const detector = detectorOf({ when: "low-confidence", provider: "p" }, fake);

  const below = { ...emptySituation(text), confidence: 0.4 };
  await expect(detector.detect({ text, kind: "user_prompt" }, below)).resolves.not.toBeNull();
  expect(fake.calls).toHaveLength(1);

  const at = { ...emptySituation(text), confidence: 0.5 };
  await expect(detector.detect({ text, kind: "user_prompt" }, at)).resolves.toBeNull();
  expect(fake.calls).toHaveLength(1);
});

test("low-confidence stays silent after a lexicon hit and runs after a miss", async () => {
  const fake = new TestFakeGateway(yesResponder(["intent:rewrite-history"]));
  const analyzer = analyzerWith(fake, "low-confidence");

  const deterministic = await analyzer.analyze({ text: "force-push to main", kind: "user_prompt" });
  expect(deterministic.detectors).toEqual(["lexicon"]);
  expect(deterministic.intent).toBeNull();
  expect(fake.calls).toHaveLength(0);

  const vague = await analyzer.analyze({ text: "tidy up the old changes", kind: "user_prompt" });
  expect(fake.calls).toHaveLength(1);
  expect(vague.detectors).toEqual(["brain"]);
  expect(vague.intent).toBe("rewrite-history");
  expect(vague.confidence).toBe(0.9);
});

test("model confidence raises the fold's confidence but never lowers it", async () => {
  const text = "force-push to main";

  const raising = new TestFakeGateway(yesResponder(["intent:rewrite-history"], 0.95));
  const high = await analyzerWith(raising).analyze({ text, kind: "user_prompt" });
  expect(high.confidence).toBe(0.95);
  expect(high.intent).toBe("rewrite-history");

  const lowering = new TestFakeGateway(yesResponder(["intent:rewrite-history"], 0.3));
  const low = await analyzerWith(lowering).analyze({ text, kind: "user_prompt" });
  expect(low.confidence).toBe(0.6);
  expect(low.intent).toBe("rewrite-history");
});

test("answers that break the contract degrade to null and log", async () => {
  const detector = detectorOf(
    { when: "always", provider: "p" },
    new TestFakeGateway(
      () => [{ id: "intent:other", answer: "yes", confidence: 2 }] as unknown as Answer[],
    ),
  );

  await expect(
    detector.detect({ text, kind: "user_prompt" }, emptySituation(text)),
  ).resolves.toBeNull();
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('model detector "brain": answers did not match the answer contract'),
  );
});

test("a non-array answer payload degrades to null and logs", async () => {
  const detector = detectorOf(
    { when: "always", provider: "p" },
    new TestFakeGateway(() => ({ answers: [] }) as unknown as Answer[]),
  );

  await expect(
    detector.detect({ text, kind: "user_prompt" }, emptySituation(text)),
  ).resolves.toBeNull();
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("did not match the answer contract"),
  );
});

test("a gateway error degrades to null and log", async () => {
  const detector = detectorOf(
    { when: "always", provider: "p" },
    new TestFakeGateway(() => {
      throw new GatewayError("opencode run exited 1");
    }),
  );

  await expect(
    detector.detect({ text, kind: "user_prompt" }, emptySituation(text)),
  ).resolves.toBeNull();
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('model detector "brain": opencode run exited 1'),
  );
});

test("a gateway timeout degrades to null and log", async () => {
  const detector = detectorOf(
    { when: "always", provider: "p" },
    new TestFakeGateway(() => {
      throw new GatewayError("opencode run timed out after 10000ms");
    }),
  );

  await expect(
    detector.detect({ text, kind: "user_prompt" }, emptySituation(text)),
  ).resolves.toBeNull();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("timed out after 10000ms"));
});

test("options reject a seat without a provider unless it is never", () => {
  expect(() => detectorOf({ when: "always" }, new TestFakeGateway())).toThrow(
    /provider is required unless when is/,
  );
  expect(() => detectorOf({ when: "low-confidence" }, new TestFakeGateway())).toThrow(
    /provider is required unless when is/,
  );
});

test("the bootstrap registers model, so a config naming it resolves", async () => {
  expect(createBuiltinDetectorRegistry().resolve("model")).toBe(ModelDetector);

  const fake = new TestFakeGateway(yesResponder(["arena:git"], 0.9));
  const config: NaviConfig = {
    corpuses: [],
    analyzer: {
      detectors: [{ id: "brain", type: "model", options: { when: "always", provider: "p" } }],
    },
    models: [
      {
        id: "p",
        model: "p/m",
        preferSession: true,
        runner: { type: "opencode" },
        timeoutMs: 1000,
      },
    ],
  };

  const situation = await createBuiltinAnalyzer(config, { createGateway: () => fake }).analyze({
    text,
    kind: "user_prompt",
  });
  expect(situation.detectors).toEqual(["brain"]);
  expect(situation.arenas).toEqual(["git"]);
});
