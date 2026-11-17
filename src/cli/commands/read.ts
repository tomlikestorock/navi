/** `navi read <corpus>:<id>` — print the full content
 * behind a hit. Resolution goes through the Corpus seam: the driver owns its
 * locator rules, so `read` and `search` cannot disagree about where content
 * lives (the registry is the single indirection). */

import { createBuiltinRegistry } from "#core/index.ts";

import { resolveConfig } from "./config.ts";

export interface ReadCommandOptions {
  configFile?: string;
  /** `{ corpus, id, location, content }` for scripts; plain content by default. */
  json?: boolean;
}

/** `corpus/id` or `corpus:id`. Corpus ids are `[a-z0-9][a-z0-9-]*`, so the
 * first `:` or `/` is unambiguously the separator and the id keeps its own
 * slashes. */
export function parseTarget(target: string): { corpus: string; id: string } {
  const colon = target.indexOf(":");
  const at = colon === -1 ? target.indexOf("/") : colon;
  const corpus = target.slice(0, at);
  const id = target.slice(at + 1);
  if (at <= 0 || id === "") {
    throw new Error(`invalid target "${target}" (expected <corpus>:<id>)`);
  }
  return { corpus, id };
}

export async function read(target: string, options: ReadCommandOptions): Promise<string> {
  const { corpus: corpusId, id } = parseTarget(target);
  const { config } = resolveConfig(options.configFile);

  const entry = config.corpuses.find((corpus) => corpus.id === corpusId);
  if (entry === undefined) throw new Error(`unknown corpus "${corpusId}"`);
  if (entry.disabled === true) throw new Error(`corpus "${corpusId}" is disabled`);

  // The same registry + load path `search` uses, for this one corpus.
  const corpus = await createBuiltinRegistry().load(entry, { config });
  if (corpus.read === undefined) {
    throw new Error(`corpus "${corpusId}" (type "${entry.type}") cannot read by id`);
  }

  const { content, location } = await corpus.read(id);
  return options.json === true
    ? `${JSON.stringify({ corpus: corpusId, id, location, content }, null, 2)}\n`
    : content;
}
