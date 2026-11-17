import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";

import { expect, test } from "vite-plus/test";

import { withTempDirAsync } from "../../test-support/tmp.ts";

import { readConfigFile } from "#core/index.ts";

import { corpusAdd, corpusDisable, corpusEnable, corpusRemove } from "./corpus.ts";

/** One throwaway project directory; `null` starts with no config file. */
async function fixture(jsonc: string | null, body: (file: string) => Promise<void>): Promise<void> {
  await withTempDirAsync("navi-corpus-", async (dir) => {
    const file = join(dir, "navi.json");
    if (jsonc !== null) writeFileSync(file, jsonc);
    await body(file);
  });
}

const COMMENTED = `// keep this comment
{
  "corpuses": [
    { "id": "adrs", "type": "files", "options": { "path": "./adr" } }, // and this one
  ],
}
`;

test("add creates a missing config file with a files entry", async () => {
  await fixture(null, async (file) => {
    mkdirSync(join(dirname(file), "docs"));

    const message = await corpusAdd(["docs"], {
      configFile: file,
      type: "files",
      driverOptions: { path: "./docs", extensions: [".md", ".ts"] },
      description: "Docs",
    });

    expect(message).toContain('added "docs"');
    expect(readConfigFile(file)?.corpuses).toEqual([
      {
        id: "docs",
        type: "files",
        description: "Docs",
        options: { path: "./docs", extensions: [".md", ".ts"] },
      },
    ]);
  });
});

test("add passes options verbatim, so every driver takes the same path", async () => {
  await fixture(null, async (file) => {
    await corpusAdd(["blog"], {
      configFile: file,
      type: "web",
      driverOptions: { urls: ["https://example.com"], maxPages: 3 },
    });

    expect(readConfigFile(file)?.corpuses[0]).toEqual({
      id: "blog",
      type: "web",
      options: { urls: ["https://example.com"], maxPages: 3 },
    });
  });
});

test("add rejects options the driver schema rejects", async () => {
  await fixture(null, async (file) => {
    await expect(
      corpusAdd(["blog"], { configFile: file, type: "web", driverOptions: { url: "x" } }),
    ).rejects.toThrow(/invalid options/);
    await expect(
      corpusAdd(["docs"], {
        configFile: file,
        type: "files",
        driverOptions: { path: ".", nope: true },
      }),
    ).rejects.toThrow(/invalid options/);
    expect(() => readFileSync(file, "utf8")).toThrow();
  });
});

test("add appends and preserves comments and layout", async () => {
  await fixture(COMMENTED, async (file) => {
    mkdirSync(join(dirname(file), "docs"));

    await corpusAdd(["docs"], {
      configFile: file,
      type: "files",
      driverOptions: { path: "./docs" },
    });

    const text = readFileSync(file, "utf8");
    expect(text).toContain("// keep this comment");
    expect(text).toContain("// and this one");
    expect(readConfigFile(file)?.corpuses.map((corpus) => corpus.id)).toEqual(["adrs", "docs"]);
  });
});

test("add rejects a duplicate id and leaves the file untouched", async () => {
  await fixture(COMMENTED, async (file) => {
    const before = readFileSync(file, "utf8");

    await expect(
      corpusAdd(["adrs"], {
        configFile: file,
        type: "files",
        driverOptions: { path: "./adr" },
      }),
    ).rejects.toThrow(/already exists/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

test("add rejects an entry that cannot be built and writes nothing", async () => {
  await fixture(null, async (file) => {
    await expect(
      corpusAdd(["ghost"], {
        configFile: file,
        type: "files",
        driverOptions: { path: "./missing" },
      }),
    ).rejects.toThrow(/not a directory/);
    await expect(
      corpusAdd(["ghost"], { configFile: join(dirname(file), "other.json"), type: "nope" }),
    ).rejects.toThrow(/unknown corpus type "nope"/);
    expect(() => readFileSync(file, "utf8")).toThrow();
  });
});

test("remove deletes the entry, keeps comments, and fails when absent", async () => {
  await fixture(COMMENTED, async (file) => {
    const message = corpusRemove(["adrs"], { configFile: file });

    expect(message).toContain('removed "adrs"');
    expect(readFileSync(file, "utf8")).toContain("// keep this comment");
    expect(readConfigFile(file)?.corpuses).toEqual([]);
    expect(() => corpusRemove(["adrs"], { configFile: file })).toThrow(/is not in/);
  });
});

test("disable and enable toggle the flag in place", async () => {
  await fixture(COMMENTED, async (file) => {
    mkdirSync(join(dirname(file), "adr"));

    corpusDisable(["adrs"], { configFile: file });
    expect(readConfigFile(file)?.corpuses).toEqual([
      { id: "adrs", type: "files", options: { path: "./adr" }, disabled: true },
    ]);
    expect(readFileSync(file, "utf8")).toContain("// keep this comment");

    await corpusEnable(["adrs"], { configFile: file });
    expect(readConfigFile(file)?.corpuses).toEqual([
      { id: "adrs", type: "files", options: { path: "./adr" } },
    ]);
  });
});

test("disable shadows a global-only corpus without touching the global file", async () => {
  await withTempDirAsync("navi-corpus-global-", async (dir) => {
    const repo = join(dir, "repo");
    const global = join(dir, "xdg", "navi", "navi.json");
    const project = join(repo, "navi.json");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(dir, "xdg", "navi"), { recursive: true });
    const globalText = `{ "corpuses": [{ "id": "wiki", "type": "files", "options": { "path": "~/wiki" } }] }`;
    writeFileSync(global, globalText);

    const previousXdg = process.env.XDG_CONFIG_HOME;
    const previousCwd = process.cwd();
    process.env.XDG_CONFIG_HOME = join(dir, "xdg");
    process.chdir(repo);
    try {
      corpusDisable(["wiki"], {});
      expect(readConfigFile(project)?.corpuses).toEqual([
        { id: "wiki", type: "files", disabled: true },
      ]);
      expect(readFileSync(global, "utf8")).toBe(globalText);

      // Enabling deletes the shadow, so the global entry applies again.
      await corpusEnable(["wiki"], {});
      expect(readConfigFile(project)?.corpuses).toEqual([]);
      expect(readFileSync(global, "utf8")).toBe(globalText);
    } finally {
      process.chdir(previousCwd);
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });
});
