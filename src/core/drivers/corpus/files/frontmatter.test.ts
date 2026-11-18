import { expect, test } from "vite-plus/test";

import { parseSurfacingFrontmatter } from "./frontmatter.ts";

test("parses scalars, inline arrays and numbers", () => {
  const text = [
    "---",
    "title: Force push",
    "surfacing:",
    "  repeat: once",
    "  force: [anthropic/claude-haiku, openai/gpt-5]",
    "  priority: 2",
    "---",
    "Body.",
  ].join("\n");

  expect(parseSurfacingFrontmatter(text)).toEqual({
    repeat: "once",
    force: ["anthropic/claude-haiku", "openai/gpt-5"],
    priority: 2,
  });
});

test("parses the turn-relative knobs", () => {
  const text = ["---", "surfacing:", "  minTurn: 4", "  cooldown: 3", "---", "Body."].join("\n");

  expect(parseSurfacingFrontmatter(text)).toEqual({ minTurn: 4, cooldown: 3 });
});

test("parses block lists and quoted scalars", () => {
  const text = [
    "---",
    "surfacing:",
    "  force:",
    "    - 'anthropic/claude-haiku'",
    '    - "openai/gpt-5"',
    "---",
    "",
  ].join("\n");

  expect(parseSurfacingFrontmatter(text)).toEqual({
    force: ["anthropic/claude-haiku", "openai/gpt-5"],
  });
});

test("absent, unclosed and non-leading blocks are ignored", () => {
  expect(parseSurfacingFrontmatter("Body only.\n")).toBeUndefined();
  expect(parseSurfacingFrontmatter("---\nsurfacing:\n  repeat: once\n")).toBeUndefined();
  expect(
    parseSurfacingFrontmatter("intro\n---\nsurfacing:\n  repeat: once\n---\n"),
  ).toBeUndefined();
  expect(parseSurfacingFrontmatter("---\ntitle: x\n---\nbody\n")).toBeUndefined();
});

test("malformed or unknown keys yield no surfacing instead of throwing", () => {
  expect(parseSurfacingFrontmatter("---\nsurfacing:\n  repeat: sometimes\n---\n")).toBeUndefined();
  expect(parseSurfacingFrontmatter("---\nsurfacing:\n  sneaky: true\n---\n")).toBeUndefined();
  expect(parseSurfacingFrontmatter("---\nsurfacing:\n  not a pair\n---\n")).toBeUndefined();
  expect(parseSurfacingFrontmatter("---\nsurfacing: everything\n---\n")).toBeUndefined();
});
