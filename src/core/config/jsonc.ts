/** The one JSONC parser. Config load and the `corpus`
 * mutations read the same document shape, so a parse error and a diagnostic
 * derived from the tree always agree on file, line and column. */

import { existsSync, readFileSync } from "node:fs";

import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

import { ConfigError } from "./error.ts";

/** A 1-based position in the source text. */
export interface SourceLocation {
  line: number;
  column: number;
}

/** One parsed JSONC file: its text, its value, and where any node starts. */
export interface JsoncDocument {
  readonly file: string;
  readonly text: string;
  readonly value: unknown;
  /** Location of the node at `path`, or null when it does not exist. */
  readonly locate: (path: ReadonlyArray<string | number>) => SourceLocation | null;
}

/** Parse `text` for `file`; a malformed document fails with its location. */
export function parseJsonc(file: string, text: string): JsoncDocument {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new ConfigError(file, describeParseError(text, errors[0]));
  if (tree === undefined) throw new ConfigError(file, "invalid JSONC: no value");

  return {
    file,
    text,
    value: getNodeValue(tree),
    locate: (path) => locateNode(text, tree, path),
  };
}

/** Read and parse one file. `null` when it does not exist. */
export function readJsonc(file: string): JsoncDocument | null {
  return existsSync(file) ? parseJsonc(file, readFileSync(file, "utf8")) : null;
}

function locateNode(
  text: string,
  tree: Node,
  path: ReadonlyArray<string | number>,
): SourceLocation | null {
  const node = findNodeAtLocation(tree, [...path]);
  return node === undefined ? null : locateOffset(text, node.offset);
}

/** Offset → 1-based line and column. */
export function locateOffset(text: string, offset: number): SourceLocation {
  const before = text.slice(0, offset).split("\n");
  return {
    line: before.length,
    column: before[before.length - 1].length + 1,
  };
}

function describeParseError(text: string, error: ParseError): string {
  const { line, column } = locateOffset(text, error.offset);
  return `invalid JSONC at line ${line}, column ${column}: ${printParseErrorCode(error.error)}`;
}
