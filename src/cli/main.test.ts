import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, vi } from "vite-plus/test";

import { withTempDirAsync } from "../test-support/tmp.ts";

import { emptySituation, readConfigFile } from "#core/index.ts";

import { configCheck, configShow, resolveConfig } from "./commands/config.ts";
import { corpusList } from "./commands/corpus.ts";
import { main } from "./main.ts";

/** Count config-file reads, to prove provenance costs no extra read. */
const configReads = vi.hoisted(() => new Map<string, number>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = (file: string, ...rest: unknown[]) => {
    if (file.endsWith("navi.json")) configReads.set(file, (configReads.get(file) ?? 0) + 1);
    return (actual.readFileSync as (file: string, ...rest: unknown[]) => string)(file, ...rest);
  };
  return { ...actual, readFileSync };
});

/** Run `body` against a throwaway directory holding one config file. */
async function fixture(jsonc: string, body: (file: string) => void | Promise<void>): Promise<void> {
  await withTempDirAsync("navi-cli-", async (dir) => {
    const file = join(dir, "navi.json");
    writeFileSync(file, jsonc);
    await body(file);
  });
}

/** Capture stdout/stderr for one `main` invocation. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => (out.push(String(chunk)), true));
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => (err.push(String(chunk)), true));
  try {
    return { code: await main(argv), out: out.join(""), err: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const config = `{
  // JSONC: comments and trailing commas are fine
  "corpuses": [
    { "id": "docs", "type": "files", "description": "Docs", "options": { "path": "." } },
    { "id": "notes", "type": "files", "disabled": true },
  ],
}
`;

test("config show prints the effective config as JSON", async () => {
  await fixture(config, (file) => {
    const shown = JSON.parse(configShow(file)) as { corpuses: Array<{ id: string }> };
    expect(shown.corpuses.map((corpus) => corpus.id)).toEqual(["docs", "notes"]);
    // The resolved anchor is internal: the output stays a valid input config.
    expect(shown.corpuses.some((corpus) => "baseDir" in corpus)).toBe(false);
  });
});

test("config check reports enabled/disabled counts", async () => {
  await fixture(config, async (file) => {
    await expect(configCheck(file)).resolves.toContain("1 enabled, 1 disabled");
  });
});

test("config check fails on a corpus that cannot be built", async () => {
  const broken = `{ "corpuses": [{ "id": "docs", "type": "nope" }] }`;
  await fixture(broken, async (file) => {
    // The kind vocabulary is closed, so a typo dies at config
    // validation — before any module is imported.
    await expect(configCheck(file)).rejects.toThrow(/corpuses\[0\]\.type: Invalid option/);
  });
  const noModule = `{ "corpuses": [{ "id": "docs", "type": "custom" }] }`;
  await fixture(noModule, async (file) => {
    await expect(configCheck(file)).rejects.toThrow(
      /corpuses\[0\]\.module: corpus "docs": type "custom" requires a "module"/,
    );
  });
});

test("config check gives detector failures a config-shaped diagnostic", async () => {
  const badOptions = `{ "corpuses": [], "analyzer": { "detectors": [
    { "id": "words", "type": "lexicon", "options": { "arenas": ["git"] } },
  ] } }`;
  await fixture(badOptions, async (file) => {
    // ConfigError, not a bare Error: the file prefixes the diagnostic.
    await expect(configCheck(file)).rejects.toThrow(
      /navi\.json: detector "words": options are not supported/,
    );
  });

  const unknownType = `{ "corpuses": [], "analyzer": { "detectors": [
    { "id": "brain", "type": "vibes" },
  ] } }`;
  await fixture(unknownType, async (file) => {
    await expect(configCheck(file)).rejects.toThrow(
      /unknown detector type "vibes" \(registered: command, lexicon, model, path, tool\)/,
    );
  });
});

test("config check accepts two instances of one detector type", async () => {
  const two = `{ "corpuses": [], "analyzer": { "detectors": [
    { "id": "git-words", "type": "lexicon" },
    { "id": "security-words", "type": "lexicon" },
  ] } }`;
  await fixture(two, async (file) => {
    await expect(configCheck(file)).resolves.toContain("config ok");
  });
});

test("corpus list shows id, type, baseDir and description, marking disabled", async () => {
  await fixture(config, (file) => {
    const lines = corpusList(file).trimEnd().split("\n");
    expect(lines[0]).toMatch(/^id\s+type\s+baseDir\s+description$/);
    expect(lines[1]).toMatch(/^docs\s+files\s+\S+\s+Docs$/);
    expect(lines[2]).toMatch(/^notes\s+files\s+\S+\s+\[disabled\]$/);
  });
});

test("corpus mutations route through main and write only the project file", async () => {
  await withTempDirAsync("navi-cli-", async (dir) => {
    const file = join(dir, "navi.json");
    writeFileSync(file, `{ "corpuses": [] }`);
    mkdirSync(join(dir, "docs"));
    const added = await run([
      "corpus",
      "add",
      "docs",
      "--type",
      "files",
      "--option",
      "path=./docs",
      "--description",
      "Docs",
      "--config",
      file,
    ]);
    expect(added.code).toBe(0);
    expect(readConfigFile(file)?.corpuses[0]).toMatchObject({ id: "docs", description: "Docs" });

    expect((await run(["corpus", "disable", "docs", "--config", file])).code).toBe(0);
    expect((await run(["corpus", "list", "--config", file])).out).toContain("[disabled]");
    expect((await run(["corpus", "enable", "docs", "--config", file])).code).toBe(0);
    expect((await run(["corpus", "remove", "docs", "--config", file])).code).toBe(0);
    expect(readConfigFile(file)?.corpuses).toEqual([]);

    // Missing/extra ids are usage errors, not silent no-ops.
    expect((await run(["corpus", "add", "--config", file])).code).toBe(2);
    expect((await run(["corpus", "remove", "a", "b", "--config", file])).code).toBe(2);
  });
});

test("corpus add reaches any driver through --option and --module", async () => {
  await withTempDirAsync("navi-cli-add-", async (dir) => {
    const file = join(dir, "navi.json");
    writeFileSync(file, `{ "corpuses": [] }`);
    const module = fileURLToPath(new URL("../../examples/copy-out/corpus.ts", import.meta.url));
    const notes = fileURLToPath(new URL("../../examples/copy-out/notes", import.meta.url));
    const web = await run([
      "corpus",
      "add",
      "blog",
      "--type",
      "web",
      "--option",
      'urls=["https://example.com"]',
      "--config",
      file,
    ]);
    expect(web.code).toBe(0);

    // A custom module is just another driver with its own options.
    const custom = await run([
      "corpus",
      "add",
      "notes",
      "--type",
      "custom",
      "--module",
      module,
      "--option",
      `path=${notes}`,
      "--config",
      file,
    ]);
    expect(custom.code).toBe(0);

    expect(readConfigFile(file)?.corpuses).toEqual([
      { id: "blog", type: "web", options: { urls: ["https://example.com"] } },
      { id: "notes", type: "custom", module, options: { path: notes } },
    ]);

    // Rejected by the driver → nothing written; a malformed pair → usage error.
    const before = readFileSync(file, "utf8");
    expect(
      (
        await run([
          "corpus",
          "add",
          "bad",
          "--type",
          "web",
          "--option",
          "urls=[]",
          "--config",
          file,
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await run([
          "corpus",
          "add",
          "bad",
          "--type",
          "files",
          "--option",
          "nokey",
          "--config",
          file,
        ])
      ).code,
    ).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

test("config check validates a models section without building any gateway", async () => {
  await fixture(
    `{
      "corpuses": [],
      "models": [
        { "id": "local", "model": "lmstudio/qwen", "runner": { "type": "opencode" } },
        {
          "id": "judge",
          "model": "jev/tev1",
          "preferSession": false,
          "runner": { "type": "systemone", "baseUrl": "http://127.0.0.1:11434" },
        },
      ],
    }`,
    async (file) => {
      // Unreferenced providers cost nothing: resolution is lazy.
      await expect(configCheck(file)).resolves.toContain("config ok");
    },
  );
});

test("config check fails on a model provider missing its model ref", async () => {
  const broken = `{ "corpuses": [], "models": [{ "id": "local", "runner": { "type": "opencode" } }] }`;
  await fixture(broken, async (file) => {
    await expect(configCheck(file)).rejects.toThrow(/models\[0\]\.model/);
  });
});

test("main returns 1 and a diagnostic when the config is broken", async () => {
  await fixture(`{ "corpuses": [{ "id": "Bad Id", "type": "files" }] }`, async (file) => {
    const result = await run(["config", "check", "--config", file]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`${file}:`);
  });
});

test("main exits 2 on usage errors and 0 for --help", async () => {
  expect((await run(["bogus"])).code).toBe(2);
  expect((await run([])).code).toBe(2);
  expect((await run(["config"])).code).toBe(2);
  expect((await run(["config", "bogus"])).code).toBe(2);
  expect((await run(["corpus", "list", "--nope"])).code).toBe(2);
  expect((await run(["corpus", "list", "--help"])).code).toBe(0);
});

test("analyze folds the CLI flags into a Situation and prints JSON", async () => {
  const result = await run([
    "analyze",
    "force-push to main",
    "--kind",
    "tool_call",
    "--paths",
    "src/a.ts, src/b.ts",
    "--tool",
    "bash",
  ]);

  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({
    ...emptySituation("force-push to main"),
    kinds: ["tool_call"],
    arenas: ["git"],
    patterns: ["force-push"],
    paths: ["src/a.ts", "src/b.ts"],
    tools: ["bash"],
    confidence: 0.6,
    detectors: ["lexicon", "path", "tool"],
  });

  expect((await run(["analyze"])).code).toBe(2);
  expect((await run(["analyze", "x", "--kind", "bogus"])).code).toBe(2);
});

test("trace routes through main and requires text", async () => {
  await fixture(`{ "corpuses": [] }`, async (file) => {
    const result = await run(["trace", "git push --force", "--config", file]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("contributions (before the fold)");

    expect((await run(["trace", "--config", file])).code).toBe(2);
  });
});

test("analyze runs the configured detector instances", async () => {
  await withTempDirAsync("navi-cli-", async (dir) => {
    const file = join(dir, "navi.json");
    const selected = `{
    "corpuses": [],
    "analyzer": { "detectors": [{ "id": "commands", "type": "command" }] }
  }`;
    const unknown = `{
    "corpuses": [],
    "analyzer": { "detectors": [{ "id": "brain", "type": "neural" }] }
  }`;
    writeFileSync(file, selected);
    const result = await run(["analyze", "git push --force origin main", "--config", file]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      tools: ["git"],
      patterns: ["push", "--force"],
      detectors: ["commands"],
    });

    writeFileSync(file, unknown);
    const rejected = await run(["analyze", "deploy", "--config", file]);
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain('unknown detector type "neural"');
  });
});

test("search and pack run the federated pipeline over the configured corpuses", async () => {
  await withTempDirAsync("navi-search-", async (dir) => {
    const docs = join(dir, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "force-push.md"), "Never force-push to a shared main branch.\n");
    const file = join(dir, "navi.json");
    writeFileSync(
      file,
      JSON.stringify({ corpuses: [{ id: "docs", type: "files", options: { path: docs } }] }),
    );
    const json = await run(["search", "force-push", "--json", "--config", file]);
    expect(json.code).toBe(0);
    const hits = JSON.parse(json.out) as Array<{ corpus: string; id: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ corpus: "docs", id: "force-push.md" });

    const inject = await run(["search", "force-push", "--config", file]);
    expect(inject.out).toContain("Advisory concerns");
    expect(inject.out).toContain("- docs:force-push.md — ");
    // Human output explains the ranking; `--json` above already carries raw matched_by.
    expect(inject.out).toContain("(text:force, text:push)");

    const packed = await run(["pack", "force-push", "--config", file]);
    expect(packed.out).toContain("## docs:force-push.md");
    expect(packed.out).toContain("read on demand");

    // --situation replaces the analyze step; missing hints default empty.
    const situationFile = join(dir, "situation.json");
    writeFileSync(situationFile, JSON.stringify({ text: "force-push" }));
    const fixture = await run(["search", "--situation", situationFile, "--json", "--config", file]);
    expect(fixture.code).toBe(0);
    expect(JSON.parse(fixture.out)).toHaveLength(1);
    const fixturePack = await run(["pack", "x", "--situation", situationFile, "--config", file]);
    expect(fixturePack.out).toContain("## docs:force-push.md");

    expect((await run(["search", "--config", file])).code).toBe(2);
    expect((await run(["search", "x", "--limit", "0", "--config", file])).code).toBe(2);
    expect((await run(["pack", "x", "--limit", "many", "--config", file])).code).toBe(2);
  });
});

test("read prints the file behind a hit, taking corpus:id or corpus/id", async () => {
  await withTempDirAsync("navi-read-", async (dir) => {
    const docs = join(dir, "docs");
    const content = "# Force push\n\nNever force-push to a shared main branch.\n";
    mkdirSync(join(docs, "guides"), { recursive: true });
    writeFileSync(join(docs, "guides", "force-push.md"), content);
    const file = join(dir, "navi.json");
    writeFileSync(
      file,
      JSON.stringify({ corpuses: [{ id: "docs", type: "files", options: { path: docs } }] }),
    );
    const plain = await run(["read", "docs:guides/force-push.md", "--config", file]);
    expect(plain.code).toBe(0);
    expect(plain.out).toBe(content);
    expect((await run(["read", "docs/guides/force-push.md", "--config", file])).out).toBe(content);

    const json = await run(["read", "docs:guides/force-push.md", "--json", "--config", file]);
    expect(JSON.parse(json.out)).toEqual({
      corpus: "docs",
      id: "guides/force-push.md",
      location: join(docs, "guides", "force-push.md"),
      content,
    });

    const unknownCorpus = await run(["read", "nope:force-push.md", "--config", file]);
    expect(unknownCorpus.code).toBe(1);
    expect(unknownCorpus.err).toContain('unknown corpus "nope"');

    const unknownId = await run(["read", "docs:missing.md", "--config", file]);
    expect(unknownId.code).toBe(1);
    expect(unknownId.err).toContain('no file "missing.md"');

    const outside = await run(["read", "docs:../navi.json", "--config", file]);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain('is not under corpus "docs"');

    // The seam is corpus-agnostic: a web corpus answers too (its cache is the
    // source, so an unfetched page is a driver-level error, not a CLI one).
    const webFile = join(dir, "web.json");
    writeFileSync(
      webFile,
      JSON.stringify({
        corpuses: [{ id: "blog", type: "web", options: { urls: ["http://127.0.0.1:9/a"] } }],
      }),
    );
    const webRead = await run(["read", "blog:http://127.0.0.1:9/a", "--config", webFile]);
    expect(webRead.code).toBe(1);
    expect(webRead.err).toContain("has not fetched");

    expect((await run(["read", "--config", file])).code).toBe(2);
    expect((await run(["read", "no-separator", "--config", file])).code).toBe(1);
  });
});

/** A repo with a project `navi.json` and a global one under a throwaway
 * `$XDG_CONFIG_HOME`, with cwd inside the repo (discovery, no `--config`). */
async function discoveryFixture(
  body: (files: { repo: string; project: string; global: string }) => Promise<void>,
): Promise<void> {
  await withTempDirAsync("navi-discover-", async (dir) => {
    const repo = join(dir, "repo");
    const project = join(repo, "navi.json");
    const global = join(dir, "xdg", "navi", "navi.json");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    mkdirSync(join(dir, "xdg", "navi"), { recursive: true });
    writeFileSync(
      project,
      JSON.stringify({
        corpuses: [{ id: "docs", type: "files", options: { path: "./docs" } }],
      }),
    );
    writeFileSync(global, JSON.stringify({ corpuses: [] }));
    writeFileSync(
      join(repo, "docs", "force-push.md"),
      "Never force-push to a shared main branch.\n",
    );

    const previousXdg = process.env.XDG_CONFIG_HOME;
    const previousCwd = process.cwd();
    process.env.XDG_CONFIG_HOME = join(dir, "xdg");
    process.chdir(join(repo, "src"));
    try {
      await body({ repo, project, global });
    } finally {
      process.chdir(previousCwd);
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });
}

test("a relative corpus path resolves against the declaring file from a subdirectory", async () => {
  await discoveryFixture(async () => {
    // navi-6dmy: `./docs` is relative to the project file, not to cwd.
    const result = await run(["search", "force-push", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject([{ corpus: "docs", id: "force-push.md" }]);
  });
});

test("discovery reads each config file once and anchors each corpus", async () => {
  await discoveryFixture(async ({ repo, project, global }) => {
    configReads.clear();

    const resolved = resolveConfig();

    expect(resolved.config.corpuses[0].baseDir).toBe(repo);
    expect(resolved.files).toEqual([global, project]);
    expect(configReads.get(global)).toBe(1);
    expect(configReads.get(project)).toBe(1);
  });
});
