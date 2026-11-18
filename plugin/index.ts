/** The OpenCode harness adapter.
 *
 * Admission surfacing: every admitted user prompt is analyzed, searched and
 * written back as one advisory instruction entry; `navi_search` and
 * `navi_pack` are deliberate pulls through the same pipeline. Before
 * injection the policy pass applies dedupe, turn-relative gates, repetition
 * caps, budget and `byModel` rules, keyed on a per-session seen-log in
 * plugin storage.
 * Config comes from the normal global + project discovery, so corpuses,
 * embeddings, detector instances and model providers are all the merged
 * config's.
 *
 * Provider gateways resolve once at setup: `preferSession` uses the session's
 * decisions API when the harness has one, otherwise the runner the CLI uses.
 * The drift gate (`ctx.session.hook("context")`) is the next
 * bean — not built here. */

import { Plugin } from "@opencode/plugin";

import {
  createBuiltinAnalyzer,
  createBuiltinRegistry,
  createSearchEngine,
  formatHits,
  loadConfig,
} from "#core/index.ts";
import type {
  CorpusHit,
  HitSurfacing,
  RawInput,
  SearchEngine,
  SituationAnalyzer,
  SurfacingConfig,
} from "#core/index.ts";

import { createHarnessGatewayFactory, type DecisionsApi } from "./gateway.ts";
import { applyPolicy } from "./policy.ts";
import type { SeenState } from "./policy.ts";
import { loadSeen, saveSeen, type SeenStorage } from "./seen.ts";
import { SURFACE_KEY, surfaceEntry } from "./surface.ts";

/** The setup context type, derived so the SDK is imported once (at the top). */
type Setup = Parameters<typeof Plugin.define>[0];
type SetupContext = Parameters<Setup["setup"]>[0];
type Decisions = SetupContext["experimental"]["generate"]["decisions"];

const QUERY_INPUT = {
  type: "object",
  properties: {
    query: { type: "string", description: "The task text to search concerns for." },
    limit: { type: "number", description: "Hits to return across all corpuses (default 5)." },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

interface Pipeline {
  analyzer: SituationAnalyzer;
  engine: SearchEngine;
  /** The config section, or undefined for always-on defaults. */
  surfacing?: SurfacingConfig;
  /** Corpus-entry defaults for hits that declare none. */
  corpusSurfacing: ReadonlyMap<string, HitSurfacing>;
}

export default Plugin.define({
  id: "navi",

  async setup(ctx) {
    const decisions = decisionsApi(ctx.experimental.generate.decisions);

    let pipeline: Pipeline;
    try {
      pipeline = await createPipeline(ctx.location.directory, decisions);
    } catch (error) {
      // A broken navi config must not take prompt admission down with it.
      console.error(`navi: plugin disabled — ${messageOf(error)}`);
      return;
    }

    await ctx.session.hook("prompt", async (event) => {
      const text = event.prompt.text;
      if (text.trim() === "") return;

      try {
        const hits = await retrieve(pipeline, text);
        const seen = await readSeen(ctx.storage, event.sessionID);
        const decision = applyPolicy(hits, {
          config: pipeline.surfacing,
          model: await sessionModel(ctx, event.sessionID),
          corpusSurfacing: pipeline.corpusSurfacing,
          seen,
          turn: seen.turn + 1,
        });
        await writeSeen(ctx.storage, event.sessionID, decision.seen);

        const entry = surfaceEntry(decision.hits);
        if (entry === null) {
          await ctx.session.instructions.entry.remove({
            sessionID: event.sessionID,
            key: SURFACE_KEY,
          });
        } else {
          await ctx.session.instructions.entry.put({
            sessionID: event.sessionID,
            key: entry.key,
            value: entry.value,
          });
        }
      } catch (error) {
        // Surfacing is advisory: a failed search never blocks the prompt.
        console.error(`navi: prompt surfacing failed — ${messageOf(error)}`);
      }
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "navi_search",
        description:
          "Search the configured navi concern corpora. Returns an advisory block of matching concerns; not commands.",
        input: QUERY_INPUT,
        execute: async (input) => ({
          content: formatHits(await retrieve(pipeline, queryOf(input), limitOf(input)), "inject"),
        }),
      });
      editor.add({
        name: "navi_pack",
        description:
          "Search the configured navi concern corpora and return a subagent-ready reference pack.",
        input: QUERY_INPUT,
        execute: async (input) => ({
          content: formatHits(await retrieve(pipeline, queryOf(input), limitOf(input)), "pack"),
        }),
      });
    });
  },
});

/** The merged config is the only setup input. The
 * registry loads built-ins and `custom` corpus modules, the engine resolves
 * embedding providers, and one gateway factory serves detectors and filter. */
async function createPipeline(cwd: string, decisions: DecisionsApi | undefined): Promise<Pipeline> {
  const { config, files } = loadConfig({ cwd });
  if (files.length === 0) {
    console.error("navi: no navi.json found; surfacing runs with no corpuses");
  }

  const createGateway = createHarnessGatewayFactory(decisions);
  const corpusSurfacing = new Map<string, HitSurfacing>();
  for (const corpus of config.corpuses) {
    if (corpus.surfacing !== undefined) corpusSurfacing.set(corpus.id, corpus.surfacing);
  }

  return {
    analyzer: createBuiltinAnalyzer(config, { createGateway }),
    engine: await createSearchEngine(config, createBuiltinRegistry(), { createGateway }),
    surfacing: config.surfacing,
    corpusSurfacing,
  };
}

/** Analyze one user prompt, then federate the configured corpuses. */
async function retrieve(pipeline: Pipeline, text: string, limit?: number): Promise<CorpusHit[]> {
  const input: RawInput = { text, kind: "user_prompt" };
  const situation = await pipeline.analyzer.analyze(input);
  return pipeline.engine.search(situation, limit === undefined ? undefined : { limit });
}

/** The harness API is experimental: an older harness without it falls back to
 * the runner instead of failing setup. The annotation is
 * also the compile-time check that the SDK's call matches navi's contract. */
function decisionsApi(decisions: Decisions | undefined): DecisionsApi | undefined {
  return typeof decisions === "function" ? decisions : undefined;
}

function queryOf(input: unknown): string {
  const query = (input as { query?: unknown } | null | undefined)?.query;
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error("navi: query must be a non-empty string");
  }
  return query;
}

function limitOf(input: unknown): number | undefined {
  const limit = (input as { limit?: unknown } | null | undefined)?.limit;
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The session's model ref (`provider/id`), for `force` and `byModel`. A
 * harness that cannot answer leaves it undefined: exact rules do not match,
 * `*` still does. */
async function sessionModel(ctx: SetupContext, sessionID: string): Promise<string | undefined> {
  try {
    const { model } = await ctx.session.get({ sessionID });
    return model === undefined ? undefined : `${model.providerID}/${model.id}`;
  } catch {
    return undefined;
  }
}

/** Storage is best-effort: an unreadable log starts empty, an unwritable one
 * leaves the log behind rather than dropping the block. */
async function readSeen(storage: SeenStorage, sessionID: string) {
  try {
    return await loadSeen(storage, sessionID);
  } catch (error) {
    console.error(`navi: seen-log read failed — ${messageOf(error)}`);
    return { turn: 0, entries: [] };
  }
}

async function writeSeen(storage: SeenStorage, sessionID: string, state: SeenState): Promise<void> {
  try {
    await saveSeen(storage, sessionID, state);
  } catch (error) {
    console.error(`navi: seen-log write failed — ${messageOf(error)}`);
  }
}
