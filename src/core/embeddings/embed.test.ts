import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "vite-plus/test";

import type { EmbeddingProviderConfig } from "#core/config/schema.ts";
import { EmbeddingError, createEmbeddingProvider } from "./embed.ts";
import { FakeEmbeddingProvider } from "./fake.ts";

interface Recorded {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** Serve one response on a throwaway port and record every request. */
async function withServer(
  respond: (recorded: Recorded, response: ServerResponse) => void,
  body: (base: string, requests: Recorded[]) => Promise<void>,
): Promise<void> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    const recorded: Recorded = {
      method: request.method,
      url: request.url,
      headers: request.headers,
    };
    requests.push(recorded);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      recorded.body = raw === "" ? undefined : (JSON.parse(raw) as unknown);
      respond(recorded, response);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await body(base, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function provider(baseUrl: string, extra: Partial<EmbeddingProviderConfig> = {}) {
  return createEmbeddingProvider({
    id: "local",
    type: "openai-compatible",
    baseUrl: `${baseUrl}/v1`,
    model: "bge-m3",
    timeoutMs: 2000,
    ...extra,
  });
}

test("posts the OpenAI shape and returns vectors in input order", async () => {
  await withServer(
    (_recorded, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }));
    },
    async (base, requests) => {
      const vectors = await provider(base).embed(["rollback", "force push"]);

      expect(vectors).toEqual([
        [0.1, 0.2],
        [0.3, 0.4],
      ]);
      expect(requests[0].method).toBe("POST");
      expect(requests[0].url).toBe("/v1/embeddings");
      expect(requests[0].body).toEqual({ model: "bge-m3", input: ["rollback", "force push"] });
      expect(requests[0].headers["content-type"]).toBe("application/json");
      expect(requests[0].headers.authorization).toBeUndefined();
    },
  );
});

test("expands ${VAR} refs into a bearer key", async () => {
  process.env.NAVI_TEST_EMBEDDING_KEY = "sk-test";
  try {
    await withServer(
      (_recorded, response) => {
        response.writeHead(200).end(JSON.stringify({ data: [{ embedding: [1] }] }));
      },
      async (base, requests) => {
        await provider(base, { apiKey: "${NAVI_TEST_EMBEDDING_KEY}" }).embed(["x"]);
        expect(requests[0].headers.authorization).toBe("Bearer sk-test");
      },
    );
  } finally {
    delete process.env.NAVI_TEST_EMBEDDING_KEY;
  }
});

test("an empty batch sends no request", async () => {
  let calls = 0;
  await withServer(
    (_recorded, response) => {
      calls += 1;
      response.writeHead(200).end(JSON.stringify({ data: [] }));
    },
    async (base) => {
      expect(await provider(base).embed([])).toEqual([]);
      expect(calls).toBe(0);
    },
  );
});

test("times out with an EmbeddingError", async () => {
  await withServer(
    () => {
      // Never respond: only the client abort ends the request.
    },
    async (base) => {
      const started = Date.now();
      await expect(provider(base, { timeoutMs: 100 }).embed(["slow"])).rejects.toThrow(
        /embedding provider "local": timed out after 100ms/,
      );
      expect(Date.now() - started).toBeLessThan(2000);
    },
  );
});

test("reports a non-2xx response with status and body excerpt", async () => {
  await withServer(
    (_recorded, response) => {
      response.writeHead(401, { "content-type": "text/plain" }).end("missing key");
    },
    async (base) => {
      await expect(provider(base).embed(["x"])).rejects.toThrow(
        /embedding provider "local": HTTP 401: missing key/,
      );
    },
  );
});

test("rejects bodies that break the embedding contract", async () => {
  const bodies = [
    "not json",
    JSON.stringify({ data: "nope" }),
    JSON.stringify({ data: [{ embedding: [] }] }),
    // One vector for two inputs: a half batch is never returned.
    JSON.stringify({ data: [{ embedding: [1] }] }),
  ];

  for (const text of bodies) {
    await withServer(
      (_recorded, response) => {
        response.writeHead(200, { "content-type": "application/json" }).end(text);
      },
      async (base) => {
        await expect(provider(base).embed(["a", "b"])).rejects.toBeInstanceOf(EmbeddingError);
      },
    );
  }
});

test("the fake is deterministic, token-based, and records batches", async () => {
  // Wide enough that these fixture tokens share no hash bucket.
  const fake = new FakeEmbeddingProvider(1024);

  const [first] = await fake.embed(["rollback procedures"]);
  const [again] = await fake.embed(["rollback procedures"]);
  const [other] = await fake.embed(["unrelated note"]);

  expect(first).toEqual(again);
  expect(first).not.toEqual(other);
  // Shared tokens land in shared buckets, so the fake supports cosine tests.
  const [partial] = await fake.embed(["rollback"]);
  const dot = (a: number[], b: number[]) =>
    a.reduce((sum, value, index) => sum + value * b[index], 0);
  expect(dot(partial, first)).toBeGreaterThan(dot(partial, other));

  expect(fake.calls).toEqual([
    ["rollback procedures"],
    ["rollback procedures"],
    ["unrelated note"],
    ["rollback"],
  ]);
});
