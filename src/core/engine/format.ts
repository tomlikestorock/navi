/** Hit formatting is a pure function of the hits. It lives apart
 * from the engine so a caller holding hits can render them without building
 * an engine or loading a corpus. */

import type { CorpusHit } from "../corpus/types.ts";

/** How the caller wants hits rendered. */
export type HitFormat = "inject" | "pack" | "json";

/** Roughly 50 tokens of excerpt per injected hit. */
const EXCERPT_TOKENS = 50;
/** Matched terms shown per injected hit before the rest are elided. */
const MATCH_TERMS_SHOWN = 3;

const INJECT_FRAMING = "Advisory concerns matched by the current work; not commands.";
const PACK_TRAILER =
  "Full content is read on demand only — follow the locations; the excerpts are locators, not the documents.";

/** A hit's federated identity: its fusion and formatting key. */
export function hitKey(hit: CorpusHit): string {
  return `${hit.corpus}:${hit.id}`;
}

export function formatHits(hits: CorpusHit[], format: HitFormat): string {
  if (format === "json") return `${JSON.stringify(hits, null, 2)}\n`;
  if (format === "pack") return formatPack(hits);
  return formatInject(hits);
}

function formatInject(hits: CorpusHit[]): string {
  const lines = [INJECT_FRAMING];
  if (hits.length === 0) lines.push("(no matches)");
  for (const hit of hits) {
    lines.push(`- ${hitKey(hit)} — ${truncate(hit.excerpt)}${formatProvenance(hit.matched_by)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Compact "why this hit ranked" suffix: at most MATCH_TERMS_SHOWN terms, with
 * the remainder counted rather than listed so one hit stays on one line. */
function formatProvenance(matchedBy: string[]): string {
  if (matchedBy.length === 0) return "";
  const shown = matchedBy.slice(0, MATCH_TERMS_SHOWN).join(", ");
  const hidden = matchedBy.length - MATCH_TERMS_SHOWN;
  return hidden > 0 ? ` (${shown} …+${hidden})` : ` (${shown})`;
}

function formatPack(hits: CorpusHit[]): string {
  if (hits.length === 0) return "No matching references.\n";

  const blocks = hits.map((hit) =>
    [`## ${hitKey(hit)}`, hit.title, truncate(hit.excerpt), `location: ${hit.location}`].join("\n"),
  );
  return `${blocks.join("\n\n")}\n\n${PACK_TRAILER}\n`;
}

/** ~50-token excerpt, ellipsized when the source is longer. */
function truncate(text: string): string {
  const tokens = text.split(/\s+/).filter((token) => token !== "");
  if (tokens.length <= EXCERPT_TOKENS) return tokens.join(" ");
  return `${tokens.slice(0, EXCERPT_TOKENS).join(" ")} …`;
}
