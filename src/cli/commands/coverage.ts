/** One compact coverage note shared by `navi trace` and
 * `navi eval`, so both views name the same reductions. Empty when the corpus
 * reported no coverage (it failed). */

import type { CorpusCoverage } from "#core/index.ts";

export function coverageNote(coverage: CorpusCoverage | undefined): string {
  if (coverage === undefined) return "";

  const parts = [`seen ${coverage.seen}`];
  if (coverage.dropped > 0) parts.push(`dropped ${coverage.dropped} by cap`);
  if (coverage.vector_hits !== undefined) parts.push(`vector ${coverage.vector_hits}`);
  if (coverage.cold_count !== undefined) parts.push(`cold ${coverage.cold_count}`);
  return ` (${parts.join(", ")})`;
}
