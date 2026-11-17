/** The systemone runner posts the real Jev request shape and maps
 * the `noul` answers back. These fixtures run a real local HTTP server so the
 * wire contract is asserted, not assumed. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "vite-plus/test";

import type { ModelProviderConfig } from "#core/config/schema.ts";
import { GatewayError } from "#core/models/gateway.ts";
import { createSystemoneGateway } from "#core/models/systemone.ts";

function provider(
  baseUrl: string,
  overrides: Partial<ModelProviderConfig> = {},
): ModelProviderConfig {
  return {
    id: "judge",
    model: "jev/tev1",
    preferSession: true,
    runner: { type: "systemone", baseUrl },
    timeoutMs: 2000,
    ...overrides,
  };
}

interface RecordedRequest {
  method?: string;
  url?: string;
  body: string;
}

/** Serve `handler` on a random port; collect every request into `recorded`. */
async function withServer(
  handler: (response: ServerResponse) => void,
  body: (baseUrl: string, recorded: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const recorded: RecordedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      recorded.push({ method: request.method, url: request.url, body });
      handler(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await body(baseUrl, recorded);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function answerJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const ask = [{ id: "git", prompt: "Is this about git?" }];

test("POSTs the real Jev request shape and maps noul answers back to predicate ids", async () => {
  await withServer(
    (response) => {
      answerJson(response, { answers: { git: { type: "noul", noul: 0.997 } } });
    },
    async (baseUrl, recorded) => {
      // A trailing slash is config noise, not a different path.
      const gateway = createSystemoneGateway(provider(`${baseUrl}/`));
      await expect(gateway.ask(ask, "force-push to main")).resolves.toEqual([
        { id: "git", answer: true, confidence: 0.994 },
      ]);

      expect(recorded).toHaveLength(1);
      expect(recorded[0].method).toBe("POST");
      expect(recorded[0].url).toBe("/v1/systemone");
      expect(JSON.parse(recorded[0].body)).toEqual({
        model: "jev/tev1",
        state: { text: "force-push to main" },
        questions: { git: { type: "noul", instructions: "Is this about git?" } },
      });
    },
  );
});

test("maps the noul probability to answer and confidence", async () => {
  await withServer(
    (response) => {
      answerJson(response, {
        answers: {
          certain: { type: "noul", noul: 0.997 },
          unsure: { type: "noul", noul: 0.5 },
          no: { type: "noul", noul: 0.1 },
        },
      });
    },
    async (baseUrl) => {
      const gateway = createSystemoneGateway(provider(baseUrl));
      await expect(
        gateway.ask(
          [
            { id: "certain", prompt: "certain?" },
            { id: "unsure", prompt: "unsure?" },
            { id: "no", prompt: "no?" },
          ],
          "x",
        ),
      ).resolves.toEqual([
        { id: "certain", answer: true, confidence: 0.994 },
        { id: "unsure", answer: false, confidence: 0 },
        { id: "no", answer: false, confidence: 0.8 },
      ]);
    },
  );
});

test("a non-2xx response is a GatewayError naming the status and body", async () => {
  await withServer(
    (response) => {
      response.writeHead(503).end("model loading");
    },
    async (baseUrl) => {
      const gateway = createSystemoneGateway(provider(baseUrl));
      await expect(gateway.ask(ask, "x")).rejects.toThrow(GatewayError);
      await expect(gateway.ask(ask, "x")).rejects.toThrow(/HTTP 503: model loading/);
    },
  );
});

test("non-JSON and contract-breaking answers are GatewayErrors", async () => {
  await withServer(
    (response) => {
      response.writeHead(200).end("not json");
    },
    async (baseUrl) => {
      await expect(createSystemoneGateway(provider(baseUrl)).ask(ask, "x")).rejects.toThrow(
        /response was not JSON/,
      );
    },
  );

  // The old array shape and an out-of-range probability both break the contract.
  for (const broken of [
    { answers: [{ name: "git", answer: true }] },
    { answers: { git: { type: "noul", noul: 1.5 } } },
    { answers: { git: { type: "boolean", noul: 0.9 } } },
  ]) {
    await withServer(
      (response) => {
        answerJson(response, broken);
      },
      async (baseUrl) => {
        await expect(createSystemoneGateway(provider(baseUrl)).ask(ask, "x")).rejects.toThrow(
          /break the contract/,
        );
      },
    );
  }
});

test("a missing answer id is a GatewayError", async () => {
  await withServer(
    (response) => {
      answerJson(response, { answers: { other: { type: "noul", noul: 0.9 } } });
    },
    async (baseUrl) => {
      await expect(createSystemoneGateway(provider(baseUrl)).ask(ask, "x")).rejects.toThrow(
        /omitted answer "git"/,
      );
    },
  );
});

test("a slow server is abandoned at timeoutMs", async () => {
  await withServer(
    () => {
      // Never respond: the AbortSignal is the only way out.
    },
    async (baseUrl) => {
      const gateway = createSystemoneGateway(provider(baseUrl, { timeoutMs: 100 }));
      await expect(gateway.ask(ask, "x")).rejects.toThrow(/timed out after 100ms/);
    },
  );
});
