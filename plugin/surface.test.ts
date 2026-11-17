import { expect, test } from "vite-plus/test";

import type { CorpusHit } from "#core/index.ts";

import { SURFACE_KEY, surfaceEntry } from "./surface.ts";

const HIT: CorpusHit = {
  corpus: "docs",
  id: "git/force-push",
  title: "Never force-push a shared branch",
  excerpt: "Force-pushing rewrites history other people already pulled.",
  location: "docs/git/force-push.md",
  score: 0.8,
  matched_by: ["pattern:force-push"],
};

test("a hit becomes one advisory entry under the session key", () => {
  const entry = surfaceEntry([HIT]);
  expect(entry).not.toBeNull();
  expect(entry?.key).toBe(SURFACE_KEY);
  expect(entry?.value).toContain("Advisory concerns matched by the current work");
  expect(entry?.value).toContain("docs:git/force-push");
});

test("no hits evicts the entry", () => {
  expect(surfaceEntry([])).toBeNull();
});
