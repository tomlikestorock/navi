/** `navi pack "task"` — the same federated search
 * as `navi search`, rendered as a reference block for handing to another
 * agent. Full content stays behind `location`; nothing is inlined. */

import { retrieve, type SearchCommandOptions } from "./search.ts";

export async function pack(text: string, options: SearchCommandOptions): Promise<string> {
  const { format } = await retrieve(text, options);
  return format("pack");
}
