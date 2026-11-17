import { expect, test } from "vite-plus/test";

import type { ModelProviderConfig } from "#core/config/schema.ts";
import { GatewayError, type ModelGateway, type PredicateQuestion } from "#core/models/gateway.ts";

import { DECISIONS_ERROR_RESPONSE, DECISIONS_RESPONSE } from "./fixtures/decisions.fixture.ts";
import {
  answersFrom,
  createHarnessGatewayFactory,
  createSessionGateway,
  gatewayKind,
  parseModelRef,
  type DecisionsApi,
} from "./gateway.ts";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    id: "decider",
    model: "anthropic/claude-haiku",
    preferSession: true,
    runner: { type: "opencode" },
    timeoutMs: 2000,
    ...overrides,
  };
}

function questions(): PredicateQuestion[] {
  return [
    { id: "arena:git", prompt: 'Is "git" an area this text concerns?' },
    { id: "arena:deploy", prompt: 'Is "deploy" an area this text concerns?' },
    {
      id: "intent:rewrite-history",
      prompt: 'Does this text express the "rewrite-history" intent?',
    },
  ];
}

test("model refs split on the first slash", () => {
  expect(parseModelRef("anthropic/claude-haiku")).toEqual({
    providerID: "anthropic",
    id: "claude-haiku",
  });
  expect(parseModelRef("openrouter/meta/llama-3")).toEqual({
    providerID: "openrouter",
    id: "meta/llama-3",
  });
  expect(() => parseModelRef("no-slash")).toThrow(GatewayError);
});

test("preferSession picks the session only when the harness has decisions", () => {
  expect(gatewayKind(provider(), true)).toBe("session");
  expect(gatewayKind(provider(), false)).toBe("runner");
  expect(gatewayKind(provider({ preferSession: false }), true)).toBe("runner");
  expect(gatewayKind(provider({ preferSession: false }), false)).toBe("runner");
});

test("a harness without a decisions API falls back to the runner", () => {
  const used: string[] = [];
  const runner = (config: ModelProviderConfig): ModelGateway => {
    used.push(config.id);
    return { ask: async () => [] };
  };
  const factory = createHarnessGatewayFactory(undefined, runner);
  factory(provider());
  expect(used).toEqual(["decider"]);
});

test("preferSession resolves through the session gateway", async () => {
  const seen: unknown[] = [];
  const decisions: DecisionsApi = async (input) => {
    seen.push(input);
    return DECISIONS_RESPONSE;
  };

  const answers = await createSessionGateway(decisions, provider()).ask(
    questions(),
    "git push --force",
  );

  expect(seen[0]).toEqual({
    model: { providerID: "anthropic", id: "claude-haiku" },
    input: [{ type: "text", text: "git push --force" }],
    questions: questions().map((question) => ({
      type: "predicate",
      name: question.id,
      instructions: question.prompt,
    })),
  });
  expect(answers).toEqual([
    { id: "arena:git", answer: true, confidence: 0.92 },
    { id: "arena:deploy", answer: false, confidence: 0.69 },
    { id: "intent:rewrite-history", answer: true, confidence: 0.5 },
  ]);
});

test("probabilities map onto navi's answer contract", () => {
  expect(answersFrom("decider", questions(), DECISIONS_RESPONSE.answers)).toHaveLength(3);
  expect(
    answersFrom("decider", questions(), [{ type: "predicate", name: "unknown", probability: 1 }]),
  ).toEqual([]);
});

test("an errored answer degrades the batch instead of half-answering", () => {
  expect(() => answersFrom("decider", questions(), DECISIONS_ERROR_RESPONSE.answers)).toThrow(
    GatewayError,
  );
});

test("an invalid probability is a gateway failure", () => {
  expect(() =>
    answersFrom("decider", questions(), [
      { type: "predicate", name: "arena:git", probability: 1.5 },
    ]),
  ).toThrow(GatewayError);
  expect(() =>
    answersFrom("decider", questions(), [{ type: "predicate", name: "arena:git" }]),
  ).toThrow(GatewayError);
});

test("an API failure surfaces as a GatewayError naming the provider", async () => {
  const decisions: DecisionsApi = async () => {
    throw new Error("provider not authenticated");
  };
  await expect(createSessionGateway(decisions, provider()).ask(questions(), "x")).rejects.toThrow(
    'model provider "decider": session decisions failed: provider not authenticated',
  );
});
