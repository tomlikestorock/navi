/** navi-0vye: the fixed end-to-end fixture shared by the golden suites.
 *
 * One files corpus over two tmpdir docs, one web corpus over two served
 * pages, one config declaring both. Fixed inputs and fixed expected hits let
 * the analyzer, the corpus drivers and the fusion engine be swapped without
 * silently changing the pipeline contract. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The known query both golden suites trace end to end. */
export const GOLDEN_QUERY = "git push --force";

/** Served pages: /a matches the query, /b is a decoy that must stay out. */
const PAGES: Record<string, string> = {
  "/a": "<html><head><title>Git Notes</title></head><body><p>Force push rewrites history.</p></body></html>",
  "/b": "<html><body><p>Branch protection blocks direct commits.</p></body></html>",
};

export interface GoldenFixture {
  /** The fixture's navi.json, declaring both corpuses. */
  configFile: string;
  /** The files corpus root, holding git.md and force-push.md. */
  docsDir: string;
  /** Server origin: pages are `${base}/a` and `${base}/b`. */
  base: string;
}

export async function withGoldenPipeline(
  body: (fixture: GoldenFixture) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    const html = PAGES[request.url ?? ""];
    if (html === undefined) response.writeHead(404).end("missing");
    else response.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const dir = mkdtempSync(join(tmpdir(), "navi-golden-"));
  const docs = join(dir, "docs");
  mkdirSync(docs);
  writeFileSync(join(docs, "git.md"), "git push origin main\n");
  writeFileSync(join(docs, "force-push.md"), "Never force-push to a shared main branch.\n");

  const configFile = join(dir, "navi.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      corpuses: [
        { id: "files", type: "files", options: { path: "./docs", extensions: [".md"] } },
        { id: "web", type: "web", options: { urls: [`${base}/a`, `${base}/b`] } },
      ],
    }),
  );

  // The web driver caches fetched pages under the standard location; keep the
  // fixture off the developer's real cache and out of the next run.
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(dir, "cache");

  try {
    await body({ configFile, docsDir: docs, base });
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}
