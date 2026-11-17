/** Lexicon detector: weighted arena vocabularies.
 *
 * Every arena carries a small vocabulary of weighted terms. Matched terms in
 * an arena that clears `ARENA_THRESHOLD` become `patterns` and the arena
 * becomes an `arenas` entry; the strongest arena score becomes the confidence
 * contribution. Matching is case-insensitive: word-boundary for single words,
 * substring for phrases and flags.
 *
 * This subsumes the flat tripwire table of the retired regex detector. Like
 * tripwires, the lexicon lives in code now and becomes canon-sourced later. */

import type { RawInput, SituationDetector } from "../../situation/types.ts";

/** A specific operation or phrase: strong evidence on its own. */
const COMMAND = 3;
/** A topical verb or sensitive noun: strong, but ambiguous alone. */
const STRONG = 2;
/** A common noun: evidence only in company. */
const NOUN = 1;

/** Arena score needed before its terms count as evidence. */
const ARENA_THRESHOLD = 3;
/** Confidence for a bare threshold hit; grows 0.1 per extra weight point. */
const BASE_CONFIDENCE = 0.6;
const MAX_CONFIDENCE = 0.9;

/** One term and its weight. Terms are lowercase; matching is case-insensitive. */
type Term = readonly [term: string, weight: number];

interface Arena {
  readonly name: string;
  readonly terms: readonly Term[];
}

/** Seed arenas. Verbs and commands outweigh common nouns. */
export const LEXICON: readonly Arena[] = [
  {
    name: "git",
    terms: [
      ["force-push", COMMAND],
      ["--force", COMMAND],
      ["rewrite history", COMMAND],
      ["rebase shared", COMMAND],
      ["git clean -fdx", COMMAND],
      ["reset --hard", COMMAND],
      ["cherry-pick", COMMAND],
      ["rebase", STRONG],
      ["merge", STRONG],
      ["commit", STRONG],
      ["push", STRONG],
      ["pull", STRONG],
      ["stash", NOUN],
      ["branch", NOUN],
      ["git", NOUN],
      ["origin", NOUN],
      ["remote", NOUN],
    ],
  },
  {
    name: "security",
    terms: [
      ["deploy token", COMMAND],
      ["access token", COMMAND],
      ["api key", COMMAND],
      ["private key", COMMAND],
      ["secret", COMMAND],
      ["exploit", COMMAND],
      ["cve", COMMAND],
      ["xss", COMMAND],
      ["credential", STRONG],
      ["vulnerability", STRONG],
      ["password", STRONG],
      ["injection", STRONG],
      ["token", NOUN],
      ["sandbox", NOUN],
      ["auth", NOUN],
      ["permission", NOUN],
    ],
  },
  {
    name: "data",
    terms: [
      ["drop table", COMMAND],
      ["alter table", COMMAND],
      ["create table", COMMAND],
      ["delete from", COMMAND],
      ["truncate", STRONG],
      ["migration", STRONG],
      ["backfill", STRONG],
      ["database", STRONG],
      ["sql", STRONG],
      ["foreign key", STRONG],
      ["schema", NOUN],
      ["index", NOUN],
      ["query", NOUN],
      ["table", NOUN],
      ["column", NOUN],
    ],
  },
  {
    name: "deploy",
    terms: [
      ["prod deploy", COMMAND],
      ["rollback", COMMAND],
      ["deploy", COMMAND],
      ["hotfix", STRONG],
      ["release", STRONG],
      ["prod", STRONG],
      ["production", STRONG],
      ["staging", STRONG],
      ["canary", STRONG],
      ["pipeline", NOUN],
      ["ship", NOUN],
      ["uptime", NOUN],
    ],
  },
  {
    name: "filesystem",
    terms: [
      ["rm -rf", COMMAND],
      ["mkfs", COMMAND],
      ["dd if=", COMMAND],
      ["chmod 777", COMMAND],
      ["chmod", STRONG],
      ["chown", STRONG],
      ["overwrite", NOUN],
    ],
  },
];

export class LexiconDetector implements SituationDetector {
  readonly type = "lexicon" as const;

  async detect(input: RawInput) {
    const text = input.text.toLowerCase();
    const arenas: string[] = [];
    const patterns: string[] = [];
    let strongest = 0;

    for (const arena of LEXICON) {
      // A longer matched term subsumes a shorter one it contains
      // ("force-push" covers "push"), so overlapping terms count and report
      // once instead of inflating the score.
      const matched = arena.terms.filter(([term]) => contains(text, term));
      const kept = matched.filter(
        ([term]) => !matched.some(([other]) => other !== term && other.includes(term)),
      );
      const score = kept.reduce((total, [, weight]) => total + weight, 0);
      if (score < ARENA_THRESHOLD) continue;

      arenas.push(arena.name);
      patterns.push(...kept.map(([term]) => term));
      strongest = Math.max(strongest, score);
    }

    if (arenas.length === 0) return null;
    return {
      arenas,
      patterns,
      confidence: Math.min(MAX_CONFIDENCE, BASE_CONFIDENCE + 0.1 * (strongest - ARENA_THRESHOLD)),
    };
  }
}

/** Single alphanumeric words match on word boundaries (so "sql" skips
 * "mysql"); anything with a space, hyphen, or flag is a substring. */
function contains(text: string, term: string): boolean {
  if (!/^[a-z0-9]+$/.test(term)) return text.includes(term);
  return new RegExp(`\\b${term}\\b`).test(text);
}
