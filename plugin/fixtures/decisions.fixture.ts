/** A recorded shape of `ctx.experimental.generate.decisions` (OpenCode
 * 2.3.0): one probability per predicate, plus the harness's `error` answer
 * variant. Unit tests pin the mapping against this, so an API shape drift is
 * visible before a live session. */

import type { DecisionsResult } from "../gateway.ts";

export const DECISIONS_RESPONSE: DecisionsResult = {
  answers: [
    { type: "predicate", name: "arena:git", probability: 0.92 },
    { type: "predicate", name: "arena:deploy", probability: 0.31 },
    { type: "predicate", name: "intent:rewrite-history", probability: 0.5 },
  ],
};

/** One predicate failed inside the session: the batch is not a half answer. */
export const DECISIONS_ERROR_RESPONSE: DecisionsResult = {
  answers: [
    { type: "predicate", name: "arena:git", probability: 0.7 },
    { type: "error", name: "intent:rewrite-history" },
  ],
};
