/** Packaging guard (navi-9hro): every example config is real, not decorative.
 *
 * Parameterized over every `navi.json` under `examples/`: each file must parse
 * and every corpus it declares must build through the same registry the CLI
 * uses. A schema change that drifts the copy-first reference (or the
 * out-of-tree custom corpus) fails here instead of shipping. */

import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { createBuiltinRegistry, mergeConfigs, readConfigFile } from "#core/index.ts";

const root = dirname(fileURLToPath(import.meta.url));

function configFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return configFiles(path);
    return entry.name === "navi.json" ? [path] : [];
  });
}

const configs = configFiles(root);
test("examples are discoverable", () => expect(configs.length).toBeGreaterThan(0));

for (const file of configs) {
  test(`example config loads and builds: ${relative(root, file)}`, async () => {
    const config = readConfigFile(file);
    expect(config, `${file} did not parse`).not.toBeNull();

    const { config: resolved } = mergeConfigs({ file, config: config! });
    const registry = createBuiltinRegistry();
    for (const corpus of resolved.corpuses) {
      await expect(registry.load(corpus)).resolves.toBeDefined();
    }
  });
}
