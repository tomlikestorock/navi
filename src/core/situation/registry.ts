/** Detector registry — detector types map to classes through the
 * shared TypeRegistry. Detectors are the situation-side
 * counterparts of corpus drivers; the same seam, the same failure discipline. */

import type { DetectorConfig } from "../config/schema.ts";
import { construct, TypeRegistry, type OptionsRecord, type TypeClass } from "../registry.ts";
import type { DetectorContext, SituationDetector } from "./types.ts";

/** A detector class: constructed synchronously with the standard setup seam,
 * optionally declaring the zod schema for `config.options`. */
export type DetectorClass<O extends OptionsRecord = OptionsRecord> = TypeClass<
  DetectorConfig,
  DetectorContext,
  SituationDetector,
  O
>;

/** Built-ins register here at CLI bootstrap; the registry is the detector
 * type vocabulary (a plugin can add one). */
export class DetectorRegistry extends TypeRegistry<
  DetectorConfig,
  DetectorContext,
  SituationDetector
> {
  constructor() {
    super("detector");
  }

  /** resolve → validate `options` against `optionsSchema` → construct. */
  load(config: DetectorConfig, ctx: DetectorContext): SituationDetector {
    return construct(this.resolve(config.type), config, ctx, this.label(config));
  }
}
