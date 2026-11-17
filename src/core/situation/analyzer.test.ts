import { expect, test, vi } from "vite-plus/test";

import type {
  AnalyzerConfig,
  DetectorConfig,
  ModelProviderConfig,
  NaviConfig,
} from "#core/index.ts";
import { ConfigError } from "#core/config/error.ts";
import { TestFakeGateway } from "#core/models/fake.ts";

import { createAnalyzer, emptySituation } from "./analyzer.ts";
import { DetectorRegistry } from "./registry.ts";
import type { DetectorContext, SituationDetector } from "./types.ts";

/** One fake detector type per entry; every instance of a type behaves alike. */
function registryOf(detectors: Record<string, SituationDetector["detect"]>): DetectorRegistry {
  const registry = new DetectorRegistry();
  for (const [detectorType, detect] of Object.entries(detectors)) {
    registry.register(
      detectorType,
      class {
        readonly type = detectorType;
        detect = detect;
      },
    );
  }
  return registry;
}

/** A merged config with only the sections this file cares about. */
function naviConfig(analyzer?: AnalyzerConfig, models?: ModelProviderConfig[]): NaviConfig {
  const config: NaviConfig = { corpuses: [] };
  if (analyzer !== undefined) config.analyzer = analyzer;
  if (models !== undefined) config.models = models;
  return config;
}

test("contributions append with dedupe; confidence is the max", async () => {
  let seenBySecond: string[] = [];
  const registry = registryOf({
    regex: async () => ({ arenas: ["git"], patterns: ["force-push"], confidence: 0.6 }),
    path: async (_input, current) => {
      seenBySecond = current.patterns.slice();
      return {
        arenas: ["git", "deploy"],
        patterns: ["force-push"],
        paths: ["src/a.ts"],
        confidence: 0.9,
      };
    },
  });

  const situation = await createAnalyzer(
    naviConfig({
      detectors: [
        { id: "lexicon", type: "regex" },
        { id: "files", type: "path" },
      ],
    }),
    registry,
  ).analyze({
    text: "force-push to main",
    kind: "user_prompt",
  });

  expect(situation).toEqual({
    ...emptySituation("force-push to main"),
    kinds: ["user_prompt"],
    arenas: ["git", "deploy"],
    patterns: ["force-push"],
    paths: ["src/a.ts"],
    confidence: 0.9,
    detectors: ["lexicon", "files"],
  });
  expect(seenBySecond).toEqual(["force-push"]);
});

test("a null contribution adds nothing; later detectors cannot lower claims", async () => {
  const registry = registryOf({
    model: async () => ({ intent: "refactor", arenas: ["git"], confidence: 0.9 }),
    tool: async () => ({ confidence: 0.2 }),
    path: async () => null,
  });

  const situation = await createAnalyzer(
    naviConfig({
      detectors: [
        { id: "model", type: "model" },
        { id: "tool", type: "tool" },
        { id: "path", type: "path" },
      ],
    }),
    registry,
  ).analyze({
    text: "tidy the git history",
    kind: "user_prompt",
  });

  expect(situation.intent).toBe("refactor");
  expect(situation.arenas).toEqual(["git"]);
  expect(situation.confidence).toBe(0.9);
  expect(situation.detectors).toEqual(["model", "tool"]);
});

test("a non-model detector cannot contribute intent", async () => {
  const registry = registryOf({
    lexicon: async () => ({ intent: "deploy-change", arenas: ["deploy"], confidence: 0.6 }),
    model: async () => ({ intent: "rotate-credential" }),
  });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    const situation = await createAnalyzer(
      naviConfig({
        detectors: [
          { id: "words", type: "lexicon" },
          { id: "brain", type: "model" },
        ],
      }),
      registry,
    ).analyze({ text: "deploy the credential change", kind: "user_prompt" });

    // The lexicon's intent claim is refused; the model's is the one that lands.
    expect(situation.intent).toBe("rotate-credential");
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('detector "words" (type "lexicon"): intent is model-only'),
    );
  } finally {
    logged.mockRestore();
  }
});

test("multi-turn input folds into one Situation; an empty list runs nothing", async () => {
  const situation = await createAnalyzer(
    naviConfig({ detectors: [] }),
    new DetectorRegistry(),
  ).analyze([
    { text: "first", kind: "user_prompt" },
    { text: "second", kind: "tool_call" },
    { text: "again", kind: "user_prompt" },
  ]);

  expect(situation.text).toBe("first\n\nsecond\n\nagain");
  expect(situation.kinds).toEqual(["user_prompt", "tool_call"]);
  expect(situation.detectors).toEqual([]);
  expect(situation.confidence).toBe(0);
});

test("the config list is selection, not addition: unlisted types never run", async () => {
  const registry = registryOf({
    lexicon: async () => ({ arenas: ["git"], patterns: ["force-push"], confidence: 0.6 }),
    command: async () => ({ tools: ["git"], patterns: ["push"], confidence: 0.6 }),
  });

  const situation = await createAnalyzer(
    naviConfig({ detectors: [{ id: "commands", type: "command" }] }),
    registry,
  ).analyze({ text: "force-push to main", kind: "user_prompt" });

  expect(situation.arenas).toEqual([]);
  expect(situation.patterns).toEqual(["push"]);
  expect(situation.detectors).toEqual(["commands"]);
});

test("config order is fold order, and two instances of one type keep distinct ids", async () => {
  const registry = registryOf({
    lexicon: async (_input, current) => ({
      arenas: current.arenas.length === 0 ? ["git"] : ["security"],
      confidence: 0.6,
    }),
  });

  const situation = await createAnalyzer(
    naviConfig({
      detectors: [
        { id: "git-words", type: "lexicon" },
        { id: "security-words", type: "lexicon" },
      ],
    }),
    registry,
  ).analyze({ text: "x", kind: "user_prompt" });

  expect(situation.arenas).toEqual(["git", "security"]);
  expect(situation.detectors).toEqual(["git-words", "security-words"]);
});

test("disabled instances are skipped", async () => {
  const registry = registryOf({
    lexicon: async () => ({ arenas: ["git"], confidence: 0.6 }),
    tool: async () => ({ tools: ["bash"], confidence: 0.5 }),
  });

  const situation = await createAnalyzer(
    naviConfig({
      detectors: [
        { id: "words", type: "lexicon", disabled: true },
        { id: "shell", type: "tool" },
      ],
    }),
    registry,
  ).analyze({ text: "force-push", kind: "tool_call" });

  expect(situation.arenas).toEqual([]);
  expect(situation.detectors).toEqual(["shell"]);
});

test("omitting the section builds one default instance per registered type, in registration order", async () => {
  const registry = registryOf({
    lexicon: async () => ({ arenas: ["git"], confidence: 0.6 }),
    command: async () => ({ patterns: ["push"] }),
    path: async () => null,
  });

  for (const analyzer of [undefined, {}, { detectors: undefined }]) {
    const situation = await createAnalyzer(naviConfig(analyzer), registry).analyze({
      text: "git push",
      kind: "user_prompt",
    });
    expect(situation.detectors).toEqual(["lexicon", "command"]);
  }
});

test("an unknown detector type fails loud, before any input is analyzed", () => {
  const registry = registryOf({ tool: async () => null });

  expect(() =>
    createAnalyzer(naviConfig({ detectors: [{ id: "brain", type: "model" }] }), registry),
  ).toThrow(/unknown detector type "model" \(registered: tool\)/);
});

/** A detector that keeps the context it was constructed with. */
class ContextSpy implements SituationDetector {
  static last: ContextSpy | undefined;
  readonly type = "model" as const;
  readonly ctx: DetectorContext;

  constructor(_config: DetectorConfig, ctx: DetectorContext) {
    this.ctx = ctx;
    ContextSpy.last = this;
  }

  async detect() {
    return null;
  }
}

/** Config with two providers; only "used" will ever be referenced. */
const providers: ModelProviderConfig[] = [
  { id: "used", model: "p/m", preferSession: true, runner: { type: "opencode" }, timeoutMs: 1000 },
  { id: "spare", model: "p/m", preferSession: true, runner: { type: "opencode" }, timeoutMs: 1000 },
];

test("every instance is constructed with the merged config", () => {
  const registry = new DetectorRegistry();
  registry.register("model", ContextSpy);

  const config = naviConfig({ detectors: [{ id: "brain", type: "model" }] }, providers);
  createAnalyzer(config, registry);

  expect(ContextSpy.last?.ctx.config).toBe(config);
});

test("gateway(id) is lazy, cached, and never builds unreferenced providers", () => {
  const registry = new DetectorRegistry();
  registry.register("model", ContextSpy);
  const fake = new TestFakeGateway();
  const createGateway = vi.fn(() => fake);

  createAnalyzer(naviConfig({ detectors: [{ id: "brain", type: "model" }] }, providers), registry, {
    createGateway,
  });

  // Nothing asked yet: no provider was built.
  expect(createGateway).not.toHaveBeenCalled();

  const ctx = ContextSpy.last!.ctx;
  expect(ctx.gateway("used")).toBe(fake);
  expect(ctx.gateway("used")).toBe(fake);
  expect(createGateway).toHaveBeenCalledTimes(1);
  expect(createGateway).toHaveBeenCalledWith(providers[0]);
});

test("gateway(unknown) and a disabled provider fail loud when referenced", () => {
  const registry = new DetectorRegistry();
  registry.register("model", ContextSpy);
  createAnalyzer(
    naviConfig({ detectors: [{ id: "brain", type: "model" }] }, [
      ...providers,
      {
        id: "off",
        model: "p/m",
        preferSession: true,
        runner: { type: "opencode" },
        timeoutMs: 1000,
        disabled: true,
      },
    ]),
    registry,
    { createGateway: () => new TestFakeGateway() },
  );

  const ctx = ContextSpy.last!.ctx;
  // Same lookup and error type as config validation, so the two cannot drift.
  expect(() => ctx.gateway("nope")).toThrow(ConfigError);
  expect(() => ctx.gateway("nope")).toThrow(/unknown model provider "nope"/);
  expect(() => ctx.gateway("off")).toThrow(/model provider "off" is disabled/);
});
