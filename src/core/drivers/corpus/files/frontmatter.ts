/** The `files` driver reads a leading `---` frontmatter block's
 * `surfacing:` map, YAML-lite like the canon's own frontmatter.
 *
 * Deliberately not a YAML parser: only the keys `HitSurfacingSchema` declares,
 * scalars, inline `[a, b]` lists and block `- item` lists. A malformed block
 * yields `undefined` — surfacing metadata is advisory, never a read error. */

import type { HitSurfacing } from "../../../config/schema.ts";
import { HitSurfacingSchema } from "../../../config/schema.ts";

const DELIMITER = "---";

/** The `surfacing` block's parsed value, or `undefined` when absent/invalid. */
export function parseSurfacingFrontmatter(text: string): HitSurfacing | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== DELIMITER) return undefined;

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trimEnd() === DELIMITER) {
      end = index;
      break;
    }
  }
  if (end === -1) return undefined;

  const block = lines.slice(1, end);
  let start = -1;
  for (let index = 0; index < block.length; index += 1) {
    const match = /^surfacing\s*:\s*(.*)$/.exec(block[index] ?? "");
    if (match === null) continue;
    // `surfacing: somethingElse` is not this block.
    if (match[1]?.trim() !== "") return undefined;
    start = index;
    break;
  }
  if (start === -1) return undefined;

  const body: string[] = [];
  for (const line of block.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    body.push(line);
  }

  const parsed = parseMap(body);
  if (parsed === undefined || Object.keys(parsed).length === 0) return undefined;
  const result = HitSurfacingSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Indented `key: value` lines, with `- item` continuations for block lists. */
function parseMap(lines: string[]): Record<string, unknown> | undefined {
  const map: Record<string, unknown> = {};
  let listKey: string | undefined;

  for (const line of lines) {
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (item !== null) {
      if (listKey === undefined) return undefined;
      (map[listKey] as unknown[]).push(scalar(item[1]));
      continue;
    }

    const pair = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair === null) return undefined;
    const [, key, raw] = pair;
    const value = raw.trim();

    if (value === "") {
      map[key] = [];
      listKey = key;
    } else if (value.startsWith("[")) {
      const inner = value.replace(/^\[/, "").replace(/\]$/, "");
      map[key] = inner.trim() === "" ? [] : inner.split(",").map((entry) => scalar(entry));
      listKey = undefined;
    } else {
      map[key] = scalar(value);
      listKey = undefined;
    }
  }
  return map;
}

/** Bare scalars: quoted strings unquoted, numbers narrowed, everything else
 * the literal text. */
function scalar(raw: string): string | number {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  return /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
}
