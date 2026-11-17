/** Options for the `files` corpus driver. Strict, so typo'd
 * keys fail loud at config load. */

import { z } from "zod";

export const filesOptionsSchema = z.strictObject({
  path: z.string().min(1).describe("Root directory to index; ~ and ${VAR} expanded"),
  extensions: z
    .array(z.string().regex(/^\./))
    .default([])
    .describe("File extensions to index; empty = all text files"),
  ignore: z.array(z.string()).default([]).describe("Glob patterns to skip (gitignore-style)"),
  maxFiles: z.number().int().min(1).default(5000).describe("Safety cap on scanned files"),
  /** Block on the first search and batch-embed every document,
   * so the vector tier is fully hot afterwards. Default is read-through:
   * embed the query plus the documents it retrieves, warming the hot set
   * with zero startup cost. */
  embedEager: z
    .boolean()
    .default(false)
    .describe(
      "Embed every document on first search (one-time blocking delay); default read-through",
    ),
});

export type FilesOptions = z.infer<typeof filesOptionsSchema>;
