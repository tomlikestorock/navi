/** Emit `navi.schema.json` from the zod config schema.
 * Run: `vp run schema`; the committed file is guarded by schema.test.ts.
 * `io: "input"` is what an editor needs: fields with defaults
 * are optional to write, not required, even though parsing always fills them.
 * The cross-field rule lives with the schema, not here (naviConfigJsonSchema). */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { naviConfigJsonSchema } from "../src/core/config/schema.ts";

const out = join(import.meta.dirname, "..", "navi.schema.json");
writeFileSync(out, `${JSON.stringify(naviConfigJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
