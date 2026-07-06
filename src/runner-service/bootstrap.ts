import { writeFile } from "node:fs/promises";

type RunnerBootstrapEnv = {
  AGENTBAY_APP_URL?: string;
  AGENTBAY_RUNNER_REGISTRATION_TOKEN?: string;
  AGENTBAY_RUNNER_ENDPOINT_URL?: string;
  AGENTBAY_RUNNER_NAME?: string;
  AGENTBAY_RUNNER_ID?: string;
  AGENTBAY_RUNNER_CREDENTIAL?: string;
  AGENTBAY_RUNNER_ENV_FILE?: string;
  AGENTBAY_RUNNER_HOST?: string;
  AGENTBAY_RUNNER_PORT?: string;
  AGENTBAY_RUNNER_BEARER_TOKEN?: string;
};

type WriteRunnerEnvFile = (
  path: string,
  content: string,
  options: { mode: number },
) => Promise<void>;

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
  input: { env?: RunnerBootstrapEnv; fetch?: typeof fetch; writeEnvFile?: WriteRunnerEnvFile } = {},
): Promise<RunnerBootstrapResult> {
  const env = (input.env ?? process.env) as RunnerBootstrapEnv;
  const fetchImplementation = input.fetch ?? fetch;
  const writeEnvFile = input.writeEnvFile ?? defaultWriteEnvFile;
  const appBaseUrl = normalizeBaseUrl(env.AGENTBAY_APP_URL);
  const endpointUrl = env.AGENTBAY_RUNNER_ENDPOINT_URL?.trim();
  const runnerName = env.AGENTBAY_RUNNER_NAME?.trim() || "AgentBay Cloud Runner";
  const envFilePath = env.AGENTBAY_RUNNER_ENV_FILE?.trim();
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

    if (envFilePath) {
      await writeEnvFile(
        envFilePath,
        buildPersistedRunnerEnv({
          env,
          appBaseUrl,
          endpointUrl,
          runnerName,
          runnerId,
          credential,
        }),
        { mode: 0o600 },
      );
    }
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

function defaultWriteEnvFile(path: string, content: string, options: { mode: number }) {
  return writeFile(path, content, { mode: options.mode });
}

function buildPersistedRunnerEnv(input: {
  env: RunnerBootstrapEnv;
  appBaseUrl: string;
  endpointUrl: string;
  runnerName: string;
  runnerId: string;
  credential: string;
}): string {
  const lines = [
    envLine("AGENTBAY_APP_URL", input.appBaseUrl),
    envLine("AGENTBAY_RUNNER_ENDPOINT_URL", input.endpointUrl),
    envLine("AGENTBAY_RUNNER_NAME", input.runnerName),
    envLine("AGENTBAY_RUNNER_ID", input.runnerId),
    envLine("AGENTBAY_RUNNER_CREDENTIAL", input.credential),
  ];

  for (const key of [
    "AGENTBAY_RUNNER_HOST",
    "AGENTBAY_RUNNER_PORT",
    "AGENTBAY_RUNNER_BEARER_TOKEN",
  ] as const) {
    const value = input.env[key]?.trim();

    if (value) {
      lines.push(envLine(key, value));
    }
  }

  return `${lines.join("\n")}\n`;
}

function envLine(key: string, value: string): string {
  return `${key}=${quoteEnvValue(value)}`;
}

function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
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
