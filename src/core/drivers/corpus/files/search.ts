/** Direct file scan: walk, filter, read. No index — ponytail: add an index
 * when a scan measurably hurts; at a few thousand files it does not.
 *
 * ranking (lexical + cosine fusion, warming, degradation) is
 * the shared hybrid retriever under `core/embeddings/`; this driver only
 * scans and maps the ranked result to hits. */

import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { countTerms, tokenize, wordCount } from "../../../corpus/scoring.ts";
import type { Match } from "../../../corpus/scoring.ts";
import type { CorpusCoverage, CorpusHit, CorpusRead } from "../../../corpus/types.ts";
import { rankHybrid } from "../../../embeddings/hybrid.ts";
import type { HybridEmbedding, HybridHit } from "../../../embeddings/hybrid.ts";
import { parseSurfacingFrontmatter } from "./frontmatter.ts";
import type { FilesOptions } from "./options.ts";

/** One corpus hit without its corpus id, which the corpus adds. */
type Hit = Omit<CorpusHit, "corpus">;

/** The ranked hits plus what the scan covered. */
interface FilesSearchResult {
  hits: Hit[];
  coverage: CorpusCoverage;
}

/** Score every readable text file under `root` and return the top `limit`. */
export async function searchFiles(
  query: string,
  root: string,
  options: FilesOptions,
  limit: number,
  embedding?: HybridEmbedding,
): Promise<FilesSearchResult> {
  const terms = tokenize(query);
  if (terms.length === 0) return { hits: [], coverage: { seen: 0, dropped: 0 } };

  const { matches, documents, scannedFiles, dropped } = scan(
    root,
    options,
    terms,
    embedding !== undefined,
  );
  const ranked = await rankHybrid(
    query,
    terms,
    {
      documents,
      matches,
      totalDocuments: scannedFiles,
      idOf: (doc) => doc.file.relPath,
      keyTextOf: (doc) => doc.text,
      textOf: (doc) => doc.text,
    },
    limit,
    embedding,
  );
  return {
    hits: ranked.hits.map(toHit),
    coverage: {
      seen: scannedFiles,
      dropped,
      ...(ranked.vectors === undefined
        ? {}
        : { vector_hits: ranked.vectors.covered, cold_count: ranked.vectors.cold }),
    },
  };
}

/** By-id read: the content behind one hit, resolved with the same
 * walk/ignore/extension/maxFiles rules the search uses, so `read` can never
 * surface something `search` would not. Traversal is rejected before lookup. */
export function readFileIn(
  root: string,
  options: FilesOptions,
  corpusId: string,
  id: string,
): CorpusRead {
  const location = resolve(root, id);
  const rel = relative(root, location);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`"${id}" is not under corpus "${corpusId}" (${root})`);
  }

  const relPath = rel.split(sep).join("/");
  const file = walk(root, options).files.find((entry) => entry.relPath === relPath);
  if (file === undefined) {
    throw new Error(`corpus "${corpusId}" has no file "${id}"`);
  }
  return { content: readFileSync(file.location, "utf8"), location: file.location };
}

/** A text file read during the scan. */
interface Doc {
  file: WalkedFile;
  text: string;
}

/** Read every readable text file once. `keepAll` retains documents that
 * matched no query term — only an embedding setup needs them: a cached vector
 * still ranks them even when this query reached them lexically. */
function scan(
  root: string,
  options: FilesOptions,
  terms: string[],
  keepAll: boolean,
): { matches: Array<Match<Doc>>; documents: Doc[]; scannedFiles: number; dropped: number } {
  const matches: Array<Match<Doc>> = [];
  const documents: Doc[] = [];
  let scannedFiles = 0;

  const { files, dropped } = walk(root, options);
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.location, "utf8");
    } catch {
      continue; // unreadable file: one corpus degrades, not the search
    }
    if (content.includes("\0")) continue; // not a text file

    scannedFiles += 1;
    const doc = { file, text: content };
    const haystack = content.toLowerCase();
    const counts = countTerms(haystack, terms);
    const matched = !counts.every((count) => count === 0);
    if (matched) matches.push({ item: doc, counts, words: wordCount(haystack) });
    if (matched || keepAll) documents.push(doc);
  }

  return { matches, documents, scannedFiles, dropped };
}

/** One ranked document as a corpus hit. */
function toHit({ item: doc, excerpt, score, matchedBy }: HybridHit<Doc>): Hit {
  const surfacing = parseSurfacingFrontmatter(doc.text);
  return {
    id: doc.file.relPath,
    location: doc.file.location,
    title: basename(doc.file.relPath),
    excerpt,
    score,
    matched_by: matchedBy,
    ...(surfacing === undefined ? {} : { surfacing }),
  };
}

interface WalkedFile {
  relPath: string;
  location: string;
}

/** Never worth indexing: the git object store. */
const ALWAYS_IGNORE = ".git";

function walk(root: string, options: FilesOptions): { files: WalkedFile[]; dropped: number } {
  const ignore = options.ignore.map(globToRegExp);
  const extensions = new Set(options.extensions.map((extension) => extension.toLowerCase()));
  const files: WalkedFile[] = [];

  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relPath = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (relPath === ALWAYS_IGNORE || relPath.startsWith(`${ALWAYS_IGNORE}/`)) continue;
    if (extensions.size > 0 && !extensions.has(extname(relPath).toLowerCase())) continue;
    if (ignore.some((pattern) => isIgnored(pattern, relPath))) continue;

    files.push({ relPath, location: join(root, relPath) });
  }

  // Filesystem order varies; sort before the cap so both are deterministic.
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    files: files.slice(0, options.maxFiles),
    dropped: Math.max(0, files.length - options.maxFiles),
  };
}

/** Minimal gitignore-style glob: `**` crosses directories, `*` does not.
 * A pattern without a slash matches any path segment, so ignoring a
 * directory also ignores everything beneath it. */
function globToRegExp(glob: string): RegExp {
  let pattern = glob.startsWith("./") ? glob.slice(2) : glob;
  if (pattern.endsWith("/")) pattern += "**";
  const anchored = pattern.includes("/");
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}$`);
}

function isIgnored(pattern: RegExp, relPath: string): boolean {
  const segments = relPath.split("/");
  for (let depth = 1; depth <= segments.length; depth += 1) {
    if (pattern.test(segments.slice(0, depth).join("/"))) return true;
  }
  return false;
}
