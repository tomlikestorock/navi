import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // Beans tracker state is tool-managed markdown; never reformat it.
    ignorePatterns: [".beans/**"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  // `vp pack` → the installable navi binary (see README), plus `navi/core`:
  // the corpus-module contract with generated declarations.
  // tsdown grants the execute bit to entry chunks that start with a shebang.
  pack: {
    entry: {
      main: "src/cli/main.ts",
      core: "src/core/contract.ts",
    },
    format: ["esm"],
    platform: "node",
    dts: true,
    banner: { js: "#!/usr/bin/env node" },
  },
});
