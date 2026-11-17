/** navi-r1y6: label loading and the recall/MRR/filter math, checked against a
 * tiny fixture whose answers are computable by hand. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { withTempDirAsync } from "../../test-support/tmp.ts";

import type { FilterDecision } from "#core/index.ts";

import {
  evaluate,
  defaultFixture,
  loadLabels,
  recallAt,
  reciprocalRank,
  scoreFilter,
} from "./eval.ts";

test("the default fixture resolves from the package root, not the cwd", () => {
  const file = defaultFixture();
  expect(file.endsWith(join("evals", "fixtures", "navi.json"))).toBe(true);
  expect(existsSync(file)).toBe(true);
});

test("loadLabels parses JSONL and fails loud with the line number", async () => {
  await withTempDirAsync("navi-labels-", async (dir) => {
    const file = join(dir, "labels.jsonl");
    writeFileSync(
      file,
      '{"query":"alpha","relevant":["docs:a.md"]}\n\n{"query":"beta","relevant":["docs:b.md"]}\n',
    );
    expect(loadLabels(file)).toEqual([
      { query: "alpha", relevant: ["docs:a.md"] },
      { query: "beta", relevant: ["docs:b.md"] },
    ]);

    writeFileSync(file, '{"query":"alpha","relevant":["docs:a.md"]}\n{"query":""}\n');
    expect(() => loadLabels(file)).toThrow(/line 2: labels\.query/);

    writeFileSync(file, '{"query":"alpha","relevant":[]}\n');
    expect(() => loadLabels(file)).toThrow(/line 1: labels\.relevant/);

    writeFileSync(file, "\n\n");
    expect(() => loadLabels(file)).toThrow(/no labels/);

    expect(() => loadLabels(join(dir, "missing.jsonl"))).toThrow(/file not found/);
  });
});

test("recallAt and reciprocalRank are plain hand-computed math", () => {
  const expected = ["docs:a", "docs:b"];

  // Both relevant docs within k → perfect recall; one of two at k=1 → half.
  expect(recallAt(expected, ["docs:b", "docs:c", "docs:a"], 3)).toBe(1);
  expect(recallAt(expected, ["docs:b", "docs:c", "docs:a"], 1)).toBe(0.5);
  expect(recallAt(expected, [], 5)).toBe(0);

  // First relevant at rank 2 → 1/2; only outside k → 0.
  expect(reciprocalRank(expected, ["docs:c", "docs:b"], 2)).toBe(0.5);
  expect(reciprocalRank(expected, ["docs:c", "docs:d", "docs:a"], 2)).toBe(0);
  expect(reciprocalRank(expected, ["docs:a"], 5)).toBe(1);
});

test("scoreFilter counts kept-relevant and dropped-irrelevant decisions", () => {
  const decision = (id: string, kept: boolean): FilterDecision => ({
    corpus: "docs",
    id,
    answer: kept,
    confidence: 0.9,
    kept,
  });
  const decisions = [
    decision("a.md", true), // relevant, kept → correct
    decision("b.md", false), // irrelevant, dropped → correct
    decision("c.md", false), // relevant, dropped → false negative
    decision("d.md", true), // irrelevant, kept → false positive
  ];

  expect(scoreFilter(decisions, new Set(["docs:a.md", "docs:c.md"]))).toEqual({
    decisions: 4,
    keptRelevant: 1,
    droppedIrrelevant: 1,
    droppedRelevant: 1,
    accuracy: 0.5,
  });
});

/** Two docs and three labels: two hits, one deliberate miss. */
async function withTinyFixture(body: (dir: string) => Promise<void>): Promise<void> {
  await withTempDirAsync("navi-eval-", async (dir) => {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "a.md"), "alpha beta gamma\n");
    writeFileSync(join(dir, "docs", "b.md"), "delta\n");
    writeFileSync(
      join(dir, "navi.json"),
      JSON.stringify({ corpuses: [{ id: "docs", type: "files", options: { path: "./docs" } }] }),
    );
    writeFileSync(
      join(dir, "labels.jsonl"),
      [
        '{"query":"alpha beta","relevant":["docs:a.md"]}',
        '{"query":"delta","relevant":["docs:b.md"]}',
        '{"query":"gamma","relevant":["docs:b.md"]}',
        "",
      ].join("\n"),
    );
    await body(dir);
  });
}

test("evaluate runs the pipeline and reports hand-computed recall@k and MRR", async () => {
  await withTinyFixture(async (dir) => {
    const fixture = join(dir, "navi.json");
    const report = JSON.parse(await evaluate({ fixture, k: 1, json: true })) as {
      queries: number;
      recallAtK: number;
      mrr: number;
      filter: unknown;
      misses: Array<{ query: string; expected: string[]; retrieved: string[] }>;
    };

    expect(report.queries).toBe(3);
    expect(report.recallAtK).toBeCloseTo(2 / 3);
    expect(report.mrr).toBeCloseTo(2 / 3);
    expect(report.filter).toBeNull();

    // The miss names what ranked instead: docs:a.md, not the expected docs:b.md.
    // a miss also carries the coverage behind it.
    expect(report.misses).toEqual([
      {
        query: "gamma",
        expected: ["docs:b.md"],
        retrieved: ["docs:a.md"],
        recall: 0,
        reciprocalRank: 0,
        coverage: { docs: { seen: 2, dropped: 0 } },
      },
    ]);

    const human = await evaluate({ fixture, k: 1 });
    expect(human).toContain("navi eval: 3 queries, k=1");
    expect(human).toContain("misses (1):");
    expect(human).toContain('"gamma" expected docs:b.md → got docs:a.md');
    expect(human).toContain("    docs (seen 2)");

    // --filter on demands a filter section; off/auto are the same here.
    await expect(evaluate({ fixture, filter: "on" })).rejects.toThrow(/no filter section/);
    await expect(evaluate({ fixture, filter: "off" })).resolves.toContain("filter:    off");
  });
});

test("the shipped fixture is self-contained and its labels point at real docs", async () => {
  const dir = fileURLToPath(new URL("../../../evals/fixtures/", import.meta.url));
  const labels = loadLabels(join(dir, "labels.jsonl"));
  expect(labels).toHaveLength(20);

  for (const label of labels) {
    expect(label.relevant.length).toBeGreaterThan(0);
    for (const id of label.relevant) {
      const [corpus, ...rest] = id.split(":");
      expect(corpus).toBe("docs");
      expect(rest.join(":")).toMatch(/\.md$/);
      // Missing files would make the label unmeasurable, not a miss.
      expect(existsSync(join(dir, "docs", rest.join(":")))).toBe(true);
    }
  }

  const report = JSON.parse(await evaluate({ fixture: join(dir, "navi.json"), json: true })) as {
    queries: number;
    recallAtK: number;
    mrr: number;
  };
  expect(report.queries).toBe(20);
  expect(report.recallAtK).toBeGreaterThan(0);
  expect(report.recallAtK).toBeLessThanOrEqual(1);
  expect(report.mrr).toBeGreaterThan(0);
});
