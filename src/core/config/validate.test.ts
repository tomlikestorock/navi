import { expect, test } from "vite-plus/test";

import { validateConfig } from "#core/config/validate.ts";
import { ConfigError } from "#core/config/error.ts";

const file = "navi.json";

test("accepts a minimal config", () => {
  expect(validateConfig({ corpuses: [{ id: "wiki", type: "files" }] }, file)).toEqual({
    corpuses: [{ id: "wiki", type: "files" }],
  });
});

test("keeps every declared corpus field", () => {
  const config = {
    $schema: "https://navi.dev/schemas/navi.json",
    corpuses: [
      {
        id: "wiki",
        type: "files",
        description: "Personal wiki",
        options: { path: "~/wiki" },
        disabled: true,
      },
    ],
  };
  expect(validateConfig(config, file)).toEqual(config);
});

test("rejects unknown keys", () => {
  expect(() => validateConfig({ corpuses: [], engine: {} }, file)).toThrow(
    /engine: Unrecognized key: "engine"/,
  );
  expect(() =>
    validateConfig({ corpuses: [{ id: "wiki", type: "files", path: "~" }] }, file),
  ).toThrow(/corpuses\[0\]\.path: Unrecognized key: "path"/);
});

test("rejects malformed shape", () => {
  for (const bad of [[], "x", null]) {
    expect(() => validateConfig(bad, file)).toThrow(ConfigError);
  }
  expect(() => validateConfig({}, file)).toThrow(/corpuses: Invalid input: expected array/);
  expect(() => validateConfig({ $schema: 1, corpuses: [] }, file)).toThrow(
    /\$schema: Invalid input: expected string/,
  );
  expect(() => validateConfig({ corpuses: [1] }, file)).toThrow(
    /corpuses\[0\]: Invalid input: expected object/,
  );
});

test("rejects invalid ids", () => {
  for (const id of ["Wiki", "-wiki", "wiki/1", ""]) {
    expect(() => validateConfig({ corpuses: [{ id, type: "files" }] }, file)).toThrow(
      /corpuses\[0\]\.id/,
    );
  }
});

test("requires a non-empty type, even on disable-only entries", () => {
  expect(() => validateConfig({ corpuses: [{ id: "wiki" }] }, file)).toThrow(/corpuses\[0\]\.type/);
  expect(() => validateConfig({ corpuses: [{ id: "wiki", type: "" }] }, file)).toThrow(
    /corpuses\[0\]\.type/,
  );
  // A disabling entry names the kind it disables.
  expect(() => validateConfig({ corpuses: [{ id: "wiki", disabled: true }] }, file)).toThrow(
    /corpuses\[0\]\.type/,
  );
  expect(
    validateConfig({ corpuses: [{ id: "wiki", type: "files", disabled: true }] }, file),
  ).toEqual({ corpuses: [{ id: "wiki", type: "files", disabled: true }] });
});

test("rejects wrong option and flag types", () => {
  const base = { id: "wiki", type: "files" };
  expect(() => validateConfig({ corpuses: [{ ...base, options: [] }] }, file)).toThrow(
    /corpuses\[0\]\.options/,
  );
  expect(() => validateConfig({ corpuses: [{ ...base, options: null }] }, file)).toThrow(
    /corpuses\[0\]\.options/,
  );
  expect(() => validateConfig({ corpuses: [{ ...base, disabled: "yes" }] }, file)).toThrow(
    /corpuses\[0\]\.disabled/,
  );
  expect(() => validateConfig({ corpuses: [{ ...base, description: 1 }] }, file)).toThrow(
    /corpuses\[0\]\.description/,
  );
});

test("custom corpora require a module; built-in kinds reject one", () => {
  expect(() => validateConfig({ corpuses: [{ id: "quotes", type: "custom" }] }, file)).toThrow(
    /corpuses\[0\]\.module: corpus "quotes": type "custom" requires a "module"/,
  );
  expect(() =>
    validateConfig({ corpuses: [{ id: "quotes", type: "files", module: "./m.ts" }] }, file),
  ).toThrow(/corpuses\[0\]\.module: corpus "quotes": "module" is only valid for type "custom"/);

  const valid = { corpuses: [{ id: "quotes", type: "custom", module: "./m.ts" }] };
  expect(validateConfig(valid, file)).toEqual(valid);
});

test("rejects an unknown corpus kind at config time", () => {
  expect(() => validateConfig({ corpuses: [{ id: "quotes", type: "git" }] }, file)).toThrow(
    /corpuses\[0\]\.type/,
  );
});

test("rejects duplicate ids within one file", () => {
  expect(() =>
    validateConfig(
      {
        corpuses: [
          { id: "wiki", type: "files" },
          { id: "wiki", type: "files" },
        ],
      },
      file,
    ),
  ).toThrow(/duplicate id "wiki"/);
});

test("validates the analyzer section", () => {
  const config = {
    corpuses: [],
    analyzer: {
      detectors: [
        { id: "git-words", type: "lexicon", options: { arenas: ["git"] } },
        { id: "notes", type: "tool", disabled: true },
      ],
    },
  };
  expect(validateConfig(config, file)).toEqual(config);

  expect(() => validateConfig({ corpuses: [], analyzer: { engine: {} } }, file)).toThrow(
    /analyzer\.engine: Unrecognized key/,
  );
  expect(() =>
    validateConfig(
      { corpuses: [], analyzer: { detectors: [{ id: "Bad Id", type: "tool" }] } },
      file,
    ),
  ).toThrow(/analyzer\.detectors\[0\]\.id/);
  expect(() =>
    validateConfig(
      { corpuses: [], analyzer: { detectors: [{ id: "off", disabled: true }] } },
      file,
    ),
  ).toThrow(/analyzer\.detectors\[0\]\.type/);
  expect(() =>
    validateConfig(
      {
        corpuses: [],
        analyzer: {
          detectors: [
            { id: "dup", type: "tool" },
            { id: "dup", type: "path" },
          ],
        },
      },
      file,
    ),
  ).toThrow(/analyzer\.detectors: duplicate id "dup"/);
});

test("validates the models section and applies defaults", () => {
  const parsed = validateConfig(
    {
      corpuses: [],
      models: [
        { id: "local", model: "lmstudio/qwen", runner: { type: "opencode" } },
        {
          id: "judge",
          model: "jev/tev1",
          preferSession: false,
          timeoutMs: 2000,
          runner: { type: "systemone", baseUrl: "http://127.0.0.1:11434" },
        },
      ],
    },
    file,
  );

  expect(parsed.models).toEqual([
    {
      id: "local",
      model: "lmstudio/qwen",
      preferSession: true,
      runner: { type: "opencode" },
      timeoutMs: 10000,
    },
    {
      id: "judge",
      model: "jev/tev1",
      preferSession: false,
      runner: { type: "systemone", baseUrl: "http://127.0.0.1:11434" },
      timeoutMs: 2000,
    },
  ]);
});

test("rejects malformed model providers", () => {
  const provider = { id: "local", model: "p/m", runner: { type: "opencode" } };
  const models = (...entries: unknown[]) => ({ corpuses: [], models: entries });

  expect(() => validateConfig(models({ ...provider, id: "Local" }), file)).toThrow(
    /models\[0\]\.id/,
  );
  // `model` is required and non-empty; the runner is a known type.
  expect(() => validateConfig(models({ id: "local", runner: { type: "opencode" } }), file)).toThrow(
    /models\[0\]\.model/,
  );
  expect(() => validateConfig(models({ ...provider, model: "" }), file)).toThrow(
    /models\[0\]\.model/,
  );
  expect(() => validateConfig(models({ ...provider, runner: { type: "nope" } }), file)).toThrow(
    /models\[0\]\.runner/,
  );
  expect(() => validateConfig(models({ ...provider, runner: {} }), file)).toThrow(
    /models\[0\]\.runner/,
  );
  // A runner that has no implementation is not a declared transport: the only
  // accepted types are the ones the gateway resolves (bean navi-dkof).
  expect(() =>
    validateConfig(models({ ...provider, runner: { type: "openai-compatible" } }), file),
  ).toThrow(/models\[0\]\.runner\.type/);
  expect(() => validateConfig(models({ ...provider, apiKey: "x" }), file)).toThrow(
    /models\[0\]\.apiKey: Unrecognized key/,
  );
  expect(() => validateConfig(models({ ...provider, timeoutMs: 99 }), file)).toThrow(
    /models\[0\]\.timeoutMs/,
  );
  expect(() => validateConfig(models({ ...provider, timeoutMs: 1.5 }), file)).toThrow(
    /models\[0\]\.timeoutMs/,
  );
  expect(() => validateConfig(models({ ...provider, preferSession: "yes" }), file)).toThrow(
    /models\[0\]\.preferSession/,
  );
  // The systemone runner needs a baseUrl and takes no keys.
  expect(() =>
    validateConfig(models({ ...provider, runner: { type: "systemone" } }), file),
  ).toThrow(/models\[0\]\.runner\.baseUrl/);
  expect(() =>
    validateConfig(
      models({
        ...provider,
        runner: { type: "systemone", baseUrl: "http://x", apiKey: "k" },
      }),
      file,
    ),
  ).toThrow(/models\[0\]\.runner\.apiKey: Unrecognized key/);
});

test("rejects duplicate model provider ids within one file", () => {
  const provider = { id: "local", model: "p/m", runner: { type: "opencode" } };
  expect(() => validateConfig({ corpuses: [], models: [provider, provider] }, file)).toThrow(
    /models: duplicate id "local"/,
  );
});

test("validates the embeddings section and applies defaults", () => {
  const parsed = validateConfig(
    {
      corpuses: [{ id: "docs", type: "files", embed: "local" }],
      embeddings: [
        {
          id: "local",
          type: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          model: "bge-m3",
        },
        {
          id: "cloud",
          type: "openai-compatible",
          baseUrl: "https://api.example/v1",
          apiKey: "${KEY}",
          model: "embed-3",
          timeoutMs: 2000,
          disabled: true,
        },
      ],
    },
    file,
  );

  expect(parsed.corpuses[0].embed).toBe("local");
  expect(parsed.embeddings).toEqual([
    {
      id: "local",
      type: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "bge-m3",
      timeoutMs: 10000,
    },
    {
      id: "cloud",
      type: "openai-compatible",
      baseUrl: "https://api.example/v1",
      apiKey: "${KEY}",
      model: "embed-3",
      timeoutMs: 2000,
      disabled: true,
    },
  ]);
});

test("rejects malformed embedding providers", () => {
  const provider = {
    id: "local",
    type: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "bge-m3",
  };
  const embeddings = (...entries: unknown[]) => ({ corpuses: [], embeddings: entries });

  expect(() => validateConfig(embeddings({ ...provider, id: "Local" }), file)).toThrow(
    /embeddings\[0\]\.id/,
  );
  expect(() => validateConfig(embeddings({ ...provider, type: "ollama" }), file)).toThrow(
    /embeddings\[0\]\.type/,
  );
  expect(() => validateConfig(embeddings({ ...provider, baseUrl: "" }), file)).toThrow(
    /embeddings\[0\]\.baseUrl/,
  );
  expect(() => validateConfig(embeddings({ ...provider, baseUrl: undefined }), file)).toThrow(
    /embeddings\[0\]\.baseUrl/,
  );
  expect(() => validateConfig(embeddings({ ...provider, model: "" }), file)).toThrow(
    /embeddings\[0\]\.model/,
  );
  expect(() => validateConfig(embeddings({ ...provider, timeoutMs: 99 }), file)).toThrow(
    /embeddings\[0\]\.timeoutMs/,
  );
  expect(() => validateConfig(embeddings({ ...provider, timeoutMs: 1.5 }), file)).toThrow(
    /embeddings\[0\]\.timeoutMs/,
  );
  expect(() => validateConfig(embeddings({ ...provider, apiKey: 1 }), file)).toThrow(
    /embeddings\[0\]\.apiKey/,
  );
  expect(() => validateConfig(embeddings({ ...provider, nope: true }), file)).toThrow(
    /embeddings\[0\]\.nope: Unrecognized key/,
  );
});

test("rejects duplicate embedding provider ids within one file", () => {
  const provider = {
    id: "local",
    type: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "bge-m3",
  };
  expect(() => validateConfig({ corpuses: [], embeddings: [provider, provider] }, file)).toThrow(
    /embeddings: duplicate id "local"/,
  );
});

test("validates the filter section and applies topK's default", () => {
  const model = {
    id: "judge",
    model: "jev/tev1",
    runner: { type: "systemone", baseUrl: "http://127.0.0.1:11434" },
  };
  const parsed = validateConfig(
    { corpuses: [], models: [model], filter: { provider: "judge" } },
    file,
  );
  expect(parsed.filter).toEqual({ provider: "judge", topK: 8 });
  expect(parsed.models?.[0].runner).toEqual({
    type: "systemone",
    baseUrl: "http://127.0.0.1:11434",
  });

  const filter = (value: unknown) => ({ corpuses: [], filter: value });
  expect(() => validateConfig(filter({}), file)).toThrow(/filter\.provider/);
  expect(() => validateConfig(filter({ provider: "" }), file)).toThrow(/filter\.provider/);
  for (const topK of [0, 21, 1.5]) {
    expect(() => validateConfig(filter({ provider: "judge", topK }), file)).toThrow(/filter\.topK/);
  }
  expect(() => validateConfig(filter({ provider: "judge", nope: true }), file)).toThrow(
    /filter\.nope: Unrecognized key/,
  );
});
