import { expect, test } from "vite-plus/test";
import * as core from "#core/index.ts";

const { emptySituation } = core;
import type { Corpus, CorpusConfig, CorpusHit, NaviConfig, Situation } from "#core/index.ts";

const situation: Situation = {
  ...emptySituation("force-push to main"),
  kinds: ["user_prompt"],
  patterns: ["force-push"],
  confidence: 0.5,
  detectors: ["regex"],
};

const config: CorpusConfig = {
  id: "wiki",
  type: "files",
  options: { path: "~/wiki" },
};

const hit: CorpusHit = {
  corpus: config.id,
  id: "force-push",
  title: "Force pushing",
  excerpt: "…",
  location: "concerns/git/force-push.md",
  score: 0.9,
  matched_by: ["pattern:force-push"],
};

test("core types are reachable through the #core alias", () => {
  expect(core).toBeDefined();

  const naviConfig: NaviConfig = { corpuses: [config] };
  expect(naviConfig.corpuses[0].id).toBe("wiki");

  // The corpus seam takes the Situation directly — no query wrapper.
  const corpus: Corpus = {
    id: config.id,
    search: async (s, options) => ({
      hits: s.patterns.length > 0 && (options?.limit ?? 1) > 0 ? [hit] : [],
      coverage: { seen: 1, dropped: 0 },
    }),
  };

  return corpus
    .search(situation, { limit: 1 })
    .then(({ hits }) => expect(hits[0].matched_by).toEqual(["pattern:force-push"]));
});
