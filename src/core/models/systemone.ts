/** The `systemone` runner.
 *
 * Local Jev-style decision models (ollama: `nimble`, `tev1`) serve TypeSafe's
 * Jev API: `POST {baseUrl}/v1/systemone` with `{ model, state: { text },
 * questions: { <id>: { type: "noul", instructions } } }` →
 * `{ answers: { <id>: { type: "noul", noul } } }`, where `noul` is the
 * probability of yes. That maps to `PredicateQuestion`/`Answer` directly, so
 * the answers are structured by construction — no prompt template to parse.
 *
 * Everything here is advisory: any failure throws `GatewayError` and the
 * caller degrades. */

import { z } from "zod";

import type { ModelProviderConfig } from "../config/schema.ts";
import { postJson } from "../http.ts";
import { GatewayError, type Answer, type ModelGateway, type PredicateQuestion } from "./gateway.ts";

/** The only question type we send: a binary predicate scored 0..1. */
const NoulAnswerSchema = z.object({
  type: z.literal("noul"),
  /** Probability of yes. */
  noul: z.number().min(0).max(1),
});

/** The answer contract the model must return, keyed by `PredicateQuestion.id`. */
const SystemoneAnswersSchema = z.object({
  answers: z.record(z.string(), NoulAnswerSchema),
});

/** One HTTP call per `ask` — the filter batches every predicate into one. */
export function createSystemoneGateway(provider: ModelProviderConfig): ModelGateway {
  const { runner } = provider;
  if (runner.type !== "systemone") {
    throw new GatewayError(`model provider "${provider.id}": not a systemone runner`);
  }
  // Trailing slashes are config noise, not a different path.
  const baseUrl = runner.baseUrl.replace(/\/+$/, "");

  return {
    ask: (questions, text) => runSystemone(baseUrl, questions, text, provider),
  };
}

async function runSystemone(
  baseUrl: string,
  questions: PredicateQuestion[],
  text: string,
  provider: ModelProviderConfig,
): Promise<Answer[]> {
  const label = `model provider "${provider.id}" (systemone)`;
  const parsed = await postJson(
    `${baseUrl}/v1/systemone`,
    {
      model: provider.model,
      state: { text },
      questions: Object.fromEntries(
        questions.map((question) => [question.id, { type: "noul", instructions: question.prompt }]),
      ),
    },
    {
      label,
      timeoutMs: provider.timeoutMs,
      fail: (message, options) => new GatewayError(message, options),
    },
  );

  const result = SystemoneAnswersSchema.safeParse(parsed);
  if (!result.success) {
    throw new GatewayError(`${label}: returned answers that break the contract`);
  }

  const { answers } = result.data;
  return questions.map(({ id }) => {
    const entry = Object.hasOwn(answers, id) ? answers[id] : undefined;
    if (entry === undefined) {
      throw new GatewayError(`${label}: omitted answer "${id}"`);
    }
    // `noul` is P(yes): 0.5 is the uncertainty point, so map it to confidence 0
    // and let the caller's "include on uncertainty" rule keep the hit.
    return { id, answer: entry.noul > 0.5, confidence: Math.abs(2 * entry.noul - 1) };
  });
}
