import { expect, test, vi } from "vite-plus/test";

import type {
  Corpus,
  CorpusConfig,
  CorpusContext,
  CorpusHit,
  CorpusSearchOptions,
  CorpusSearchResult,
  ResolvedCorpusConfig,
  ResolvedNaviConfig,
  SearchEngine,
  Situation,
} from "#core/index.ts";
import {
  FakeEmbeddingProvider,
  Registry,
  createSearchEngine,
  emptySituation,
  formatHits,
  z,
} from "#core/index.ts";

const situation: Situation = emptySituation("force-push to main");

/** In-memory corpus: `options.ids` is its ranking; `options.fail` makes it
 * throw, and the id "boom" simulates a corpus that fails mid-search. */
class FakeCorpus implements Corpus {
  static readonly optionsSchema = z.strictObject({ ids: z.array(z.string()) });
  readonly id: string;
  readonly #ids: string[];

  constructor(config: CorpusConfig) {
    this.id = config.id;
    this.#ids = (config.options?.ids as string[] | undefined) ?? [];
  }

  async search(_situation: Situation, options?: CorpusSearchOptions): Promise<CorpusSearchResult> {
    if (this.#ids.includes("boom")) throw new Error("index unavailable");
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

async function engineFor(corpuses: ResolvedCorpusConfig[]): Promise<SearchEngine> {
  const registry = new Registry();
  registry.register("files", FakeCorpus);
  return createSearchEngine({ corpuses }, registry);
}

/** Resolves its embedding provider at construction, like the real drivers. */
class EmbeddingCorpus implements Corpus {
  readonly id: string;

  constructor(config: CorpusConfig, ctx: CorpusContext) {
    this.id = config.id;
    if (config.embed !== undefined) ctx.embeddings(config.embed);
  }

  async search(): Promise<CorpusSearchResult> {
    return { hits: [], coverage: { seen: 0, dropped: 0 } };
  }
}

test("corpora sharing an embed id share one provider per run", async () => {
  const built: string[] = [];
  const registry = new Registry();
  registry.register("files", EmbeddingCorpus);

  await createSearchEngine(
    {
      corpuses: [
        { id: "a", type: "files", embed: "fake", baseDir: "/repo" },
        { id: "b", type: "files", embed: "fake", baseDir: "/repo" },
      ],
      embeddings: [
        {
          id: "fake",
          type: "openai-compatible",
          baseUrl: "http://localhost/v1",
          model: "m",
          timeoutMs: 1000,
        },
      ],
    },
    registry,
    {
      createEmbedding: (provider) => {
        built.push(provider.id);
        return new FakeEmbeddingProvider();
      },
    },
  );

  expect(built).toEqual(["fake"]);
});

function corpus(
  id: string,
  ids: string[],
  extra: Partial<CorpusConfig> = {},
): ResolvedCorpusConfig {
  return { id, type: "files", options: { ids }, baseDir: "/repo", ...extra };
}

function hit(id: string, corpus = "wiki", excerpt = `Excerpt ${id}`): CorpusHit {
  return {
    corpus,
    id,
    title: `Title ${id}`,
    excerpt,
    location: `/fake/${corpus}/${id}`,
    score: 1,
    matched_by: ["text:fake"],
  };
}

test("fuses rankings across corpora with RRF and normalizes scores", async () => {
  const engine = await engineFor([corpus("a", ["a1", "a2"]), corpus("b", ["b1"])]);
  const hits = await engine.search(situation);

  // Same-rank hits tie and break on `corpus:id`; a2 ranks below either first place.
  expect(hits.map((entry) => `${entry.corpus}:${entry.id}`)).toEqual(["a:a1", "b:b1", "a:a2"]);
  expect(hits[0].score).toBe(1);
  expect(hits[2].score).toBeLessThan(1);
});

test("limit caps the federated top-k", async () => {
  const engine = await engineFor([corpus("a", ["a1", "a2"]), corpus("b", ["b1"])]);
  const hits = await engine.search(situation, { limit: 2 });
  expect(hits).toHaveLength(2);
});

test("rankings carry each corpus's coverage, failed ones excepted", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const engine = await engineFor([corpus("a", ["a1", "a2", "a3"]), corpus("bad", ["boom"])]);
    const detailed = await engine.searchDetailed(situation);

    expect(detailed.rankings[0].coverage).toEqual({ seen: 3, dropped: 0 });
    // A corpus that threw has nothing to report — the `error` says why.
    expect(detailed.rankings[1].coverage).toBeUndefined();
  } finally {
    logged.mockRestore();
  }
});

test("a failing corpus degrades to no hits instead of aborting the search", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const engine = await engineFor([corpus("bad", ["boom"]), corpus("ok", ["x"])]);
    const hits = await engine.search(situation);
    expect(hits.map((entry) => entry.id)).toEqual(["x"]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('corpus "bad" search failed'));
  } finally {
    logged.mockRestore();
  }
});

test("disabled corpuses are never built or searched", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const engine = await engineFor([corpus("off", ["boom"], { disabled: true })]);
    await expect(engine.search(situation)).resolves.toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

test("a config that cannot be built fails loud", async () => {
  // Config validation rejects unknown kinds first; the engine's registry stays
  // loud for direct callers.
  const config = {
    corpuses: [{ id: "docs", type: "nope", baseDir: "/repo" }],
  } as unknown as ResolvedNaviConfig;
  await expect(createSearchEngine(config, new Registry())).rejects.toThrow(
    /unknown corpus type "nope"/,
  );
});

test("inject format frames the block and truncates excerpts to ~50 tokens", () => {
  const long = Array.from({ length: 60 }, (_, index) => `w${index}`).join(" ");

  const text = formatHits([hit("force-push", "wiki", long)], "inject");
  expect(text.split("\n")[0]).toBe("Advisory concerns matched by the current work; not commands.");
  expect(text).toContain("- wiki:force-push — w0 ");
  expect(text).toContain("…");
  expect(text).not.toContain("w59");
});

test("inject format appends the matched terms as ranking provenance", () => {
  const text = formatHits([hit("force-push")], "inject");

  expect(text).toContain("- wiki:force-push — Excerpt force-push (text:fake)");
});

test("inject provenance keeps at most three terms and counts the rest", () => {
  const many = {
    ...hit("force-push"),
    matched_by: ["text:a", "text:b", "text:c", "text:d", "text:e"],
  };
  const text = formatHits([many], "inject");

  expect(text).toContain("(text:a, text:b, text:c …+2)");
  expect(text).not.toContain("text:d");
});

test("pack format names each hit with a location and a read-on-demand note", () => {
  const text = formatHits([hit("force-push")], "pack");

  expect(text).toContain("## wiki:force-push");
  expect(text).toContain("location: /fake/wiki/force-push");
  expect(text).toContain("read on demand");
});

test("json format is the raw hit list", () => {
  const hits = [hit("force-push")];
  expect(JSON.parse(formatHits(hits, "json"))).toEqual(hits);
});
