import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "vite-plus/test";

import { withTempDir } from "../../test-support/tmp.ts";

import { discoverConfigPaths, loadConfig, readConfigFile } from "#core/config/load.ts";
import { ConfigError } from "#core/config/error.ts";

/** Run `body` against a throwaway directory tree. */
function fixture(body: (dir: string) => void): void {
  withTempDir("navi-config-", body);
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const GLOBAL_JSONC = `// global navi config
{
  "$schema": "https://navi.dev/schemas/navi.json",
  "corpuses": [
    {
      "id": "wiki",
      "type": "files",
      /* the locator lives in options */
      "options": { "path": "~/wiki", },
    },
  ],
}
`;

const PROJECT_JSONC = `{
  "corpuses": [
    { "id": "project-docs", "type": "files", "options": { "path": "./docs" } },
    { "id": "wiki", "type": "files", "disabled": true },
  ],
}
`;

test("accepts comments, trailing commas and comment-like strings", () => {
  fixture((dir) => {
    const file = join(dir, "navi.json");
    write(
      file,
      `{
        // line comment
        "corpuses": [
          {
            "id": "wiki",
            "type": "files",
            /* block comment */
            "description": "http://example.com/a,}",
          },
        ],
      }`,
    );

    expect(readConfigFile(file)?.corpuses[0].description).toBe("http://example.com/a,}");
  });
});

test("discovers the global path from $XDG_CONFIG_HOME", () => {
  fixture((dir) => {
    const paths = discoverConfigPaths({ cwd: dir, env: { XDG_CONFIG_HOME: join(dir, "xdg") } });
    expect(paths.global).toBe(join(dir, "xdg", "navi", "navi.json"));
    expect(paths.project).toBeNull();
  });
});

test("an empty $XDG_CONFIG_HOME falls back to ~/.config", () => {
  fixture((dir) => {
    const paths = discoverConfigPaths({ cwd: dir, env: { XDG_CONFIG_HOME: "" } });
    expect(paths.global).toBe(join(homedir(), ".config", "navi", "navi.json"));
  });
});

test("finds the project file upward from a nested cwd and stops at the repo root", () => {
  fixture((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(join(repo, "navi.json"), PROJECT_JSONC);
    // A config above the repo root must be ignored.
    write(join(dir, "navi.json"), `{ "corpuses": [] }`);

    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const paths = discoverConfigPaths({ cwd: nested, env: { XDG_CONFIG_HOME: join(dir, "xdg") } });
    expect(paths.project).toBe(join(repo, "navi.json"));
  });
});

test("loads nothing gracefully", () => {
  fixture((dir) => {
    const loaded = loadConfig({ cwd: dir, env: { XDG_CONFIG_HOME: join(dir, "xdg") } });
    expect(loaded).toEqual({ config: { corpuses: [] }, files: [] });
  });
});

test("loads and merges global and project files", () => {
  fixture((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(join(repo, "navi.json"), PROJECT_JSONC);
    const globalFile = join(dir, "xdg", "navi", "navi.json");
    write(globalFile, GLOBAL_JSONC);

    const loaded = loadConfig({
      cwd: join(repo, "src"),
      env: { XDG_CONFIG_HOME: join(dir, "xdg") },
    });

    expect(loaded.files).toEqual([globalFile, join(repo, "navi.json")]);
    expect(loaded.config.$schema).toBe("https://navi.dev/schemas/navi.json");
    expect(loaded.config.corpuses).toEqual([
      { id: "wiki", type: "files", disabled: true, baseDir: repo },
      { id: "project-docs", type: "files", options: { path: "./docs" }, baseDir: repo },
    ]);
  });
});

test("every loaded corpus carries its declaring file's directory as baseDir", () => {
  fixture((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(join(repo, "navi.json"), PROJECT_JSONC);
    const globalFile = join(dir, "xdg", "navi", "navi.json");
    write(globalFile, GLOBAL_JSONC);

    const { config } = loadConfig({
      cwd: join(repo, "src"),
      env: { XDG_CONFIG_HOME: join(dir, "xdg") },
    });

    // `wiki` is redeclared by the project file, so the project wins — and its
    // anchor follows the winner. A relative `./docs` resolves against the
    // project root, not the subdirectory the CLI happened to run from.
    expect(config.corpuses).toEqual([
      { id: "wiki", type: "files", disabled: true, baseDir: repo },
      { id: "project-docs", type: "files", options: { path: "./docs" }, baseDir: repo },
    ]);
  });
});

test("baseDir distinguishes a global-only entry from a project one", () => {
  fixture((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(
      join(repo, "navi.json"),
      `{ "corpuses": [{ "id": "local", "type": "files", "options": { "path": "./docs" } }] }`,
    );
    const globalFile = join(dir, "xdg", "navi", "navi.json");
    write(globalFile, `{ "corpuses": [{ "id": "wiki", "type": "files" }] }`);

    const { config } = loadConfig({
      cwd: repo,
      env: { XDG_CONFIG_HOME: join(dir, "xdg") },
    });

    expect(config.corpuses.map(({ id, baseDir }) => [id, baseDir])).toEqual([
      ["wiki", dirname(globalFile)],
      ["local", repo],
    ]);
  });
});

test("reports the file and line of invalid JSONC", () => {
  fixture((dir) => {
    const file = join(dir, "navi.json");
    write(file, `{\n  "corpuses": []\n  "extra": 1\n}\n`);

    expect(() => readConfigFile(file)).toThrow(ConfigError);
    expect(() => readConfigFile(file)).toThrow(/navi\.json: invalid JSONC at line 3/);
  });
});

test("reports the line of a duplicate id", () => {
  fixture((dir) => {
    const file = join(dir, "navi.json");
    write(
      file,
      `{\n  "corpuses": [\n    { "id": "wiki", "type": "files" },\n    { "id": "wiki", "type": "files" }\n  ]\n}\n`,
    );

    expect(() => readConfigFile(file)).toThrow(
      /corpuses: duplicate id "wiki" at line 4, column 13/,
    );
  });
});

test("reads the analyzer section from navi.json", () => {
  fixture((dir) => {
    const file = join(dir, "navi.json");
    write(
      file,
      `{
        "corpuses": [],
        "analyzer": {
          "detectors": [
            { "id": "git-words", "type": "lexicon", "options": { "arenas": ["git"] } },
            { "id": "commands", "type": "command", "disabled": true },
          ],
        },
      }`,
    );

    expect(readConfigFile(file)?.analyzer?.detectors).toEqual([
      { id: "git-words", type: "lexicon", options: { arenas: ["git"] } },
      { id: "commands", type: "command", disabled: true },
    ]);
  });
});

test("rejects an invalid detector entry with a field diagnostic", () => {
  fixture((dir) => {
    const file = join(dir, "navi.json");
    write(
      file,
      `{ "corpuses": [], "analyzer": { "detectors": [{ "id": "Bad Id", "type": "tool" }] } }`,
    );
    expect(() => readConfigFile(file)).toThrow(/analyzer\.detectors\[0\]\.id/);
  });
});

test("rejects a structurally invalid file", () => {
  fixture((dir) => {
    write(join(dir, "navi.json"), `{ "corpuses": [{ "id": "Wiki", "type": "files" }] }`);
    expect(() => readConfigFile(join(dir, "navi.json"))).toThrow(/corpuses\[0\]\.id/);
  });
});
