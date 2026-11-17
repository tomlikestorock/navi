import { expect, test } from "vite-plus/test";

import { createAnalyzer, emptySituation } from "../../situation/analyzer.ts";
import { DetectorRegistry } from "../../situation/registry.ts";
import type { SituationDetector } from "../../situation/types.ts";
import { createBuiltinAnalyzer } from "../index.ts";
import { CommandDetector } from "./command.ts";
import { LexiconDetector } from "./lexicon.ts";
import { PathDetector } from "./path.ts";
import { ToolDetector } from "./tool.ts";

const input = { text: "", kind: "tool_call" as const };

/** The four built-ins as default instances, one per registered type. */
const lexicon: SituationDetector = new LexiconDetector();
const command: SituationDetector = new CommandDetector();
const path: SituationDetector = new PathDetector();
const tool: SituationDetector = new ToolDetector();

test("lexicon fills arenas and patterns with a confidence contribution", async () => {
  const text = "Please force-push to main, then DROP TABLE users; rm -rf build";
  const contribution = await lexicon.detect({ ...input, text }, emptySituation(text));

  expect(contribution?.patterns).toEqual(["force-push", "drop table", "rm -rf"]);
  expect(contribution?.arenas).toEqual(["git", "data", "filesystem"]);
  expect(contribution?.confidence).toBe(0.6);
});

test("lexicon matches case-insensitively and longer terms subsume shorter ones", async () => {
  const text = "Rewrite History on the shared branch";
  const contribution = await lexicon.detect({ ...input, text }, emptySituation(text));

  // "rewrite history" covers its own substring; "branch" is extra signal.
  expect(contribution?.patterns).toEqual(["rewrite history", "branch"]);
  expect(contribution?.arenas).toEqual(["git"]);
  expect(contribution?.confidence).toBe(0.7);
});

test("lexicon scores multiple arenas in one contribution", async () => {
  const text = "rotate the prod deploy token";
  const contribution = await lexicon.detect({ ...input, text }, emptySituation(text));

  expect(contribution?.arenas).toEqual(["security", "deploy"]);
  expect(contribution?.patterns).toEqual(["deploy token", "prod deploy"]);
  expect(contribution?.confidence).toBe(0.6);
});

test("lexicon ignores arenas that stay below the threshold", async () => {
  const weak = "update the index and the pipeline";
  await expect(lexicon.detect({ ...input, text: weak }, emptySituation(weak))).resolves.toBeNull();

  const noMatch = "add a unit test";
  await expect(
    lexicon.detect({ ...input, text: noMatch }, emptySituation(noMatch)),
  ).resolves.toBeNull();
});

test("lexicon matches single words on word boundaries, not substrings", async () => {
  const text = "tune the mysql database";
  const contribution = await lexicon.detect({ ...input, text }, emptySituation(text));

  // "sql" inside "mysql" is not a hit; "database" alone stays below threshold.
  expect(contribution).toBeNull();
});

test("lexicon patterns dedupe against another detector in the analyzer fold", async () => {
  class RegexFamily implements SituationDetector {
    readonly type = "regex" as const;

    async detect() {
      return { arenas: ["git"], patterns: ["force-push"], confidence: 0.6 };
    }
  }

  const registry = new DetectorRegistry();
  registry.register("lexicon", LexiconDetector);
  registry.register("regex", RegexFamily);

  const situation = await createAnalyzer(
    {
      corpuses: [],
      analyzer: {
        detectors: [
          { id: "lexicon", type: "lexicon" },
          { id: "regex", type: "regex" },
        ],
      },
    },
    registry,
  ).analyze({
    text: "force-push to main",
    kind: "user_prompt",
  });

  expect(situation.arenas).toEqual(["git"]);
  expect(situation.patterns).toEqual(["force-push"]);
  expect(situation.confidence).toBe(0.6);
  expect(situation.detectors).toEqual(["lexicon", "regex"]);
});

test("the built-in analyzer defaults to every registered type in registration order", async () => {
  const situation = await createBuiltinAnalyzer().analyze({
    text: "git push --force origin main",
    kind: "tool_call",
    paths: ["src/a.ts"],
    tool: "bash",
  });

  expect(situation.detectors).toEqual(["lexicon", "command", "path", "tool"]);
});

test("command detector names git invocations, tools, and flags", async () => {
  const text = "git push --force origin main";
  const contribution = await command.detect({ ...input, text }, emptySituation(text));

  expect(contribution?.tools).toEqual(["git"]);
  // The flag belongs to the invocation; "origin main" is not a pattern.
  expect(contribution?.patterns).toEqual(["push", "--force"]);
  expect(contribution?.confidence).toBe(0.6);
});

test("command detector reads bare git verbs and package runners", async () => {
  const rebase = "please rebase onto main";
  expect(
    (await command.detect({ ...input, text: rebase }, emptySituation(rebase)))?.patterns,
  ).toEqual(["rebase"]);

  const npmText = "then run npm install";
  const npm = await command.detect({ ...input, text: npmText }, emptySituation(npmText));
  expect(npm?.tools).toEqual(["npm"]);
  expect(npm?.patterns).toEqual(["install"]);
});

test("command detector reads SQL verbs as one uppercase pattern", async () => {
  const text = "DROP TABLE users";
  const contribution = await command.detect({ ...input, text }, emptySituation(text));

  expect(contribution).toEqual({ tools: [], patterns: ["DROP TABLE"], paths: [], confidence: 0.6 });
});

test("command detector extracts paths, URLs, versions, hashes, and secrets", async () => {
  const text =
    "see src/a.ts, /etc/hosts and https://example.com/v1.2.3 — bumped to 2.0.0 in abc1234, token=hunter2";
  const contribution = await command.detect({ ...input, text }, emptySituation(text));

  expect(contribution?.paths).toEqual(["src/a.ts", "/etc/hosts"]);
  // The URL's version segment is not double-counted; secret values are redacted.
  expect(contribution?.patterns).toEqual([
    "https://example.com/v1.2.3",
    "2.0.0",
    "abc1234",
    "token=",
  ]);
  expect(contribution?.tools).toEqual([]);
  expect(contribution?.confidence).toBe(0.5);
});

test("command detector returns null when there is nothing to extract", async () => {
  const text = "add a unit test for the parser";
  await expect(command.detect({ ...input, text }, emptySituation(text))).resolves.toBeNull();
});

test("path detector copies and deduplicates paths", async () => {
  const paths = ["src/a.ts", "src/a.ts", "src/b.ts"];
  const contribution = await path.detect({ ...input, paths }, emptySituation("x"));

  expect(contribution).toEqual({ paths: ["src/a.ts", "src/b.ts"], confidence: 0.5 });
  await expect(path.detect(input, emptySituation("x"))).resolves.toBeNull();
});

test("tool detector copies the tool name", async () => {
  const contribution = await tool.detect({ ...input, tool: "bash" }, emptySituation("x"));

  expect(contribution).toEqual({ tools: ["bash"], confidence: 0.5 });
  await expect(tool.detect(input, emptySituation("x"))).resolves.toBeNull();
});
