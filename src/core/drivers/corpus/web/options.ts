/** Options for the `web` corpus driver. Strict, so typo'd keys
 * fail loud at config load. No cache dir option: cache location is standard.
 * The page cache is fetch-once (see `pages.ts`). */

import { z } from "zod";

export const webOptionsSchema = z.strictObject({
  urls: z.array(z.string().url()).min(1).describe("Pages to fetch and search"),
  maxPages: z.number().int().min(1).default(10).describe("Safety cap on configured URLs"),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .default(5000)
    .describe("Per-request abort timeout in milliseconds"),
});

export type WebOptions = z.infer<typeof webOptionsSchema>;
