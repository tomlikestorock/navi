import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { withTempDirAsync } from "../../../../test-support/tmp.ts";

import type {
  Corpus,
  CorpusHit,
  EmbeddingProvider,
  ResolvedCorpusConfig,
  ResolvedNaviConfig,
} from "#core/index.ts";
import { emptySituation, FakeEmbeddingProvider, createSearchEngine } from "#core/index.ts";
import { createEmbeddingResolver, Registry } from "#core/corpus/registry.ts";
import { registerBuiltinCorpuses } from "#core/drivers/index.ts";

const PAGE_A = `<!doctype html>
<html><head><title>Git Notes</title><style>.x{}</style></head>
<body><h1>Git</h1><p>Force push rewrites history.</p>
<script>var leak = "force push";</script>
<p>Never force-push to main.</p></body></html>`;

const PAGE_B = `<html><body><p>Branch protection blocks direct commits.</p></body></html>`;

const situation = emptySituation;

/** Serve `routes` (path → html, or "slow" to never respond) on a throwaway
 * port and count requests per path. */
async function withServer(
  routes: Record<string, string>,
  body: (base: string, requests: Record<string, number>) => Promise<void>,
): Promise<void> {
  const requests: Record<string, number> = {};
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests[path] = (requests[path] ?? 0) + 1;
    const html = routes[path];
    if (html === undefined) {
      response.writeHead(404).end("missing");
    } else if (html === "slow") {
      // Leave the request hanging so only the client abort ends it.
    } else {
      response.writeHead(200, { "content-type": "text/html" }).end(html);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await body(base, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A port with nothing listening: bind, capture, close. */
async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/gone`;
}

async function load(urls: string[], options: Record<string, unknown> = {}): Promise<Corpus> {
  const registry = new Registry();
  registerBuiltinCorpuses(registry);
  return registry.load({
    id: "docs",
    type: "web",
    options: { urls, ...options },
    baseDir: "/repo",
  });
}

/** Load `docs` wired to `provider`; both caches go under the standard
 * location, redirected per test by the hooks below. */
async function loadEmbedded(
  urls: string[],
  provider: EmbeddingProvider,
  options: Record<string, unknown> = {},
  model = "fake-model",
): Promise<Corpus> {
  const registry = new Registry();
  registerBuiltinCorpuses(registry);
  const config: ResolvedNaviConfig = {
    corpuses: [
      { id: "docs", type: "web", embed: "fake", options: { urls, ...options }, baseDir: "/repo" },
    ],
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
  cacheHome = mkdtempSync(join(tmpdir(), "navi-web-cache-"));
  // The standard cache location, redirected so tests neither read nor write
  // the developer's real page cache.
  vi.stubEnv("XDG_CACHE_HOME", cacheHome);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(cacheHome, { recursive: true, force: true });
});

test("fetches pages, strips markup and finds matching content", async () => {
  await withServer({ "/a": PAGE_A, "/b": PAGE_B }, async (base) => {
    const corpus = await load([`${base}/a`, `${base}/b`]);
    const hits = await searchHits(corpus, "force push");

    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      corpus: "docs",
      id: `${base}/a`,
      title: "Git Notes",
      excerpt: "Force push rewrites history.",
      location: `${base}/a`,
      score: 1,
      matched_by: ["text:force", "text:push"],
    });
    // Script contents are not visible text.
    expect(hits[0].excerpt).not.toContain("leak");
  });
});

test("the second search reuses the cache and never re-fetches", async () => {
  await withServer({ "/a": PAGE_A, "/b": PAGE_B }, async (base, requests) => {
    const urls = [`${base}/a`, `${base}/b`];

    const first = await searchHits(await load(urls), "force push");
    expect(first).toHaveLength(1);
    expect(requests).toEqual({ "/a": 1, "/b": 1 });

    const second = await searchHits(await load(urls), "force push");
    expect(second).toEqual(first);
    expect(requests).toEqual({ "/a": 1, "/b": 1 });
  });
});

test("reports pages dropped by maxPages and the vector coverage", async () => {
  await withServer({ "/a": PAGE_A, "/b": PAGE_B }, async (base, requests) => {
    const corpus = await loadEmbedded([`${base}/a`, `${base}/b`], new FakeEmbeddingProvider(), {
      maxPages: 1,
    });
    const { hits, coverage } = await corpus.search(situation("force push"));

    // Only the first page was fetched and embedded; the second is reported.
    expect(requests).toEqual({ "/a": 1 });
    expect(coverage).toEqual({ seen: 1, dropped: 1, vector_hits: 1, cold_count: 0 });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('corpus "docs": maxPages 1 dropped 1 urls'),
    );
    expect(hits[0].id).toBe(`${base}/a`);
  });
});

test("a slow endpoint times out and degrades while other URLs still return", async () => {
  await withServer({ "/slow": "slow", "/a": PAGE_A }, async (base) => {
    const corpus = await load([`${base}/slow`, `${base}/a`], { timeoutMs: 100 });
    const hits = await searchHits(corpus, "force push");

    expect(hits.map((hit) => hit.id)).toEqual([`${base}/a`]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${base}/slow`));
  });
});

test("an unreachable URL degrades to no hits, alone or beside a live URL", async () => {
  const gone = await deadUrl();
  await withServer({ "/a": PAGE_A }, async (base) => {
    const alone = await searchHits(await load([gone]), "force push");
    expect(alone).toEqual([]);

    const hits = await searchHits(await load([gone, `${base}/a`]), "force push");
    expect(hits.map((hit) => hit.id)).toEqual([`${base}/a`]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(gone));
  });
});

test("a mixed files + web config fuses both corpora", async () => {
  await withTempDirAsync("navi-web-files-", async (dir) => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "git.md"), "force push rewrites history\n");

    await withServer({ "/a": PAGE_A }, async (base) => {
      const registry = new Registry();
      registerBuiltinCorpuses(registry);
      const corpuses: ResolvedCorpusConfig[] = [
        { id: "notes", type: "files", options: { path: join(dir, "docs") }, baseDir: dir },
        { id: "web", type: "web", options: { urls: [`${base}/a`] }, baseDir: dir },
      ];
      const engine = await createSearchEngine({ corpuses }, registry);
      const hits = await engine.search(situation("force push"));

      expect(new Set(hits.map((hit) => hit.corpus))).toEqual(new Set(["notes", "web"]));
    });
  });
});

test("embed-on-read embeds fetched pages once, then only the query", async () => {
  await withServer({ "/a": PAGE_A, "/b": PAGE_B }, async (base, requests) => {
    const urls = [`${base}/a`, `${base}/b`];
    const provider = new FakeEmbeddingProvider();

    const first = await searchHits(await loadEmbedded(urls, provider), "force push");
    // Query first, then one array with both freshly fetched page texts.
    expect(provider.calls[0]).toEqual(["force push"]);
    expect(provider.calls[1]).toHaveLength(2);
    expect(provider.calls.flat().some((text) => text.includes("Force push"))).toBe(true);
    expect(first[0].matched_by.some((entry) => entry.startsWith("vector:"))).toBe(true);

    // A fresh corpus over the same caches: everything is warm, so no page is
    // re-embedded and no page is re-fetched.
    const second = await searchHits(await loadEmbedded(urls, provider), "force push");
    expect(second.map((hit) => hit.id)).toEqual(first.map((hit) => hit.id));
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls.at(-1)).toEqual(["force push"]);
    expect(requests).toEqual({ "/a": 1, "/b": 1 });
  });
});

test("fuses lexical and cosine, surfacing a vector-only page", async () => {
  const lexical = `<html><body><p>undo release steps</p></body></html>`;
  const paraphrase = `<html><body><p>rollback procedures</p></body></html>`;
  await withServer({ "/lexical": lexical, "/paraphrase": paraphrase }, async (base) => {
    // The paraphrase page shares no query term, so only fusion can surface it.
    const vectors: Record<string, number[]> = {
      "undo release": [1, 0],
      "undo release steps": [0.8, 0.2],
      "rollback procedures": [1, 0],
    };
    const provider: EmbeddingProvider = {
      embed: async (texts) => texts.map((text) => vectors[text] ?? [0, 0]),
    };

    const hits = await searchHits(
      await loadEmbedded([`${base}/lexical`, `${base}/paraphrase`], provider),
      "undo release",
    );

    expect(hits.map((hit) => hit.id)).toEqual([`${base}/lexical`, `${base}/paraphrase`]);
    expect(hits[0].matched_by).toEqual(["text:undo", "text:release", "vector:0.970"]);
    expect(hits[1].matched_by).toEqual(["vector:1.000"]);
    expect(hits[1].excerpt).toBe("rollback procedures");
  });
});

test("a failed fetch still degrades cleanly when embedded", async () => {
  const gone = await deadUrl();
  await withServer({ "/a": PAGE_A }, async (base) => {
    const provider = new FakeEmbeddingProvider();
    const hits = await searchHits(await loadEmbedded([gone, `${base}/a`], provider), "force push");

    expect(hits.map((hit) => hit.id)).toEqual([`${base}/a`]);
    // Only the page that was fetched got a vector.
    expect(provider.calls[1]).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(gone));
  });
});

test("an embedding provider failure degrades to the lexical hits", async () => {
  await withServer({ "/a": PAGE_A }, async (base) => {
    const failing: EmbeddingProvider = {
      embed: async () => {
        throw new Error("provider offline");
      },
    };
    const hits = await searchHits(await loadEmbedded([`${base}/a`], failing), "force push");

    expect(hits.map((hit) => hit.id)).toEqual([`${base}/a`]);
    expect(hits[0].matched_by).toEqual(["text:force", "text:push"]);
  });
});

/** A corpus's read capability, failing loudly when it has none. */
function reader(corpus: Corpus): (id: string) => Promise<{ content: string; location: string }> {
  const read = corpus.read?.bind(corpus);
  if (read === undefined) throw new Error("corpus has no read()");
  return read;
}

test("read returns the extracted text of a fetched, configured page", async () => {
  await withServer({ "/a": PAGE_A, "/b": PAGE_B }, async (base) => {
    const corpus = await load([`${base}/a`, `${base}/b`]);
    const read = reader(corpus);

    // The page cache is the read source, so an unfetched page is loud.
    await expect(read(`${base}/a`)).rejects.toThrow("has not fetched");

    await searchHits(corpus, "force push");
    const page = await read(`${base}/a`);
    expect(page.location).toBe(`${base}/a`);
    expect(page.content).toContain("Never force-push to main.");
    expect(page.content).not.toContain("<p>");

    // An unconfigured url is not part of this corpus, even if cached.
    await expect(read(`${base}/unknown`)).rejects.toThrow("has no page");
  });
});
