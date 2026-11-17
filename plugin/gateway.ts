/** The harness session gateway.
 *
 * `preferSession` resolves at setup, not per call: in a harness
 * with a decisions API the provider answers through the session's own
 * providers and auth — navi stores no keys; otherwise the runner transport is
 * exactly the CLI's. Every API or contract failure becomes a `GatewayError`,
 * so the detector degrades to a null contribution.
 *
 * The decisions call is structurally typed instead of importing the plugin
 * SDK: this module stays free of harness types and is testable with a plain
 * fake. */

import type { ModelProviderConfig } from "#core/config/schema.ts";
import {
  GatewayError,
  type Answer,
  type GatewayFactory,
  type ModelGateway,
  type PredicateQuestion,
} from "#core/models/gateway.ts";
import { createRunnerGateway } from "#core/models/opencode.ts";

/** One answer in the harness decisions response. Only `predicate` carries a
 * probability; every variant has a stable `name` (the question id). */
export interface DecisionAnswer {
  readonly type: string;
  readonly name: string;
  readonly probability?: number;
}

export interface DecisionsResult {
  readonly answers: ReadonlyArray<DecisionAnswer>;
}

/** `ctx.experimental.generate.decisions`, narrowed to the one call navi makes:
 * batched predicate questions over one text input. */
export type DecisionsApi = (
  input: {
    readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string };
    readonly input: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
    readonly questions: ReadonlyArray<{
      readonly type: "predicate";
      readonly name: string;
      readonly instructions: string;
    }>;
  },
  requestOptions?: { readonly signal?: AbortSignal },
) => Promise<DecisionsResult>;

/** `model` is a `provider/model` ref shared by both transports.
 * Split on the first slash so multi-slash model names survive. */
export function parseModelRef(model: string): { providerID: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new GatewayError(`model ref "${model}" must be "provider/model"`);
  }
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** The transport choice. Standalone runs have no decisions API,
 * so they always take the runner — the CLI path stays untouched. */
export function gatewayKind(
  provider: ModelProviderConfig,
  hasDecisions: boolean,
): "session" | "runner" {
  return provider.preferSession && hasDecisions ? "session" : "runner";
}

/** The plugin's `GatewayFactory`: both the analyzer's detectors and the
 * engine's filter resolve providers through it (one config section). */
export function createHarnessGatewayFactory(
  decisions: DecisionsApi | undefined,
  runner: GatewayFactory = createRunnerGateway,
): GatewayFactory {
  return (provider) =>
    gatewayKind(provider, decisions !== undefined) === "session" && decisions !== undefined
      ? createSessionGateway(decisions, provider)
      : runner(provider);
}

/** One provider through the harness session. The timeout is provider-level,
 * so a slow model cannot wedge a prompt admission. */
export function createSessionGateway(
  decisions: DecisionsApi,
  provider: ModelProviderConfig,
): ModelGateway {
  return {
    async ask(questions, text) {
      let result: DecisionsResult;
      try {
        result = await decisions(
          {
            model: parseModelRef(provider.model),
            input: [{ type: "text", text }],
            questions: questions.map((question) => ({
              type: "predicate",
              name: question.id,
              instructions: question.prompt,
            })),
          },
          { signal: AbortSignal.timeout(provider.timeoutMs) },
        );
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError(
          `model provider "${provider.id}": session decisions failed: ${messageOf(error)}`,
          { cause: error },
        );
      }

      if (!Array.isArray(result?.answers)) {
        throw new GatewayError(
          `model provider "${provider.id}": session decisions returned no answers`,
        );
      }
      return answersFrom(provider.id, questions, result.answers);
    },
  };
}

/** Map the harness's probabilities onto navi's gateway contract: a predicate
 * is yes at 0.5 or above, and confidence is the model's distance from the
 * coin flip — the same "confident no drops a hit" rule the engine uses. An
 * errored or malformed answer is a gateway failure, never a partial batch. */
export function answersFrom(
  provider: string,
  questions: PredicateQuestion[],
  answers: ReadonlyArray<DecisionAnswer>,
): Answer[] {
  const asked = new Set(questions.map((question) => question.id));
  const mapped: Answer[] = [];

  for (const answer of answers) {
    if (!asked.has(answer.name)) continue;
    if (answer.type === "error") {
      throw new GatewayError(
        `model provider "${provider}": decision "${answer.name}" failed in the session`,
      );
    }
    if (answer.type !== "predicate") continue;

    const probability = answer.probability;
    if (
      probability === undefined ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      throw new GatewayError(
        `model provider "${provider}": decision "${answer.name}" returned an invalid probability`,
      );
    }

    const yes = probability >= 0.5;
    mapped.push({ id: answer.name, answer: yes, confidence: yes ? probability : 1 - probability });
  }

  return mapped;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
