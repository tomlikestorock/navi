import { expect, test } from "vite-plus/test";
import { z } from "zod";

import type { DetectorConfig, DetectorContext, SituationDetector } from "#core/index.ts";
import { GatewayError } from "#core/models/gateway.ts";
import { DetectorRegistry } from "#core/situation/registry.ts";

/** Detector construction never touches a gateway here; any call is a bug. */
const ctx: DetectorContext = {
  config: { corpuses: [] },
  gateway() {
    throw new GatewayError("unexpected gateway resolution");
  },
};

const lexiconOptionsSchema = z.strictObject({
  arenas: z.array(z.string()).default([]),
  weights: z.record(z.string(), z.number()).default({}),
});

class ConfigurableDetector implements SituationDetector {
  static readonly optionsSchema = lexiconOptionsSchema;
  readonly type = "lexicon" as const;
  readonly options: unknown;

  constructor(config: DetectorConfig) {
    this.options = config.options ?? {};
  }

  async detect() {
    return null;
  }
}

class LooseDetector implements SituationDetector {
  readonly type = "lexicon" as const;
  readonly options: unknown;

  constructor(config: DetectorConfig) {
    this.options = config.options;
  }

  async detect() {
    return null;
  }
}

test("register then resolve returns the class", () => {
  const registry = new DetectorRegistry();
  registry.register("lexicon", ConfigurableDetector);
  expect(registry.resolve("lexicon")).toBe(ConfigurableDetector);
});

test("register rejects a duplicate type", () => {
  const registry = new DetectorRegistry();
  registry.register("lexicon", ConfigurableDetector);
  expect(() => registry.register("lexicon", LooseDetector)).toThrow(
    /detector type "lexicon" is already registered/,
  );
});

test("resolve throws a diagnostic for unknown types", () => {
  const registry = new DetectorRegistry();
  registry.register("lexicon", ConfigurableDetector);
  expect(() => registry.resolve("model")).toThrow(
    /unknown detector type "model" \(registered: lexicon\)/,
  );
  expect(() => new DetectorRegistry().resolve("model")).toThrow(/registered: none/);
});

test("types() reports registration order, which is the default fold order", () => {
  const registry = new DetectorRegistry();
  registry.register("lexicon", ConfigurableDetector);
  registry.register("command", LooseDetector);
  registry.register("path", LooseDetector);
  expect(registry.types()).toEqual(["lexicon", "command", "path"]);
});

test("load constructs a detector and applies zod defaults", () => {
  const registry = new DetectorRegistry();
  registry.register("lexicon", ConfigurableDetector);

  const config: DetectorConfig = { id: "words", type: "lexicon", options: { arenas: ["git"] } };
  const detector = registry.load(config, ctx) as ConfigurableDetector;

  expect(detector).toBeInstanceOf(ConfigurableDetector);
  expect(detector.options).toEqual({ arenas: ["git"], weights: {} });
  // load never mutates the caller's config: only the constructor gets the
  // defaulted data.
  expect(config.options).toEqual({ arenas: ["git"] });
});

test("load rejects options that fail the class schema", () => {
  const registry = new DetectorRegistry();
  registry.register("lexicon", ConfigurableDetector);

  expect(() =>
    registry.load({ id: "words", type: "lexicon", options: { arenas: "git" } }, ctx),
  ).toThrow(/detector "words": invalid options — options\.arenas/);
  expect(() =>
    registry.load({ id: "words", type: "lexicon", options: { arenas: [], nope: true } }, ctx),
  ).toThrow(/options\.nope: Unrecognized key: "nope"/);
});

test("load rejects options for a class that declares no schema", () => {
  const registry = new DetectorRegistry();
  registry.register("loose", LooseDetector);

  expect(() =>
    registry.load({ id: "loose", type: "loose", options: { anything: 1 } }, ctx),
  ).toThrow(/detector "loose": options are not supported by this type/);

  // No options means nothing to validate: the class gets the entry as-is.
  const detector = registry.load({ id: "loose", type: "loose" }, ctx) as LooseDetector;
  expect(detector.options).toBeUndefined();
});

test("load fails loud on an unknown type", () => {
  const registry = new DetectorRegistry();
  registry.register("lexicon", ConfigurableDetector);

  expect(() => registry.load({ id: "brain", type: "model" }, ctx)).toThrow(
    /unknown detector type "model"/,
  );
});

test("load hands the setup context to the constructor", () => {
  let seen: DetectorContext | undefined;
  class ContextDetector implements SituationDetector {
    readonly type = "model" as const;

    constructor(_config: DetectorConfig, received: DetectorContext) {
      seen = received;
    }

    async detect() {
      return null;
    }
  }

  const registry = new DetectorRegistry();
  registry.register("model", ContextDetector);
  registry.load({ id: "brain", type: "model" }, ctx);

  expect(seen).toBe(ctx);
});
