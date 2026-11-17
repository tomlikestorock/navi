/** Acceptance: a config + corpus module created fresh outside the
 * repo works end-to-end through the real `navi` CLI. The module imports only
 * `navi/core` (its type contract) and `zod` — no repo-relative paths — and the
 * package is linked into the temp dir the way an installed package would be.
 *
 * Runs Node directly (not Vitest's Vite pipeline) with the `development`
 * export condition, so the module resolves `navi/core` through package.json
 * `exports` and Node's own loader; the packed `dist/core.mjs` uses the same
 * map in production. */

import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { withTempDirAsync } from "../../test-support/tmp.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const NAVI_JSON = `{
  "corpuses": [
    {
      "id": "quotes",
      "type": "custom",
      "module": "./corpus/mod.ts",
      "options": { "path": "./corpus/quotes.json" }
    }
  ]
}
`;

const QUOTES_JSON = `[{ "id": "q1", "text": "never force-push to main", "author": "ops" }]
`;

const MODULE = `import { readFile } from "node:fs/promises";

import { z } from "zod";

import type {
  Corpus,
  CorpusConfig,
  CorpusContext,
  CorpusSearchOptions,
  CorpusSearchResult,
  Situation,
} from "navi/core";

const optionsSchema = z.strictObject({ path: z.string() });

export default class Quotes implements Corpus {
  static readonly optionsSchema = optionsSchema;

  readonly id: string;
  readonly #path: string;

  constructor(config: CorpusConfig, context: CorpusContext) {
    const { path } = optionsSchema.parse(config.options ?? {});
    this.id = config.id;
    this.#path = context.resolvePath(path);
  }

  async search(situation: Situation, _options?: CorpusSearchOptions): Promise<CorpusSearchResult> {
    const quotes = JSON.parse(await readFile(this.#path, "utf8")) as Array<{
      id: string;
      text: string;
      author: string;
    }>;
    const hits = quotes
      .filter((quote) => situation.text.includes("force-push"))
      .map((quote) => ({
        corpus: this.id,
        id: quote.id,
        title: quote.author,
        excerpt: quote.text,
        location: this.#path,
        score: 1,
        matched_by: ["text:force-push"],
      }));
    return { hits, coverage: { seen: quotes.length, dropped: 0 } };
  }
}
`;

test("a custom corpus module outside the repo loads via navi/core", async () => {
  await withTempDirAsync("navi-module-", async (dir) => {
    mkdirSync(join(dir, "corpus"));
    writeFileSync(join(dir, "navi.json"), NAVI_JSON);
    writeFileSync(join(dir, "corpus", "quotes.json"), QUOTES_JSON);
    writeFileSync(join(dir, "corpus", "mod.ts"), MODULE);

    // What `npm install navi zod` would put here, without touching the network.
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(repoRoot, join(dir, "node_modules", "navi"), "dir");
    symlinkSync(join(repoRoot, "node_modules", "zod"), join(dir, "node_modules", "zod"), "dir");

    const out = execFileSync(
      process.execPath,
      [
        "--conditions=development",
        join(repoRoot, "src", "cli", "main.ts"),
        "search",
        "force-push to main",
        "--config",
        join(dir, "navi.json"),
      ],
      { encoding: "utf8" },
    );

    expect(out).toContain("quotes:q1");
    expect(out).toContain("never force-push to main");
  });
});
