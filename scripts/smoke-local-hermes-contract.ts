import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AGENT_LAUNCH_SPEC_VERSION,
  type AgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";
import {
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
} from "@/src/runner-service/constants";
import { ManualRunnerDocker, type RunnerLogLine } from "@/src/runner-service/docker";
import {
  projectHermesHome,
  type HermesProjectionResult,
} from "@/src/runner-service/hermes-projection";
import { DEFAULT_LOCAL_HERMES_IMAGE } from "@/scripts/smoke-hermes-agent-image";

const FAKE_MODEL_ALIAS = "agentbay-local-fake-model";
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
  configRevision: string;
  elapsedMs: number;
  fakeModelContainer: string;
  image: string;
  logSources: string[];
  modelResponse: string;
  network: string;
  noPublicHermesPort: true;
  privateApiAuth: true;
  removedAgentRoot: true;
  statePersistence: true;
  telegramBoundary: "local-smoke-disabled";
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
    const runner = new ManualRunnerDocker({
      hermes: {
        cpus: "1",
        memory: "1536m",
        network,
        pidsLimit: "256",
        readinessPort: 8642,
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
          return projected;
        },
      },
      readiness: {
        wait: async (input) => {
          const health = await waitForHermesHealth({
            apiServerKey: input.apiServerKey,
            containerName: input.containerName,
          });

          return health ? { ok: true } : { ok: false, reason: "timeout" };
        },
      },
    });

    const started = await runner.start(agentId, spec);
    projection = started.projection;

    if (!projection) {
      throw new Error("Hermes projection was not returned by the runner.");
    }

    await assertProjectedConfigRevision(projection, spec.agent.configRevision);
    await assertNoPublicHermesPort(started.container.id);
    await assertPrivateApiAuth(started.container.name, spec.secrets.apiServerKey);
    const modelResponse = await runHermesModelTurn(
      started.container.name,
      spec.secrets.apiServerKey,
    );
    const sentinelPath = join(projection.workspace, "agentbay-contract-sentinel.txt");

    await writeFile(sentinelPath, "agentbay local hermes contract persisted\n", "utf8");
    const firstLogs = await waitForHermesGatewayLogs(runner, agentId);

    await runner.stop(agentId);
    await cp(projection.agentRoot, backupRoot, { recursive: true });
    await rm(projection.agentRoot, { force: true, recursive: true });
    await cp(backupRoot, projection.agentRoot, { recursive: true });

    const restarted = await runner.restart(agentId, spec);
    const sentinel = await readFile(sentinelPath, "utf8");

    if (!sentinel.includes("agentbay local hermes contract persisted")) {
      throw new Error("Hermes workspace state did not survive backup/restore and restart.");
    }

    await assertPrivateApiAuth(restarted.container.name, spec.secrets.apiServerKey);
    await runner.cleanup(agentId);
    await assertPathRemoved(projection.agentRoot, "Hermes agent root");
    await assertNoSelectedContainers(agentId);

    return {
      agentId,
      backupRestored: true,
      configRevision: spec.agent.configRevision,
      elapsedMs: Date.now() - startedAt,
      fakeModelContainer,
      image: SMOKE_IMAGE,
      logSources: [...new Set(firstLogs.map((line) => line.source ?? "container_bootstrap"))],
      modelResponse,
      network,
      noPublicHermesPort: true,
      privateApiAuth: true,
      removedAgentRoot: true,
      statePersistence: true,
      telegramBoundary: "local-smoke-disabled",
    };
  } finally {
    await removeLabeledAgentContainers(agentId);
    await docker(["rm", "--force", fakeModelContainer], { allowFailure: true });
    if (projection) {
      await rm(projection.agentRoot, { force: true, recursive: true }).catch(() => undefined);
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
    version: AGENT_LAUNCH_SPEC_VERSION,
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
      model: "openai/gpt-4.1-mini",
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
    },
    tools: {
      enabled: ["file_operations", "terminal"],
      disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
    },
    secrets: {
      kind: "inline",
      openrouterApiKey: "sk-or-v1-contract-smoke-local-fake-model-key",
      telegramBotToken: "123456:abcdefghijklmnopqrstuvwxyz",
      telegramAllowedUsers: "123456789",
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

  await writeFile(
    input.projection.configPath,
    `${config}
# AgentBay local contract smoke only: fake provider route and no external Telegram polling.
telegram:
  enabled: false
platforms:
  telegram:
    enabled: false
  api_server:
    enabled: true
    extra:
      model_routes:
        ${FAKE_MODEL_ALIAS}:
          model: "openai/gpt-4.1-mini"
          provider: "openrouter"
          base_url: "${input.fakeModelBaseUrl}"
`,
    "utf8",
  );
  await writeFile(
    input.projection.envPath,
    env.replace(/^TELEGRAM_BOT_TOKEN=.*$/m, 'TELEGRAM_BOT_TOKEN=""'),
    "utf8",
  );
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

async function waitForHermesHealth(input: {
  apiServerKey: string;
  containerName: string;
}): Promise<boolean> {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await requestHermes(input.containerName, {
      apiServerKey: input.apiServerKey,
      path: "/health/detailed",
    }).catch(() => null);

    if (response?.status === 200 && isHermesHealthReady(response.body)) {
      return true;
    }

    await sleep(POLL_MS);
  }

  return false;
}

async function assertPrivateApiAuth(containerName: string, apiServerKey: string): Promise<void> {
  const unauthorized = await requestHermes(containerName, {
    apiServerKey: "wrong-local-smoke-key",
    path: "/health/detailed",
  });

  if (unauthorized.status !== 401) {
    throw new Error(`Hermes private API accepted an invalid bearer token: ${unauthorized.status}`);
  }

  const authorized = await requestHermes(containerName, {
    apiServerKey,
    path: "/health/detailed",
  });

  if (authorized.status !== 200 || !isRecord(authorized.body)) {
    throw new Error(`Hermes private API did not accept the configured bearer token.`);
  }
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

function isHermesHealthReady(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const platforms = value.platforms;

  return (
    value.status === "ok" &&
    value.platform === "hermes-agent" &&
    JSON.stringify(platforms).includes("api_server")
  );
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
