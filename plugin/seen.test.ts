import { expect, test } from "vite-plus/test";

import type { CorpusHit } from "#core/index.ts";

import { applyPolicy, EMPTY_SEEN } from "./policy.ts";
import { loadSeen, saveSeen, seenKey, type SeenStorage } from "./seen.ts";

/** In-memory stand-in for `ctx.storage`. */
function fakeStorage(): SeenStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value);
    },
  };
}

const HIT: CorpusHit = {
  corpus: "docs",
  id: "git/force-push",
  title: "Never force-push",
  excerpt: "Force-pushing rewrites history.",
  location: "docs/git/force-push.md",
  score: 1,
  matched_by: ["text:force"],
};

test("a session's log round-trips through plugin storage", async () => {
  const storage = fakeStorage();
  await saveSeen(storage, "ses_1", {
    turn: 4,
    entries: [{ key: "docs:a", turn: 3, shows: 2, turnShows: 1, last: 123 }],
  });

  expect(storage.data.has(seenKey("ses_1"))).toBe(true);
  expect(await loadSeen(storage, "ses_1")).toEqual({
    turn: 4,
    entries: [{ key: "docs:a", turn: 3, shows: 2, turnShows: 1, last: 123 }],
  });
});

test("sessions do not share logs and junk reads as empty", async () => {
  const storage = fakeStorage();
  await saveSeen(storage, "ses_1", { ...EMPTY_SEEN, turn: 2 });
  expect(await loadSeen(storage, "ses_2")).toEqual(EMPTY_SEEN);

  await storage.set(seenKey("ses_3"), { turn: "nope", entries: [] });
  expect(await loadSeen(storage, "ses_3")).toEqual(EMPTY_SEEN);
  await storage.set(seenKey("ses_4"), { turn: 1, entries: [{ key: 1 }] });
  expect(await loadSeen(storage, "ses_4")).toEqual({ turn: 1, entries: [] });
});

test("repetition state persists across turns through the stored log", async () => {
  const storage = fakeStorage();
  const config = { repetition: { perTurn: 1, perSession: 1 } };

  const first = applyPolicy([HIT], {
    config,
    seen: await loadSeen(storage, "ses_1"),
    turn: 1,
  });
  await saveSeen(storage, "ses_1", first.seen);
  expect(first.hits).toHaveLength(1);

  const stored = await loadSeen(storage, "ses_1");
  const second = applyPolicy([HIT], { config, seen: stored, turn: stored.turn + 1 });
  expect(second.hits).toEqual([]);
});
