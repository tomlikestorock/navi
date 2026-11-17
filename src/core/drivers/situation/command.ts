/** Command/entity detector: pattern extraction, not classification.
 *
 * One cheap regex pass pulls out commands (`git <verb>`, `npm <cmd>`, SQL
 * verbs), file paths, URLs, versions, hex hashes, and secret-looking strings.
 * Commands name both a tool and an operation, so they fill `tools` and
 * `patterns`; everything else is a literal `pattern` except paths. Nothing is
 * classified here — the search engine and the future drift gate
 * weigh these hints themselves. */

import type { RawInput, SituationDetector } from "../../situation/types.ts";

/** A named command is strong evidence; entities alone are weaker hints. */
const COMMAND_CONFIDENCE = 0.6;
const ENTITY_CONFIDENCE = 0.5;

/** Every git subcommand worth naming after an explicit `git`. */
const GIT_VERBS = new Set([
  "add",
  "bisect",
  "blame",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "config",
  "diff",
  "fetch",
  "init",
  "log",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reflog",
  "remote",
  "reset",
  "restore",
  "revert",
  "rm",
  "show",
  "stash",
  "status",
  "submodule",
  "switch",
  "tag",
  "worktree",
]);

/** Git verbs that are unambiguous without the `git` token ("push", "rebase",
 * …). Common English words ("status", "log", "branch") only count after an
 * explicit `git`. */
const BARE_GIT_VERBS = [
  "bisect",
  "cherry-pick",
  "checkout",
  "clone",
  "commit",
  "fetch",
  "push",
  "rebase",
  "reflog",
  "stash",
  "worktree",
];

const GIT_INVOCATION = /\bgit\s+([a-z][a-z-]*)/gi;
const BARE_GIT_VERB = new RegExp(`(?<![\\w-])(?:${BARE_GIT_VERBS.join("|")})(?![\\w-])`, "gi");
const PACKAGE_RUN = /\b(npm|pnpm|bun)\s+(?:run\s+)?([a-z][\w:-]*)/gi;
const SQL_COMMAND = /\b(drop|alter|create|truncate)\s+(table|index|view)\b/gi;
const FLAG = /(?<![\w-])--?[a-z][\w-]*/gi;

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`)\]]+/gi;
const PATH_PATTERN =
  /(?:^|[\s"'(=,:;[{])((?:~|\.{1,2})\/[\w.@+-]+(?:\/[\w.@+-]+)*|\/[\w.@+-]+(?:\/[\w.@+-]+)*|(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z]\w*)/g;

const VERSION = /\bv?\d+\.\d+\.\d+\b/gi;
/** A hex run that looks like a hash, not a number or an ordinary word: needs
 * at least one a–f letter and one digit. */
const HASH = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi;
/** Matches the secret so it can be reported redacted: the value must never
 * reach a Situation that gets logged or injected (the situation is the only
 * cross-layer artifact). */
const SECRET = /\bsk-[A-Za-z0-9_-]{8,}|\b(token|password|passwd|api[_-]?key|secret)\s*=\s*\S+/gi;

export class CommandDetector implements SituationDetector {
  readonly type = "command" as const;

  async detect(input: RawInput) {
    const tools = new Set<string>();
    const patterns = new Set<string>();
    const paths = new Set<string>();
    let commandFound = false;

    for (const match of input.text.matchAll(GIT_INVOCATION)) {
      const verb = match[1].toLowerCase();
      if (!GIT_VERBS.has(verb)) continue;
      tools.add("git");
      patterns.add(verb);
      commandFound = true;
    }

    for (const match of input.text.matchAll(BARE_GIT_VERB)) {
      patterns.add(match[0].toLowerCase());
      commandFound = true;
    }

    for (const match of input.text.matchAll(PACKAGE_RUN)) {
      tools.add(match[1].toLowerCase());
      patterns.add(match[2].toLowerCase());
      commandFound = true;
    }

    for (const match of input.text.matchAll(SQL_COMMAND)) {
      patterns.add(`${match[1]} ${match[2]}`.toUpperCase());
      commandFound = true;
    }

    // Flags only count in command context; a stray "--verbose" in prose is
    // not evidence of anything.
    if (commandFound) {
      for (const match of input.text.matchAll(FLAG)) patterns.add(match[0]);
    }

    // URLs are matched first and blanked so their path and version segments
    // are not double-counted as entity patterns.
    const urls = new Set<string>();
    for (const match of input.text.matchAll(URL_PATTERN)) {
      urls.add(match[0]);
      patterns.add(match[0]);
    }
    const text = input.text.replace(URL_PATTERN, (url) => " ".repeat(url.length));

    for (const match of text.matchAll(PATH_PATTERN)) {
      const path = match[1].replace(/[.,;:]+$/, "");
      if (path !== "") paths.add(path);
    }

    for (const match of text.matchAll(VERSION)) patterns.add(match[0]);
    for (const match of text.matchAll(HASH)) patterns.add(match[0]);
    for (const match of text.matchAll(SECRET)) {
      // Report the marker, never the value: "sk-…", "token=".
      const marker = match[0].toLowerCase().startsWith("sk-") ? "sk-…" : `${match[1]}=`;
      patterns.add(marker);
    }

    if (tools.size === 0 && patterns.size === 0 && paths.size === 0) return null;
    return {
      tools: [...tools],
      patterns: [...patterns],
      paths: [...paths],
      confidence: commandFound ? COMMAND_CONFIDENCE : ENTITY_CONFIDENCE,
    };
  }
}
