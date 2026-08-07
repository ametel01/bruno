import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import {
  createHermesReadinessWaiter,
  ManualRunnerDocker,
  type DockerExecutableRunner,
  type HermesCanaryTransportResult,
  type HermesDockerRuntimeOptions,
  type HermesHealthTransportResult,
} from "@/src/runner-service/docker";
import type { RunnerBootReadinessController } from "@/src/runner-service/boot-self-test";
import {
  RUNNER_BOOT_COMPONENTS,
  RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
  type RunnerBootSnapshot,
} from "@/src/runner-service/runner-contracts";
import {
  type HermesProjectionResult,
  projectHermesHome,
} from "@/src/runner-service/hermes-projection";

export const LOCAL_AGENT_SMOKE_MODE_ENV = "AGENTBAY_LOCAL_AGENT_SMOKE_MODE";
export const LOCAL_AGENT_SMOKE_MODE_VALUE = "synthetic-external-boundaries";
export const LOCAL_AGENT_SMOKE_FAKE_MODEL_CONTAINER = "agentbay-local-agent-fake-model";
export const LOCAL_AGENT_SMOKE_MODEL_ALIAS = "gpt-5.4";

const LOCAL_HOSTNAME = "host.docker.internal";
const REQUEST_TIMEOUT_MS = 60_000;
const HERMES_REQUEST_SOURCE = `
import json
import sys
import urllib.error
import urllib.request

method, path, key, raw_body = sys.argv[1:5]
body = raw_body.encode("utf-8") if raw_body else None
headers = {"authorization": f"Bearer {key}", "accept": "application/json"}
if body is not None:
    headers["content-type"] = "application/json"
request = urllib.request.Request(
    f"http://127.0.0.1:8642{path}",
    data=body,
    headers=headers,
    method=method,
)
try:
    with urllib.request.urlopen(request, timeout=45) as response:
        text = response.read().decode("utf-8")
        try:
            parsed = json.loads(text)
        except Exception:
            parsed = None
        print(json.dumps({"status": response.status, "body": parsed}))
except urllib.error.HTTPError as error:
    text = error.read().decode("utf-8")
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = None
    print(json.dumps({"status": error.code, "body": parsed}))
`;

export type LocalAgentSmokeMode =
  | { enabled: false }
  | {
      enabled: true;
      fakeModelBaseUrl: string;
    };

export function resolveLocalAgentSmokeMode(
  env: Record<string, string | undefined>,
): LocalAgentSmokeMode {
  const configured = env[LOCAL_AGENT_SMOKE_MODE_ENV];

  if (configured === undefined) {
    return { enabled: false };
  }

  if (configured !== LOCAL_AGENT_SMOKE_MODE_VALUE) {
    throw new Error(`${LOCAL_AGENT_SMOKE_MODE_ENV} has an invalid value.`);
  }

  assertLocalUrl(env.AGENTBAY_APP_URL, "AGENTBAY_APP_URL", [LOCAL_HOSTNAME]);
  assertLocalUrl(env.AGENTBAY_RUNNER_ENDPOINT_URL, "AGENTBAY_RUNNER_ENDPOINT_URL", [
    LOCAL_HOSTNAME,
    "127.0.0.1",
  ]);

  return {
    enabled: true,
    fakeModelBaseUrl: `http://${LOCAL_AGENT_SMOKE_FAKE_MODEL_CONTAINER}:8080/v1`,
  };
}

export function createLocalAgentSmokeRunnerDocker(
  env: Record<string, string | undefined>,
): ManualRunnerDocker | null {
  const mode = resolveLocalAgentSmokeMode(env);

  if (!mode.enabled) {
    return null;
  }

  const runtime = resolveRuntime(env);
  const hermesImage = env.AGENTBAY_HERMES_WORKLOAD_IMAGE?.trim() || "agentbay-hermes:local";
  const requestHealth = async (input: {
    apiServerKey: string;
    containerName: string;
  }): Promise<HermesHealthTransportResult> => {
    const response = await requestHermes(input.containerName, {
      apiServerKey: input.apiServerKey,
      path: "/health/detailed",
    });

    return {
      ok: response.status === 200,
      status: response.status,
      body: response.status === 200 ? withSyntheticTelegramHealth(response.body) : null,
    };
  };

  return new ManualRunnerDocker({
    docker: runLocalAgentSmokeDocker,
    hermes: runtime,
    projection: {
      project: async (spec) => {
        await ensureLocalAgentSmokeFakeModel(hermesImage, runtime.network);
        const projection = await projectHermesHome(spec, {
          ownership: { uid: 10_000, gid: 10_000 },
          ...(env.AGENTBAY_HERMES_STATE_ROOT ? { stateRoot: env.AGENTBAY_HERMES_STATE_ROOT } : {}),
        });
        await applyLocalAgentSmokeProjection(projection, mode.fakeModelBaseUrl);
        return projection;
      },
    },
    probe: {
      requestHealth,
      requestCanary: async (input): Promise<HermesCanaryTransportResult> => {
        const response = await requestHermes(input.containerName, {
          apiServerKey: input.apiServerKey,
          body: {
            model: input.model,
            messages: [{ role: "user", content: "Reply with ok." }],
            tools: [],
            stream: false,
            max_tokens: 16,
          },
          method: "POST",
          path: "/v1/chat/completions",
        });

        return {
          ok: response.status === 200,
          status: response.status,
          body: response.body,
        };
      },
    },
    readiness: {
      wait: createHermesReadinessWaiter(runtime, {
        requestHealth,
        requireTelegram: true,
        timeoutMs: readPositiveInteger(env.AGENTBAY_HERMES_READINESS_TIMEOUT_MS, 180_000),
      }),
    },
  });
}

async function ensureLocalAgentSmokeFakeModel(image: string, network: string): Promise<void> {
  await runLocalAgentSmokeDocker("docker", ["network", "inspect", network]);
  await runLocalAgentSmokeDocker("docker", [
    "rm",
    "--force",
    LOCAL_AGENT_SMOKE_FAKE_MODEL_CONTAINER,
  ]).catch(() => undefined);
  await runLocalAgentSmokeDocker("docker", [
    "run",
    "--detach",
    "--platform",
    "linux/amd64",
    "--name",
    LOCAL_AGENT_SMOKE_FAKE_MODEL_CONTAINER,
    "--label",
    "agentbay.smoke=local-agent-cycle",
    "--network",
    network,
    "--entrypoint",
    "python",
    image,
    "-c",
    LOCAL_AGENT_SMOKE_FAKE_MODEL_SOURCE,
  ]);
}

export function createLocalAgentSmokeBootReadiness(
  options: { docker?: DockerExecutableRunner; now?: () => Date } = {},
): RunnerBootReadinessController {
  const docker = options.docker ?? runLocalAgentSmokeDocker;
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  let snapshot = localBootSnapshot("testing", startedAt, null, "pending");
  let run: Promise<void> | null = null;

  return {
    async read() {
      return snapshot;
    },
    start() {
      run ??= (async () => {
        try {
          await docker("docker", ["version", "--format", "{{.Server.Version}}"], {
            timeoutMs: REQUEST_TIMEOUT_MS,
          });
          snapshot = localBootSnapshot("ready", startedAt, now().toISOString(), "passed");
        } catch {
          snapshot = localBootSnapshot("failed", startedAt, now().toISOString(), "failed");
        }
      })();
      return run;
    },
  };
}

function localBootSnapshot(
  status: RunnerBootSnapshot["status"],
  startedAt: string,
  completedAt: string | null,
  componentStatus: RunnerBootSnapshot["components"][keyof RunnerBootSnapshot["components"]],
): RunnerBootSnapshot {
  return {
    ok: true,
    contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
    validationMode: "full",
    attestations: null,
    status,
    components: Object.fromEntries(
      RUNNER_BOOT_COMPONENTS.map((component) => [
        component,
        status === "ready" &&
        (component === "releaseAttestation" || component === "snapshotAttestation")
          ? "not_applicable"
          : componentStatus,
      ]),
    ) as RunnerBootSnapshot["components"],
    failureReason: status === "failed" ? "docker_unavailable" : null,
    startedAt,
    completedAt,
  };
}

function runLocalAgentSmokeDocker(
  executable: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const localArgs =
    args[0] === "stop" && args[1] === "--time" && args[2] === "20"
      ? ["stop", "--time", "1", ...args.slice(3)]
      : [...args];

  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      localArgs,
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

async function applyLocalAgentSmokeProjection(
  projection: HermesProjectionResult,
  fakeModelBaseUrl: string,
): Promise<void> {
  const parsed = parse(await readFile(projection.configPath, "utf8"));

  if (!isRecord(parsed)) {
    throw new Error("Local agent smoke projection did not render a YAML mapping.");
  }

  const platforms = ensureRecord(parsed, "platforms");
  const telegram = ensureRecord(platforms, "telegram");
  const apiServer = ensureRecord(platforms, "api_server");
  const apiExtra = ensureRecord(apiServer, "extra");
  const routes = ensureRecord(apiExtra, "model_routes");

  if (telegram.enabled !== true || apiServer.enabled !== true) {
    throw new Error("Local agent smoke projection did not enable the managed platforms.");
  }

  telegram.enabled = false;
  routes[LOCAL_AGENT_SMOKE_MODEL_ALIAS] = {
    model: LOCAL_AGENT_SMOKE_MODEL_ALIAS,
    provider: "openai-api",
    base_url: fakeModelBaseUrl,
  };

  await writeFile(
    projection.configPath,
    stringify(parsed, { indent: 2, lineWidth: 0, sortMapEntries: true }),
    "utf8",
  );
}

function resolveRuntime(env: Record<string, string | undefined>): HermesDockerRuntimeOptions {
  return {
    cpus: env.AGENTBAY_HERMES_DOCKER_CPUS?.trim() || "1",
    memory: env.AGENTBAY_HERMES_DOCKER_MEMORY?.trim() || "1536m",
    network: env.AGENTBAY_HERMES_PRIVATE_NETWORK?.trim() || "agentbay-hermes",
    pidsLimit: env.AGENTBAY_HERMES_DOCKER_PIDS_LIMIT?.trim() || "256",
    readinessPort: readPositiveInteger(env.AGENTBAY_HERMES_READINESS_PORT, 8642),
  };
}

async function requestHermes(
  containerName: string,
  input: {
    apiServerKey: string;
    body?: unknown;
    method?: "GET" | "POST";
    path: string;
  },
): Promise<{ status: number; body: unknown }> {
  const result = await runDocker([
    "exec",
    containerName,
    "python",
    "-c",
    HERMES_REQUEST_SOURCE,
    input.method ?? "GET",
    input.path,
    input.apiServerKey,
    input.body === undefined ? "" : JSON.stringify(input.body),
  ]);
  const parsed: unknown = JSON.parse(result.stdout);

  if (!isRecord(parsed) || typeof parsed.status !== "number") {
    throw new Error("Local agent smoke Hermes response was invalid.");
  }

  return { status: parsed.status, body: parsed.body };
}

function runDocker(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "docker",
      [...args],
      { encoding: "utf8", timeout: REQUEST_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error("Local agent smoke Docker probe failed.", { cause: error }));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

function withSyntheticTelegramHealth(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }

  const platforms = isRecord(body.platforms) ? body.platforms : {};
  return {
    ...body,
    platforms: {
      ...platforms,
      api_server: { state: "connected" },
      telegram: { state: "connected" },
    },
  };
}

function assertLocalUrl(
  value: string | undefined,
  envName: string,
  allowedHostnames: readonly string[],
): void {
  try {
    const url = new URL(value ?? "");
    if (
      url.protocol !== "http:" ||
      !allowedHostnames.includes(url.hostname) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(`${envName} must be an isolated local HTTP URL.`);
  }
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (isRecord(existing)) return existing;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const LOCAL_AGENT_SMOKE_FAKE_MODEL_SOURCE = `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def _json(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "provider": "agentbay-local-fake-openai"})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or "0")
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path != "/v1/chat/completions":
            self._json(404, {"error": "not_found"})
            return
        model = str(body.get("model") or "unknown")
        self._json(200, {
            "id": "chatcmpl-agentbay-local-agent-smoke",
            "object": "chat.completion",
            "created": 1784000000,
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "agentbay local fake model response"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

    def log_message(self, _format, *_args):
        return

ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`;
