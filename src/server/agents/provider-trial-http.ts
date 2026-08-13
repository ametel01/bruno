export type ProviderTrialJsonResponse = {
  status: number;
  body: unknown;
};

type ProviderTrialJsonOptions = {
  attempts?: number;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
};

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchProviderTrialJson(
  url: string,
  headers: Record<string, string>,
  options: ProviderTrialJsonOptions = {},
): Promise<ProviderTrialJsonResponse> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS));
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const sleep = options.sleep ?? wait;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Status remains authoritative when a provider returns a non-JSON error body.
      }
      if (isRetryableStatus(response.status) && attempt < attempts) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      return { status: response.status, body };
    } catch (error) {
      if (attempt === attempts) throw error;
      await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error("Provider Trial JSON probe exhausted without a result.");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
