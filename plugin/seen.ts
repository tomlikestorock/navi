/** The seen-log lives in plugin storage under the session id, so
 * repetition state survives turns (and process restarts) with no core state.
 *
 * One JSON entry per session: `{ turn, entries }` with one entry per
 * `corpus:id`. Anything unreadable is treated as an empty log — surfacing is
 * advisory, and a stale key must not break a prompt. */

import type { SeenEntry, SeenState } from "./policy.ts";
import { EMPTY_SEEN } from "./policy.ts";

/** The two storage members this module needs; `ctx.storage` satisfies them. */
export interface SeenStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function seenKey(sessionID: string): string {
  return `navi/surfacing/${sessionID}`;
}

export async function loadSeen(storage: SeenStorage, sessionID: string): Promise<SeenState> {
  const raw = await storage.get(seenKey(sessionID));
  if (raw === null || typeof raw !== "object") return EMPTY_SEEN;

  const { turn, entries } = raw as { turn?: unknown; entries?: unknown };
  if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) return EMPTY_SEEN;
  if (!Array.isArray(entries)) return EMPTY_SEEN;
  return { turn, entries: entries.filter(isEntry) };
}

export async function saveSeen(
  storage: SeenStorage,
  sessionID: string,
  state: SeenState,
): Promise<void> {
  await storage.set(seenKey(sessionID), state);
}

function isEntry(value: unknown): value is SeenEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<SeenEntry>;
  return (
    typeof entry.key === "string" &&
    typeof entry.turn === "number" &&
    typeof entry.shows === "number" &&
    typeof entry.turnShows === "number" &&
    typeof entry.last === "number"
  );
}
