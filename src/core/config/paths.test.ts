import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { resolveConfiguredPath } from "./paths.ts";

test("expands ~ and ${VAR}, then anchors at baseDir", () => {
  vi.stubEnv("NAVI_TEST_DIR", "docs");
  try {
    expect(resolveConfiguredPath("/repo", "~/wiki")).toBe(join(homedir(), "wiki"));
    expect(resolveConfiguredPath("/repo", "${NAVI_TEST_DIR}/a.md")).toBe("/repo/docs/a.md");
    expect(resolveConfiguredPath("/repo", "./docs")).toBe("/repo/docs");
    // An unset variable stays visible instead of resolving to something wrong.
    expect(resolveConfiguredPath("/repo", "${NAVI_TEST_MISSING}")).toBe(
      "/repo/${NAVI_TEST_MISSING}",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
