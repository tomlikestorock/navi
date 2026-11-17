/** A deterministic, hash-based provider for tests — no network,
 * no model. Same text always yields the same vector; texts sharing tokens
 * land closer under cosine, so hybrid-retrieval ordering is meaningful.
 *
 * Each `embed` call is recorded, so tests can assert batching discipline
 * (arrays per call, never per-doc calls). */

import type { EmbeddingProvider } from "./embed.ts";

/** Default vector width. Small on purpose: tests read these as data. */
const DEFAULT_DIMENSIONS = 64;

export class FakeEmbeddingProvider implements EmbeddingProvider {
  /** Every batch in order, so tests can assert call counts and inputs. */
  readonly calls: string[][] = [];
  readonly #dimensions: number;

  constructor(dimensions: number = DEFAULT_DIMENSIONS) {
    this.#dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => vectorFor(text, this.#dimensions));
  }
}

/** Bag-of-token hashing: token → bucket, count added. Cosine between two
 * texts therefore grows with shared vocabulary. */
function vectorFor(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    vector[hash(token) % dimensions] += 1;
  }
  return vector;
}

/** FNV-1a, 32-bit. */
function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  }
  return value >>> 0;
}
