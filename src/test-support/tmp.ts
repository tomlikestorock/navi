/** Throwaway directories for the suite: create, hand over, remove either way.
 * One helper, so a test cannot forget the cleanup (or race it). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run `body` against a fresh temp directory. */
export function withTempDir<T>(prefix: string, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The async twin: the body settles before the directory is removed. */
export async function withTempDirAsync<T>(
  prefix: string,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
