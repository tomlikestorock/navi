/** Config discovery and the load entry point. JSONC parsing
 * itself lives in `jsonc.ts`, shared with the `corpus` mutations. */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { NaviConfig, ResolvedNaviConfig } from "./schema.ts";
import { readJsonc } from "./jsonc.ts";
import { validateConfig } from "./validate.ts";
import { mergeConfigs, type ConfigSource } from "./merge.ts";

export interface LoadConfigOptions {
  /** Directory to start the project-file search from. Defaults to `cwd`. */
  cwd?: string;
  /** Environment for `$XDG_CONFIG_HOME`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Where each level's config lives. Global is always a candidate path;
 * project is `null` when no `navi.json` exists up to the repo root. */
export interface ConfigPaths {
  global: string;
  project: string | null;
}

export interface LoadedConfig {
  /** Merged config where every corpus carries its resolved `baseDir`. */
  config: ResolvedNaviConfig;
  /** Files that were actually read, global first. */
  files: string[];
}

/** Resolve the two candidate paths. */
export function discoverConfigPaths(options: LoadConfigOptions = {}): ConfigPaths {
  const env = options.env ?? process.env;
  // XDG base-dir spec: unset OR empty falls back to ~/.config.
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return {
    global: join(configHome, "navi", "navi.json"),
    project: findProjectConfig(resolve(options.cwd ?? process.cwd())),
  };
}

/** Read, parse and validate one file. `null` when it does not exist. */
export function readConfigFile(file: string): NaviConfig | null {
  const document = readJsonc(file);
  return document === null ? null : validateConfig(document.value, document.file, document.locate);
}

/** Discover, read, validate and merge both files. */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const paths = discoverConfigPaths(options);
  const globalConfig = readConfigFile(paths.global);
  const projectFile = paths.project;
  const projectConfig = projectFile === null ? null : readConfigFile(projectFile);

  const { config } = mergeConfigs(
    source(paths.global, globalConfig),
    source(projectFile, projectConfig),
  );

  return {
    config,
    files: [paths.global, projectFile].filter(
      (file): file is string => file !== null && existsSync(file),
    ),
  };
}

function source(file: string | null, config: NaviConfig | null): ConfigSource | null {
  return file === null || config === null ? null : { file, config };
}

/** Nearest `navi.json` from `startDir` upward, stopping at the repo root
 * (the first directory holding `.git`) or the filesystem root. */
function findProjectConfig(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "navi.json");
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return null;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
