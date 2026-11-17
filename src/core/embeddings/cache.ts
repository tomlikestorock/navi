/** The local vector cache.
 *
 * Append-only JSONL keyed by document content hash *and* provider model id,
 * so a hosted model bump invalidates every entry. Retrieval is a brute-force
 * cosine scan: milliseconds at corpus scale, no index until a scan hurts.
 *
 * ponytail: entries from a previous model linger rather than being pruned on
 * load; prune when the file size measurably hurts. */

import { createHash } from "node:crypto";

import { naviCachePath, readJsonl } from "../cache.ts";

/** One cached document vector. */
export interface CachedVector {
  key: string;
  vector: number[];
}

/** Where a corpus keeps its vectors. */
export function vectorCacheFile(corpusId: string): string {
  return naviCachePath("embeddings", corpusId, "vectors.jsonl");
}

/** Content hash + model id: different content and different models never
 * share a vector. */
export function vectorKey(model: string, content: string): string {
  return `${model}:${createHash("sha256").update(content).digest("hex")}`;
}

/** Read the cache, or an empty map when there is none. */
export function loadVectors(file: string): Map<string, number[]> {
  const vectors = new Map<string, number[]>();
  for (const entry of readJsonl(file, isCachedVector)) vectors.set(entry.key, entry.vector);
  return vectors;
}

function isCachedVector(entry: unknown): entry is CachedVector {
  const value = entry as Partial<CachedVector> | null;
  return typeof value?.key === "string" && Array.isArray(value.vector);
}
