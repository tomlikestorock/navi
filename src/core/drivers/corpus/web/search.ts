/** Read-through web scan: fetch configured URLs once, cache their text on
 * disk, then rank cached + fresh text. Network is never trusted: one dead URL
 * degrades its own entry only, never the search.
 *
 * ranking is the shared hybrid retriever. Web embeds on read
 * — its fetch step already establishes the page text — so every fetched page
 * is warmed; this corpus has no eagerness knob. Fetching, extraction and the
 * page cache live in `pages.ts`. */

import { countTerms, tokenize, wordCount } from "../../../corpus/scoring.ts";
import type { Match } from "../../../corpus/scoring.ts";
import type { CorpusCoverage, CorpusHit } from "../../../corpus/types.ts";
import { rankHybrid } from "../../../embeddings/hybrid.ts";
import type { HybridEmbedding, HybridHit } from "../../../embeddings/hybrid.ts";
import type { WebOptions } from "./options.ts";
import { appendPages, fetchPage, hostnameOf, loadPages, webCacheFile } from "./pages.ts";
import type { Page } from "./pages.ts";

/** One corpus hit without its corpus id, which the corpus adds. */
type Hit = Omit<CorpusHit, "corpus">;

/** The ranked hits plus what the scan covered. */
interface WebSearchResult {
  hits: Hit[];
  coverage: CorpusCoverage;
}

/** Fetch every configured-but-uncached URL, then score the corpus. */
export async function searchWeb(
  query: string,
  corpusId: string,
  options: WebOptions,
  limit: number,
  embedding?: HybridEmbedding,
): Promise<WebSearchResult> {
  const terms = tokenize(query);
  if (terms.length === 0) return { hits: [], coverage: { seen: 0, dropped: 0 } };

  const cacheFile = webCacheFile(corpusId);
  const pages = loadPages(cacheFile);
  const urls = options.urls.slice(0, options.maxPages);
  const dropped = options.urls.length - urls.length;

  const missing = urls.filter((url) => !pages.has(url));
  const fresh = (
    await Promise.all(missing.map((url) => fetchPage(url, options.timeoutMs, corpusId)))
  ).filter((page): page is Page => page !== null);
  for (const page of fresh) pages.set(page.url, page);
  appendPages(cacheFile, fresh);

  // Only configured URLs are searchable: stale cache entries from a previous
  // config must not resurface as hits.
  const documents: Page[] = [];
  const matches: Array<Match<Page>> = [];
  for (const url of urls) {
    const page = pages.get(url);
    if (page === undefined) continue;
    documents.push(page);

    const haystack = page.text.toLowerCase();
    const counts = countTerms(haystack, terms);
    if (counts.every((count) => count === 0)) continue;
    matches.push({ item: page, counts, words: wordCount(haystack) });
  }

  const ranked = await rankHybrid(
    query,
    terms,
    {
      documents,
      matches,
      totalDocuments: documents.length,
      idOf: (page) => page.url,
      // A page's vector belongs to the exact text served at that address, so
      // an edited page never reuses a stale one.
      keyTextOf: (page) => `${page.url}\n${page.text}`,
      textOf: (page) => page.text,
    },
    limit,
    embedding,
  );
  return {
    hits: ranked.hits.map(toHit),
    coverage: {
      seen: documents.length,
      dropped,
      ...(ranked.vectors === undefined
        ? {}
        : { vector_hits: ranked.vectors.covered, cold_count: ranked.vectors.cold }),
    },
  };
}

/** One ranked page as a corpus hit. */
function toHit({ item: page, excerpt, score, matchedBy }: HybridHit<Page>): Hit {
  return {
    id: page.url,
    title: page.title || hostnameOf(page.url),
    excerpt,
    location: page.url,
    score,
    matched_by: matchedBy,
  };
}
