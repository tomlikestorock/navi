# navi

Local, situation-aware knowledge retrieval for coding agents — hybrid search
and decision-model filtering over your content resources, implicitly triggered
throughout the session so the right context surfaces the moment it matters.

## What it is

- **Corpuses** — pluggable searchable systems behind one registry: `files`
  (local docs, hybrid TF-IDF + embedding retrieval), `web` (fetch + a
  fetch-once page cache + search, embeddings on read), and `custom` (your own
  class, loaded from a module against the `navi/core` contract).
- **Situation analyzer** — configurable detector instances (lexicon,
  command, path, tool, and a gated model detector) fold into one Situation
  per query; deterministic by default, models opt-in.
- **Engine** — federates every corpus (reciprocal rank fusion), applies the
  optional decision-model applicability filter, and formats results as an
  advisory block or a subagent-ready pack.
- **CLI** — `navi analyze | trace | search | pack | read | eval`, `navi config
  show | check`, `navi corpus list | add | remove | disable | enable`.

## Quick start

```sh
cp examples/navi.json navi.json   # then edit: point a corpus at your content
cp -r examples/docs docs          # the demo content the reference points at
```

```sh
navi config check
navi search "what should we keep in mind before deploying"
navi pack "…"     # a reference block to hand to a subagent
navi trace "…"    # the full pipeline, stage by stage
navi eval         # recall@k, MRR and misses over the shipped fixture
```

`examples/navi.json` is the annotated reference — corpuses, embeddings,
analyzer, models, and filter sections, all commented.

## Install

```sh
vp pack      # bundle the CLI to dist/main.mjs and the navi/core contract
npm link     # `navi` on PATH, pointing at this checkout's dist/main.mjs
```

Custom corpus modules import their types and `z` from `navi/core`;
the packed install ships that contract as `dist/core.mjs` with
`dist/core.d.mts` (zod only — no Node modules on the import path).

Or install a packed tarball globally:

```sh
npm pack
npm install -g ./navi-0.0.0.tgz
```

Publishing would only need `"private": false`, a real version, and a
repository/homepage — `bin` and `files` are already set.

## OpenCode plugin

The plugin in `plugin/` is the harness adapter: it surfaces
concerns without being asked, and adds two deliberate-pull tools. It is
loaded from this checkout's source, so no build step is needed.

Load it in `opencode.json` (or drop it under `.opencode/plugins/`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/navi/plugin"],
}
```

It reads the same `navi.json` as the CLI — global
(`~/.config/navi/navi.json`) plus the nearest project file, merged — so
corpuses, embeddings, detector instances, and model providers are configured
once. `vp install` must have run so `@opencode/plugin` is present.

What it does:

- **Every admitted user prompt** is analyzed, searched, and written back as
  one advisory instruction entry (`<context key="navi-surface">`). Each turn
  replaces the previous block; a prompt with no hits evicts it. The policy
  pass runs before injection: same-turn dedupe on `corpus:id`,
  per-hit repetition caps (default one per turn, three per session), a
  `maxHits`/`maxTokens` budget, and `byModel` rules. The seen-log lives in
  plugin storage, keyed by session.
- **`navi_search` / `navi_pack`** run the same pipeline with a query, for
  deliberate pulls; `pack` returns the subagent-ready reference block. They
  skip the policy pass: an explicit request is not repetition.
- **`preferSession`** resolves at setup: with a harness
  decisions API the provider answers in-session using OpenCode's own auth and
  navi needs no keys; otherwise it uses the configured `runner`, exactly like
  the CLI. The model must support the decision capability — a chat model
  returns a typed `UnsupportedModelError`, and the detector degrades to a
  deterministic-only Situation instead of failing the prompt.

The `surfacing` section is harness-only (the CLI never reads it) and every
default is always on, so it can be omitted:

```jsonc
// navi.json — tighten the injection policy
{
  "surfacing": {
    "repetition": { "perTurn": 1, "perSession": 3 },
    "budget": { "maxHits": 3, "maxTokens": 200 },
    "byModel": {
      "*": { "repetition": { "perSession": 2 } },
      "opencode/jev-1.13": { "repetition": { "perSession": 1 } },
    },
  },
}
```

A hit can opt out of repetition itself, in the corpus config or in a file's
frontmatter (`surfacing:` — `repeat: eager|normal|once`, `force: [model refs]`,
`priority`, `minTurn`, `cooldown`). `force` lifts the caps and budget for the
listed models (or `*`) and `minTurn`; only the same-turn dedupe and `cooldown`
are never overridden. `minTurn: N` suppresses a hit until the session reaches
turn N; `cooldown: N` suppresses a re-show within N turns of the last one.

```jsonc
// navi.json — opt the model seat into the session gateway
{
  "analyzer": {
    "detectors": [
      { "id": "lexicon", "type": "lexicon" },
      {
        "id": "model",
        "type": "model",
        "options": { "when": "low-confidence", "provider": "decider" },
      },
    ],
  },
  "models": [
    {
      "id": "decider",
      "model": "opencode/jev-1.13",
      "preferSession": true,
      "runner": { "type": "opencode" },
    },
  ],
}
```

The drift gate (`ctx.session.hook("context")`) and the concern
canon are the remaining roadmap items; both slot in behind the same seams.

## Toolchain

Vite+ (the `vp` CLI): `vp install` for deps, `vp check` for format/lint/type,
`vp test` for tests, `vp pack` for the installable binary, and `vp run cli …`
to run navi from the repo during development.
