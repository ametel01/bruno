import { writeFile } from "node:fs/promises";
import { RUNNER_BOOT_MODEL_CANARY_ENABLED_ENV } from "@/src/runner-service/constants";
import {
  resolveRunnerReleaseEvidence,
  RUNNER_CONTAINER_ID_ENV,
  RUNNER_EXPECTED_BOOT_CONTRACT_VERSION_ENV,
  RUNNER_EXPECTED_IMAGE_DIGEST_ENV,
  RUNNER_EXPECTED_RELEASE_VERSION_ENV,
  RUNNER_RELEASE_IDENTITY_MODE_ENV,
  type RunnerReleaseEvidence,
} from "@/src/runner-service/release-identity";

type RunnerBootstrapEnv = {
  BRUNO_APP_URL?: string;
  BRUNO_RUNNER_REGISTRATION_TOKEN?: string;
  BRUNO_RUNNER_ENDPOINT_URL?: string;
  BRUNO_RUNNER_NAME?: string;
  BRUNO_RUNNER_ID?: string;
  BRUNO_RUNNER_CREDENTIAL?: string;
  BRUNO_RUNNER_ENV_FILE?: string;
  BRUNO_RUNNER_HOST?: string;
  BRUNO_RUNNER_PORT?: string;
  BRUNO_RUNNER_BEARER_TOKEN?: string;
  BRUNO_DOCKER_RUNNER_IMAGE?: string;
  BRUNO_RUNNER_CONTAINER_ID?: string;
  BRUNO_RUNNER_EXPECTED_RELEASE_VERSION?: string;
  BRUNO_RUNNER_EXPECTED_IMAGE_DIGEST?: string;
  BRUNO_RUNNER_EXPECTED_BOOT_CONTRACT_VERSION?: string;
  BRUNO_RUNNER_RELEASE_IDENTITY_MODE?: string;
  BRUNO_RUNNER_BOOT_MODEL_CANARY_ENABLED?: string;
  BRUNO_LOCAL_AGENT_SMOKE_MODE?: string;
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
      status: "degraded" | "online";
    }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "registration_failed"
        | "registration_response_invalid"
        | "release_identity_unavailable"
        | "heartbeat_failed";
    };

export async function bootstrapRegisteredRunner(
  input: {
    env?: RunnerBootstrapEnv;
    fetch?: typeof fetch;
    releaseEvidence?: RunnerReleaseEvidence;
    resolveReleaseEvidence?: (env: RunnerBootstrapEnv) => Promise<RunnerReleaseEvidence>;
    writeEnvFile?: WriteRunnerEnvFile;
  } = {},
): Promise<RunnerBootstrapResult> {
  const env = (input.env ?? process.env) as RunnerBootstrapEnv;
  const fetchImplementation = input.fetch ?? fetch;
  const writeEnvFile = input.writeEnvFile ?? defaultWriteEnvFile;
  const appBaseUrl = normalizeBaseUrl(env.BRUNO_APP_URL);
  const endpointUrl = env.BRUNO_RUNNER_ENDPOINT_URL?.trim();
  const runnerName = env.BRUNO_RUNNER_NAME?.trim() || "Bruno Cloud Runner";
  const envFilePath = env.BRUNO_RUNNER_ENV_FILE?.trim();
  let runnerId = env.BRUNO_RUNNER_ID?.trim() ?? "";
  let credential = env.BRUNO_RUNNER_CREDENTIAL?.trim() ?? "";

  if (!appBaseUrl || !endpointUrl) {
    return { ok: false, reason: "not_configured" };
  }

  if (!runnerId || !credential) {
    const registrationToken = env.BRUNO_RUNNER_REGISTRATION_TOKEN?.trim();

    if (!registrationToken) {
      return { ok: false, reason: "not_configured" };
    }
  }

  let releaseEvidence: RunnerReleaseEvidence;

  try {
    releaseEvidence =
      input.releaseEvidence ??
      (await (input.resolveReleaseEvidence
        ? input.resolveReleaseEvidence(env)
        : resolveRunnerReleaseEvidence({ env })));
  } catch {
    return { ok: false, reason: "release_identity_unavailable" };
  }

  if (!runnerId || !credential) {
    const registrationToken = env.BRUNO_RUNNER_REGISTRATION_TOKEN?.trim();

    if (!registrationToken) return { ok: false, reason: "not_configured" };

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
      status: releaseEvidence.expectedMatch === false ? "degraded" : "online",
      version: "bruno-runner/bootstrap",
      release: releaseEvidence.release,
    }),
  });

  if (!heartbeat.ok) {
    return { ok: false, reason: "heartbeat_failed" };
  }

  return {
    ok: true,
    runnerId,
    status: releaseEvidence.expectedMatch === false ? "degraded" : "online",
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
    envLine("BRUNO_APP_URL", input.appBaseUrl),
    envLine("BRUNO_RUNNER_ENDPOINT_URL", input.endpointUrl),
    envLine("BRUNO_RUNNER_NAME", input.runnerName),
    envLine("BRUNO_RUNNER_ID", input.runnerId),
    envLine("BRUNO_RUNNER_CREDENTIAL", input.credential),
  ];

  for (const key of [
    "BRUNO_RUNNER_HOST",
    "BRUNO_RUNNER_PORT",
    "BRUNO_RUNNER_BEARER_TOKEN",
    "BRUNO_DOCKER_RUNNER_IMAGE",
    RUNNER_CONTAINER_ID_ENV,
    RUNNER_EXPECTED_RELEASE_VERSION_ENV,
    RUNNER_EXPECTED_IMAGE_DIGEST_ENV,
    RUNNER_EXPECTED_BOOT_CONTRACT_VERSION_ENV,
    RUNNER_RELEASE_IDENTITY_MODE_ENV,
    RUNNER_BOOT_MODEL_CANARY_ENABLED_ENV,
    "BRUNO_LOCAL_AGENT_SMOKE_MODE",
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
    console.error(`bruno runner bootstrap failed: ${result.reason}`);
    process.exit(1);
  }

  console.log(`bruno runner bootstrap completed for runner ${result.runnerId}.`);
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
