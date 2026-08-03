import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import {
  MANAGED_AGENT_LAUNCH_SPEC_VERSION,
  type AgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";
import {
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
} from "@/src/runner-service/constants";
import {
  createHermesReadinessWaiter,
  ManualRunnerDocker,
  type RunnerLogLine,
} from "@/src/runner-service/docker";
import {
  projectHermesHome,
  type HermesProjectionResult,
} from "@/src/runner-service/hermes-projection";
import { DEFAULT_LOCAL_HERMES_IMAGE } from "@/scripts/smoke-hermes-agent-image";

const FAKE_MODEL_ALIAS = "agentbay/local-fake-model";
const SMOKE_IMAGE = process.env.AGENTBAY_HERMES_IMAGE?.trim() || DEFAULT_LOCAL_HERMES_IMAGE;
const TIMEOUT_MS = readPositiveInteger(process.env.AGENTBAY_HERMES_CONTRACT_TIMEOUT_MS, 240_000);
const POLL_MS = readPositiveInteger(process.env.AGENTBAY_HERMES_CONTRACT_POLL_MS, 1_000);

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type HermesHttpResult = {
  status: number;
  body: unknown;
  text: string;
};

export type LocalHermesContractSmokeSummary = {
  agentId: string;
  backupRestored: true;
  canaryPassed: true;
  configRevision: string;
  duplicateLaunchReused: true;
  elapsedMs: number;
  fakeModelContainer: string;
  image: string;
  logSources: string[];
  modelResponse: string;
  network: string;
  noPublicHermesPort: true;
  privateApiAuth: true;
  removedAgentRoot: true;
  restartReused: true;
  statePersistence: true;
  statusProgression: ["accepted", "starting", "ready"];
  telegramBoundary: "local-fake-platform-state";
};

export async function smokeLocalHermesContract(): Promise<LocalHermesContractSmokeSummary> {
  const startedAt = Date.now();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const agentId = randomUUID();
  const network =
    process.env.AGENTBAY_HERMES_CONTRACT_NETWORK?.trim() ||
    `${DEFAULT_HERMES_PRIVATE_NETWORK}-smoke-${suffix}`;
  const fakeModelContainer = `agentbay-hermes-fake-model-${suffix}`;
  const stateRoot = await mkdtemp(join(tmpdir(), "agentbay-hermes-contract-"));
  const backupRoot = resolve(stateRoot, `${agentId}.backup`);
  const previousStateRoot = process.env.AGENTBAY_HERMES_STATE_ROOT;
  let networkCreated = false;
  let projection: HermesProjectionResult | null = null;
  let projectionRoot: string | null = null;

  process.env.AGENTBAY_HERMES_STATE_ROOT = stateRoot;

  try {
    await docker(["image", "inspect", SMOKE_IMAGE]);
    await docker(["network", "create", network]);
    networkCreated = true;
    await startFakeModelServer({ containerName: fakeModelContainer, image: SMOKE_IMAGE, network });

    const spec = buildSmokeLaunchSpec({
      agentId,
      configRevision: `cfg-${Date.now()}`,
      fakeModelImage: SMOKE_IMAGE,
    });
    const hermesRuntime = {
      cpus: "1",
      memory: "1536m",
      network,
      pidsLimit: "256",
      readinessPort: 8642,
    };
    let runnerHealthObservations = 0;
    const waitForLocalHermesReadiness = createHermesReadinessWaiter(hermesRuntime, {
      pollMs: POLL_MS,
      requireTelegram: true,
      timeoutMs: TIMEOUT_MS,
      requestHealth: async (input) => {
        const response = await requestHermes(input.containerName, {
          apiServerKey: input.apiServerKey,
          path: "/health/detailed",
        }).catch(() => null);

        return {
          ok: response?.status === 200,
          body: response?.status === 200 ? withLocalFakeTelegramHealth(response.body) : null,
        };
      },
    });
    const runner = new ManualRunnerDocker({
      hermes: hermesRuntime,
      probe: {
        requestCanary: async (input) => {
          const response = await requestHermes(input.containerName, {
            apiServerKey: input.apiServerKey,
            body: {
              model: input.model,
              messages: [
                {
                  role: "user",
                  content: "Reply with ok.",
                },
              ],
              tools: [],
              stream: false,
              max_tokens: 16,
            },
            method: "POST",
            path: "/v1/chat/completions",
          }).catch(() => null);

          return {
            ok: response?.status === 200,
            status: response?.status ?? 0,
            body: response?.body ?? null,
          };
        },
        requestHealth: async (input) => {
          runnerHealthObservations += 1;
          if (runnerHealthObservations === 1) {
            return {
              ok: true,
              body: {
                status: "ok",
                gateway_state: "starting",
                platforms: {
                  api_server: { state: "connecting" },
                  telegram: { state: "connecting" },
                },
              },
            };
          }

          const response = await requestHermes(input.containerName, {
            apiServerKey: input.apiServerKey,
            path: "/health/detailed",
          }).catch(() => null);

          return {
            ok: response?.status === 200,
            body: response?.status === 200 ? withLocalFakeTelegramHealth(response.body) : null,
          };
        },
      },
      projection: {
        project: async (launchSpec) => {
          const projected = await projectHermesHome(launchSpec, {
            stateRoot,
          });
          await applyLocalSmokeOverrides({
            fakeModelBaseUrl: `http://${fakeModelContainer}:8080/v1`,
            projection: projected,
          });
          projection = projected;
          projectionRoot = projected.agentRoot;
          return projected;
        },
      },
      readiness: {
        wait: waitForLocalHermesReadiness,
      },
    });

    const started = await runner.start(agentId, spec);
    const launchAcceptedAt = Date.now();

    if (!projection) {
      throw new Error("Hermes projection was not returned by the runner.");
    }
    const activeProjection: HermesProjectionResult = projection;

    if (
      !("snapshot" in started) ||
      !started.snapshot.container.id ||
      !started.snapshot.container.name
    ) {
      throw new Error("Hermes runner did not return an accepted launch snapshot.");
    }

    await assertProjectedConfigRevision(activeProjection, spec.agent.configRevision);
    await assertNoPublicHermesPort(started.snapshot.container.id);
    if (launchAcceptedAt - startedAt >= 30_000) {
      throw new Error("Hermes launch acceptance exceeded the 30-second runner budget.");
    }

    const duplicate = await runner.start(agentId, spec);
    if (
      !("snapshot" in duplicate) ||
      duplicate.operation.disposition !== "reused" ||
      duplicate.operation.id !== started.operation.id ||
      duplicate.snapshot.container.id !== started.snapshot.container.id
    ) {
      throw new Error("Duplicate Hermes launch did not reuse one exact operation and container.");
    }

    const startingStatus = await runner.status(agentId);
    if (startingStatus.snapshot.phase !== "starting") {
      throw new Error(
        `Hermes runner did not expose starting after asynchronous acceptance: ${startingStatus.snapshot.phase}/${startingStatus.snapshot.readinessReason}/${startingStatus.snapshot.revision.state}`,
      );
    }

    const readiness = await waitForLocalHermesReadiness({
      agentId,
      apiServerKey: spec.secrets.apiServerKey,
      configRevision: spec.agent.configRevision,
      containerName: started.snapshot.container.name,
    });

    if (!readiness.ok) {
      throw new Error(
        `Hermes readiness did not complete after launch acceptance: ${readiness.reason}`,
      );
    }

    await assertPrivateApiAuth(started.snapshot.container.name, spec.secrets.apiServerKey);
    const modelResponse = await runHermesModelTurn(
      started.snapshot.container.name,
      spec.secrets.apiServerKey,
    );
    const status = await runner.status(agentId);

    if (status.snapshot.phase !== "ready" || !status.snapshot.operation) {
      throw new Error("Hermes runner status did not report a ready operation after readiness.");
    }

    const canary = await runner.canary(agentId, {
      operationId: status.snapshot.operation.id,
      configRevision: spec.agent.configRevision,
      model: spec.model.model,
    });

    if (canary.observation.state !== "passed") {
      throw new Error("Hermes runner canary did not pass through the private API seam.");
    }

    const reusedRestart = await runner.restart(agentId, spec);
    if (
      !("snapshot" in reusedRestart) ||
      reusedRestart.operation.disposition !== "reused" ||
      reusedRestart.operation.id !== status.snapshot.operation.id ||
      reusedRestart.snapshot.container.id !== status.snapshot.container.id
    ) {
      throw new Error("Hermes restart did not reuse the exact running operation and container.");
    }
    const sentinelPath = join(activeProjection.workspace, "agentbay-contract-sentinel.txt");

    await writeFile(sentinelPath, "agentbay local hermes contract persisted\n", "utf8");
    const firstLogs = await waitForHermesGatewayLogs(runner, agentId);

    const stopped = await runner.stop(agentId);
    if (
      stopped.cancelledOperationId !== status.snapshot.operation.id ||
      stopped.snapshot.phase !== "stopped"
    ) {
      throw new Error("Hermes stop did not return exact cancellation evidence.");
    }
    await cp(activeProjection.agentRoot, backupRoot, { recursive: true });
    await rm(activeProjection.agentRoot, { force: true, recursive: true });
    await cp(backupRoot, activeProjection.agentRoot, { recursive: true });

    const restarted = await runner.restart(agentId, spec);
    const sentinel = await readFile(sentinelPath, "utf8");

    if (!sentinel.includes("agentbay local hermes contract persisted")) {
      throw new Error("Hermes workspace state did not survive backup/restore and restart.");
    }

    if (!("snapshot" in restarted) || !restarted.snapshot.container.name) {
      throw new Error("Hermes runner did not return an accepted restart snapshot.");
    }

    await assertPrivateApiAuth(restarted.snapshot.container.name, spec.secrets.apiServerKey);
    const cleaned = await runner.cleanup(agentId);
    if (!cleaned.cancelledOperationId || cleaned.snapshot.phase !== "cancelled") {
      throw new Error("Hermes cleanup did not return exact cancellation evidence.");
    }
    await assertPathRemoved(activeProjection.agentRoot, "Hermes agent root");
    await assertNoSelectedContainers(agentId);

    return {
      agentId,
      backupRestored: true,
      canaryPassed: true,
      configRevision: spec.agent.configRevision,
      duplicateLaunchReused: true,
      elapsedMs: Date.now() - startedAt,
      fakeModelContainer,
      image: SMOKE_IMAGE,
      logSources: [...new Set(firstLogs.map((line) => line.source ?? "container_bootstrap"))],
      modelResponse,
      network,
      noPublicHermesPort: true,
      privateApiAuth: true,
      removedAgentRoot: true,
      restartReused: true,
      statePersistence: true,
      statusProgression: ["accepted", "starting", "ready"],
      telegramBoundary: "local-fake-platform-state",
    };
  } finally {
    await removeLabeledAgentContainers(agentId);
    await docker(["rm", "--force", fakeModelContainer], { allowFailure: true });
    if (projectionRoot) {
      await rm(projectionRoot, { force: true, recursive: true }).catch(() => undefined);
    }
    await rm(backupRoot, { force: true, recursive: true }).catch(() => undefined);
    await rm(stateRoot, { force: true, recursive: true }).catch(() => undefined);
    if (networkCreated) {
      await docker(["network", "rm", network], { allowFailure: true });
    }
    if (previousStateRoot === undefined) {
      delete process.env.AGENTBAY_HERMES_STATE_ROOT;
    } else {
      process.env.AGENTBAY_HERMES_STATE_ROOT = previousStateRoot;
    }
  }
}

function buildSmokeLaunchSpec(input: {
  agentId: string;
  configRevision: string;
  fakeModelImage: string;
}): AgentLaunchSpec {
  return {
    version: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
    requestId: randomUUID(),
    agent: {
      id: input.agentId,
      name: "Local Hermes contract smoke",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      configRevision: input.configRevision,
    },
    image: {
      ref: input.fakeModelImage || DEFAULT_HERMES_WORKLOAD_IMAGE,
    },
    model: {
      provider: "openrouter",
      model: FAKE_MODEL_ALIAS,
    },
    platforms: {
      required: ["api_server", "telegram"],
      apiServer: {
        enabled: true,
        host: "0.0.0.0",
        port: 8642,
      },
      telegram: {
        enabled: true,
        allowAllUsers: false,
        unauthorizedDmBehavior: "ignore",
      },
    },
    schedule: {
      mode: "manual",
      cron: null,
      timezone: "UTC",
    },
    prompt: {
      soul: "Reply tersely for the AgentBay local Hermes contract smoke.",
    },
    runtime: {
      dataDir: "/opt/data",
      workspaceDir: "/workspace",
      terminalCwd: "/workspace",
      browserEnabled: false,
      unattendedLoopLimit: 3,
      toolLoopGuardrails: {
        hardStopEnabled: true,
        hardStopAfter: {
          exactFailure: 5,
          idempotentNoProgress: 5,
        },
      },
    },
    tools: {
      enabled: ["file_operations", "terminal"],
      disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
    },
    secrets: {
      kind: "inline",
      openrouterApiKey: "sk-or-v1-contractsmokelocalfakemodelkey",
      telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
      telegramAllowedUsers: ["1"],
      apiServerKey: `agb_agent_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
    },
  };
}

async function applyLocalSmokeOverrides(input: {
  fakeModelBaseUrl: string;
  projection: HermesProjectionResult;
}): Promise<void> {
  const config = await readFile(input.projection.configPath, "utf8");
  const env = await readFile(input.projection.envPath, "utf8");
  const parsed = parse(config);

  if (!isRecord(parsed)) {
    throw new Error("Managed Hermes projection did not render a YAML mapping.");
  }

  const platforms = ensureRecord(parsed, "platforms");
  const telegram = ensureRecord(platforms, "telegram");
  const apiServer = ensureRecord(platforms, "api_server");
  const apiExtra = ensureRecord(apiServer, "extra");
  const routes = ensureRecord(apiExtra, "model_routes");

  if (telegram.enabled !== true || apiServer.enabled !== true) {
    throw new Error("Managed Hermes projection did not enable required platforms before smoke.");
  }

  telegram.enabled = false;
  routes[FAKE_MODEL_ALIAS] = {
    model: FAKE_MODEL_ALIAS,
    provider: "openrouter",
    base_url: input.fakeModelBaseUrl,
  };

  await writeFile(
    input.projection.configPath,
    stringify(parsed, { indent: 2, lineWidth: 0, sortMapEntries: true }),
    "utf8",
  );
  await writeFile(input.projection.envPath, env, "utf8");
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];

  if (isRecord(existing)) {
    return existing;
  }

  const created: Record<string, unknown> = {};
  parent[key] = created;

  return created;
}

function withLocalFakeTelegramHealth(body: unknown): unknown {
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

async function startFakeModelServer(input: {
  containerName: string;
  image: string;
  network: string;
}): Promise<void> {
  await docker([
    "run",
    "--detach",
    "--platform",
    "linux/amd64",
    "--name",
    input.containerName,
    "--network",
    input.network,
    "--entrypoint",
    "python",
    input.image,
    "-c",
    FAKE_MODEL_SERVER_SOURCE,
  ]);

  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const result = await docker(
      [
        "exec",
        input.containerName,
        "python",
        "-c",
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).read()",
      ],
      { allowFailure: true },
    );

    if (result.exitCode === 0) {
      return;
    }

    await sleep(POLL_MS);
  }

  throw new Error("Fake OpenAI-compatible model server did not become ready.");
}

async function assertPrivateApiAuth(containerName: string, apiServerKey: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const unauthorized = await requestHermes(containerName, {
      apiServerKey: "wrong-local-smoke-key",
      path: "/health/detailed",
    }).catch(() => null);

    if (unauthorized?.status !== 401) {
      await sleep(POLL_MS);
      continue;
    }

    const authorized = await requestHermes(containerName, {
      apiServerKey,
      path: "/health/detailed",
    }).catch(() => null);

    if (authorized?.status === 200 && isRecord(authorized.body)) {
      return;
    }

    await sleep(POLL_MS);
  }

  throw new Error("Hermes private API auth boundary did not stabilize.");
}

async function assertProjectedConfigRevision(
  projection: HermesProjectionResult,
  configRevision: string,
): Promise<void> {
  const revision = JSON.parse(await readFile(projection.revisionPath, "utf8")) as {
    configRevision?: unknown;
  };

  if (revision.configRevision !== configRevision) {
    throw new Error("Projected Hermes config revision does not match the launch spec.");
  }
}

async function runHermesModelTurn(containerName: string, apiServerKey: string): Promise<string> {
  const response = await requestHermes(containerName, {
    apiServerKey,
    body: {
      model: FAKE_MODEL_ALIAS,
      messages: [
        {
          role: "user",
          content: "Reply with the deterministic AgentBay local contract phrase.",
        },
      ],
      stream: false,
    },
    method: "POST",
    path: "/v1/chat/completions",
  });

  if (response.status !== 200) {
    throw new Error(`Hermes model turn failed with HTTP ${response.status}: ${response.text}`);
  }

  const content = readChatCompletionContent(response.body);

  if (!content.includes("agentbay fake model response")) {
    throw new Error(`Hermes model turn did not use the fake provider: ${content}`);
  }

  return content;
}

async function waitForHermesGatewayLogs(
  runner: ManualRunnerDocker,
  agentId: string,
): Promise<RunnerLogLine[]> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const result = await runner.logs(agentId);
    const gatewayLogs = result.logs.filter((line) => line.source === "hermes_gateway");

    if (gatewayLogs.length > 0) {
      return result.logs;
    }

    await sleep(POLL_MS);
  }

  throw new Error("Hermes gateway logs were not ingested from durable state.");
}

async function assertNoPublicHermesPort(containerId: string): Promise<void> {
  const portResult = await docker(["port", containerId, "8642"], { allowFailure: true });

  if (portResult.stdout.trim()) {
    throw new Error(`Hermes API port is publicly published: ${portResult.stdout.trim()}`);
  }
}

async function assertNoSelectedContainers(agentId: string): Promise<void> {
  const result = await docker([
    "ps",
    "--all",
    "--filter",
    `label=agentbay.agent_id=${agentId}`,
    "--format",
    "{{.ID}}",
  ]);

  if (result.stdout.trim()) {
    throw new Error(`Cleanup left Hermes containers behind: ${result.stdout.trim()}`);
  }
}

async function removeLabeledAgentContainers(agentId: string): Promise<void> {
  const result = await docker([
    "ps",
    "--all",
    "--filter",
    `label=agentbay.agent_id=${agentId}`,
    "--format",
    "{{.ID}}",
  ]);
  const ids = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (ids.length > 0) {
    await docker(["rm", "--force", ...ids], { allowFailure: true });
  }
}

async function assertPathRemoved(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }

  throw new Error(`${label} still exists after cleanup: ${path}`);
}

async function requestHermes(
  containerName: string,
  input: {
    apiServerKey: string;
    body?: unknown;
    method?: "GET" | "POST";
    path: string;
  },
): Promise<HermesHttpResult> {
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  const result = await docker([
    "exec",
    containerName,
    "python",
    "-c",
    HERMES_REQUEST_SOURCE,
    input.method ?? "GET",
    input.path,
    input.apiServerKey,
    body,
  ]);
  const parsed = JSON.parse(result.stdout) as HermesHttpResult;

  return parsed;
}

function readChatCompletionContent(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }

  const choices = value.choices;

  if (!Array.isArray(choices) || !isRecord(choices[0])) {
    return "";
  }

  const message = choices[0].message;

  if (!isRecord(message) || typeof message.content !== "string") {
    return "";
  }

  return message.content;
}

function docker(
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return runCommand("docker", args, options);
}

function runCommand(
  command: string,
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        env: process.env,
        timeout: options.timeoutMs ?? 60_000,
      },
      (error, stdout, stderr) => {
        const exitCode =
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? ((error as { code: number }).code ?? null)
            : error
              ? 1
              : 0;
        const result = { exitCode, stdout, stderr };

        if (error && !options.allowFailure) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed with exit ${exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
          return;
        }

        resolvePromise(result);
      },
    );
  });
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const FAKE_MODEL_SERVER_SOURCE = String.raw`
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
            self._json(200, {"ok": True, "provider": "agentbay-fake-openai"})
            return
        if self.path == "/v1/models":
            self._json(200, {"object": "list", "data": [{"id": "openai/gpt-4.1-mini", "object": "model"}]})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or "0")
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path != "/v1/chat/completions":
            self._json(404, {"error": "not_found"})
            return
        model = str(body.get("model") or "unknown")
        content = f"agentbay fake model response provider=openai-compatible model={model}"
        if body.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            chunk = {
                "id": "chatcmpl-agentbay-local-smoke",
                "object": "chat.completion.chunk",
                "created": 1784000000,
                "model": model,
                "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}],
            }
            done = {
                "id": "chatcmpl-agentbay-local-smoke",
                "object": "chat.completion.chunk",
                "created": 1784000000,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
            self.wfile.write(f"data: {json.dumps(done)}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        self._json(200, {
            "id": "chatcmpl-agentbay-local-smoke",
            "object": "chat.completion",
            "created": 1784000000,
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

    def log_message(self, _format, *_args):
        return

ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`;

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
        print(json.dumps({"status": response.status, "body": parsed, "text": text}))
except urllib.error.HTTPError as error:
    text = error.read().decode("utf-8")
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = None
    print(json.dumps({"status": error.code, "body": parsed, "text": text}))
`;

async function main() {
  const summary = await smokeLocalHermesContract();

  console.log(JSON.stringify({ event: "local_hermes_contract_smoke_passed", ...summary }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
