/** `navi corpus` — list the merged config and
 * mutate the project file (navi-rkli). Nothing here is corpus-specific:
 * `baseDir` is the declaring directory each entry resolved to, so adding a
 * driver needs no CLI change. */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { applyEdits, modify } from "jsonc-parser";
import type { FormattingOptions } from "jsonc-parser";

import {
  CORPUS_TYPES,
  CorpusConfigSchema,
  createBuiltinRegistry,
  discoverConfigPaths,
  parseJsonc,
  readJsonc,
  validateConfig,
} from "#core/index.ts";
import type { CorpusConfig, JsoncDocument, NaviConfig } from "#core/index.ts";

import { resolveConfig } from "./config.ts";

/** Flags shared by the `corpus` mutations. */
export interface CorpusCommandOptions {
  configFile?: string;
  /** `add`: corpus kind; required. Validated against `CORPUS_TYPES`. */
  type?: string;
  /** `add`: driver options from repeated `--option k=v`, already JSON-decoded
   * by the CLI. Passed through verbatim — the driver schema validates them
   * and supplies defaults. */
  driverOptions?: Record<string, unknown>;
  /** `add`: module of a `custom` corpus. */
  module?: string;
  description?: string;
}

export function corpusList(configFile?: string): string {
  const { config } = resolveConfig(configFile);

  const rows = config.corpuses.map((corpus) => {
    const disabled = corpus.disabled === true;
    return {
      cells: [corpus.id, corpus.type, shorten(corpus.baseDir)],
      detail: [corpus.description ?? "", disabled ? "[disabled]" : ""]
        .filter((part) => part !== "")
        .join("  "),
    };
  });

  const header = ["id", "type", "baseDir"];
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row.cells[column].length)),
  );
  const line = (cells: string[], detail: string): string =>
    [...cells.map((cell, column) => cell.padEnd(widths[column])), detail].join("  ").trimEnd();

  const lines = [line(header, "description"), ...rows.map((row) => line(row.cells, row.detail))];
  return `${lines.join("\n")}\n`;
}

/** Append a new corpus to the project file. The entry is
 * validated through the same registry the engine uses before anything is
 * written, so a config that cannot load is never persisted. */
export async function corpusAdd(args: string[], options: CorpusCommandOptions): Promise<string> {
  const [id] = args;
  if (options.type === undefined) {
    throw new Error("missing --type: navi corpus add <id> --type files --option path=./dir");
  }

  const document = projectDocument(options.configFile);
  const { file } = document;
  const config = validateConfig(document.value, file, document.locate);
  if (config.corpuses.some((corpus) => corpus.id === id)) {
    throw new Error(`corpus "${id}" already exists in ${file}`);
  }

  // Only what the caller named: the driver schema supplies the defaults and
  // validates the record verbatim, so a new driver needs no CLI change.
  const entry: CorpusConfig = { id, type: corpusType(options.type) };
  if (options.module !== undefined) entry.module = options.module;
  if (options.description !== undefined) entry.description = options.description;
  if (options.driverOptions !== undefined) entry.options = options.driverOptions;

  await buildable(entry, file, config);
  const next: NaviConfig = { ...config, corpuses: [...config.corpuses, entry] };
  return commit(document, ["corpuses", config.corpuses.length], entry, next, `added "${id}"`);
}

/** Delete an entry from the project file. Absent → loud error. */
export function corpusRemove(args: string[], options: CorpusCommandOptions): string {
  const [id] = args;
  const document = projectDocument(options.configFile);
  const { file } = document;
  const config = validateConfig(document.value, file, document.locate);
  const index = indexOf(config, id, file);

  const next: NaviConfig = {
    ...config,
    corpuses: config.corpuses.filter((corpus) => corpus.id !== id),
  };
  return commit(document, ["corpuses", index], undefined, next, `removed "${id}"`);
}

/** Disable in the project file. A global-only corpus is shadowed
 * by a project entry that repeats `id` + `type` and sets `disabled`; the
 * global file is never written. */
export function corpusDisable(args: string[], options: CorpusCommandOptions): string {
  const [id] = args;
  const document = projectDocument(options.configFile);
  const { file } = document;
  const config = validateConfig(document.value, file, document.locate);
  const index = config.corpuses.findIndex((corpus) => corpus.id === id);

  if (index !== -1) {
    const entry = { ...config.corpuses[index], disabled: true };
    const next = replaceAt(config, index, entry);
    return commit(document, ["corpuses", index, "disabled"], true, next, `disabled "${id}"`);
  }

  // Only the merged config can name a global-only corpus.
  const merged = resolveConfig(options.configFile).config.corpuses.find(
    (corpus) => corpus.id === id,
  );
  if (merged === undefined) throw new Error(`unknown corpus "${id}"`);

  const entry: CorpusConfig = {
    id,
    type: merged.type,
    // A custom corpus names its module; the disable-only shadow repeats it so
    // the entry still validates.
    ...(merged.module === undefined ? {} : { module: merged.module }),
    disabled: true,
  };
  const next: NaviConfig = { ...config, corpuses: [...config.corpuses, entry] };
  return commit(document, ["corpuses", config.corpuses.length], entry, next, `disabled "${id}"`);
}

/** Clear `disabled` in the project file. A disable-only shadow
 * (id + type + disabled) is deleted whole, falling back to the global entry. */
export async function corpusEnable(args: string[], options: CorpusCommandOptions): Promise<string> {
  const [id] = args;
  const document = projectDocument(options.configFile);
  const { file } = document;
  const config = validateConfig(document.value, file, document.locate);
  const index = indexOf(config, id, file);
  const entry = config.corpuses[index];
  if (entry.disabled !== true) throw new Error(`corpus "${id}" is already enabled in ${file}`);

  if (isDisableOnly(entry)) {
    const next: NaviConfig = {
      ...config,
      corpuses: config.corpuses.filter((corpus) => corpus.id !== id),
    };
    return commit(document, ["corpuses", index], undefined, next, `enabled "${id}"`);
  }

  const { disabled: _disabled, ...enabled } = entry;
  await buildable(enabled, file, config);
  const next = replaceAt(config, index, enabled);
  return commit(document, ["corpuses", index, "disabled"], undefined, next, `enabled "${id}"`);
}

/** `~` instead of the home prefix, for readability only. */
function shorten(file: string): string {
  const home = homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

/** The project file is the only write target. `--config`
 * re-points it at a fixture. */
function projectFile(configFile?: string): string {
  if (configFile !== undefined) return configFile;
  return discoverConfigPaths().project ?? join(process.cwd(), "navi.json");
}

const EMPTY_CONFIG = `{\n  "corpuses": []\n}\n`;
const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

/** The project file parsed for surgical editing; an absent one starts empty,
 * so `add` can create it. */
function projectDocument(configFile?: string): JsoncDocument {
  const file = projectFile(configFile);
  return readJsonc(file) ?? parseJsonc(file, EMPTY_CONFIG);
}

/** Apply one JSONC edit after proving the result is a valid config: comments
 * and layout survive because edits are surgical, and a failure leaves the
 * file untouched because the write is the last step. */
function commit(
  document: JsoncDocument,
  path: (string | number)[],
  value: unknown,
  next: NaviConfig,
  action: string,
): string {
  const { file, text } = document;
  validateConfig(next, file);
  const edited = applyEdits(text, modify(text, path, value, { formattingOptions: FORMAT }));
  // The edit itself must round-trip; a malformed splice never reaches disk.
  const roundTrip = parseJsonc(file, edited);
  validateConfig(roundTrip.value, file, roundTrip.locate);
  writeFileSync(file, edited);
  return `${action} in ${file}\n`;
}

/** The entry must build with the driver's own options schema.
 * This is what `navi config check` does per enabled corpus. The entry is not
 * loaded from disk yet, so its declaring directory is supplied explicitly. */
async function buildable(entry: CorpusConfig, file: string, config: NaviConfig): Promise<void> {
  await createBuiltinRegistry().load({ ...entry, baseDir: dirname(file) }, { config });
}

function replaceAt(config: NaviConfig, index: number, entry: CorpusConfig): NaviConfig {
  return {
    ...config,
    corpuses: config.corpuses.map((corpus, position) => (position === index ? entry : corpus)),
  };
}

function indexOf(config: NaviConfig, id: string, file: string): number {
  const index = config.corpuses.findIndex((corpus) => corpus.id === id);
  if (index === -1) throw new Error(`corpus "${id}" is not in ${file}`);
  return index;
}

/** Keys the schema itself demands of any entry, read from the schema so a new
 * required field joins the shadow vocabulary automatically. */
const REQUIRED_KEYS = Object.entries(CorpusConfigSchema.shape)
  .filter(([, schema]) => !schema.isOptional())
  .map(([key]) => key);

/** A shadow may carry identity, the custom module it re-declares, and the
 * flag — never a payload field such as `options` or `description`. */
const SHADOW_KEYS = new Set([...REQUIRED_KEYS, "module", "disabled"]);

/** A shadow entry exists only to disable a global corpus. An unknown key fails
 * this check, so enabling a hand-written entry keeps it rather than silently
 * deleting data. */
function isDisableOnly(entry: CorpusConfig): boolean {
  return Object.keys(entry).every((key) => SHADOW_KEYS.has(key));
}

/** The closed kind vocabulary; a typo fails before any file is
 * written. */
function corpusType(value: string): CorpusConfig["type"] {
  const known = CORPUS_TYPES.find((type) => type === value);
  if (known === undefined) {
    throw new Error(`unknown corpus type "${value}" (expected ${CORPUS_TYPES.join(", ")})`);
  }
  return known;
}
