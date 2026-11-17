/** The `navi` CLI. No arg-parsing dependency — `node:util`
 * parseArgs is enough. Commands are pure (text or throw); routing, streams
 * and exit codes live here. */

import { parseArgs } from "node:util";

import { CORPUS_TYPES, SituationKindSchema } from "#core/index.ts";
import type { SituationKind } from "#core/index.ts";

import { analyze } from "./commands/analyze.ts";
import { configCheck, configShow } from "./commands/config.ts";
import {
  corpusAdd,
  corpusDisable,
  corpusEnable,
  corpusList,
  corpusRemove,
  type CorpusCommandOptions,
} from "./commands/corpus.ts";
import { evaluate, FILTER_MODES, type FilterMode } from "./commands/eval.ts";
import { pack } from "./commands/pack.ts";
import { read } from "./commands/read.ts";
import { search, type SearchCommandOptions } from "./commands/search.ts";
import { trace } from "./commands/trace.ts";

/** One source for each closed vocabulary: the schemas, never a restatement. */
const KINDS = SituationKindSchema.options;

const USAGE = `navi — concern canon CLI

Usage:
  navi analyze "text" [--kind K] [--paths a,b] [--tool name]  the Situation as JSON
  navi search "text" [--limit N] [--json] [--situation f]     analyze → federate → hits
  navi pack "task" [--limit N] [--situation f]                the same search as a reference block
  navi trace "text" [--limit N] [--json]                      contributions → per-corpus hits → fusion
  navi read <corpus>:<id> [--json]         the full content behind a hit
  navi eval [--fixture <file>] [--k N] [--filter on|off|auto] [--json]
                                            labeled query set → recall@k, MRR, misses
  navi config show [--config <file>]       effective merged config as JSON
  navi config check [--config <file>]      validate config and build enabled corpuses
  navi corpus list [--config <file>]       configured corpuses
  navi corpus add <id> --type <t> [--option k=v ...] [--module <m>] [--description ...]
  navi corpus remove <id>                  delete the entry from the project file
  navi corpus disable <id> | enable <id>   set or clear the disabled flag

  Mutations write the project navi.json only (the nearest one, or cwd's when
  none exists); the global config is never modified.

Options:
  -c, --config <file>  read this file alone instead of global + project config
      --limit <n>      hits to return across all corpuses (default 5)
      --json           raw hits (search), {corpus,id,location,content} (read), or the report (eval)
      --fixture <file> eval fixture navi.json (default: the shipped fixture)
      --k <n>          eval depth for recall@k and MRR (default 5)
      --filter <mode>  eval filter: ${FILTER_MODES.join(" | ")} (default auto)
      --kind <k>       turn kind: ${KINDS.join(" | ")} (default user_prompt)
      --paths <a,b>    filesystem signals for the analyzer
      --tool <name>    tool-type signal for the analyzer
      --situation <f>  search/pack this fixture Situation JSON instead of analyzing text
      --type <t>       corpus type for 'corpus add': ${CORPUS_TYPES.join(" | ")}
      --option k=v     driver option for 'corpus add'; repeatable, value is JSON when it parses
      --module <m>     corpus module for 'corpus add' (required for custom)
      --description <s>   description shown by 'corpus list'
  -h, --help           show this help
`;

/** Every flag main parses and validates; each command reads the subset it
 * needs (structural typing keeps the table free of per-command plumbing). */
interface CliOptions extends SearchCommandOptions, CorpusCommandOptions {
  fixture?: string;
  k?: number;
  filter?: FilterMode;
}

type Handler = (args: string[], options: CliOptions) => string | Promise<string>;

/** How a command takes its positionals: "text" folds them into one string
 * (the analyze family), "one" is exactly one id, "none" forbids any. */
type Arity = "text" | "one" | "none";

interface Command {
  arity: Arity;
  /** Usage error when the arity is not met. */
  usage: string;
  run: Handler;
}

/** The one routing table (bean navi-68om): each row owns its arity and handler,
 * so adding a command touches this table only — nothing is derived from a
 * command's name. */
const COMMANDS: Record<string, Command> = {
  analyze: {
    arity: "text",
    usage: `missing text: navi analyze "text"`,
    run: (args, options) => analyze(args.join(" "), options),
  },
  search: {
    arity: "text",
    usage: `missing text: navi search "text"`,
    run: (args, options) => search(args.join(" "), options),
  },
  pack: {
    arity: "text",
    usage: `missing text: navi pack "text"`,
    run: (args, options) => pack(args.join(" "), options),
  },
  trace: {
    arity: "text",
    usage: `missing text: navi trace "text"`,
    run: (args, options) => trace(args.join(" "), options),
  },
  read: {
    arity: "text",
    usage: "missing target: navi read <corpus>:<id>",
    run: (args, options) => read(args.join(" "), options),
  },
  eval: {
    arity: "none",
    usage: "navi eval takes flags only",
    run: (_args, options) =>
      evaluate({
        configFile: options.configFile,
        fixture: options.fixture,
        k: options.k,
        filter: options.filter,
        json: options.json,
      }),
  },
  "config show": {
    arity: "none",
    usage: "navi config show takes flags only",
    run: (_args, options) => configShow(options.configFile),
  },
  "config check": {
    arity: "none",
    usage: "navi config check takes flags only",
    run: (_args, options) => configCheck(options.configFile),
  },
  "corpus list": {
    arity: "none",
    usage: "navi corpus list takes flags only",
    run: (_args, options) => corpusList(options.configFile),
  },
  "corpus add": {
    arity: "one",
    usage: "expected one corpus id: navi corpus add <id>",
    run: corpusAdd,
  },
  "corpus remove": {
    arity: "one",
    usage: "expected one corpus id: navi corpus remove <id>",
    run: corpusRemove,
  },
  "corpus disable": {
    arity: "one",
    usage: "expected one corpus id: navi corpus disable <id>",
    run: corpusDisable,
  },
  "corpus enable": {
    arity: "one",
    usage: "expected one corpus id: navi corpus enable <id>",
    run: corpusEnable,
  },
};

/** Route argv and return the exit code: 0 ok, 1 failure, 2 usage error. */
export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        limit: { type: "string" },
        json: { type: "boolean" },
        kind: { type: "string" },
        paths: { type: "string" },
        tool: { type: "string" },
        situation: { type: "string" },
        type: { type: "string" },
        option: { type: "string", multiple: true },
        module: { type: "string" },
        description: { type: "string" },
        fixture: { type: "string" },
        k: { type: "string" },
        filter: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }

  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return usage(`invalid --limit: ${values.limit}`);
  }
  const kind = values.kind as SituationKind | undefined;
  if (kind !== undefined && !KINDS.includes(kind)) {
    return usage(`invalid --kind: ${values.kind} (expected ${KINDS.join(" | ")})`);
  }
  const k = values.k === undefined ? undefined : Number(values.k);
  if (k !== undefined && (!Number.isInteger(k) || k <= 0)) {
    return usage(`invalid --k: ${values.k}`);
  }
  const filter = values.filter as FilterMode | undefined;
  if (filter !== undefined && !FILTER_MODES.includes(filter)) {
    return usage(`invalid --filter: ${values.filter} (expected ${FILTER_MODES.join(" | ")})`);
  }

  let driverOptions;
  try {
    driverOptions = parseDriverOptions(values.option);
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }

  const options: CliOptions = {
    configFile: values.config,
    limit,
    json: values.json,
    kind,
    paths:
      values.paths === undefined
        ? undefined
        : values.paths
            .split(",")
            .map((path) => path.trim())
            .filter((path) => path !== ""),
    tool: values.tool,
    situation: values.situation,
    type: values.type,
    driverOptions,
    module: values.module,
    description: values.description,
    fixture: values.fixture,
    k,
    filter,
  };

  try {
    const route = lookup(positionals);
    if (route === undefined) {
      const [group] = positionals;
      const isGroup =
        group !== undefined && Object.keys(COMMANDS).some((key) => key.startsWith(`${group} `));
      if (isGroup && positionals.length === 1) {
        return usage(`missing command: navi ${group} <command>`);
      }
      return usage(
        `unknown command: ${positionals.length === 0 ? "(none)" : positionals.join(" ")}`,
      );
    }

    const { command, words } = route;
    const args = positionals.slice(words);
    if (command.arity === "text" && args.length === 0 && options.situation === undefined) {
      return usage(command.usage);
    }
    if (command.arity === "one" && args.length !== 1) return usage(command.usage);
    if (command.arity === "none" && args.length > 0) {
      return usage(`unexpected argument: ${args.join(" ")}`);
    }

    process.stdout.write(await command.run(args, options));
    return 0;
  } catch (error) {
    process.stderr.write(`navi: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** The longest table key that prefixes the positionals, so `corpus add` never
 * resolves to a bare group name. */
function lookup(positionals: string[]): { command: Command; words: number } | undefined {
  for (const words of [2, 1]) {
    const command = COMMANDS[positionals.slice(0, words).join(" ")];
    if (command !== undefined) return { command, words };
  }
  return undefined;
}

/** `--option key=value`, repeatable. The value is JSON when it parses (arrays,
 * numbers, booleans) and a plain string otherwise; the driver schema is the
 * validator. A pair without a key is a usage error. */
function parseDriverOptions(pairs: string[] | undefined): Record<string, unknown> | undefined {
  if (pairs === undefined) return undefined;

  const options: Record<string, unknown> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error(`invalid --option "${pair}": expected key=value`);
    const raw = pair.slice(separator + 1);
    try {
      options[pair.slice(0, separator)] = JSON.parse(raw);
    } catch {
      options[pair.slice(0, separator)] = raw;
    }
  }
  return options;
}

function usage(message: string): number {
  process.stderr.write(`navi: ${message}\n\n${USAGE}`);
  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
