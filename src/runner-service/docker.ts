import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { AgentLaunchSpec } from "@/src/server/agents/agent-launch-spec";
import {
  AGENTBAY_AGENT_ID_LABEL,
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_MANUAL_RUNNER_IMAGE,
  DOCKER_CLI_TIMEOUT_MS,
} from "@/src/runner-service/constants";
import {
  projectHermesHome,
  type HermesProjectionOptions,
  type HermesProjectionResult,
} from "@/src/runner-service/hermes-projection";
import { redactSecretText } from "@/src/shared/secret-redaction";

export { AGENTBAY_AGENT_ID_LABEL, DEFAULT_MANUAL_RUNNER_IMAGE, DOCKER_CLI_TIMEOUT_MS };
const DOCKER_RUNNER_IMAGE_ENV = "AGENTBAY_DOCKER_RUNNER_IMAGE";
const DOCKER_RUNNER_ARGS_ENV = "AGENTBAY_DOCKER_RUNNER_ARGS_JSON";
const DOCKER_EXECUTABLE_ENV = "AGENTBAY_RUNNER_DOCKER_EXECUTABLE";
const HERMES_PRIVATE_NETWORK_ENV = "AGENTBAY_HERMES_PRIVATE_NETWORK";
const HERMES_DOCKER_CPUS_ENV = "AGENTBAY_HERMES_DOCKER_CPUS";
const HERMES_DOCKER_MEMORY_ENV = "AGENTBAY_HERMES_DOCKER_MEMORY";
const HERMES_DOCKER_PIDS_LIMIT_ENV = "AGENTBAY_HERMES_DOCKER_PIDS_LIMIT";
const HERMES_READINESS_PORT_ENV = "AGENTBAY_HERMES_READINESS_PORT";
const HERMES_STATE_ROOT_ENV = "AGENTBAY_HERMES_STATE_ROOT";
const AGENTBAY_CONFIG_REVISION_LABEL = "agentbay.config_revision";
const AGENTBAY_LAUNCH_SPEC_VERSION_LABEL = "agentbay.launch_spec_version";
const MAX_HERMES_LOG_BYTES_PER_FILE = 64 * 1024;
const MAX_HERMES_LOG_LINES = 500;
const DUMMY_DOCKER_RUNNER_ARGS = [
  "sh",
  "-c",
  [
    'printf "agentbay manual runner started for %s\\n" "$AGENTBAY_AGENT_ID"',
    'printf "agentbay manual runner stderr ready for %s\\n" "$AGENTBAY_AGENT_ID" >&2',
    'trap \'printf "agentbay manual runner stopping for %s\\n" "$AGENTBAY_AGENT_ID"; exit 0\' TERM INT',
    "while true; do sleep 1; done",
  ].join("; "),
];

export type DockerCliResult = {
  stdout: string;
  stderr: string;
};

export type DockerRunnerCommand = {
  image: string;
  args: string[];
};

export type ManualRunnerDockerOptions = {
  command?: DockerRunnerCommand;
  docker?: DockerExecutableRunner;
  dockerExecutable?: string;
  hermes?: Partial<HermesDockerRuntimeOptions>;
  nameSuffix?: () => string;
  projection?: {
    project?: (spec: AgentLaunchSpec) => Promise<HermesProjectionResult>;
    options?: HermesProjectionOptions;
  };
  readiness?: {
    wait?: HermesReadinessWaiter;
  };
};

export type HermesDockerRuntimeOptions = {
  cpus: string;
  memory: string;
  network: string;
  pidsLimit: string;
  readinessPort: number;
};

export type HermesReadinessWaiter = (input: {
  agentId: string;
  apiServerKey: string;
  configRevision: string;
  containerName: string;
}) => Promise<{ ok: true } | { ok: false; reason: string }>;

export type DockerExecutableRunner = (
  executable: string,
  args: readonly string[],
) => Promise<DockerCliResult>;

export type RunnerContainer = {
  id: string;
  name: string;
  image: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunnerLogLine = {
  stream: "stdout" | "stderr";
  message: string;
  source?: "container_bootstrap" | "hermes_gateway";
  metadata?: Record<string, unknown>;
  createdAt: string | null;
};

export class HermesReadinessError extends Error {
  constructor() {
    super("Hermes readiness check failed.");
    this.name = "HermesReadinessError";
  }
}

type DockerInspectContainer = {
  Id?: string;
  Args?: string[];
  Mounts?: Array<{
    Destination?: string;
    Source?: string;
    Type?: string;
  }>;
  Name?: string;
  Config?: {
    Cmd?: string[];
    Entrypoint?: string[];
    Env?: string[];
    Healthcheck?: {
      Test?: string[];
    };
    Image?: string;
    Labels?: Record<string, string> | null;
  };
  HostConfig?: {
    CapAdd?: string[] | null;
    Binds?: string[] | null;
    CapDrop?: string[] | null;
    Memory?: number;
    NanoCpus?: number;
    NetworkMode?: string;
    PidsLimit?: number;
    PortBindings?: Record<string, Array<{ HostPort?: string }> | null> | null;
    SecurityOpt?: string[] | null;
  };
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
    Ports?: Record<string, Array<{ HostPort?: string }> | null> | null;
  };
  State?: {
    Status?: string;
    StartedAt?: string;
    FinishedAt?: string;
  };
};

type DockerPsLine = {
  ID?: string;
};

export class ManualRunnerDocker {
  private readonly command: DockerRunnerCommand;
  private readonly docker: DockerExecutableRunner;
  private readonly dockerExecutable: string;
  private readonly hermes: HermesDockerRuntimeOptions;
  private readonly nameSuffix: () => string;
  private readonly project: (spec: AgentLaunchSpec) => Promise<HermesProjectionResult>;
  private readonly waitForReadiness: HermesReadinessWaiter;

  constructor(options: ManualRunnerDockerOptions = {}) {
    this.command = options.command ?? resolveManualRunnerCommand();
    this.docker = options.docker ?? runDockerExecutable;
    this.dockerExecutable =
      options.dockerExecutable ?? process.env[DOCKER_EXECUTABLE_ENV]?.trim() ?? "docker";
    this.hermes = resolveHermesDockerRuntimeOptions(options.hermes);
    this.nameSuffix = options.nameSuffix ?? (() => randomUUID().replaceAll("-", "").slice(0, 12));
    this.project =
      options.projection?.project ??
      ((spec) => projectHermesHome(spec, options.projection?.options));
    this.waitForReadiness = options.readiness?.wait ?? createHermesReadinessWaiter(this.hermes);
  }

  async start(
    agentId: string,
    launchSpec: AgentLaunchSpec | null = null,
  ): Promise<{ container: RunnerContainer; projection: HermesProjectionResult | null }> {
    const projection = launchSpec ? await this.project(launchSpec) : null;

    await this.removeSelectedContainers(agentId);
    const containerName = dockerContainerName(agentId, this.nameSuffix());
    const runResult = await this.runDocker(
      launchSpec && projection
        ? buildHermesDockerRunArgs({
            agentId,
            containerName,
            launchSpec,
            projection,
            runtime: this.hermes,
          })
        : buildLegacyDockerRunArgs({
            agentId,
            command: this.command,
            containerName,
          }),
    );
    const containerId = runResult.stdout.trim();

    if (!containerId) {
      throw new Error("Docker did not return a container id.");
    }

    const hermesInspect =
      launchSpec && projection ? { launchSpec, projection, runtime: this.hermes } : null;
    const container = await this.inspectSelectedContainer(containerId, agentId, hermesInspect);

    if (launchSpec) {
      const readiness = await this.waitForReadiness({
        agentId,
        apiServerKey: launchSpec.secrets.apiServerKey,
        configRevision: launchSpec.agent.configRevision,
        containerName,
      });

      if (!readiness.ok) {
        throw new HermesReadinessError();
      }
    }

    return { container, projection };
  }

  async stop(agentId: string): Promise<{ containers: RunnerContainer[] }> {
    const containers = await this.listSelectedContainers(agentId);
    const stopped: RunnerContainer[] = [];

    for (const container of containers) {
      if (container.status === "running") {
        await this.runDocker(["stop", "--time", "20", container.id]);
      }
      stopped.push(await this.inspectSelectedContainer(container.id, agentId));
    }

    return { containers: stopped };
  }

  async cleanup(
    agentId: string,
  ): Promise<{ containers: RunnerContainer[]; removedAgentRoot: boolean }> {
    const containers = await this.listSelectedContainers(agentId);

    for (const container of containers) {
      await this.runDocker(["rm", "--force", container.id]);
    }

    return {
      containers,
      removedAgentRoot: await removeHermesAgentRoot(agentId),
    };
  }

  async restart(
    agentId: string,
    launchSpec: AgentLaunchSpec | null = null,
  ): Promise<{ container: RunnerContainer; projection: HermesProjectionResult | null }> {
    await this.removeSelectedContainers(agentId);
    return await this.start(agentId, launchSpec);
  }

  async status(agentId: string): Promise<{ containers: RunnerContainer[] }> {
    return { containers: await this.listSelectedContainers(agentId) };
  }

  async logs(
    agentId: string,
  ): Promise<{ container: RunnerContainer | null; logs: RunnerLogLine[] }> {
    const [container] = await this.listSelectedContainers(agentId);
    const gatewayLogs = await readHermesGatewayLogLines(agentId);

    if (!container) {
      return { container: null, logs: gatewayLogs };
    }

    const result = await this.runDocker(["logs", "--timestamps", container.id]);

    return {
      container,
      logs: mergeRunnerLogLines(gatewayLogs, parseDockerLogOutput(result)),
    };
  }

  private async listSelectedContainers(agentId: string): Promise<RunnerContainer[]> {
    const result = await this.runDocker([
      "ps",
      "--all",
      "--filter",
      `label=${AGENTBAY_AGENT_ID_LABEL}=${agentId}`,
      "--format",
      "{{json .}}",
    ]);
    const ids = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseDockerPsLine(line).ID)
      .filter((id): id is string => Boolean(id?.trim()));
    const containers: RunnerContainer[] = [];

    for (const id of ids) {
      containers.push(await this.inspectSelectedContainer(id, agentId));
    }

    return containers;
  }

  private async removeSelectedContainers(agentId: string): Promise<void> {
    for (const container of await this.listSelectedContainers(agentId)) {
      await this.runDocker(["rm", "--force", container.id]);
    }
  }

  private async inspectSelectedContainer(
    containerId: string,
    agentId: string,
    hermes: {
      launchSpec: AgentLaunchSpec;
      projection: HermesProjectionResult;
      runtime: HermesDockerRuntimeOptions;
    } | null = null,
  ): Promise<RunnerContainer> {
    const result = await this.runDocker(["inspect", "--format", "{{json .}}", containerId]);
    const inspect = parseDockerInspect(result.stdout);

    if (inspect.Config?.Labels?.[AGENTBAY_AGENT_ID_LABEL] !== agentId) {
      throw new Error("Docker container label mismatch.");
    }

    if (hermes) {
      assertHermesInspectMatchesRuntime(inspect, hermes);
    }

    return {
      id: inspect.Id || containerId,
      name: inspect.Name?.replace(/^\//, "") || "",
      image: inspect.Config?.Image || "",
      status: inspect.State?.Status || "unknown",
      startedAt: normalizeDockerTimestamp(inspect.State?.StartedAt),
      finishedAt: normalizeDockerTimestamp(inspect.State?.FinishedAt),
    };
  }

  private runDocker(args: readonly string[]): Promise<DockerCliResult> {
    return this.docker(this.dockerExecutable, args);
  }
}

function assertHermesInspectMatchesRuntime(
  inspect: DockerInspectContainer,
  input: {
    launchSpec: AgentLaunchSpec;
    projection: HermesProjectionResult;
    runtime: HermesDockerRuntimeOptions;
  },
): void {
  if (inspect.Config?.Image !== input.launchSpec.image.ref) {
    throw new Error("Docker container image mismatch.");
  }

  if (
    inspect.Config?.Labels?.[AGENTBAY_CONFIG_REVISION_LABEL] !==
    input.launchSpec.agent.configRevision
  ) {
    throw new Error("Docker container config revision mismatch.");
  }

  if (inspect.Config?.Labels?.[AGENTBAY_LAUNCH_SPEC_VERSION_LABEL] !== input.launchSpec.version) {
    throw new Error("Docker container launch spec version mismatch.");
  }

  assertMount(inspect, input.projection.hermesHome, "/opt/data");
  assertMount(inspect, input.projection.workspace, "/workspace");

  if (!inspect.HostConfig || inspect.HostConfig.NetworkMode !== input.runtime.network) {
    throw new Error("Docker container network mismatch.");
  }

  if (
    !inspect.NetworkSettings?.Networks ||
    !(input.runtime.network in inspect.NetworkSettings.Networks)
  ) {
    throw new Error("Docker container private network missing.");
  }

  if (
    hasPublishedPort(inspect.HostConfig.PortBindings) ||
    hasPublishedPort(inspect.NetworkSettings.Ports)
  ) {
    throw new Error("Docker container unexpectedly publishes ports.");
  }

  if (!inspect.HostConfig.SecurityOpt?.includes("no-new-privileges")) {
    throw new Error("Docker container security options mismatch.");
  }

  if (!inspect.HostConfig.CapDrop?.includes("ALL")) {
    throw new Error("Docker container capability set mismatch.");
  }

  for (const capability of ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]) {
    if (!hasDockerCapability(inspect.HostConfig.CapAdd, capability)) {
      throw new Error("Docker container capability set mismatch.");
    }
  }

  if (inspect.HostConfig.PidsLimit !== Number.parseInt(input.runtime.pidsLimit, 10)) {
    throw new Error("Docker container PID limit mismatch.");
  }

  const expectedNanoCpus = parseDockerCpusToNanoCpus(input.runtime.cpus);

  if (inspect.HostConfig.NanoCpus !== expectedNanoCpus) {
    throw new Error("Docker container CPU limit mismatch.");
  }

  const expectedMemory = parseDockerMemoryBytes(input.runtime.memory);

  if (inspect.HostConfig.Memory !== expectedMemory) {
    throw new Error("Docker container memory limit mismatch.");
  }

  if (inspectContainsDockerSocket(inspect)) {
    throw new Error("Docker container unexpectedly mounts the Docker socket.");
  }

  if (inspectContainsSecretValue(inspect, input.launchSpec)) {
    throw new Error("Docker container inspect exposes launch secrets.");
  }
}

function assertMount(
  inspect: DockerInspectContainer,
  expectedSource: string,
  expectedDestination: string,
): void {
  const hasMount = inspect.Mounts?.some(
    (mount) =>
      mount.Type === "bind" &&
      mount.Source === expectedSource &&
      mount.Destination === expectedDestination,
  );

  if (!hasMount) {
    throw new Error(`Docker container missing ${expectedDestination} bind mount.`);
  }
}

function hasPublishedPort(
  ports: Record<string, Array<{ HostPort?: string }> | null> | null | undefined,
): boolean {
  return Object.values(ports ?? {}).some((bindings) =>
    (bindings ?? []).some((binding) => Boolean(binding.HostPort?.trim())),
  );
}

function inspectContainsDockerSocket(inspect: DockerInspectContainer): boolean {
  const values = [
    ...(inspect.Mounts ?? []).flatMap((mount) => [mount.Source, mount.Destination]),
    ...(inspect.HostConfig?.Binds ?? []),
  ];

  return values.some((value) => value?.includes("/var/run/docker.sock"));
}

function hasDockerCapability(
  capabilities: string[] | null | undefined,
  capability: string,
): boolean {
  return (capabilities ?? []).some(
    (value) => value === capability || value === `CAP_${capability}`,
  );
}

function inspectContainsSecretValue(
  inspect: DockerInspectContainer,
  launchSpec: AgentLaunchSpec,
): boolean {
  const secrets = [launchSpec.secrets.apiServerKey].filter((secret) => secret.trim().length > 0);
  const inspectText = JSON.stringify({
    Args: inspect.Args,
    Cmd: inspect.Config?.Cmd,
    Entrypoint: inspect.Config?.Entrypoint,
    Env: inspect.Config?.Env,
    Healthcheck: inspect.Config?.Healthcheck,
    Labels: inspect.Config?.Labels,
    Name: inspect.Name,
  });

  return secrets.some((secret) => inspectText.includes(secret));
}

function parseDockerCpusToNanoCpus(value: string): number {
  const cpus = Number.parseFloat(value);

  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error("Hermes Docker CPU limit must be positive.");
  }

  return Math.round(cpus * 1_000_000_000);
}

function parseDockerMemoryBytes(value: string): number {
  const match = /^(\d+)([bkmg])?$/i.exec(value.trim());

  if (!match?.[1]) {
    throw new Error("Hermes Docker memory limit must be a Docker byte value.");
  }

  const units: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
  };
  const unit = match[2]?.toLowerCase() ?? "b";

  return Number.parseInt(match[1], 10) * (units[unit] ?? 1);
}

export function buildHermesDockerRunArgs(input: {
  agentId: string;
  containerName: string;
  launchSpec: AgentLaunchSpec;
  projection: HermesProjectionResult;
  runtime: HermesDockerRuntimeOptions;
}): string[] {
  return [
    "run",
    "--detach",
    "--name",
    input.containerName,
    "--label",
    `${AGENTBAY_AGENT_ID_LABEL}=${input.agentId}`,
    "--label",
    `${AGENTBAY_CONFIG_REVISION_LABEL}=${input.launchSpec.agent.configRevision}`,
    "--label",
    `${AGENTBAY_LAUNCH_SPEC_VERSION_LABEL}=${input.launchSpec.version}`,
    "--network",
    input.runtime.network,
    "--mount",
    `type=bind,source=${input.projection.hermesHome},target=/opt/data`,
    "--mount",
    `type=bind,source=${input.projection.workspace},target=/workspace`,
    "--cpus",
    input.runtime.cpus,
    "--memory",
    input.runtime.memory,
    "--pids-limit",
    input.runtime.pidsLimit,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "SETUID",
    input.launchSpec.image.ref,
    "gateway",
    "run",
  ];
}

function buildLegacyDockerRunArgs(input: {
  agentId: string;
  command: DockerRunnerCommand;
  containerName: string;
}): string[] {
  return [
    "run",
    "--detach",
    "--name",
    input.containerName,
    "--label",
    `${AGENTBAY_AGENT_ID_LABEL}=${input.agentId}`,
    "--env",
    `AGENTBAY_AGENT_ID=${input.agentId}`,
    input.command.image,
    ...input.command.args,
  ];
}

function resolveHermesDockerRuntimeOptions(
  overrides: Partial<HermesDockerRuntimeOptions> | undefined,
): HermesDockerRuntimeOptions {
  return {
    cpus: overrides?.cpus ?? process.env[HERMES_DOCKER_CPUS_ENV]?.trim() ?? "1",
    memory: overrides?.memory ?? process.env[HERMES_DOCKER_MEMORY_ENV]?.trim() ?? "1536m",
    network:
      overrides?.network ??
      process.env[HERMES_PRIVATE_NETWORK_ENV]?.trim() ??
      DEFAULT_HERMES_PRIVATE_NETWORK,
    pidsLimit: overrides?.pidsLimit ?? process.env[HERMES_DOCKER_PIDS_LIMIT_ENV]?.trim() ?? "256",
    readinessPort: readPositiveInteger(
      process.env[HERMES_READINESS_PORT_ENV],
      overrides?.readinessPort ?? 8642,
    ),
  };
}

function createHermesReadinessWaiter(runtime: HermesDockerRuntimeOptions): HermesReadinessWaiter {
  return async (input) => {
    const deadline = Date.now() + 180_000;
    const url = `http://${input.containerName}:${runtime.readinessPort}/health/detailed`;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${input.apiServerKey}`,
            Accept: "application/json",
          },
        });

        if (response.ok) {
          const body: unknown = await response.json();

          if (isHermesReadyResponse(body, input.configRevision)) {
            return { ok: true };
          }
        }
      } catch {
        // Hermes may still be booting or the private network route may not be ready yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    return { ok: false, reason: "timeout" };
  };
}

export function isHermesReadyResponse(value: unknown, configRevision: string): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const status = value.status;
  const revision = value.configRevision ?? value.config_revision;

  return (
    (isReadyStatus(status) || value.ok === true) &&
    revision === configRevision &&
    isTelegramReady(value)
  );
}

function isTelegramReady(value: Record<string, unknown>): boolean {
  const candidates = [
    value.telegram,
    readNestedRecord(value, ["messaging", "telegram"]),
    readNestedRecord(value, ["platforms", "telegram"]),
    readNestedRecord(value, ["checks", "telegram"]),
    readNestedRecord(value, ["services", "telegram"]),
    readNestedRecord(value, ["integrations", "telegram"]),
  ];

  return candidates.some((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }

    return (
      candidate.ready === true ||
      candidate.ok === true ||
      candidate.connected === true ||
      candidate.enabled === true ||
      isReadyStatus(candidate.status) ||
      isReadyStatus(candidate.state) ||
      isReadyStatus(candidate.connection) ||
      isReadyStatus(candidate.connectionStatus)
    );
  });
}

function isReadyStatus(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return ["connected", "enabled", "healthy", "ok", "online", "ready", "running"].includes(
    value.trim().toLowerCase(),
  );
}

function readNestedRecord(value: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }

    current = current[key];
  }

  return current;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveManualRunnerCommand(
  input: Record<string, string | undefined> = process.env,
): DockerRunnerCommand {
  return {
    image: input[DOCKER_RUNNER_IMAGE_ENV]?.trim() || DEFAULT_MANUAL_RUNNER_IMAGE,
    args: parseManualRunnerArgs(input[DOCKER_RUNNER_ARGS_ENV]),
  };
}

function runDockerExecutable(
  executable: string,
  args: readonly string[],
): Promise<DockerCliResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: DOCKER_CLI_TIMEOUT_MS,
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

function parseDockerPsLine(line: string): DockerPsLine {
  const parsed: unknown = JSON.parse(line);

  if (!isRecord(parsed)) {
    throw new Error("Docker ps returned an invalid row.");
  }

  return parsed;
}

function parseDockerInspect(stdout: string): DockerInspectContainer {
  const parsed: unknown = JSON.parse(stdout.trim());

  if (!isRecord(parsed)) {
    throw new Error("Docker inspect returned an invalid object.");
  }

  return parsed;
}

function parseDockerLogOutput(result: DockerCliResult): RunnerLogLine[] {
  return [
    ...parseDockerLogStream("stdout", result.stdout),
    ...parseDockerLogStream("stderr", result.stderr),
  ].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;

    return leftTime - rightTime;
  });
}

function parseDockerLogStream(stream: RunnerLogLine["stream"], content: string): RunnerLogLine[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => parseDockerLogLine(stream, line))
    .filter((line): line is RunnerLogLine => line !== null);
}

function parseDockerLogLine(stream: RunnerLogLine["stream"], line: string): RunnerLogLine | null {
  const match = /^(\S+)\s(.*)$/.exec(line);

  if (!match) {
    return {
      stream,
      source: "container_bootstrap",
      message: redactSecretText(line),
      metadata: { logSource: "container_bootstrap" },
      createdAt: null,
    };
  }

  const timestamp = new Date(match[1] ?? "");
  const message = match[2]?.trimEnd() ?? "";

  if (message.trim().length === 0) {
    return null;
  }

  if (Number.isNaN(timestamp.getTime())) {
    return {
      stream,
      source: "container_bootstrap",
      message: redactSecretText(line),
      metadata: { logSource: "container_bootstrap" },
      createdAt: null,
    };
  }

  return {
    stream,
    source: "container_bootstrap",
    message: redactSecretText(message),
    metadata: { logSource: "container_bootstrap" },
    createdAt: timestamp.toISOString(),
  };
}

async function readHermesGatewayLogLines(agentId: string): Promise<RunnerLogLine[]> {
  const logDirectory = resolveHermesGatewayLogDirectory(agentId);

  try {
    await rejectSymlinkPath(resolveHermesStateRoot());
    await rejectSymlinkPath(resolve(resolveHermesStateRoot(), agentId));
    await rejectSymlinkPath(logDirectory);
  } catch {
    return [];
  }

  let entries: Array<{ name: string; mtimeMs: number }> = [];

  try {
    entries = await Promise.all(
      (await readdir(logDirectory))
        .filter((name) => name === "current" || name.startsWith("current."))
        .map(async (name) => ({
          name,
          mtimeMs: (await stat(resolve(logDirectory, name))).mtimeMs,
        })),
    );
  } catch {
    return [];
  }

  const files = entries
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))
    .map((entry) => resolve(logDirectory, entry.name));
  const lines: RunnerLogLine[] = [];

  for (const file of files) {
    lines.push(...(await readHermesGatewayLogFile(file, logDirectory)));
  }

  return lines.slice(-MAX_HERMES_LOG_LINES);
}

async function readHermesGatewayLogFile(
  filePath: string,
  logDirectory: string,
): Promise<RunnerLogLine[]> {
  const relativePath = relative(logDirectory, filePath);

  if (relativePath.startsWith("..") || relativePath.includes(sep)) {
    return [];
  }

  try {
    await rejectSymlinkPath(filePath);
    const content = await readFile(filePath, { encoding: "utf8" });
    const tail =
      Buffer.byteLength(content, "utf8") > MAX_HERMES_LOG_BYTES_PER_FILE
        ? content.slice(-MAX_HERMES_LOG_BYTES_PER_FILE)
        : content;

    return tail
      .split(/\r?\n/)
      .map((line) => parseHermesGatewayLogLine(line, basename(filePath)))
      .filter((line): line is RunnerLogLine => line !== null);
  } catch {
    return [];
  }
}

function parseHermesGatewayLogLine(line: string, fileName: string): RunnerLogLine | null {
  const trimmed = line.trimEnd();

  if (!trimmed.trim()) {
    return null;
  }

  const dockerTimestamp = /^(\S+)\s(.*)$/.exec(trimmed);
  const bracketTimestamp = /^\[([^\]]+)\]\s*(.*)$/.exec(trimmed);
  const timestampText = dockerTimestamp?.[1] ?? bracketTimestamp?.[1] ?? "";
  const parsedTimestamp = timestampText ? new Date(timestampText) : null;
  const message = dockerTimestamp?.[2] ?? bracketTimestamp?.[2] ?? trimmed;

  return {
    stream: "stdout",
    source: "hermes_gateway",
    message: redactSecretText(message.trimEnd()),
    metadata: {
      logSource: "hermes_gateway",
      logFile: fileName,
    },
    createdAt:
      parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime())
        ? parsedTimestamp.toISOString()
        : null,
  };
}

function mergeRunnerLogLines(
  gatewayLogs: RunnerLogLine[],
  bootstrapLogs: RunnerLogLine[],
): RunnerLogLine[] {
  const gatewayKeys = new Set(gatewayLogs.map(logDeduplicationKey));

  return [
    ...gatewayLogs,
    ...bootstrapLogs.filter((line) => !gatewayKeys.has(logDeduplicationKey(line))),
  ]
    .sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;

      return leftTime - rightTime || sourceOrder(left) - sourceOrder(right);
    })
    .slice(-MAX_HERMES_LOG_LINES);
}

function logDeduplicationKey(line: RunnerLogLine): string {
  return `${line.createdAt ?? ""}:${line.message}`;
}

function sourceOrder(line: RunnerLogLine): number {
  return line.source === "hermes_gateway" ? 0 : 1;
}

async function removeHermesAgentRoot(agentId: string): Promise<boolean> {
  const stateRoot = resolveHermesStateRoot();
  const agentRoot = resolve(stateRoot, agentId);
  assertChildPath(stateRoot, agentRoot);

  try {
    await rejectSymlinkPath(stateRoot);
    await rejectSymlinkPath(agentRoot);
    await rm(agentRoot, { force: true, recursive: true });
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

function resolveHermesGatewayLogDirectory(agentId: string): string {
  const stateRoot = resolveHermesStateRoot();
  const agentRoot = resolve(stateRoot, agentId);
  const logDirectory = resolve(agentRoot, "hermes", "logs", "gateways", "default");
  assertChildPath(stateRoot, agentRoot);
  assertChildPath(agentRoot, logDirectory);

  return logDirectory;
}

function resolveHermesStateRoot(): string {
  return resolve(process.env[HERMES_STATE_ROOT_ENV]?.trim() || DEFAULT_HERMES_STATE_ROOT);
}

async function rejectSymlinkPath(path: string): Promise<void> {
  const info = await lstat(path);

  if (info.isSymbolicLink()) {
    throw new Error("Hermes runner path must not be a symbolic link.");
  }
}

function assertChildPath(parent: string, child: string): void {
  const relativePath = relative(parent, child);

  if (relativePath === "" || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
    throw new Error("Hermes runner path escaped the managed root.");
  }
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function parseManualRunnerArgs(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [...DUMMY_DOCKER_RUNNER_ARGS];
  }

  const parsed: unknown = JSON.parse(value);

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${DOCKER_RUNNER_ARGS_ENV} must be a JSON string array.`);
  }

  return parsed;
}

function normalizeDockerTimestamp(value: string | undefined): string | null {
  if (!value || value.startsWith("0001-01-01")) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dockerContainerName(agentId: string, suffix: string): string {
  return `agentbay-runner-${agentId}-${suffix}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
