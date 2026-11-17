import { chmodSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { withTempDirAsync } from "../../test-support/tmp.ts";

import type { ModelProviderConfig } from "#core/config/schema.ts";
import { GatewayError } from "#core/models/gateway.ts";
import { createOpencodeGateway } from "#core/models/opencode.ts";

/** A provider whose transport is the `opencode` on PATH. */
function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    id: "local",
    model: "p/m",
    preferSession: true,
    runner: { type: "opencode" },
    timeoutMs: 2000,
    ...overrides,
  };
}

/** Run `body` with a fake `opencode` executable first on PATH, then restore
 * PATH and the tmpdir — the runner always spawns the real command name. */
async function withFakeOpencode(script: string, body: () => Promise<void>): Promise<void> {
  await withTempDirAsync("navi-opencode-", async (dir) => {
    const file = join(dir, "opencode");
    writeFileSync(file, script);
    chmodSync(file, 0o755);

    const original = process.env.PATH;
    process.env.PATH = `${dir}:${original ?? ""}`;
    try {
      await body();
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  });
}

const ask = [{ id: "git", prompt: "Is this about git?" }];

test("reads answers from the JSONL text events of a successful run", async () => {
  // Assert the CLI contract too: run --format json -m <model> <prompt>.
  const script = `#!/bin/sh
[ "$1" = run ] && [ "$2" = --format ] && [ "$3" = json ] && [ "$4" = -m ] && [ "$5" = p/m ] || {
  echo "unexpected args: $*" >&2
  exit 9
}
printf '%s' "$6" | grep -q "Is this about git?" || { echo "prompt missing question" >&2; exit 8; }
printf '%s' "$6" | grep -q "force-push" || { echo "prompt missing text" >&2; exit 8; }
printf '%s\\n' '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"type":"step-start"}}'
printf '%s\\n' '{"type":"text","timestamp":2,"sessionID":"s","part":{"type":"text","text":"{\\"answers\\":[{\\"id\\":\\"git\\",\\"answer\\":true,\\"confidence\\":0.8}]}"}}'
printf '%s\\n' '{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"type":"step-finish"}}'
`;
  await withFakeOpencode(script, async () => {
    await expect(createOpencodeGateway(provider()).ask(ask, "force-push to main")).resolves.toEqual(
      [{ id: "git", answer: true, confidence: 0.8 }],
    );
  });
});

test("finds the answer envelope inside markdown fences or prose", async () => {
  const answer =
    '```json\\n{\\"answers\\":[{\\"id\\":\\"git\\",\\"answer\\":false,\\"confidence\\":0.2}]}\\n```';
  const script = `#!/bin/sh
printf '%s\\n' '{"type":"text","timestamp":2,"sessionID":"s","part":{"type":"text","text":"${answer}"}}'
`;
  await withFakeOpencode(script, async () => {
    await expect(createOpencodeGateway(provider()).ask(ask, "x")).resolves.toEqual([
      { id: "git", answer: false, confidence: 0.2 },
    ]);
  });
});

test("a non-zero exit is a GatewayError naming stderr", async () => {
  const script = `#!/bin/sh
echo "provider exploded" >&2
exit 1
`;
  await withFakeOpencode(script, async () => {
    await expect(createOpencodeGateway(provider()).ask(ask, "x")).rejects.toThrow(GatewayError);
    await expect(createOpencodeGateway(provider()).ask(ask, "x")).rejects.toThrow(
      /exited 1: provider exploded/,
    );
  });
});

test("garbage output and a broken answer contract are GatewayErrors", async () => {
  const garbage = `#!/bin/sh
echo "not json"
`;
  await withFakeOpencode(garbage, async () => {
    await expect(createOpencodeGateway(provider()).ask(ask, "x")).rejects.toThrow(
      /non-JSON output/,
    );
  });

  const wrongShape = `#!/bin/sh
printf '%s\\n' '{"type":"text","timestamp":2,"sessionID":"s","part":{"type":"text","text":"{\\"answers\\":[{\\"id\\":\\"git\\",\\"answer\\":\\"yes\\"}]}"}}'
`;
  await withFakeOpencode(wrongShape, async () => {
    await expect(createOpencodeGateway(provider()).ask(ask, "x")).rejects.toThrow(
      /break the contract/,
    );
  });
});

test("a slow run is killed at timeoutMs", async () => {
  const script = `#!/bin/sh
exec sleep 5
`;
  await withFakeOpencode(script, async () => {
    await expect(createOpencodeGateway(provider({ timeoutMs: 100 })).ask(ask, "x")).rejects.toThrow(
      /timed out after 100ms/,
    );
  });
});
