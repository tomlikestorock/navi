import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { naviCachePath } from "./cache.ts";

test("an empty XDG_CACHE_HOME counts as unset, never a cwd-relative path", () => {
  vi.stubEnv("XDG_CACHE_HOME", "");
  try {
    // The bug: `??` treats "" as a directory, so the cache lands in ./navi
    // under whatever directory the user happens to run navi from.
    const file = naviCachePath("embeddings", "docs", "vectors.jsonl");
    expect(file).toBe(join(homedir(), ".cache", "navi", "embeddings", "docs", "vectors.jsonl"));
    expect(isAbsolute(file)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("XDG_CACHE_HOME redirects the cache and the corpus id is sanitized", () => {
  vi.stubEnv("XDG_CACHE_HOME", join(tmpdir(), "navi-cache"));
  try {
    expect(naviCachePath("web", "docs/../x", "pages.jsonl")).toBe(
      join(tmpdir(), "navi-cache", "navi", "web", "docs_.._x", "pages.jsonl"),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
