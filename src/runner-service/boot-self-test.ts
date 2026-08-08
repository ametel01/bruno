import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_RUNNER_BOOT_SELF_TEST_ROOT,
  DOCKER_CLI_TIMEOUT_MS,
  RUNNER_BOOT_MODEL_CANARY_ENABLED_ENV,
} from "@/src/runner-service/constants";
import {
  type DockerExecutableRunner,
  type HermesContainerHealthTransport,
  ManualRunnerDocker,
} from "@/src/runner-service/docker";
import {
  type HermesProjectionResult,
  projectHermesHome,
} from "@/src/runner-service/hermes-projection";
import { resolveRunnerReleaseEvidence } from "@/src/runner-service/release-identity";
import {
  parseRunnerBootSnapshot,
  RUNNER_BOOT_COMPONENTS,
  RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
  type RunnerBootComponent,
  type RunnerBootFailureReason,
  type RunnerBootSnapshot,
} from "@/src/runner-service/runner-contracts";
import {
  type AgentLaunchSpec,
  MANAGED_AGENT_LAUNCH_SPEC_VERSION,
} from "@/src/server/agents/agent-launch-spec";

export const RUNNER_BOOT_SNAPSHOT_PATH_ENV = "BRUNO_RUNNER_BOOT_SNAPSHOT_PATH";
export const RUNNER_BOOT_SELF_TEST_ROOT_ENV = "BRUNO_RUNNER_BOOT_SELF_TEST_ROOT";
export const DEFAULT_RUNNER_BOOT_SNAPSHOT_PATH = "/var/lib/bruno/boot-readiness.json";
export const DEFAULT_RUNNER_BOOT_SELF_TEST_TIMEOUT_MS = 180_000;
export const DEFAULT_RUNNER_BOOT_CLEANUP_TIMEOUT_MS = 30_000;
export const DEFAULT_RUNNER_BOOT_CANARY_ATTEMPTS = 3;
export const DEFAULT_RUNNER_BOOT_CANARY_RETRY_DELAY_MS = 2_000;

const FIXTURE_LABEL = "bruno.boot_fixture";
const FIXTURE_LABEL_VALUE = "v1";
const FAKE_MODEL_ALIAS = "openai/gpt-4.1-mini";
const execFileAsync = promisify(execFile);

export type RunnerBootFixture = {
  agentId: string;
  configRevision: string;
  fakeModelContainer: string;
  network: string;
  operationId: string;
  root: string;
  runner: ManualRunnerDocker;
};

export type RunnerBootSelfTestExecutor = {
  recover(signal: AbortSignal): Promise<void>;
  verifyDockerAndRelease(signal: AbortSignal): Promise<void>;
  launchFixture(signal: AbortSignal): Promise<RunnerBootFixture>;
  probeDetailedHealth(fixture: RunnerBootFixture, signal: AbortSignal): Promise<void>;
  runCanary(fixture: RunnerBootFixture, signal: AbortSignal): Promise<void>;
  cleanup(fixture: RunnerBootFixture | null, signal: AbortSignal): Promise<void>;
};

export type RunnerBootReadinessController = {
  read(): Promise<RunnerBootSnapshot>;
  start(): Promise<void>;
};

export class RunnerBootSelfTestError extends Error {
  readonly reason: Exclude<RunnerBootFailureReason, null>;

  constructor(reason: Exclude<RunnerBootFailureReason, null>) {
    super("Runner boot self-test failed.");
    this.name = "RunnerBootSelfTestError";
    this.reason = reason;
  }
}

export function createRunnerBootReadinessController(
  options: {
    executor?: RunnerBootSelfTestExecutor;
    now?: () => Date;
    snapshotPath?: string;
    timeoutMs?: number;
    cleanupTimeoutMs?: number;
    canaryAttempts?: number;
    canaryRetryDelayMs?: number;
    modelCanaryEnabled?: boolean;
  } = {},
): RunnerBootReadinessController {
  const now = options.now ?? (() => new Date());
  const snapshotPath =
    options.snapshotPath ??
    process.env[RUNNER_BOOT_SNAPSHOT_PATH_ENV]?.trim() ??
    DEFAULT_RUNNER_BOOT_SNAPSHOT_PATH;
  const executor = options.executor ?? createDockerRunnerBootSelfTestExecutor();
  let run: Promise<void> | null = null;
  let testingSnapshot: RunnerBootSnapshot | null = null;

  return {
    async read() {
      try {
        const parsed = parseRunnerBootSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
        return parsed ?? testingSnapshot ?? invalidSnapshot(now());
      } catch {
        return testingSnapshot ?? invalidSnapshot(now());
      }
    },
    start() {
      if (!run) {
        const startedAt = now().toISOString();
        testingSnapshot = createTestingSnapshot(startedAt);
        run = executeBootSelfTest({
          executor,
          now,
          snapshotPath,
          startedAt,
          timeoutMs: options.timeoutMs ?? DEFAULT_RUNNER_BOOT_SELF_TEST_TIMEOUT_MS,
          cleanupTimeoutMs: options.cleanupTimeoutMs ?? DEFAULT_RUNNER_BOOT_CLEANUP_TIMEOUT_MS,
          canaryAttempts: options.canaryAttempts ?? DEFAULT_RUNNER_BOOT_CANARY_ATTEMPTS,
          canaryRetryDelayMs:
            options.canaryRetryDelayMs ?? DEFAULT_RUNNER_BOOT_CANARY_RETRY_DELAY_MS,
          modelCanaryEnabled:
            options.modelCanaryEnabled ??
            process.env[RUNNER_BOOT_MODEL_CANARY_ENABLED_ENV]?.trim().toLowerCase() !== "false",
        });
      }
      return run;
    },
  };
}

async function executeBootSelfTest(input: {
  executor: RunnerBootSelfTestExecutor;
  now: () => Date;
  snapshotPath: string;
  startedAt: string;
  timeoutMs: number;
  cleanupTimeoutMs: number;
  canaryAttempts: number;
  canaryRetryDelayMs: number;
  modelCanaryEnabled: boolean;
}): Promise<void> {
  const startedAt = input.startedAt;
  const states = Object.fromEntries(
    RUNNER_BOOT_COMPONENTS.map((component) => [component, "pending"]),
  ) as RunnerBootSnapshot["components"];
  let fixture: RunnerBootFixture | null = null;
  let activeComponent: RunnerBootComponent = "docker";
  let failureReason: Exclude<RunnerBootFailureReason, null> | null = null;

  await persistSnapshot(input.snapshotPath, {
    ok: true,
    contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
    status: "testing",
    components: states,
    failureReason: null,
    startedAt,
    completedAt: null,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    await abortable(controller.signal, () => input.executor.recover(controller.signal));
    await abortable(controller.signal, () =>
      input.executor.verifyDockerAndRelease(controller.signal),
    );
    states.docker = "passed";
    await persistTestingSnapshot(input.snapshotPath, startedAt, states);

    activeComponent = "hermesFixture";
    fixture = await abortable(controller.signal, () =>
      input.executor.launchFixture(controller.signal),
    );
    states.hermesFixture = "passed";
    states.telegramConfig = "passed";
    await persistTestingSnapshot(input.snapshotPath, startedAt, states);

    activeComponent = "detailedHealth";
    await abortable(controller.signal, () =>
      input.executor.probeDetailedHealth(fixture as RunnerBootFixture, controller.signal),
    );
    states.detailedHealth = "passed";
    await persistTestingSnapshot(input.snapshotPath, startedAt, states);

    if (input.modelCanaryEnabled) {
      activeComponent = "modelCanary";
      await abortable(controller.signal, () =>
        runBootCanaryWithRetries({
          executor: input.executor,
          fixture: fixture as RunnerBootFixture,
          signal: controller.signal,
          attempts: input.canaryAttempts,
          retryDelayMs: input.canaryRetryDelayMs,
        }),
      );
      states.modelCanary = "passed";
    } else {
      states.modelCanary = "skipped";
    }
    await persistTestingSnapshot(input.snapshotPath, startedAt, states);
  } catch (error) {
    failureReason = controller.signal.aborted
      ? "deadline_exceeded"
      : failureFrom(error, activeComponent);
    states[activeComponent] = "failed";
    if (failureReason === "telegram_config_failed") {
      states.telegramConfig = "failed";
    }
  } finally {
    clearTimeout(timeout);
    const cleanupController = new AbortController();
    const cleanupTimeout = setTimeout(() => cleanupController.abort(), input.cleanupTimeoutMs);
    try {
      await abortable(cleanupController.signal, () =>
        input.executor.cleanup(fixture, cleanupController.signal),
      );
      await abortable(cleanupController.signal, () =>
        input.executor.recover(cleanupController.signal),
      );
      states.cleanup = "passed";
    } catch {
      states.cleanup = "failed";
      failureReason = "cleanup_failed";
    } finally {
      clearTimeout(cleanupTimeout);
    }
  }

  const completedAt = input.now().toISOString();
  await persistSnapshot(input.snapshotPath, {
    ok: true,
    contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
    status: failureReason === null ? "ready" : "failed",
    components: states,
    failureReason,
    startedAt,
    completedAt,
  });
}

async function runBootCanaryWithRetries(input: {
  executor: RunnerBootSelfTestExecutor;
  fixture: RunnerBootFixture;
  signal: AbortSignal;
  attempts: number;
  retryDelayMs: number;
}): Promise<void> {
  const attempts = Number.isSafeInteger(input.attempts) && input.attempts > 0 ? input.attempts : 1;
  const retryDelayMs =
    Number.isSafeInteger(input.retryDelayMs) && input.retryDelayMs >= 0 ? input.retryDelayMs : 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await input.executor.runCanary(input.fixture, input.signal);
      return;
    } catch (error) {
      lastError = error;
      if (input.signal.aborted || attempt === attempts) throw error;
      await delay(retryDelayMs, input.signal);
    }
  }

  throw lastError;
}

function failureFrom(
  error: unknown,
  component: RunnerBootComponent,
): Exclude<RunnerBootFailureReason, null> {
  if (error instanceof RunnerBootSelfTestError) {
    return error.reason;
  }

  return {
    docker: "docker_unavailable",
    hermesFixture: "fixture_launch_failed",
    detailedHealth: "detailed_health_failed",
    modelCanary: "canary_failed",
    telegramConfig: "telegram_config_failed",
    cleanup: "cleanup_failed",
  }[component] as Exclude<RunnerBootFailureReason, null>;
}

async function persistSnapshot(path: string, snapshot: RunnerBootSnapshot): Promise<void> {
  const directory = path.slice(0, Math.max(1, path.lastIndexOf("/")));
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function persistTestingSnapshot(
  path: string,
  startedAt: string,
  components: RunnerBootSnapshot["components"],
): Promise<void> {
  await persistSnapshot(path, {
    ok: true,
    contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
    status: "testing",
    components: { ...components },
    failureReason: null,
    startedAt,
    completedAt: null,
  });
}

function invalidSnapshot(now: Date): RunnerBootSnapshot {
  const observedAt = now.toISOString();
  return {
    ok: true,
    contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
    status: "failed",
    components: {
      docker: "failed",
      hermesFixture: "pending",
      detailedHealth: "pending",
      modelCanary: "pending",
      telegramConfig: "pending",
      cleanup: "pending",
    },
    failureReason: "snapshot_invalid",
    startedAt: observedAt,
    completedAt: observedAt,
  };
}

function createTestingSnapshot(startedAt: string): RunnerBootSnapshot {
  return {
    ok: true,
    contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
    status: "testing",
    components: {
      docker: "pending",
      hermesFixture: "pending",
      detailedHealth: "pending",
      modelCanary: "pending",
      telegramConfig: "pending",
      cleanup: "pending",
    },
    failureReason: null,
    startedAt,
    completedAt: null,
  };
}

export function createDockerRunnerBootSelfTestExecutor(
  options: { docker?: DockerExecutableRunner; root?: string } = {},
): RunnerBootSelfTestExecutor {
  const docker = options.docker ?? executeDocker;
  const root =
    options.root ??
    process.env[RUNNER_BOOT_SELF_TEST_ROOT_ENV]?.trim() ??
    DEFAULT_RUNNER_BOOT_SELF_TEST_ROOT;

  return {
    recover: (signal) => recoverFixtures({ docker, root, signal }),
    async verifyDockerAndRelease(signal) {
      try {
        await docker("docker", ["version", "--format", "{{.Server.Version}}"], {
          signal,
          timeoutMs: DOCKER_CLI_TIMEOUT_MS,
        });
        const evidence = await resolveRunnerReleaseEvidence({
          docker: async (args) =>
            await docker("docker", args, { signal, timeoutMs: DOCKER_CLI_TIMEOUT_MS }),
        });
        if (evidence.expectedMatch === false) {
          throw new RunnerBootSelfTestError("release_mismatch");
        }
      } catch (error) {
        if (error instanceof RunnerBootSelfTestError) throw error;
        throw new RunnerBootSelfTestError("docker_unavailable");
      }
    },
    launchFixture: (signal) => launchDockerFixture({ docker, root, signal }),
    async probeDetailedHealth(fixture, signal) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && !signal.aborted) {
        const status = await fixture.runner.status(fixture.agentId);
        if (status.snapshot.phase === "ready") return;
        if (status.snapshot.phase === "failed") break;
        await delay(500, signal);
      }
      throw new RunnerBootSelfTestError("detailed_health_failed");
    },
    async runCanary(fixture) {
      const result = await fixture.runner.canary(fixture.agentId, {
        operationId: fixture.operationId,
        configRevision: fixture.configRevision,
        model: FAKE_MODEL_ALIAS,
      });
      if (result.observation.state !== "passed") {
        throw new RunnerBootSelfTestError("canary_failed");
      }
    },
    cleanup: (fixture, signal) => cleanupFixture({ docker, fixture, root, signal }),
  };
}

async function launchDockerFixture(input: {
  docker: DockerExecutableRunner;
  root: string;
  signal: AbortSignal;
}): Promise<RunnerBootFixture> {
  const id = randomUUID();
  const suffix = id.replaceAll("-", "").slice(0, 12);
  const agentId = randomUUID();
  const network = `bruno-boot-${suffix}`;
  const fakeModelContainer = `${network}-model`;
  const fixtureRoot = join(input.root, "fixtures", id);
  const stateRoot = join(fixtureRoot, "state");
  const configRevision = `boot-${id}`;
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(fixtureRoot, "fixture.json"),
    `${JSON.stringify({ agentId, fakeModelContainer, network })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  await input.docker(
    "docker",
    ["network", "create", "--label", `${FIXTURE_LABEL}=${FIXTURE_LABEL_VALUE}`, network],
    {
      signal: input.signal,
      timeoutMs: DOCKER_CLI_TIMEOUT_MS,
    },
  );
  await input.docker(
    "docker",
    [
      "run",
      "--detach",
      "--platform",
      "linux/amd64",
      "--name",
      fakeModelContainer,
      "--network",
      network,
      "--label",
      `${FIXTURE_LABEL}=${FIXTURE_LABEL_VALUE}`,
      "--entrypoint",
      "python",
      DEFAULT_HERMES_WORKLOAD_IMAGE,
      "-c",
      FAKE_MODEL_SERVER_SOURCE,
    ],
    { signal: input.signal, timeoutMs: DOCKER_CLI_TIMEOUT_MS },
  );

  const requestContainerHealth: HermesContainerHealthTransport = async (probe) => {
    const result = await requestContainerJson(
      input.docker,
      probe.containerName,
      probe.readinessPort,
      "/health/detailed",
      probe.signal,
    );
    return result.ok ? { ...result, body: withSyntheticTelegramHealth(result.body) } : result;
  };
  const runner = new ManualRunnerDocker({
    additionalContainerLabels: { [FIXTURE_LABEL]: FIXTURE_LABEL_VALUE },
    docker: input.docker,
    hermes: { network },
    probe: { requestContainerHealth },
    projection: {
      options: { stateRoot },
      project: async (spec) => {
        const projection = await projectHermesHome(spec, {
          stateRoot,
        });
        await configurePrivateSyntheticTelegram(projection, fakeModelContainer);
        return projection;
      },
    },
  });
  const spec = buildRunnerBootLaunchSpec({ agentId, configRevision });
  const launched = await runner.start(agentId, spec);

  if (!("operation" in launched)) {
    throw new RunnerBootSelfTestError("fixture_launch_failed");
  }

  return {
    agentId,
    configRevision,
    fakeModelContainer,
    network,
    operationId: launched.operation.id,
    root: fixtureRoot,
    runner,
  };
}

async function configurePrivateSyntheticTelegram(
  projection: HermesProjectionResult,
  fakeModelContainer: string,
): Promise<void> {
  const parsed = parse(await readFile(projection.configPath, "utf8"));
  if (!isRecord(parsed)) throw new RunnerBootSelfTestError("telegram_config_failed");
  const platforms = ensureRecord(parsed, "platforms");
  const telegram = ensureRecord(platforms, "telegram");
  const apiServer = ensureRecord(platforms, "api_server");
  const routes = ensureRecord(ensureRecord(apiServer, "extra"), "model_routes");
  if (telegram.enabled !== true || apiServer.enabled !== true) {
    throw new RunnerBootSelfTestError("telegram_config_failed");
  }
  // Loading the real-shaped configuration is exercised above; disabling it before launch prevents traffic.
  telegram.enabled = false;
  routes[FAKE_MODEL_ALIAS] = {
    model: FAKE_MODEL_ALIAS,
    provider: "openai-api",
    base_url: `http://${fakeModelContainer}:8080/v1`,
  };
  await writeFile(
    projection.configPath,
    stringify(parsed, { indent: 2, lineWidth: 0, sortMapEntries: true }),
    "utf8",
  );
}

async function cleanupFixture(input: {
  docker: DockerExecutableRunner;
  fixture: RunnerBootFixture | null;
  root: string;
  signal: AbortSignal;
}): Promise<void> {
  if (input.fixture) {
    await input.fixture.runner.cleanup(input.fixture.agentId).catch(() => undefined);
    await removeExactFixtureResources(input.docker, input.fixture, input.signal);
    await rm(input.fixture.root, { force: true, recursive: true });
  }
}

async function recoverFixtures(input: {
  docker: DockerExecutableRunner;
  root: string;
  signal: AbortSignal;
}): Promise<void> {
  const fixturesRoot = join(input.root, "fixtures");
  let entries: string[];
  try {
    entries = await readdir(fixturesRoot);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
  for (const id of entries) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const fixtureRoot = join(fixturesRoot, id);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(fixtureRoot, "fixture.json"), "utf8"));
    } catch {
      continue;
    }
    // Invalid descriptors are retained: cleanup never widens ownership based on hostile input.
    if (!isFixtureDescriptor(value)) continue;
    await removeExactFixtureResources(input.docker, value, input.signal);
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function removeExactFixtureResources(
  docker: DockerExecutableRunner,
  fixture: Pick<RunnerBootFixture, "agentId" | "fakeModelContainer" | "network">,
  signal: AbortSignal,
): Promise<void> {
  const containers = await docker(
    "docker",
    [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=bruno.agent_id=${fixture.agentId}`,
      "--filter",
      `label=${FIXTURE_LABEL}=${FIXTURE_LABEL_VALUE}`,
    ],
    { signal, timeoutMs: DOCKER_CLI_TIMEOUT_MS },
  );
  await Promise.all(
    containers.stdout
      .split(/\s+/)
      .filter((value) => /^[a-f0-9]{12,64}$/.test(value))
      .map((id) =>
        docker("docker", ["rm", "--force", id], {
          signal,
          timeoutMs: DOCKER_CLI_TIMEOUT_MS,
        }),
      ),
  );
  const fixtureContainers = await docker(
    "docker",
    [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `name=^/${fixture.fakeModelContainer}$`,
      "--filter",
      `label=${FIXTURE_LABEL}=${FIXTURE_LABEL_VALUE}`,
    ],
    { signal, timeoutMs: DOCKER_CLI_TIMEOUT_MS },
  );
  await Promise.all(
    safeDockerIds(fixtureContainers.stdout).map((id) =>
      docker("docker", ["rm", "--force", id], {
        signal,
        timeoutMs: DOCKER_CLI_TIMEOUT_MS,
      }),
    ),
  );
  const fixtureNetworks = await docker(
    "docker",
    [
      "network",
      "ls",
      "--quiet",
      "--filter",
      `name=^${fixture.network}$`,
      "--filter",
      `label=${FIXTURE_LABEL}=${FIXTURE_LABEL_VALUE}`,
    ],
    { signal, timeoutMs: DOCKER_CLI_TIMEOUT_MS },
  );
  await Promise.all(
    safeDockerIds(fixtureNetworks.stdout).map((id) =>
      docker("docker", ["network", "rm", id], {
        signal,
        timeoutMs: DOCKER_CLI_TIMEOUT_MS,
      }),
    ),
  );
}

function safeDockerIds(stdout: string): string[] {
  return stdout.split(/\s+/).filter((value) => /^[a-f0-9]{12,64}$/.test(value));
}

export function buildRunnerBootLaunchSpec(input: {
  agentId: string;
  configRevision: string;
}): AgentLaunchSpec {
  return {
    version: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
    requestId: randomUUID(),
    agent: {
      id: input.agentId,
      name: "Runner boot fixture",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      configRevision: input.configRevision,
    },
    image: { ref: DEFAULT_HERMES_WORKLOAD_IMAGE },
    model: { provider: "openai-api", model: FAKE_MODEL_ALIAS },
    platforms: {
      required: ["api_server", "telegram"],
      apiServer: { enabled: true, host: "0.0.0.0", port: 8642 },
      telegram: { enabled: true, allowAllUsers: false, unauthorizedDmBehavior: "ignore" },
    },
    schedule: { mode: "manual", cron: null, timezone: "UTC" },
    prompt: { soul: "Reply tersely for the isolated runner boot self-test." },
    runtime: {
      dataDir: "/opt/data",
      workspaceDir: "/workspace",
      terminalCwd: "/workspace",
      browserEnabled: false,
      unattendedLoopLimit: 3,
      toolLoopGuardrails: {
        hardStopEnabled: true,
        hardStopAfter: { exactFailure: 5, idempotentNoProgress: 5 },
      },
    },
    tools: {
      enabled: ["file_operations", "terminal"],
      disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
    },
    secrets: {
      kind: "inline",
      modelApiKey: ["sk", "runnerbootlocalfixturekey1234567890"].join("-"),
      telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
      telegramAllowedUsers: ["1"],
      apiServerKey: `bruno_agent_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
    },
  };
}

async function requestContainerJson(
  docker: DockerExecutableRunner,
  containerName: string,
  port: number,
  path: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const result = await docker(
      "docker",
      ["exec", containerName, "python", "-c", CONTAINER_JSON_PROBE, String(port), path],
      { ...(signal ? { signal } : {}), timeoutMs: 2_000 },
    );
    const parsed = JSON.parse(result.stdout);
    if (!isRecord(parsed) || !Number.isInteger(parsed.status))
      return { ok: false, status: 0, body: null };
    const status = Number(parsed.status);
    return { ok: status >= 200 && status < 300, status, body: parsed.body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

function withSyntheticTelegramHealth(body: unknown): unknown {
  if (!isRecord(body)) return body;
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

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (isRecord(parent[key])) return parent[key] as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFixtureDescriptor(
  value: unknown,
): value is Pick<RunnerBootFixture, "agentId" | "fakeModelContainer" | "network"> {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "agentId,fakeModelContainer,network"
  )
    return false;
  return (
    typeof value.agentId === "string" &&
    /^[0-9a-f-]{36}$/.test(value.agentId) &&
    typeof value.fakeModelContainer === "string" &&
    /^bruno-boot-[a-f0-9]{12}-model$/.test(value.fakeModelContainer) &&
    typeof value.network === "string" &&
    /^bruno-boot-[a-f0-9]{12}$/.test(value.network)
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(resolveDelay, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        rejectDelay(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const onAbort = () => rejectOperation(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation()
      .then(resolveOperation, rejectOperation)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

async function executeDocker(
  executable: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(executable, [...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
    timeout: options.timeoutMs ?? DOCKER_CLI_TIMEOUT_MS,
  });
}

const CONTAINER_JSON_PROBE = `
import json, sys, urllib.request, urllib.error
status, body = 0, None
try:
    key = None
    for raw in open('/opt/data/.env', encoding='utf-8'):
        if raw.strip().startswith('API_SERVER_KEY='):
            value = raw.strip().split('=', 1)[1].strip()
            key = json.loads(value) if value.startswith('"') else value
            break
    request = urllib.request.Request('http://127.0.0.1:' + sys.argv[1] + sys.argv[2], headers={'Authorization': 'Bearer ' + key, 'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=2) as response:
        status = response.status
        body = json.loads(response.read(65537).decode('utf-8'))
except urllib.error.HTTPError as error: status = error.code
except Exception: pass
print(json.dumps({'status': status, 'body': body}, separators=(',', ':')))
`;

const FAKE_MODEL_SERVER_SOURCE = `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send_json(self, body):
        data=json.dumps(body).encode(); self.send_response(200); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self): self.send_json({'ok': True, 'data': [{'id':'openai/gpt-4.1-mini'}]})
    def do_POST(self):
        size=int(self.headers.get('content-length','0')); request=json.loads(self.rfile.read(size) or b'{}')
        self.send_json({'id':'chatcmpl_runner_boot','object':'chat.completion','created':1784000000,'model':request.get('model','openai/gpt-4.1-mini'),'choices':[{'index':0,'message':{'role':'assistant','content':'ok'},'finish_reason':'stop'}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}})
ThreadingHTTPServer(('0.0.0.0',8080), Handler).serve_forever()
`;
