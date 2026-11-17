/** The web corpus's HTTP fetch, HTML→text extraction and page
 * cache. Ranking lives in `search.ts`, so the network half and the ranking
 * half stay independently readable.
 *
 * Cache policy: fetch-once, append-only. A URL is fetched the first time a
 * search needs it and its extracted text is reused from then on; nothing
 * expires or re-fetches it. No ADR defines a refresh TTL, so none is invented
 * here — delete the cache file (or change the URL) to fetch again. */

import { appendJsonl, naviCachePath, readJsonl } from "../../../cache.ts";
import type { CorpusRead } from "../../../corpus/types.ts";
import type { WebOptions } from "./options.ts";

/** One cached page, one JSONL line. */
export interface Page {
  url: string;
  title: string;
  text: string;
}

/** Where a web corpus keeps its fetched pages. */
export function webCacheFile(corpusId: string): string {
  return naviCachePath("web", corpusId, "pages.jsonl");
}

/** Fetched pages keyed by url, or an empty map when nothing is cached yet. */
export function loadPages(file: string): Map<string, Page> {
  const pages = new Map<string, Page>();
  for (const page of readJsonl(file, isPage)) pages.set(page.url, page);
  return pages;
}

/** Append-only: a URL is fetched at most once, so records never change. */
export function appendPages(file: string, pages: Page[]): void {
  appendJsonl(file, pages);
}

function isPage(entry: unknown): entry is Page {
  const value = entry as Partial<Page> | null;
  return typeof value?.url === "string" && typeof value.text === "string";
}

/** By-id read: the extracted text of a configured page that has been
 * fetched. Only configured URLs are readable (a stale cache must not resurface
 * after the config drops a url, matching the search rule). */
export function readPage(corpusId: string, options: WebOptions, url: string): CorpusRead {
  const configured = options.urls.slice(0, options.maxPages);
  if (!configured.includes(url)) {
    throw new Error(`corpus "${corpusId}" has no page "${url}"`);
  }

  const page = loadPages(webCacheFile(corpusId)).get(url);
  if (page === undefined) {
    throw new Error(`corpus "${corpusId}" has not fetched "${url}" yet; run a search first`);
  }
  return { content: page.text, location: page.url };
}

/** A failed or timed-out page is skipped with a log; the cache stays usable. */
export async function fetchPage(
  url: string,
  timeoutMs: number,
  corpusId: string,
): Promise<Page | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { title, text } = extractText(await response.text());
    return { url, title, text };
  } catch (error) {
    console.error(`corpus "${corpusId}": failed to fetch ${url}: ${errorMessage(error)}`);
    return null;
  }
}

/** Crude HTML → text: drop non-visible elements, treat block tags as line
 * breaks, strip the rest, collapse whitespace. ponytail: no parser — nested
 * tables flatten and JS-rendered pages are empty; upgrade to a real HTML
 * parser when extraction quality starts affecting hits. */
export function extractText(html: string): { title: string; text: string } {
  const titleHtml = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const body = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
  return {
    title: decodeEntities(titleHtml).replace(/\s+/g, " ").trim(),
    text: decodeEntities(body),
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** ponytail: the handful of entities pages actually use; a named entity
 * outside this table stays literal rather than pulling in a full table. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const hex = name[1] === "x" || name[1] === "X";
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** Display fallback for a page with no `<title>`. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
