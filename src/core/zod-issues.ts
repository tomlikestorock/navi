/** One inline rendering of zod issues, shared by every fail-loud surface:
 * config validation and driver `options` validation. */

import type { z } from "zod";

/** Render every issue as `path: message`, joined with `; `. `prefix` names a
 * value validated on its own, so paths and the root read as `options.path` /
 * `options`; without a prefix paths are absolute and the root is `config`.
 * Unrecognized keys expand one entry each, so the operator sees which key to
 * delete. */
export function formatIssues(error: z.ZodError, prefix?: string): string {
  const root = prefix ?? "config";
  const rendered: string[] = [];
  for (const issue of error.issues) {
    const path = [prefix, formatPath(issue.path)].filter(Boolean).join(".");
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const keyPath = path === "" ? key : `${path}.${key}`;
        rendered.push(`${keyPath}: ${issue.message}`);
      }
    } else {
      rendered.push(`${path === "" ? root : path}: ${issue.message}`);
    }
  }
  return rendered.join("; ");
}

/** `["corpuses", 0, "id"]` → `corpuses[0].id`; `[]` → `""`. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}
