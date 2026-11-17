/** The runner gateways.
 *
 * `opencode` spawns `opencode run --format json -m <model>` and scrapes the
 * assistant text out of the JSONL event stream; `systemone` POSTs the Jev
 * decision API. Both are the only declared runner types, so a configured
 * provider always resolves to a working transport.
 *
 * Everything here is advisory: any failure throws `GatewayError` and the
 * detector degrades. */

import { spawn } from "node:child_process";

import { z } from "zod";

import type { ModelProviderConfig } from "../config/schema.ts";
import {
  AnswerSchema,
  GatewayError,
  type Answer,
  type GatewayFactory,
  type ModelGateway,
  type PredicateQuestion,
} from "./gateway.ts";
import { createSystemoneGateway } from "./systemone.ts";

/** The answer contract the model must return as JSON. */
const AnswerEnvelopeSchema = z.object({ answers: z.array(AnswerSchema) });

/** One process per `ask`. */
export function createOpencodeGateway(provider: ModelProviderConfig): ModelGateway {
  return {
    ask: (questions, text) => runOpencode(questions, text, provider),
  };
}

/** Resolve a provider to its runner. Standalone runs always use a runner,
 * regardless of `preferSession`; the harness session
 * branch is the future plugin's job and slots in as another `GatewayFactory`. */
export const createRunnerGateway: GatewayFactory = (provider) => {
  switch (provider.runner.type) {
    case "opencode":
      return createOpencodeGateway(provider);
    case "systemone":
      return createSystemoneGateway(provider);
  }
};

async function runOpencode(
  questions: PredicateQuestion[],
  text: string,
  provider: ModelProviderConfig,
): Promise<Answer[]> {
  const args = ["run", "--format", "json", "-m", provider.model, promptFor(questions, text)];

  let stdout: string;
  let stderr: string;
  let code: number | null;
  try {
    ({ stdout, stderr, code } = await collect(args, provider.timeoutMs));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(`model provider "${provider.id}": opencode run failed to start`, {
      cause: error,
    });
  }

  if (code !== 0) {
    throw new GatewayError(
      `model provider "${provider.id}": opencode run exited ${code ?? "without a code"}: ${stderr.trim()}`,
    );
  }
  return parseAnswers(assistantText(stdout));
}

/** Spawn, capture, and enforce the timeout. The abort signal both kills the
 * child and rejects this promise, so a slow runner cannot wedge a detector. */
function collect(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const child = spawn("opencode", args, { signal, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      reject(
        signal.aborted
          ? new GatewayError(`opencode run timed out after ${timeoutMs}ms`)
          : new GatewayError(`opencode run failed: ${error.message}`, { cause: error }),
      );
    });
    child.on("close", (code) => {
      if (signal.aborted) {
        reject(new GatewayError(`opencode run timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      });
    });
  });
}

/** The ONE prompt shape the runner sends. The detector owns the vocabulary
 * and the questions; this only renders them and pins the answer contract. */
function promptFor(questions: PredicateQuestion[], text: string): string {
  const list = questions.map((question) => `- ${question.id}: ${question.prompt}`).join("\n");
  return [
    "Answer every yes/no question about the text below.",
    "",
    "TEXT:",
    text,
    "",
    "QUESTIONS:",
    list,
    "",
    "Reply with JSON only, no prose:",
    '{"answers":[{"id":"<question id>","answer":true,"confidence":0.0}]}',
    "confidence is 0..1. Include one answer per question.",
  ].join("\n");
}

/** Concatenate the assistant text deltas from `opencode run --format json`.
 * Events are `{ type, timestamp, sessionID, part }`; text parts are deltas, so
 * the answer is their concatenation (not any single event). */
function assistantText(stdout: string): string {
  let text = "";
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new GatewayError(`opencode run produced non-JSON output: ${line.slice(0, 120)}`);
    }
    const part = (event as { part?: { type?: string; text?: string } }).part;
    if (part?.type === "text" && typeof part.text === "string") text += part.text;
  }
  if (text === "") throw new GatewayError("opencode run produced no assistant text");
  return text;
}

/** Pull the answer envelope out of the assistant text. Models fence JSON in
 * markdown or add a sentence; take the outermost braces, then validate. */
function parseAnswers(text: string): Answer[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = start === -1 || end < start ? text : text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new GatewayError("opencode run returned unparseable answers");
  }

  const result = AnswerEnvelopeSchema.safeParse(parsed);
  if (!result.success)
    throw new GatewayError("opencode run returned answers that break the contract");
  return result.data.answers;
}
