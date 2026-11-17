import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";
import { z } from "zod";

import type {
  Corpus,
  CorpusConfig,
  CorpusContext,
  CorpusSearchResult,
  ResolvedCorpusConfig,
  Situation,
} from "#core/index.ts";
import { createSearchEngine, emptySituation, FakeEmbeddingProvider } from "#core/index.ts";
import { createCorpusContext, createEmbeddingResolver, Registry } from "#core/corpus/registry.ts";

/** The example custom corpus, loaded from its real location. */
const examplesDir = fileURLToPath(new URL("../../../examples", import.meta.url));
/** Directory of this test file — anchors the bad-export fixture. */
const here = dirname(fileURLToPath(import.meta.url));

const situation: Situation = emptySituation("force-push to main");

const filesOptionsSchema = z.strictObject({
  path: z.string(),
  extensions: z.array(z.string()).default([]),
  maxFiles: z.number().int().min(1).default(5000),
});

class FilesCorpus implements Corpus {
  static readonly optionsSchema = filesOptionsSchema;
  readonly id: string;
  readonly options: Record<string, unknown>;
  readonly ctx: CorpusContext;

  constructor(config: CorpusConfig, ctx: CorpusContext) {
    this.id = config.id;
    this.options = config.options ?? {};
    this.ctx = ctx;
  }

  async search() {
    return { hits: [], coverage: { seen: 0, dropped: 0 } };
  }
}

class LooseCorpus implements Corpus {
  readonly id: string;
  readonly options: unknown;

  constructor(config: CorpusConfig, _ctx: CorpusContext) {
    this.id = config.id;
    this.options = config.options;
  }

  async search() {
    return { hits: [], coverage: { seen: 0, dropped: 0 } };
  }
}

/** One fixed hit, so the custom module's ranking can fuse against something. */
class OneHitCorpus implements Corpus {
  readonly id: string;

  constructor(config: CorpusConfig) {
    this.id = config.id;
  }

  async search(): Promise<CorpusSearchResult> {
    return {
      hits: [
        {
          corpus: this.id,
          id: "fake-1",
          title: "Fake",
          excerpt: "force-push",
          location: "/fake",
          score: 1,
          matched_by: ["text:fake"],
        },
      ],
      coverage: { seen: 1, dropped: 0 },
    };
  }
}

test("register then resolve returns the class", () => {
  const registry = new Registry();
  registry.register("files", FilesCorpus);
  expect(registry.resolve("files")).toBe(FilesCorpus);
});

test("registered kinds resolve without module loading", () => {
  const registry = new Registry();
  registry.register("files", FilesCorpus);

  expect(registry.resolve("files")).toBe(FilesCorpus);
});

test("register rejects a duplicate type", () => {
  const registry = new Registry();
  registry.register("files", FilesCorpus);
  expect(() => registry.register("files", LooseCorpus)).toThrow(
    /corpus type "files" is already registered/,
  );
});

test("resolve fails loud for an unknown kind", () => {
  const registry = new Registry();
  registry.register("files", FilesCorpus);
  expect(() => registry.resolve("git")).toThrow(/unknown corpus type "git" \(registered: files\)/);
  expect(() => new Registry().resolve("git")).toThrow(/registered: none/);
});

test("custom without a module fails loud instead of guessing", async () => {
  const registry = new Registry();
  await expect(registry.load({ id: "quotes", type: "custom", baseDir: here })).rejects.toThrow(
    /type "custom" requires a "module"/,
  );
});

test("custom loads its module from the declaring config directory", async () => {
  const registry = new Registry();
  const corpus = await registry.load({
    id: "notes",
    type: "custom",
    module: "./copy-out/corpus.ts",
    options: { path: "./copy-out/notes" },
    baseDir: examplesDir,
  });

  expect(corpus.id).toBe("notes");
  const { hits, coverage } = await corpus.search(situation);
  expect(hits.map((hit) => hit.id)).toContain("git-hygiene");
  // A custom corpus reports coverage like any driver.
  expect(coverage).toEqual({ seen: 4, dropped: 0 });
});

test("a missing module fails loud with the module path", async () => {
  const registry = new Registry();
  await expect(
    registry.load({ id: "nope", type: "custom", module: "./nope.ts", baseDir: examplesDir }),
  ).rejects.toThrow(/corpus module ".*nope\.ts": cannot load/);
});

test("a module without a CorpusClass default export fails loud", async () => {
  const registry = new Registry();
  await expect(
    registry.load({
      id: "bad",
      type: "custom",
      module: "./bad-export.fixture.ts",
      baseDir: here,
    }),
  ).rejects.toThrow(
    /corpus module ".*bad-export\.fixture\.ts": default export must be a CorpusClass/,
  );
});

test("load constructs a corpus and applies zod defaults", async () => {
  const registry = new Registry();
  registry.register("files", FilesCorpus);

  const config: ResolvedCorpusConfig = {
    id: "wiki",
    type: "files",
    options: { path: "~/wiki" },
    baseDir: here,
  };
  const corpus = await registry.load(config);

  expect(corpus).toBeInstanceOf(FilesCorpus);
  expect(corpus.id).toBe("wiki");
  expect((corpus as FilesCorpus).options).toEqual({
    path: "~/wiki",
    extensions: [],
    maxFiles: 5000,
  });
  // load never mutates the caller's config: only the constructor gets the
  // defaulted data.
  expect(config.options).toEqual({ path: "~/wiki" });
});

test("load rejects options that fail the class schema", async () => {
  const registry = new Registry();
  registry.register("files", FilesCorpus);

  await expect(
    registry.load({ id: "wiki", type: "files", options: {}, baseDir: here }),
  ).rejects.toThrow(/corpus "wiki": invalid options — options\.path/);
  await expect(
    registry.load({ id: "wiki", type: "files", options: { path: 1 }, baseDir: here }),
  ).rejects.toThrow(/options\.path/);
  await expect(
    registry.load({ id: "wiki", type: "files", options: { path: "~", nope: true }, baseDir: here }),
  ).rejects.toThrow(/options\.nope: Unrecognized key: "nope"/);
});

test("load fails loud on an unknown type", async () => {
  const registry = new Registry();
  // Config validation rejects this first (the `type` enum); the registry keeps
  // its own loud branch for direct callers.
  const config = { id: "history", type: "git", baseDir: here } as unknown as ResolvedCorpusConfig;
  await expect(registry.load(config)).rejects.toThrow(/unknown corpus type "git"/);
});

test("load rejects options for a class that declares no schema", async () => {
  const registry = new Registry();
  registry.register("web", LooseCorpus);

  await expect(
    registry.load({ id: "loose", type: "web", options: { anything: 1 }, baseDir: here }),
  ).rejects.toThrow(/corpus "loose": options are not supported by this type/);

  // No options means nothing to validate: the class gets the entry as-is.
  const config = { id: "loose", type: "web", baseDir: here } as const;
  const corpus = (await registry.load(config)) as LooseCorpus;
  expect(corpus.options).toBeUndefined();
});

test("a custom module corpus participates in search and fusion", async () => {
  const registry = new Registry();
  registry.register("web", OneHitCorpus);

  const engine = await createSearchEngine(
    {
      corpuses: [
        {
          id: "notes",
          type: "custom",
          module: "./copy-out/corpus.ts",
          options: { path: "./copy-out/notes" },
          baseDir: examplesDir,
        },
        { id: "fake", type: "web", baseDir: examplesDir },
      ],
    },
    registry,
  );

  const detailed = await engine.searchDetailed(situation);
  expect(detailed.rankings.map((ranking) => ranking.corpus)).toEqual(["notes", "fake"]);
  expect(detailed.fused.map(({ hit }) => hit.corpus).sort()).toEqual(["fake", "notes", "notes"]);
});

test("load passes the setup context to the class", async () => {
  const registry = new Registry();
  registry.register("files", FilesCorpus);

  const config = { corpuses: [] as CorpusConfig[] };
  const corpus = (await registry.load(
    { id: "wiki", type: "files", options: { path: "~/wiki" }, baseDir: "/repo" },
    { config },
  )) as FilesCorpus;

  expect(corpus.ctx.config).toBe(config);
  expect(corpus.ctx.baseDir).toBe("/repo");
});

test("embedding resolution is lazy per id, cached, and loud", () => {
  const built: string[] = [];
  const config = {
    corpuses: [],
    embeddings: [
      {
        id: "local",
        type: "openai-compatible" as const,
        baseUrl: "http://localhost:11434/v1",
        model: "bge-m3",
        timeoutMs: 10000,
      },
      {
        id: "off",
        type: "openai-compatible" as const,
        baseUrl: "https://example.test/v1",
        model: "m",
        timeoutMs: 10000,
        disabled: true,
      },
    ],
  };

  const ctx = createCorpusContext(config, {
    baseDir: "/repo",
    embeddings: createEmbeddingResolver(config, (provider) => {
      built.push(provider.id);
      return new FakeEmbeddingProvider();
    }),
  });

  // Nothing referenced → nothing built.
  expect(built).toEqual([]);

  const provider = ctx.embeddings("local");
  expect(ctx.embeddings("local")).toBe(provider);
  expect(built).toEqual(["local"]);

  expect(() => ctx.embeddings("ghost")).toThrow(/unknown embedding provider "ghost"/);
  expect(() => ctx.embeddings("off")).toThrow(/embedding provider "off" is disabled/);
  expect(built).toEqual(["local"]);
});
