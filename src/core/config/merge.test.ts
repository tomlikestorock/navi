import { expect, test } from "vite-plus/test";

import { mergeConfigs, type ConfigSource } from "#core/config/merge.ts";

const global: ConfigSource = {
  file: "/home/me/.config/navi/navi.json",
  config: {
    $schema: "https://navi.dev/schemas/navi.json",
    corpuses: [
      { id: "wiki", type: "files", options: { path: "~/wiki", embed: true } },
      { id: "notes", type: "files", options: { path: "~/notes" } },
    ],
  },
};

const project: ConfigSource = {
  file: "/repo/navi.json",
  config: {
    corpuses: [
      { id: "project-docs", type: "files", options: { path: "./docs" } },
      // Disable a global corpus without restating its driver
      // config; the entry still names the kind it disables.
      { id: "wiki", type: "files", disabled: true },
    ],
  },
};

test("handles missing files", () => {
  expect(mergeConfigs(null, null)).toEqual({ config: { corpuses: [] }, origin: new Map() });
  expect(mergeConfigs({ file: "g", config: { corpuses: [] } }, null)).toEqual({
    config: { corpuses: [] },
    origin: new Map(),
  });
  expect(mergeConfigs(null, { file: "p", config: { corpuses: [] } })).toEqual({
    config: { corpuses: [] },
    origin: new Map(),
  });
});

test("project entries replace global entries wholesale, order preserved", () => {
  const { config } = mergeConfigs(global, project);

  expect(config.corpuses.map((corpus) => corpus.id)).toEqual(["wiki", "notes", "project-docs"]);
  // Wholesale replacement: the global options do not survive, and the anchor
  // follows the winning file.
  expect(config.corpuses[0]).toEqual({
    id: "wiki",
    type: "files",
    disabled: true,
    baseDir: "/repo",
  });
  expect(config.$schema).toBe("https://navi.dev/schemas/navi.json");
});

test("origin names the file whose entry won", () => {
  const { origin } = mergeConfigs(global, project);

  expect(origin.get("wiki")).toBe(project.file);
  expect(origin.get("project-docs")).toBe(project.file);
  expect(origin.get("notes")).toBe(global.file);
  expect([...origin.keys()]).toEqual(["wiki", "notes", "project-docs"]);
});

test("a repeated id replaces, never duplicates", () => {
  const { config, origin } = mergeConfigs(global, {
    file: "/repo/navi.json",
    config: { corpuses: [{ id: "wiki", type: "files", options: { path: "./docs" } }] },
  });

  expect(config.corpuses).toEqual([
    { id: "wiki", type: "files", options: { path: "./docs" }, baseDir: "/repo" },
    {
      id: "notes",
      type: "files",
      options: { path: "~/notes" },
      baseDir: "/home/me/.config/navi",
    },
  ]);
  expect(origin.get("wiki")).toBe("/repo/navi.json");
});

test("project $schema wins, otherwise global's is kept", () => {
  expect(
    mergeConfigs(
      { file: "g", config: { $schema: "global", corpuses: [] } },
      { file: "p", config: { $schema: "project", corpuses: [] } },
    ).config.$schema,
  ).toBe("project");
  expect(
    mergeConfigs(
      { file: "g", config: { $schema: "global", corpuses: [] } },
      { file: "p", config: { corpuses: [] } },
    ).config.$schema,
  ).toBe("global");
});

test("analyzer detectors merge by id like corpuses", () => {
  const { config } = mergeConfigs(
    {
      file: "g",
      config: {
        corpuses: [],
        analyzer: {
          detectors: [
            { id: "git-words", type: "lexicon", options: { arenas: ["git"] } },
            { id: "commands", type: "command" },
          ],
        },
      },
    },
    {
      file: "p",
      config: {
        corpuses: [],
        analyzer: {
          detectors: [
            { id: "commands", type: "command", disabled: true },
            { id: "security-words", type: "lexicon" },
          ],
        },
      },
    },
  );

  // Wholesale replacement: the global `commands` options/type are gone; the
  // new project instances append in project order.
  expect(config.analyzer?.detectors).toEqual([
    { id: "git-words", type: "lexicon", options: { arenas: ["git"] } },
    { id: "commands", type: "command", disabled: true },
    { id: "security-words", type: "lexicon" },
  ]);
});

test("an explicitly empty detector list survives, distinct from an omitted section", () => {
  const { config } = mergeConfigs({
    file: "p",
    config: { corpuses: [], analyzer: { detectors: [] } },
  });
  expect(config.analyzer).toEqual({ detectors: [] });

  // No analyzer section anywhere → absent, so the analyzer builds defaults.
  expect(mergeConfigs({ file: "p", config: { corpuses: [] } }).config).toEqual({ corpuses: [] });
});

test("model providers merge by id like corpuses", () => {
  const provider = (id: string, model: string, disabled?: boolean) => ({
    id,
    model,
    preferSession: true,
    runner: { type: "opencode" as const },
    timeoutMs: 10000,
    ...(disabled === undefined ? {} : { disabled }),
  });

  const { config } = mergeConfigs(
    {
      file: "g",
      config: { corpuses: [], models: [provider("local", "g/m"), provider("shared", "g/m")] },
    },
    { file: "p", config: { corpuses: [], models: [provider("shared", "p/m", true)] } },
  );

  // Wholesale replacement: project's `shared` wins, order is preserved.
  expect(config.models).toEqual([provider("local", "g/m"), provider("shared", "p/m", true)]);
});

test("an explicitly empty models list survives, distinct from an omitted section", () => {
  expect(mergeConfigs({ file: "p", config: { corpuses: [], models: [] } }).config).toEqual({
    corpuses: [],
    models: [],
  });
  expect(mergeConfigs({ file: "p", config: { corpuses: [] } }).config).toEqual({ corpuses: [] });
});

test("embedding providers merge by id like corpuses", () => {
  const provider = (id: string, model: string, disabled?: boolean) => ({
    id,
    type: "openai-compatible" as const,
    baseUrl: "http://localhost:11434/v1",
    model,
    timeoutMs: 10000,
    ...(disabled === undefined ? {} : { disabled }),
  });

  const { config } = mergeConfigs(
    {
      file: "g",
      config: {
        corpuses: [],
        embeddings: [provider("local", "g/m"), provider("shared", "g/m")],
      },
    },
    { file: "p", config: { corpuses: [], embeddings: [provider("shared", "p/m", true)] } },
  );

  // Wholesale replacement: project's `shared` wins, order is preserved.
  expect(config.embeddings).toEqual([provider("local", "g/m"), provider("shared", "p/m", true)]);
});

test("an explicitly empty embeddings list survives, distinct from an omitted section", () => {
  expect(mergeConfigs({ file: "p", config: { corpuses: [], embeddings: [] } }).config).toEqual({
    corpuses: [],
    embeddings: [],
  });
  expect(mergeConfigs({ file: "p", config: { corpuses: [] } }).config).toEqual({ corpuses: [] });
});

test("an embed reference resolves across files after merge", () => {
  const provider = {
    id: "local",
    type: "openai-compatible" as const,
    baseUrl: "http://localhost:11434/v1",
    model: "bge-m3",
    timeoutMs: 10000,
  };

  // The provider is global; the corpus referencing it is declared by the project.
  const { config } = mergeConfigs(
    { file: "/home/me/.config/navi/navi.json", config: { corpuses: [], embeddings: [provider] } },
    {
      file: "/repo/navi.json",
      config: { corpuses: [{ id: "docs", type: "files", embed: "local" }] },
    },
  );
  expect(config.corpuses[0].embed).toBe("local");
});

test("a corpus embedding an undeclared provider fails loud with corpus and id", () => {
  const source: ConfigSource = {
    file: "/repo/navi.json",
    config: { corpuses: [{ id: "docs", type: "files", embed: "ghost" }] },
  };

  expect(() => mergeConfigs(source)).toThrow(
    /\/repo\/navi\.json: corpus "docs" embed: references unknown embedding provider "ghost"/,
  );
});

test("a corpus embedding a disabled provider fails loud at config time (SW-1)", () => {
  const source: ConfigSource = {
    file: "/repo/navi.json",
    config: {
      corpuses: [{ id: "docs", type: "files", embed: "local" }],
      embeddings: [
        {
          id: "local",
          type: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          model: "bge-m3",
          timeoutMs: 10000,
          disabled: true,
        },
      ],
    },
  };

  expect(() => mergeConfigs(source)).toThrow(
    /\/repo\/navi\.json: corpus "docs" embed: embedding provider "local" is disabled/,
  );
});

test("the filter section is single-valued and its provider resolves across files", () => {
  const judge = (disabled = false) => ({
    id: "judge",
    model: "jev/tev1",
    preferSession: true,
    runner: { type: "systemone" as const, baseUrl: "http://127.0.0.1:11434" },
    timeoutMs: 10000,
    ...(disabled ? { disabled } : {}),
  });

  // The provider is global; the filter is declared by the project.
  const { config } = mergeConfigs(
    {
      file: "g",
      config: { corpuses: [], models: [judge()], filter: { provider: "judge", topK: 6 } },
    },
    { file: "p", config: { corpuses: [], filter: { provider: "judge", topK: 3 } } },
  );
  // A single top-level section: the later file replaces it wholesale.
  expect(config.filter).toEqual({ provider: "judge", topK: 3 });

  // Omitted in the later file: the earlier section survives.
  expect(
    mergeConfigs(
      {
        file: "g",
        config: { corpuses: [], models: [judge()], filter: { provider: "judge", topK: 6 } },
      },
      { file: "p", config: { corpuses: [] } },
    ).config.filter,
  ).toEqual({ provider: "judge", topK: 6 });

  expect(() =>
    mergeConfigs({ file: "p", config: { corpuses: [], filter: { provider: "ghost", topK: 8 } } }),
  ).toThrow(/filter: references unknown model provider "ghost"/);

  expect(() =>
    mergeConfigs({
      file: "p",
      config: { corpuses: [], models: [judge(true)], filter: { provider: "judge", topK: 8 } },
    }),
  ).toThrow(/filter: model provider "judge" is disabled/);
});

test("the surfacing section is single-valued and survives merge", () => {
  const rule = { repetition: { perTurn: 1, perSession: 2 } };
  expect(
    mergeConfigs(
      { file: "g", config: { corpuses: [], surfacing: rule } },
      { file: "p", config: { corpuses: [] } },
    ).config.surfacing,
  ).toEqual(rule);

  // A single top-level section: the later file replaces it wholesale.
  expect(
    mergeConfigs(
      { file: "g", config: { corpuses: [], surfacing: rule } },
      {
        file: "p",
        config: { corpuses: [], surfacing: { budget: { maxHits: 1 } } },
      },
    ).config.surfacing,
  ).toEqual({ budget: { maxHits: 1 } });
});
