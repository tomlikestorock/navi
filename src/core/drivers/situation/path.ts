/** Path detector: copy filesystem signals from the RawInput. */

import type { RawInput, SituationDetector } from "../../situation/types.ts";

/** Paths alone are weak evidence; they hint at scope, not concerns. */
const CONFIDENCE = 0.5;

export class PathDetector implements SituationDetector {
  readonly type = "path" as const;

  async detect(input: RawInput) {
    if (input.paths === undefined || input.paths.length === 0) return null;
    return { paths: [...new Set(input.paths)], confidence: CONFIDENCE };
  }
}
