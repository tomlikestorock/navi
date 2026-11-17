import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { withTempDirAsync } from "../../../../test-support/tmp.ts";

import type {
  Corpus,
  CorpusConfig,
  CorpusHit,
  EmbeddingProvider,
  ResolvedNaviConfig,
} from "#core/index.ts";
import { emptySituation, FakeEmbeddingProvider } from "#core/index.ts";
import { createEmbeddingResolver, Registry } from "#core/corpus/registry.ts";
import { registerBuiltinCorpuses } from "#core/drivers/index.ts";

const situation = emptySituation;

/** Run `body` against a throwaway fixture tree written from `files`. */
async function fixture(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  await withTempDirAsync("navi-files-", async (dir) => {
    for (const [path, content] of Object.entries(files)) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    await body(dir);
  });
}

async function load(
  options: Record<string, unknown>,
  config: Partial<CorpusConfig> = {},
): Promise<Corpus> {
  const registry = new Registry();
  registerBuiltinCorpuses(registry);
  // Every fixture path is absolute, so the anchor is only there to satisfy the
  // resolved-config contract.
  return registry.load({ id: "docs", type: "files", ...config, options, baseDir: "/repo" });
}

/** Load `docs` wired to `provider`; the vector cache goes under the standard
 * location, redirected per test by the hooks below. */
async function loadEmbedded(
  options: Record<string, unknown>,
  provider: EmbeddingProvider,
  model = "fake-model",
): Promise<Corpus> {
  const registry = new Registry();
  registerBuiltinCorpuses(registry);
  const config: ResolvedNaviConfig = {
    corpuses: [{ id: "docs", type: "files", embed: "fake", options, baseDir: "/repo" }],
    embeddings: [
      {
        id: "fake",
        type: "openai-compatible",
        baseUrl: "http://localhost/v1",
        model,
        timeoutMs: 10000,
      },
    ],
  };
  return registry.load(config.corpuses[0], {
    config,
    embeddings: createEmbeddingResolver(config, () => provider),
  });
}

/** Hits of one query; coverage has its own tests. */
async function searchHits(corpus: Corpus, text: string): Promise<CorpusHit[]> {
  return (await corpus.search(situation(text))).hits;
}

let cacheHome: string;

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "navi-embeddings-cache-"));
  // Tests neither read nor write the developer's real vector cache.
  vi.stubEnv("XDG_CACHE_HOME", cacheHome);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(cacheHome, { recursive: true, force: true });
});

test("matches content, ranks by tf-idf and normalizes scores", async () => {
  await fixture(
    {
      "git.md": "# Git\n\nForce push rewrites history.\n\nNever force-push to main.\n",
      "notes.md": "Force push to main is risky, and this note rambles on about unrelated things.\n",
      "other.md": "Nothing about branch protection.\n",
    },
    async (dir) => {
      const corpus = await load({ path: dir });
      const hits = await searchHits(corpus, "force push main");

      expect(hits.map((hit) => hit.id)).toEqual(["git.md", "notes.md"]);
      expect(hits[0]).toEqual({
        corpus: "docs",
        id: "git.md",
        title: "git.md",
        excerpt: "Force push rewrites history.",
        location: join(dir, "git.md"),
        score: 1,
        matched_by: ["text:force", "text:push", "text:main"],
      });
      // Same terms, lower density: 3 matches over 14 words vs 5 over 10.
      expect(hits[1].score).toBeCloseTo(3 / 14 / (5 / 10));
    },
  );
});

test("idf ranks a rare term above a term common to every file", async () => {
  await fixture(
    {
      "a.md": "config\n",
      "b.md": "config\n",
      "c.md": "config\n",
      "rare.md": "force-push\n",
    },
    async (dir) => {
      const corpus = await load({ path: dir });
      const hits = await searchHits(corpus, "config force-push");

      expect(hits[0].id).toBe("rare.md");
      expect(hits[0].score).toBe(1);
      // Equal raw counts (1 each), but "config" is in 3 of 4 files.
      expect(hits[1].score).toBeLessThan(0.7);
    },
  );
});

test("document length keeps a big file stuffed with a common term from dominating", async () => {
  const filler = Array.from(
    { length: 100 },
    (_, index) => `filler${index} alpha beta gamma delta config\n`,
  ).join("");
  await fixture(
    { "huge.md": filler, "focused.md": "force-push is the whole point here\n" },
    async (dir) => {
      const corpus = await load({ path: dir });
      const hits = await searchHits(corpus, "config force-push");

      // 100 raw occurrences in huge.md, but only a tenth of its words.
      expect(hits.map((hit) => hit.id)).toEqual(["focused.md", "huge.md"]);
    },
  );
});

test("honors the extensions filter and skips binary files by default", async () => {
  await fixture(
    {
      "a.md": "widget\n",
      "b.png": "widget\n",
      "c.dat": "\0widget\n",
    },
    async (dir) => {
      const markdown = await load({ path: dir, extensions: [".md"] });
      expect((await searchHits(markdown, "widget")).map((hit) => hit.id)).toEqual(["a.md"]);

      const textOnly = await load({ path: dir });
      expect((await searchHits(textOnly, "widget")).map((hit) => hit.id)).toEqual([
        "a.md",
        "b.png",
      ]);
    },
  );
});

test("honors gitignore-style ignore globs, including whole directories", async () => {
  await fixture(
    {
      "keep.md": "widget\n",
      "drafts/a.md": "widget\n",
      "notes.tmp": "widget\n",
      "vendor/deep/b.md": "widget\n",
    },
    async (dir) => {
      const corpus = await load({ path: dir, ignore: ["drafts/", "*.tmp", "**/vendor/**"] });
      expect((await searchHits(corpus, "widget")).map((hit) => hit.id)).toEqual(["keep.md"]);
    },
  );
});

test("caps the number of scanned files with maxFiles", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => [`f${index}.md`, "widget\n"]),
  );
  await fixture(files, async (dir) => {
    const corpus = await load({ path: dir, maxFiles: 2 });
    const result = await corpus.search(situation("widget"));

    expect(result.hits.map((hit) => hit.id)).toEqual(["f0.md", "f1.md"]);
    // The cap is reported next to the hits, not left silent.
    expect(result.coverage).toEqual({ seen: 2, dropped: 4 });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('corpus "docs": maxFiles 2 dropped 4 files'),
    );

    // Once per corpus, not once per search.
    await corpus.search(situation("widget"));
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

test("reports vector coverage and cold documents when embedded", async () => {
  await fixture(
    {
      "git.md": "force push rewrites history\n",
      "rollback.md": "rollback procedures undo a release safely\n",
      "other.md": "an unrelated note\n",
    },
    async (dir) => {
      const readThrough = await loadEmbedded({ path: dir }, new FakeEmbeddingProvider());
      const cold = await readThrough.search(situation("force push"));
      // Read-through warms only the retrieved document; the rest stay cold.
      expect(cold.coverage).toEqual({ seen: 3, dropped: 0, vector_hits: 1, cold_count: 2 });

      const eager = await loadEmbedded(
        { path: dir, embedEager: true },
        new FakeEmbeddingProvider(),
      );
      const warm = await eager.search(situation("force push"));
      expect(warm.coverage).toEqual({ seen: 3, dropped: 0, vector_hits: 3, cold_count: 0 });
    },
  );
});

test("an empty query returns no hits", async () => {
  await fixture({ "a.md": "widget\n" }, async (dir) => {
    const corpus = await load({ path: dir });
    expect(await searchHits(corpus, "")).toEqual([]);
    expect(await searchHits(corpus, "  !!  ")).toEqual([]);
  });
});

test("a missing locator fails at load, not at search", async () => {
  await withTempDirAsync("navi-files-", async (dir) => {
    await expect(load({ path: join(dir, "missing") })).rejects.toThrow(
      /files path is not a directory/,
    );
  });
});

test("a relative path resolves against the declaring config file's dir", async () => {
  await fixture({ "project/docs/a.md": "widget\n" }, async (dir) => {
    const registry = new Registry();
    registerBuiltinCorpuses(registry);
    // `./docs` is relative to the config file, not to cwd —
    // which is here the temp dir's parent, not the project root.
    const corpus = await registry.load({
      id: "docs",
      type: "files",
      options: { path: "./docs" },
      baseDir: join(dir, "project"),
    });

    const hits = await searchHits(corpus, "widget");
    expect(hits.map((hit) => hit.id)).toEqual(["a.md"]);
    expect(hits[0].location).toBe(join(dir, "project", "docs", "a.md"));
  });
});

test("read-through embeds the query and only the retrieved documents", async () => {
  await fixture(
    {
      "git.md": "force push rewrites history\n",
      "rollback.md": "rollback procedures undo a release safely\n",
      "other.md": "an unrelated note\n",
    },
    async (dir) => {
      const provider = new FakeEmbeddingProvider();
      const corpus = await loadEmbedded({ path: dir }, provider);

      const hits = await searchHits(corpus, "force push");
      expect(provider.calls).toEqual([["force push"], ["force push rewrites history\n"]]);
      expect(hits[0].matched_by).toContain("text:force");
      expect(hits[0].matched_by.some((entry) => entry.startsWith("vector:"))).toBe(true);

      // Same query: every vector is cached, so only the query is embedded.
      await searchHits(corpus, "force push");
      expect(provider.calls.at(-1)).toEqual(["force push"]);

      // A new query embeds its own retrieved document, never the whole corpus.
      await searchHits(corpus, "rollback release");
      expect(provider.calls.at(-1)).toEqual(["rollback procedures undo a release safely\n"]);
      expect(provider.calls.flat()).not.toContain("an unrelated note\n");
    },
  );
});

test("read-through warms add recall, not just reordering", async () => {
  await fixture(
    {
      "lexical.md": "undo release\n",
      "paraphrase.md": "rollback procedures\n",
      "unrelated.md": "nothing to see\n",
    },
    async (dir) => {
      // Controlled vectors: the paraphrase doc is cosine-identical to the
      // "undo release" query yet shares no query term with it.
      const vectors: Record<string, number[]> = {
        "undo release": [1, 0],
        "undo release\n": [0.8, 0.2],
        "rollback procedures": [1, 0],
        "rollback procedures\n": [1, 0],
        "nothing to see\n": [0, 1],
      };
      const calls: string[][] = [];
      const provider: EmbeddingProvider = {
        embed: async (texts) => {
          calls.push([...texts]);
          return texts.map((text) => vectors[text] ?? [0, 0]);
        },
      };
      const corpus = await loadEmbedded({ path: dir, embedEager: false }, provider);

      // Cold read-through embeds only what it retrieved: the paraphrase doc
      // has no vector yet, so lexical-only recall is the whole result.
      const cold = await searchHits(corpus, "undo release");
      expect(cold.map((hit) => hit.id)).toEqual(["lexical.md"]);
      expect(calls.flat()).not.toContain("rollback procedures\n");

      // A second query retrieves and warms the paraphrase doc.
      await searchHits(corpus, "rollback procedures");

      // The same first query again: the cached vector now adds a hit that
      // lexical search cannot reach at all.
      const warm = await searchHits(corpus, "undo release");
      expect(warm.map((hit) => hit.id)).toEqual(["lexical.md", "paraphrase.md"]);
      expect(warm[1].matched_by).toEqual(["vector:1.000"]);
      expect(warm[1].excerpt).toBe("rollback procedures");
    },
  );
});

test("eager warming embeds every document once, in batches", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 205 }, (_, index) => [`f${index}.md`, `widget ${index}\n`]),
  );
  await fixture(files, async (dir) => {
    const provider = new FakeEmbeddingProvider();
    const corpus = await loadEmbedded({ path: dir, embedEager: true }, provider);

    await searchHits(corpus, "widget");
    // Query first, then document batches: arrays only, never per-document calls.
    expect(provider.calls.slice(1).map((batch) => batch.length)).toEqual([100, 100, 5]);
    expect(new Set(provider.calls.slice(1).flat()).size).toBe(205);

    // The blocking warm is done: the next search embeds only its query.
    const before = provider.calls.length;
    await searchHits(corpus, "widget");
    expect(provider.calls.length).toBe(before + 1);
  });
});

test("a cold cache or a failed provider still returns the lexical hits", async () => {
  await fixture(
    { "git.md": "force push rewrites history\n", "other.md": "unrelated\n" },
    async (dir) => {
      const lexical = await searchHits(await load({ path: dir }), "force push");

      const cold = await searchHits(
        await loadEmbedded({ path: dir }, new FakeEmbeddingProvider()),
        "force push",
      );
      expect(cold.map((hit) => hit.id)).toEqual(lexical.map((hit) => hit.id));
      expect(cold.map((hit) => hit.excerpt)).toEqual(lexical.map((hit) => hit.excerpt));

      const failing: EmbeddingProvider = {
        embed: async () => {
          throw new Error("provider offline");
        },
      };
      const degraded = await searchHits(await loadEmbedded({ path: dir }, failing), "force push");
      expect(degraded.map((hit) => hit.id)).toEqual(lexical.map((hit) => hit.id));
      expect(degraded[0].matched_by).toEqual(["text:force", "text:push"]);
    },
  );
});

test("fusion keeps a two-tier hit first and surfaces a vector-only hit", async () => {
  await fixture(
    {
      "lexical.md": "undo release\n",
      "paraphrase.md": "rollback procedures\n",
      "unrelated.md": "nothing to see\n",
    },
    async (dir) => {
      // Controlled vectors: the paraphrase doc is vector rank 1 but shares no
      // query term, so only fusion can surface it.
      const vectors: Record<string, number[]> = {
        "undo release": [1, 0],
        "undo release\n": [0.8, 0.2],
        "rollback procedures\n": [1, 0],
        "nothing to see\n": [0, 1],
      };
      const provider: EmbeddingProvider = {
        embed: async (texts) => texts.map((text) => vectors[text] ?? [0, 0]),
      };
      const corpus = await loadEmbedded({ path: dir, embedEager: true }, provider);

      const hits = await searchHits(corpus, "undo release");
      expect(hits.map((hit) => hit.id)).toEqual(["lexical.md", "paraphrase.md"]);
      expect(hits[0].matched_by).toEqual(["text:undo", "text:release", "vector:0.970"]);
      expect(hits[1].matched_by).toEqual(["vector:1.000"]);
      expect(hits[1].excerpt).toBe("rollback procedures");
    },
  );
});

test("a provider model bump invalidates the cached vectors", async () => {
  await fixture({ "git.md": "force push rewrites history\n" }, async (dir) => {
    const first = new FakeEmbeddingProvider();
    await searchHits(await loadEmbedded({ path: dir }, first, "model-a"), "force push");
    expect(first.calls).toHaveLength(2);

    const second = new FakeEmbeddingProvider();
    await searchHits(await loadEmbedded({ path: dir }, second, "model-b"), "force push");
    // Query + document again: the old model's vectors were not reused.
    expect(second.calls).toHaveLength(2);
  });
});

/** A corpus's read capability, failing loudly when it has none. */
function reader(corpus: Corpus): (id: string) => Promise<{ content: string; location: string }> {
  const read = corpus.read?.bind(corpus);
  if (read === undefined) throw new Error("corpus has no read()");
  return read;
}

test("read serves only ids the corpus scan would surface", async () => {
  await fixture(
    {
      "keep.md": "keep\n",
      "skip.log": "log\n",
      "ignored/secret.md": "secret\n",
      "nested/deep.md": "deep\n",
    },
    async (dir) => {
      const corpus = await load({ path: dir, extensions: [".md"], ignore: ["ignored"] });
      const read = reader(corpus);

      await expect(read("keep.md")).resolves.toEqual({
        content: "keep\n",
        location: join(dir, "keep.md"),
      });
      await expect(read("nested/deep.md")).resolves.toMatchObject({ content: "deep\n" });

      // Not in the corpus view: wrong extension, ignored, unknown, or outside.
      await expect(read("skip.log")).rejects.toThrow('no file "skip.log"');
      await expect(read("ignored/secret.md")).rejects.toThrow('no file "ignored/secret.md"');
      await expect(read("missing.md")).rejects.toThrow('no file "missing.md"');
      await expect(read("../outside.md")).rejects.toThrow('is not under corpus "docs"');
    },
  );
});

test("read honours maxFiles", async () => {
  await fixture({ "a.md": "a\n", "b.md": "b\n" }, async (dir) => {
    const read = reader(await load({ path: dir, maxFiles: 1 }));
    await expect(read("a.md")).resolves.toMatchObject({ content: "a\n" });
    await expect(read("b.md")).rejects.toThrow('no file "b.md"');
  });
});

test("frontmatter surfacing rides the hit; files without it stay bare", async () => {
  await fixture(
    {
      "once.md": [
        "---",
        "surfacing:",
        "  repeat: once",
        "  force: [anthropic/claude-haiku]",
        "  priority: 2",
        "---",
        "widget guidance",
      ].join("\n"),
      "bare.md": "widget guidance\n",
    },
    async (dir) => {
      const hits = await searchHits(await load({ path: dir }), "widget");
      const once = hits.find((hit) => hit.id === "once.md");
      const bare = hits.find((hit) => hit.id === "bare.md");

      expect(once?.surfacing).toEqual({
        repeat: "once",
        force: ["anthropic/claude-haiku"],
        priority: 2,
      });
      expect(bare?.surfacing).toBeUndefined();
    },
  );
});
