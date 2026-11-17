/** The ModelGateway seam.
 *
 * A gateway answers yes/no predicates about text. It is a transport, not a
 * policy: the detector owns its vocabulary and template, the gateway owns the
 * wire (harness session, runner subprocess, HTTP). Gateway failure is
 * advisory — the detector degrades to a null contribution.
 *
 * `DetectorContext` resolves an id to a gateway; only referenced providers are
 * ever built. */

import { z } from "zod";

import type { ModelProviderConfig } from "../config/schema.ts";

/** One yes/no predicate. `id` is the detector's vocabulary id and is echoed
 * back in the matching `Answer`. */
export interface PredicateQuestion {
  /** Stable id, e.g. "git" (arena) or "rewrite-history" (intent). */
  id: string;
  /** The question as put to the model. */
  prompt: string;
}

export const AnswerSchema = z.object({
  /** The `PredicateQuestion.id` this answers. */
  id: z.string(),
  /** true = matches, false = does not. */
  answer: z.boolean(),
  /** The model's own confidence in that answer, 0..1. */
  confidence: z.number().min(0).max(1),
});

export type Answer = z.infer<typeof AnswerSchema>;

export interface ModelGateway {
  /** One batched call: ask every question about `text`. */
  ask(questions: PredicateQuestion[], text: string): Promise<Answer[]>;
}

/** Builds the gateway for one provider. The session-gateway branch slots in
 * here later; standalone runs always get a runner. */
export type GatewayFactory = (provider: ModelProviderConfig) => ModelGateway;

/** Any gateway failure — spawn error, non-zero exit, timeout, or output that
 * is not the answer contract. Callers degrade; they never see a half answer. */
export class GatewayError extends Error {
  override readonly name = "GatewayError";
}
