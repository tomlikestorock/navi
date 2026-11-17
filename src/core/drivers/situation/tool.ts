/** Tool detector: copy the tool-type signal from the RawInput. */

import type { RawInput, SituationDetector } from "../../situation/types.ts";

/** A tool name alone is weak evidence; it hints at scope, not concerns. */
const CONFIDENCE = 0.5;

export class ToolDetector implements SituationDetector {
  readonly type = "tool" as const;

  async detect(input: RawInput) {
    if (input.tool === undefined || input.tool === "") return null;
    return { tools: [input.tool], confidence: CONFIDENCE };
  }
}
