/** Local caches — append-only JSONL under the standard cache
 * dir.
 *
 * `XDG_CACHE_HOME` is honored so tests and non-default homes stay out of
 * `~/.cache`. An empty value counts as unset: it must never resolve to a
 * cwd-relative path that scatters cache files through the user's project.
 * Corpus ids are user config, not paths, so they are sanitized. */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The one cache-location policy: `<base>/navi/<kind>/<corpus-id>/<leaf>`. */
export function naviCachePath(kind: string, corpusId: string, leaf: string): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".cache");
  const safe = corpusId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(base, "navi", kind, safe, leaf);
}

/** Read an append-only JSONL file, or nothing when there is none yet. Blank
 * lines and torn lines from a crashed write are skipped; the rest of the
 * cache stays usable. `isValid` is the caller's record shape, so one bad or
 * stale line degrades its own entry, never the whole cache. */
export function readJsonl<T>(file: string, isValid: (entry: unknown) => entry is T): T[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return []; // no cache yet
  }

  const entries: T[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isValid(entry)) entries.push(entry);
    } catch {
      continue; // torn line from a crashed write: skip it, keep the rest
    }
  }
  return entries;
}

/** Append records as JSONL, creating the parent directory. Write-through: a
 * crashed search loses only its own batch. */
export function appendJsonl(file: string, entries: unknown[]): void {
  if (entries.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}
