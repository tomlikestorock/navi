/** Config-declared paths expand `~` and `${VAR}` and resolve
 * against the declaring file's directory — never the process cwd. */

import { homedir } from "node:os";
import { resolve } from "node:path";

/** Expand `~` and `${VAR}`, then anchor the result at `baseDir`. An unset
 * `${VAR}` stays literal, so a typo is visible instead of silently empty. */
export function resolveConfiguredPath(baseDir: string, value: string): string {
  const expanded = value.replace(/^~(?=$|\/)/, homedir()).replace(ENV_VAR, envVar);
  return resolve(baseDir, expanded);
}

const ENV_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function envVar(match: string, name: string): string {
  return process.env[name] ?? match;
}

/** Standalone `${VAR}` expansion for non-path values such as API keys; the
 * same rule, so one typo policy everywhere. */
export function expandEnv(value: string): string {
  return value.replace(ENV_VAR, envVar);
}
