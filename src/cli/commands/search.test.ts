import { writeFileSync } from "node:fs";

import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { withTempDir } from "../../test-support/tmp.ts";

import { ConfigError, emptySituation } from "#core/index.ts";
import type { Situation } from "#core/index.ts";

import { GOLDEN_QUERY, withGoldenPipeline } from "./golden.fixture.ts";
import { loadSituation, search } from "./search.ts";

/** Write `value` as a situation fixture and run `body` against its path. */
function fixture(value: unknown, body: (file: string) => void): void {
  withTempDir("navi-situation-", (dir) => {
    const file = join(dir, "situation.json");
    writeFileSync(file, JSON.stringify(value));
    body(file);
  });
}

function captureError(body: () => void): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  throw new Error("expected the fixture to be rejected");
}

test("missing hints get the schema defaults", () => {
  fixture({ text: "force-push to main" }, (file) => {
    expect(loadSituation(file)).toEqual(emptySituation("force-push to main"));
  });
});

test("a valid fixture passes through unchanged", () => {
  const situation: Situation = {
    ...emptySituation("force-push to main"),
    kinds: ["tool_call"],
    arenas: ["git"],
    patterns: ["force-push"],
    paths: ["src/a.ts"],
    tools: ["bash"],
    intent: "push",
    confidence: 0.8,
    detectors: ["regex", "path", "tool"],
  };
  fixture(situation, (file) => {
    expect(loadSituation(file)).toEqual(situation);
  });
});

test("an invalid kind is rejected with a file/field diagnostic", () => {
  fixture({ text: "x", kinds: ["nonsense"] }, (file) => {
    const error = captureError(() => loadSituation(file));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(`${file}: situation.kinds[0]:`);
  });
});

test("the golden pipeline fuses one files and one web corpus into an exact ranking", async () => {
  await withGoldenPipeline(async ({ configFile, docsDir, base }) => {
    const hits = JSON.parse(await search(GOLDEN_QUERY, { configFile, json: true })) as unknown[];

    // Equal RRF first places tie-break on `corpus:id`; the decoy page stays out.
    expect(hits).toEqual([
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
        corpus: "web",
        id: `${base}/a`,
        title: "Git Notes",
        excerpt: "Git Notes Force push rewrites history.",
        location: `${base}/a`,
        score: 1,
        matched_by: ["text:git", "text:push", "text:force"],
      },
      {
        corpus: "files",
        id: "force-push.md",
        title: "force-push.md",
        excerpt: "Never force-push to a shared main branch.",
        location: join(docsDir, "force-push.md"),
        score: 1 / 62 / (1 / 61),
        matched_by: ["text:push", "text:force"],
      },
    ]);
  });
});
