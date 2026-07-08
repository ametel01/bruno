type CreatedAgentResponse = {
  agent?: {
    id?: unknown;
    runnerId?: unknown;
    status?: unknown;
  };
};

export {};

const appUrl = normalizeBaseUrl(process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000");
const timeoutMs = readPositiveInteger(process.env.AGENTBAY_LOCAL_CLOUD_SMOKE_TIMEOUT_MS, 240_000);
const pollMs = readPositiveInteger(process.env.AGENTBAY_LOCAL_CLOUD_SMOKE_POLL_MS, 2_000);

const startedAt = Date.now();

await waitForDashboard();
const { agentId, runnerId } = await createAgent();
await startAgent(agentId);

console.log(
  JSON.stringify({
    event: "local_cloud_smoke_passed",
    agentId,
    runnerId,
    elapsedMs: Date.now() - startedAt,
  }),
);

async function waitForDashboard(): Promise<void> {
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${appUrl}/`);

      if (response.ok) {
        return;
      }
    } catch {
      // Dashboard may still be building or restarting.
    }

    await sleep(pollMs);
  }

  throw new Error(`Dashboard did not become ready at ${appUrl} before timeout.`);
}

async function createAgent(): Promise<{ agentId: string; runnerId: string | null }> {
  const response = await fetch(`${appUrl}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `Local cloud smoke ${new Date().toISOString()}`,
      templateKey: "research_agent",
    }),
  });
  const text = await response.text();

  if (response.status !== 201) {
    throw new Error(`Agent create failed with HTTP ${response.status}: ${text}`);
  }

  const parsed = parseJson<CreatedAgentResponse>(text);
  const agentId = typeof parsed.agent?.id === "string" ? parsed.agent.id : null;
  const runnerId = typeof parsed.agent?.runnerId === "string" ? parsed.agent.runnerId : null;

  if (!agentId) {
    throw new Error(`Agent create response did not include an agent id: ${text}`);
  }

  console.log(
    JSON.stringify({
      event: "local_cloud_smoke_agent_created",
      agentId,
      runnerId,
    }),
  );

  return { agentId, runnerId };
}

async function startAgent(agentId: string): Promise<void> {
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;

    const response = await fetch(
      `${appUrl}/api/agents/${encodeURIComponent(agentId)}/actions/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
    );
    const text = await response.text();

    if (response.status === 202) {
      console.log(
        JSON.stringify({
          event: "local_cloud_smoke_agent_started",
          agentId,
          attempt,
        }),
      );
      return;
    }

    if (
      (response.status === 409 && text.includes("No online runner is available yet")) ||
      (response.status === 500 && text.includes("agent_start_failed"))
    ) {
      console.log(
        JSON.stringify({
          event: "local_cloud_smoke_waiting_for_runner",
          agentId,
          attempt,
          httpStatus: response.status,
        }),
      );
      await sleep(pollMs);
      continue;
    }

    throw new Error(`Agent start failed with HTTP ${response.status}: ${text}`);
  }

  throw new Error(`Agent did not start before timeout: ${agentId}`);
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Response was not valid JSON: ${error instanceof Error ? error.message : text}`,
    );
  }
}

function normalizeBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
