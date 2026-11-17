# Copy-out custom corpus

A complete, out-of-tree `navi` project: a custom corpus over a
directory of plain-text notes. It imports only `navi/core`, whose re-export of
`zod` means **no other dependency to install**.

```text
navi.json      one custom corpus: module ./corpus.ts, options.path ./notes
corpus.ts      NotesCorpus — the default-exported CorpusClass
notes/         four small .txt files to search
```

## Confirmation workflow

Run these verbatim to prove the folder works outside this repo.

```sh
# 1. Copy it out of the tree.
cp -r examples/copy-out /tmp/ && cd /tmp/copy-out

# 2. Make navi resolvable here. `navi/core` must resolve from node_modules:
#    while navi is linked globally (README "Install"), `npm link navi` in this
#    folder links the package; once published, `npm i navi` does the same.
npm link navi

# 3. Validate the config and build the corpus.
navi config check

# 4. Search it and inspect the pipeline.
navi search "deploy checklist"
navi trace "deploy checklist"
```

Expected: `config ok: 1 enabled, 0 disabled` from step 3, and hits from the
`notes` corpus (`notes:deploy-checklist`, …) in steps 4. Try `navi search "force-push"` or
`navi search "on-call handoff"` too.

## Editing it

`module` and `options.path` are resolved relative to `navi.json`, never the
working directory — so moving this whole folder needs no edits. If you move
`navi.json` and `notes/` apart, update `options.path`; if you rename the
module, update `module`. Both stay relative to the config file.

`options.limit` (default 5) caps hits per search; `navi --limit` caps hits
across all corpuses.
