/** The write-back shape for one turn.
 *
 * One session-scoped key means each admitted prompt replaces the previous
 * turn's block instead of stacking stale advice; an empty result evicts it.
 * The hits reaching this function have already been through the
 * policy pass (`policy.ts`). */

import type { CorpusHit } from "#core/index.ts";
import { formatHits } from "#core/index.ts";

/** Slash-free key; the server namespaces API entries itself. */
export const SURFACE_KEY = "navi-surface";

/** The advisory entry for this turn, or `null` when the search found nothing
 * (the caller removes the entry). `inject` keeps core's advisory framing. */
export function surfaceEntry(hits: CorpusHit[]): { key: string; value: string } | null {
  return hits.length === 0 ? null : { key: SURFACE_KEY, value: formatHits(hits, "inject") };
}
