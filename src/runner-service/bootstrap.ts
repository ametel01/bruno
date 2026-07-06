type RunnerBootstrapEnv = {
  AGENTBAY_APP_URL?: string;
  AGENTBAY_RUNNER_REGISTRATION_TOKEN?: string;
  AGENTBAY_RUNNER_ENDPOINT_URL?: string;
  AGENTBAY_RUNNER_NAME?: string;
  AGENTBAY_RUNNER_ID?: string;
  AGENTBAY_RUNNER_CREDENTIAL?: string;
};

export type RunnerBootstrapResult =
  | {
      ok: true;
      runnerId: string;
      status: "online";
    }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "registration_failed"
        | "registration_response_invalid"
        | "heartbeat_failed";
    };

export async function bootstrapRegisteredRunner(
  input: { env?: RunnerBootstrapEnv; fetch?: typeof fetch } = {},
): Promise<RunnerBootstrapResult> {
  const env = input.env ?? process.env;
  const fetchImplementation = input.fetch ?? fetch;
  const appBaseUrl = normalizeBaseUrl(env.AGENTBAY_APP_URL);
  const endpointUrl = env.AGENTBAY_RUNNER_ENDPOINT_URL?.trim();
  const runnerName = env.AGENTBAY_RUNNER_NAME?.trim() || "AgentBay Cloud Runner";
  let runnerId = env.AGENTBAY_RUNNER_ID?.trim() ?? "";
  let credential = env.AGENTBAY_RUNNER_CREDENTIAL?.trim() ?? "";

  if (!appBaseUrl || !endpointUrl) {
    return { ok: false, reason: "not_configured" };
  }

  if (!runnerId || !credential) {
    const registrationToken = env.AGENTBAY_RUNNER_REGISTRATION_TOKEN?.trim();

    if (!registrationToken) {
      return { ok: false, reason: "not_configured" };
    }

    const registered = await fetchImplementation(`${appBaseUrl}/runner/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        registrationToken,
        endpointUrl,
        name: runnerName,
      }),
    });

    if (!registered.ok) {
      return { ok: false, reason: "registration_failed" };
    }

    const body = await registered.json();
    const parsedRegistration = parseRegistrationResponse(body);

    if (!parsedRegistration) {
      return { ok: false, reason: "registration_response_invalid" };
    }

    runnerId = parsedRegistration.runnerId;
    credential = parsedRegistration.credential;
  }

  const heartbeat = await fetchImplementation(`${appBaseUrl}/runner/v1/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runnerId,
      status: "online",
      version: "agentbay-runner/bootstrap",
    }),
  });

  if (!heartbeat.ok) {
    return { ok: false, reason: "heartbeat_failed" };
  }

  return {
    ok: true,
    runnerId,
    status: "online",
  };
}

if (import.meta.main) {
  const result = await bootstrapRegisteredRunner();

  if (!result.ok) {
    console.error(`AgentBay runner bootstrap failed: ${result.reason}`);
    process.exit(1);
  }

  console.log(`AgentBay runner bootstrap completed for runner ${result.runnerId}.`);
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  try {
    return new URL(normalized).toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseRegistrationResponse(
  value: unknown,
): { runnerId: string; credential: string } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const body = value as Record<string, unknown>;
  const runner = typeof body.runner === "object" && body.runner !== null ? body.runner : null;
  const credential =
    typeof body.credential === "object" && body.credential !== null ? body.credential : null;

  const runnerId =
    runner && "id" in runner && typeof runner.id === "string" ? runner.id.trim() : "";
  const credentialToken =
    credential && "token" in credential && typeof credential.token === "string"
      ? credential.token.trim()
      : "";

  return runnerId && credentialToken ? { runnerId, credential: credentialToken } : null;
}
