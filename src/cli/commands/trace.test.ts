/** navi-0vye: golden end-to-end fixtures for the trace view.
 *
 * The trace command is the pipeline's window: per-instance detector
 * contributions, per-corpus raw hits, and the fused ranking with its RRF
 * math. These fixtures pin every stage of that window so a detector, corpus or
 * engine swap cannot silently change the contract. */

import { mkdirSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { withTempDirAsync } from "../../test-support/tmp.ts";

import { emptySituation, TestFakeGateway } from "#core/index.ts";
import type { DetailedAnalysis, FederatedSearch } from "#core/index.ts";

import { GOLDEN_QUERY, withGoldenPipeline } from "./golden.fixture.ts";
import { trace } from "./trace.ts";

/** Run `body` against a throwaway config file holding `config`. */
async function withConfig(config: unknown, body: (file: string) => Promise<void>): Promise<void> {
  await withTempDirAsync("navi-trace-", async (dir) => {
    const file = join(dir, "navi.json");
    writeFileSync(file, JSON.stringify(config));
    await body(file);
  });
}

interface TraceShape {
  situation: DetailedAnalysis["situation"];
  contributions: DetailedAnalysis["contributions"];
  corpuses: FederatedSearch["rankings"];
  fused: Array<{
    corpus: string;
    id: string;
    rrf: number;
    score: number;
    contributions: Array<{ corpus: string; rank: number; value: number }>;
  }>;
  filter: FederatedSearch["filter"];
}

async function traceJson(configFile: string): Promise<TraceShape> {
  return JSON.parse(await trace(GOLDEN_QUERY, { configFile, json: true })) as TraceShape;
}

test("the golden query pins the Situation, the raw per-corpus hits and the fusion", async () => {
  await withGoldenPipeline(async ({ configFile, docsDir, base }) => {
    const traced = await traceJson(configFile);

    // 1. The folded Situation, detectors as configured instance ids.
    expect(traced.situation).toEqual({
      ...emptySituation("git push --force"),
      kinds: ["user_prompt"],
      arenas: ["git"],
      patterns: ["--force", "push", "git"],
      tools: ["git"],
      confidence: 0.9,
      detectors: ["lexicon", "command"],
    });

    // 2. Each detector's pre-fold claim, in fold order.
    expect(traced.contributions).toEqual([
      {
        detector: "lexicon",
        type: "lexicon",
        contribution: {
          arenas: ["git"],
          patterns: ["--force", "push", "git"],
          confidence: 0.9,
        },
      },
      {
        detector: "command",
        type: "command",
        contribution: {
          tools: ["git"],
          patterns: ["push", "--force"],
          paths: [],
          confidence: 0.6,
        },
      },
      { detector: "path", type: "path", contribution: null },
      { detector: "tool", type: "tool", contribution: null },
      // The model seat is registered last and defaults to
      // `when: "never"`, so the default pipeline stays deterministic.
      { detector: "model", type: "model", contribution: null },
    ]);

    // 3. Per-corpus rankings, before fusion; the decoy page never surfaces.
    // coverage rides each ranking (both scans are complete).
    expect(traced.corpuses).toEqual([
      {
        corpus: "files",
        coverage: { seen: 2, dropped: 0 },
        hits: [
          {
            corpus: "files",
            id: "git.md",
            title: "git.md",
            excerpt: "git push origin main",
            location: join(docsDir, "git.md"),
            score: 1,
            matched_by: ["text:git", "text:push"],
          },
          {
            corpus: "files",
            id: "force-push.md",
            title: "force-push.md",
            excerpt: "Never force-push to a shared main branch.",
            location: join(docsDir, "force-push.md"),
            score: 0.5,
            matched_by: ["text:push", "text:force"],
          },
        ],
      },
      {
        corpus: "web",
        coverage: { seen: 2, dropped: 0 },
        hits: [
          {
            corpus: "web",
            id: `${base}/a`,
            title: "Git Notes",
            excerpt: "Git Notes Force push rewrites history.",
            location: `${base}/a`,
            score: 1,
            matched_by: ["text:git", "text:push", "text:force"],
          },
        ],
      },
    ]);

    // 4. Fusion: the equal files/web first places tie-break on corpus:id.
    const first = 1 / 61;
    expect(traced.fused).toEqual([
      {
        corpus: "files",
        id: "git.md",
        rrf: first,
        score: 1,
        contributions: [{ corpus: "files", rank: 1, value: first }],
      },
      {
        corpus: "web",
        id: `${base}/a`,
        rrf: first,
        score: 1,
        contributions: [{ corpus: "web", rank: 1, value: first }],
      },
      {
        corpus: "files",
        id: "force-push.md",
        rrf: 1 / 62,
        score: 1 / 62 / first,
        contributions: [{ corpus: "files", rank: 2, value: 1 / 62 }],
      },
    ]);
  });
});

test("the human view shows all three sections, including silence and the RRF terms", async () => {
  await withGoldenPipeline(async ({ configFile, base }) => {
    const text = await trace(GOLDEN_QUERY, { configFile });

    expect(text).toContain("contributions (before the fold)");
    expect(text).toContain("  lexicon (lexicon):\n    arenas: git");
    expect(text).toContain("  command (command):\n    patterns: push, --force");
    expect(text).toContain("  path (path): no contribution");

    expect(text).toContain("corpuses (before fusion)");
    expect(text).toContain(
      "  files (seen 2)\n    git.md  score 1.000  matched_by: text:git, text:push",
    );
    expect(text).toContain(
      `    ${base}/a  score 1.000  matched_by: text:git, text:push, text:force`,
    );

    expect(text).toContain("fused (RRF k=60)");
    expect(text).toContain("1. files:git.md  rrf 0.016393 (files #1 1/61)  score 1.000");
    expect(text).toContain("3. files:force-push.md  rrf 0.016129 (files #2 1/62)  score 0.984");

    // Absent filter section = off, stated explicitly.
    expect(text).toContain("\nfilter disabled\n");
  });
});

test("a corpus that fails mid-search is shown as failed instead of aborting the trace", async () => {
  await withGoldenPipeline(async ({ configFile }) => {
    // Make the web driver's cache write fail at search time (a file where a
    // directory belongs): the corpus throws, and only it degrades.
    const cache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = configFile;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const text = await trace(GOLDEN_QUERY, { configFile });

      expect(text).toContain("  web: failed (");
      expect(text).toContain("1. files:git.md");
      expect(text).toContain("  files (seen 2)\n    git.md  score 1.000");
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('corpus "web" search failed'));
    } finally {
      logged.mockRestore();
      if (cache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = cache;
    }
  });
});

test("the views report a truncating cap instead of hiding it", async () => {
  await withConfig(
    { corpuses: [{ id: "docs", type: "files", options: { path: "./docs", maxFiles: 1 } }] },
    async (file) => {
      const docs = join(dirname(file), "docs");
      mkdirSync(docs);
      writeFileSync(join(docs, "a.md"), "widget here\n");
      writeFileSync(join(docs, "b.md"), "widget too\n");

      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const text = await trace("widget", { configFile: file });
        expect(text).toContain("  docs (seen 1, dropped 1 by cap)");
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining('corpus "docs": maxFiles 1 dropped 1 files'),
        );

        const traced = await traceJson(file);
        expect(traced.corpuses[0].coverage).toEqual({ seen: 1, dropped: 1 });
      } finally {
        logged.mockRestore();
      }
    },
  );
});

test("contributions are keyed by config instance id, not detector type", async () => {
  await withConfig(
    {
      corpuses: [],
      analyzer: {
        detectors: [
          { id: "git-words", type: "lexicon" },
          { id: "commands", type: "command" },
        ],
      },
    },
    async (file) => {
      const traced = await traceJson(file);

      expect(traced.situation.detectors).toEqual(["git-words", "commands"]);
      expect(traced.contributions.map((entry) => entry.detector)).toEqual([
        "git-words",
        "commands",
      ]);
      expect(traced.contributions.map((entry) => entry.type)).toEqual(["lexicon", "command"]);
    },
  );
});

test("the filter section shows kept/dropped per hit with answer and confidence", async () => {
  await withConfig(
    {
      corpuses: [{ id: "docs", type: "files", options: { path: "./docs", extensions: [".md"] } }],
      models: [
        {
          id: "judge",
          model: "jev/tev1",
          runner: { type: "systemone", baseUrl: "http://127.0.0.1:1" },
        },
      ],
      filter: { provider: "judge" },
    },
    async (file) => {
      const docs = join(dirname(file), "docs");
      mkdirSync(docs);
      writeFileSync(join(docs, "git.md"), "git push origin main\n");
      writeFileSync(join(docs, "force-push.md"), "Never force-push to a shared main branch.\n");

      // The fake judge drops the near-miss (force-push.md) and keeps git.md.
      const gateway = new TestFakeGateway((questions) =>
        questions.map((question) => ({
          id: question.id,
          answer: !question.id.endsWith("force-push.md"),
          confidence: 0.9,
        })),
      );

      const text = await trace(GOLDEN_QUERY, { configFile: file, createGateway: () => gateway });
      expect(text).toContain("filter (topK 8)");
      expect(text).toContain("docs:git.md  kept (yes, 0.90)");
      expect(text).toContain("docs:force-push.md  dropped (no, 0.90)");

      const traced = JSON.parse(
        await trace(GOLDEN_QUERY, {
          configFile: file,
          json: true,
          createGateway: () => gateway,
        }),
      ) as TraceShape;
      expect(traced.filter).toEqual({
        enabled: true,
        topK: 8,
        decisions: [
          { corpus: "docs", id: "git.md", answer: true, confidence: 0.9, kept: true },
          { corpus: "docs", id: "force-push.md", answer: false, confidence: 0.9, kept: false },
        ],
      });
    },
  );
});
