/** Copy-out example: a custom corpus over a directory of .txt notes.
 *
 * Self-contained by design — copy this folder anywhere and it keeps working:
 * the only imports are `navi/core` (the contract plus its zod re-export, so no
 * other dependency to install) and Node built-ins. Point `navi.json` at this
 * file (`"type": "custom"`, `"module": "./corpus.ts"`); the default export is
 * the CorpusClass the registry loads. Swap `search` for your own retrieval and
 * the surrounding contract stays.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  Corpus,
  CorpusConfig,
  CorpusContext,
  CorpusSearchOptions,
  CorpusSearchResult,
  Situation,
} from "navi/core";
import { z } from "navi/core";

const optionsSchema = z.strictObject({
  /** Directory of `.txt` notes; relative to the declaring config. */
  path: z.string(),
  /** Hits returned when the caller does not ask for a count. */
  limit: z.number().int().min(1).default(5),
});

export default class NotesCorpus implements Corpus {
  static readonly optionsSchema = optionsSchema;

  readonly id: string;
  readonly #dir: string;
  readonly #limit: number;

  constructor(config: CorpusConfig, context: CorpusContext) {
    const { path, limit } = optionsSchema.parse(config.options ?? {});
    this.id = config.id;
    // Options resolve against the declaring config's directory,
    // with `~` and `${VAR}` expanded — the context owns both rules.
    this.#dir = context.resolvePath(path);
    this.#limit = limit;
  }

  async search(situation: Situation, options?: CorpusSearchOptions): Promise<CorpusSearchResult> {
    const terms = tokenize(situation.text);
    if (terms.size === 0) return { hits: [], coverage: { seen: 0, dropped: 0 } };

    const names = (await readdir(this.#dir)).filter((name) => name.endsWith(".txt")).sort();
    const notes = await Promise.all(
      names.map(async (name) => ({ name, text: await readFile(join(this.#dir, name), "utf8") })),
    );

    const hits = notes
      .map((note) => ({
        note,
        matched: [...terms].filter((term) => tokenize(note.text).has(term)),
      }))
      .filter(({ matched }) => matched.length > 0)
      .sort((a, b) => b.matched.length - a.matched.length || a.note.name.localeCompare(b.note.name))
      .slice(0, options?.limit ?? this.#limit)
      .map(({ note, matched }) => ({
        corpus: this.id,
        id: note.name.replace(/\.txt$/, ""),
        title: firstLine(note.text),
        excerpt: note.text.trim(),
        location: join(this.#dir, note.name),
        score: matched.length / terms.size,
        matched_by: matched.map((term) => `text:${term}`),
      }));
    // Every note was examined; the hit limit is not a scan cap.
    return { hits, coverage: { seen: notes.length, dropped: 0 } };
  }
}

/** Plain-word matching: lowercase alphanumeric runs. */
function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0];
}
