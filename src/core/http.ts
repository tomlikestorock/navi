/** The one JSON-over-HTTP transport for provider
 * calls.
 *
 * The embedding provider and the systemone runner POST JSON and fail the same
 * four ways — timeout, transport error, non-2xx, non-JSON — so they share one
 * implementation and one message vocabulary. `fail` builds the caller's error
 * type (`EmbeddingError`, `GatewayError`); callers stay responsible for
 * degrading, never this helper. */

export interface PostJsonOptions {
  /** Prefix on every failure message: what is speaking, e.g.
   * `embedding provider "local"`. */
  label: string;
  /** Bound on the whole request; a timeout is a failure, not a hang. */
  timeoutMs: number;
  /** Extra request headers merged over `content-type`. */
  headers?: Record<string, string>;
  /** Builds the caller's error type from the finished message. */
  fail: (message: string, options?: ErrorOptions) => Error;
}

/** POST `body` as JSON and return the parsed response. Throws the error
 * `fail` builds on every failure path. */
export async function postJson(
  url: string,
  body: unknown,
  options: PostJsonOptions,
): Promise<unknown> {
  const { label, timeoutMs } = options;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw options.fail(
      isTimeout(error)
        ? `${label}: timed out after ${timeoutMs}ms`
        : `${label}: request failed: ${reasonOf(error)}`,
      { cause: error },
    );
  }

  if (!response.ok) {
    const detail = await bodySnippet(response);
    throw options.fail(`${label}: HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`);
  }

  try {
    return await response.json();
  } catch {
    throw options.fail(`${label}: response was not JSON`);
  }
}

/** `AbortSignal.timeout` rejects with a `TimeoutError` DOMException. */
function isTimeout(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "TimeoutError";
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A short error-body excerpt for diagnostics; never the whole payload. */
async function bodySnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 200);
  } catch {
    return "";
  }
}
