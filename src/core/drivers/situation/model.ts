/** The model seat — a gateway-backed detector for arena and
 * intent classification.
 *
 * Deterministic by default: `when: "never"` is the default, so an
 * unconfigured pipeline behaves exactly as before and nothing below runs.
 * Every failure (gateway error, timeout, off-contract output) is advisory:
 * log one line and contribute `null` — the fold never sees a corrupted
 * contribution. */

import { z } from "zod";

import type { DetectorConfig } from "../../config/schema.ts";
import { AnswerSchema, type ModelGateway, type PredicateQuestion } from "../../models/gateway.ts";
import { parseOptions } from "../../registry.ts";
import type {
  DetectorContext,
  RawInput,
  Situation,
  SituationDetector,
} from "../../situation/types.ts";
import { LEXICON } from "./lexicon.ts";

/** Fixed, documented, not configured. With the lexicon's 0.6
 * base confidence, any deterministic hit suppresses `low-confidence`. */
const CONFIDENCE_THRESHOLD = 0.5;

/** One source for the arena vocabulary: the lexicon detector's arenas. */
const ARENAS: readonly string[] = LEXICON.map((arena) => arena.name);

/** Code-defined initial intent vocabulary; canon-sourced later. */
export const INTENTS = [
  "rewrite-history",
  "rotate-credential",
  "destructive-schema",
  "deploy-change",
  "secret-exposure",
  "other",
] as const;

export const ModelDetectorOptionsSchema = z
  .strictObject({
    when: z.enum(["never", "low-confidence", "always"]).default("never"),
    provider: z.string().optional(),
  })
  .refine((options) => options.when === "never" || options.provider !== undefined, {
    message: 'provider is required unless when is "never"',
    path: ["provider"],
  });

export type ModelDetectorOptions = z.infer<typeof ModelDetectorOptionsSchema>;

/**
 * One batched call per turn: every arena and intent as a yes/no predicate.
 * `low-confidence` reads the fold *at its own position*, so the convention is
 * model entries LAST — earlier deterministic hits silence it.
 */
export class ModelDetector implements SituationDetector {
  static readonly optionsSchema = ModelDetectorOptionsSchema;

  readonly type = "model" as const;

  readonly #id: string;
  readonly #options: ModelDetectorOptions;
  readonly #gateway: ModelGateway | undefined;

  constructor(config: DetectorConfig, ctx: DetectorContext) {
    this.#id = config.id;
    // Parse through the one helper: the registry validates before
    // construction, but tests and adapters may construct directly.
    this.#options = parseOptions(
      ModelDetectorOptionsSchema,
      config.options,
      `detector "${config.id}"`,
    );
    // Resolved at construction so an unknown or disabled provider is a load
    // error, while a `never` instance never touches a transport: runner
    // gateways only spawn on `ask`.
    this.#gateway =
      this.#options.provider === undefined ? undefined : ctx.gateway(this.#options.provider);
  }

  async detect(input: RawInput, current: Situation) {
    const { when } = this.#options;
    if (when === "never" || this.#gateway === undefined) return null;
    if (when === "low-confidence" && current.confidence >= CONFIDENCE_THRESHOLD) return null;

    const questions = questionsFor();
    let answers: unknown;
    try {
      answers = await this.#gateway.ask(questions, input.text);
    } catch (error) {
      this.#degrade(error instanceof Error ? error.message : String(error));
      return null;
    }

    const parsed = z.array(AnswerSchema).safeParse(answers);
    if (!parsed.success) {
      this.#degrade("answers did not match the answer contract");
      return null;
    }

    const asked = new Set(questions.map((question) => question.id));
    const claimed = parsed.data.filter((answer) => answer.answer && asked.has(answer.id));
    if (claimed.length === 0) return null;

    const matched = new Set(claimed.map((answer) => answer.id));
    const arenas = ARENAS.filter((arena) => matched.has(`arena:${arena}`));
    const intents = INTENTS.filter((intent) => matched.has(`intent:${intent}`));

    const contribution: Partial<Situation> = {
      // Additive only: the fold takes the max, so this can raise confidence
      // and never lower it.
      confidence: Math.max(...claimed.map((answer) => answer.confidence)),
    };
    if (arenas.length > 0) contribution.arenas = arenas;
    // The Situation holds one intent. First match in vocabulary order wins;
    // a joined value would invent a format nothing consumes.
    if (intents.length > 0) contribution.intent = intents[0];

    return contribution;
  }

  #degrade(reason: string): void {
    console.error(`model detector "${this.#id}": ${reason}; contributing nothing`);
  }
}

/** The ONE batched question set. Ids are namespaced so the two vocabularies
 * can never answer for one another. The gateway owns the answer contract. */
function questionsFor(): PredicateQuestion[] {
  return [
    ...ARENAS.map((arena) => ({
      id: `arena:${arena}`,
      prompt: `Is "${arena}" an area this text concerns?`,
    })),
    ...INTENTS.map((intent) => ({
      id: `intent:${intent}`,
      prompt: `Does this text express the "${intent}" intent?`,
    })),
  ];
}
