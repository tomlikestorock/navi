/** The embeddings tier.
 *
 * A provider turns a batch of texts into vectors. Transport is a direct HTTP
 * call in the OpenAI shape — hosted gateways and local servers (ollama,
 * llama.cpp, vLLM, LM Studio) speak the same protocol, so one type covers
 * both. Batching is the caller's job: one call = one request.
 *
 * `CorpusContext.embeddings(id)` resolves an id to a provider and its model id;
 * only referenced providers are ever built. Failure is loud — callers get an
 * `EmbeddingError`, never a half batch. */

import { z } from "zod";

import type { EmbeddingProviderConfig } from "../config/schema.ts";
import { expandEnv } from "../config/paths.ts";
import { postJson } from "../http.ts";

export interface EmbeddingProvider {
  /** One batched call: every text becomes one vector, same order in/out. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Builds the provider for one config entry. The seam tests inject through
 * (a counting factory proves laziness). */
export type EmbeddingFactory = (provider: EmbeddingProviderConfig) => EmbeddingProvider;

/** Any transport failure — network, non-2xx, timeout, or a body that is not
 * the embedding contract. Corpus callers degrade; they never see a half
 * batch. */
export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError";
}

/** The OpenAI response slice navi consumes. Vector length and count are
 * checked against the request rather than pinned: models differ. */
const EmbeddingResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()).min(1) })),
});

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  return { embed: (texts) => embedOpenAICompatible(texts, config) };
}

async function embedOpenAICompatible(
  texts: string[],
  config: EmbeddingProviderConfig,
): Promise<number[][]> {
  // No inputs, no request: an empty batch is not an error.
  if (texts.length === 0) return [];

  const label = `embedding provider "${config.id}"`;
  const headers: Record<string, string> = {};
  if (config.apiKey !== undefined) {
    headers.authorization = `Bearer ${expandEnv(config.apiKey)}`;
  }

  const parsed = await postJson(
    `${config.baseUrl.replace(/\/+$/, "")}/embeddings`,
    { model: config.model, input: texts },
    {
      label,
      timeoutMs: config.timeoutMs,
      headers,
      fail: (message, options) => new EmbeddingError(message, options),
    },
  );

  const result = EmbeddingResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new EmbeddingError(`${label}: response did not match the embedding contract`);
  }
  if (result.data.data.length !== texts.length) {
    throw new EmbeddingError(
      `${label}: returned ${result.data.data.length} vectors for ${texts.length} inputs`,
    );
  }
  return result.data.data.map((entry) => entry.embedding);
}
