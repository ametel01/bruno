import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type { AgentLogPage } from "@/src/server/logs/agent-logs";
import {
  appendDockerRunnerLogLines,
  type DockerRunnerContainerDto,
  type DockerRunnerLogLineInput,
  getDockerRunnerContainerForDevelopmentUser,
  getLatestDockerRunnerLogCursor,
  listDockerRunnerContainerLogs,
  recordDockerRunnerContainerForDevelopmentUser,
} from "@/src/server/runners/docker-runner-state";
import type {
  RunnerAdapter as RunnerAdapterContract,
  RunnerLogStreamInput,
} from "@/src/server/runners/runner-adapter";

export const AGENTBAY_AGENT_ID_LABEL = "agentbay.agent_id";
export const DEFAULT_DOCKER_RUNNER_IMAGE = "busybox:1.36";
export const DEFAULT_DOCKER_CPU_LIMIT = "1";
export const DEFAULT_DOCKER_MEMORY_LIMIT = "512m";
export const DEFAULT_DOCKER_WORKSPACE_TARGET = "/workspace";
export const DEFAULT_DOCKER_CONFIG_TARGET = "/etc/agentbay/config";

const DOCKER_RUNNER_IMAGE_ENV = "AGENTBAY_DOCKER_RUNNER_IMAGE";
const DOCKER_RUNNER_ARGS_ENV = "AGENTBAY_DOCKER_RUNNER_ARGS_JSON";
const DOCKER_RUNNER_CONFIG_PATH_ENV = "AGENTBAY_DOCKER_CONFIG_PATH";
const DOCKER_RUNNER_WORKSPACE_ROOT_ENV = "AGENTBAY_DOCKER_WORKSPACE_ROOT";
const DOCKER_RUNNER_CPU_LIMIT_ENV = "AGENTBAY_DOCKER_CPU_LIMIT";
const DOCKER_RUNNER_MEMORY_LIMIT_ENV = "AGENTBAY_DOCKER_MEMORY_LIMIT";
const DOCKER_CLI_TIMEOUT_MS = 15_000;
const DUMMY_DOCKER_RUNNER_ARGS = [
  "sh",
  "-c",
  [
    'printf "agentbay docker dummy runner started for %s\\n" "$AGENTBAY_AGENT_ID"',
    'printf "agentbay docker dummy runner stderr ready for %s\\n" "$AGENTBAY_AGENT_ID" >&2',
    'trap \'printf "agentbay docker dummy runner stopping for %s\\n" "$AGENTBAY_AGENT_ID"; exit 0\' TERM INT',
    "while true; do sleep 1; done",
  ].join("; "),
];

export type DockerRunnerCommand = {
  image: string;
  args: string[];
};

export type DockerRunnerResources = {
  cpus: string;
  memory: string;
};

export type DockerRunnerMounts = {
  configPath?: string;
  configTarget: string;
  workspaceRoot: string;
  workspaceTarget: string;
};

export type DockerCliResult = {
  stdout: string;
  stderr: string;
};

export type DockerCliRunner = (args: readonly string[]) => Promise<DockerCliResult>;

export type DockerRunnerStartResult =
  | { ok: true; container: DockerRunnerContainerDto }
  | {
      ok: false;
      reason:
        | "agent_not_found"
        | "docker_run_failed"
        | "docker_inspect_failed"
        | "container_not_running"
        | "label_mismatch"
        | "state_persistence_failed";
    };

export type DockerRunnerStopResult =
  | { ok: true; container: DockerRunnerContainerDto }
  | {
      ok: false;
      reason:
        | "no_container"
        | "docker_inspect_failed"
        | "docker_stop_failed"
        | "label_mismatch"
        | "state_persistence_failed";
    };

export type DockerRunnerRestartResult =
  | { ok: true; container: DockerRunnerContainerDto }
  | {
      ok: false;
      reason:
        | Extract<DockerRunnerStopResult, { ok: false }>["reason"]
        | Extract<DockerRunnerStartResult, { ok: false }>["reason"];
    };

export type DockerRunnerStatusResult =
  | { ok: true; container: DockerRunnerContainerDto | null }
  | {
      ok: false;
      reason: "docker_inspect_failed" | "label_mismatch" | "state_persistence_failed";
    };

export type DockerRunnerAdapterDependencies = {
  command?: DockerRunnerCommand;
  createConnection?: () => DatabaseConnection;
  dockerCli?: DockerCliRunner;
  mounts?: Partial<DockerRunnerMounts>;
  nameSuffix?: () => string;
  now?: () => Date;
  resources?: Partial<DockerRunnerResources>;
};

type DockerInspectContainer = {
  Id?: string;
  Name?: string;
  Config?: {
    Image?: string;
    Labels?: Record<string, string> | null;
  };
  State?: {
    Status?: string;
    StartedAt?: string;
    FinishedAt?: string;
  };
};

type ResolvedContainerTarget = {
  stored: DockerRunnerContainerDto;
  inspect: DockerInspectContainer;
};

export type DockerRunPlan = {
  args: string[];
  containerName: string;
  workspacePath: string;
};

export class DockerRunnerAdapter
  implements
    RunnerAdapterContract<
      DockerRunnerStartResult,
      DockerRunnerStopResult,
      DockerRunnerRestartResult,
      DockerRunnerStatusResult
    >
{
  private readonly command: DockerRunnerCommand;
  private readonly createConnection: () => DatabaseConnection;
  private readonly dockerCli: DockerCliRunner;
  private readonly mounts: DockerRunnerMounts;
  private readonly nameSuffix: () => string;
  private readonly now: () => Date;
  private readonly ownsConnections: boolean;
  private readonly resources: DockerRunnerResources;

  constructor(dependencies: DockerRunnerAdapterDependencies = {}) {
    this.command = dependencies.command ?? resolveDockerRunnerCommand();
    this.createConnection = dependencies.createConnection ?? createDatabaseConnection;
    this.dockerCli = dependencies.dockerCli ?? runDockerCli;
    this.mounts = resolveDockerRunnerMounts(dependencies.mounts);
    this.nameSuffix =
      dependencies.nameSuffix ?? (() => randomUUID().replaceAll("-", "").slice(0, 12));
    this.now = dependencies.now ?? (() => new Date());
    this.ownsConnections = !dependencies.createConnection;
    this.resources = {
      cpus:
        dependencies.resources?.cpus ??
        resolveDockerTextEnv(DOCKER_RUNNER_CPU_LIMIT_ENV, DEFAULT_DOCKER_CPU_LIMIT),
      memory:
        dependencies.resources?.memory ??
        resolveDockerTextEnv(DOCKER_RUNNER_MEMORY_LIMIT_ENV, DEFAULT_DOCKER_MEMORY_LIMIT),
    };
  }

  async start(agentId: string): Promise<DockerRunnerStartResult> {
    const connection = this.createConnection();
    const plan = buildDockerRunPlan({
      agentId,
      command: this.command,
      mounts: this.mounts,
      nameSuffix: this.nameSuffix(),
      resources: this.resources,
    });

    try {
      await mkdir(plan.workspacePath, { recursive: true });

      let containerId: string;
      try {
        const runResult = await this.dockerCli(plan.args);
        containerId = runResult.stdout.trim();
      } catch {
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "docker_run_failed" };
      }

      if (!containerId) {
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "docker_run_failed" };
      }

      const inspected = await this.inspectExpectedContainer(containerId, agentId);
      if (!inspected.ok) {
        await this.cleanupStartedContainer(containerId, agentId);
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: inspected.reason };
      }

      const observedStatus = observedStatusFromInspect(inspected.inspect);
      if (observedStatus !== "running") {
        await this.cleanupStartedContainer(containerId, agentId);
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "container_not_running" };
      }

      try {
        const container = await recordDockerRunnerContainerForDevelopmentUser({
          db: connection.db,
          agentId,
          containerId,
          containerName: plan.containerName,
          image: this.command.image,
          observedStatus,
          metadata: dockerRunnerMetadata({
            agentId,
            command: this.command,
            mounts: this.mounts,
            plan,
            resources: this.resources,
          }),
          observedAt: this.now(),
          startedAt: dockerTimestampToDate(inspected.inspect.State?.StartedAt),
          finishedAt: dockerTimestampToDate(inspected.inspect.State?.FinishedAt),
        });

        if (!container) {
          await this.cleanupStartedContainer(containerId, agentId);
          await this.closeOwnedConnection(connection);
          return { ok: false, reason: "agent_not_found" };
        }

        await this.closeOwnedConnection(connection);
        return { ok: true, container };
      } catch {
        await this.cleanupStartedContainer(containerId, agentId);
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "state_persistence_failed" };
      }
    } catch {
      await this.closeOwnedConnection(connection);
      return { ok: false, reason: "state_persistence_failed" };
    }
  }

  async stop(agentId: string): Promise<DockerRunnerStopResult> {
    const connection = this.createConnection();

    try {
      const target = await this.resolveContainerTarget(connection, agentId);

      if (!target.ok) {
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: target.reason };
      }

      try {
        await this.dockerCli(["stop", target.target.stored.containerId]);
      } catch {
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "docker_stop_failed" };
      }

      const inspectedAfterStop = await this.inspectExpectedContainer(
        target.target.stored.containerId,
        agentId,
      );

      if (!inspectedAfterStop.ok) {
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: inspectedAfterStop.reason };
      }

      const container = await this.recordInspectedContainer(
        connection,
        target.target.stored,
        inspectedAfterStop.inspect,
      );

      await this.closeOwnedConnection(connection);
      return container
        ? { ok: true, container }
        : { ok: false, reason: "state_persistence_failed" };
    } catch {
      await this.closeOwnedConnection(connection);
      return { ok: false, reason: "state_persistence_failed" };
    }
  }

  async restart(agentId: string): Promise<DockerRunnerRestartResult> {
    const stopResult = await this.stop(agentId);

    if (!stopResult.ok && stopResult.reason !== "no_container") {
      return stopResult;
    }

    return this.start(agentId);
  }

  async status(agentId: string): Promise<DockerRunnerStatusResult> {
    const connection = this.createConnection();

    try {
      const target = await this.resolveContainerTarget(connection, agentId);

      if (!target.ok) {
        await this.closeOwnedConnection(connection);
        return target.reason === "no_container"
          ? { ok: true, container: null }
          : { ok: false, reason: target.reason };
      }

      const container = await this.recordInspectedContainer(
        connection,
        target.target.stored,
        target.target.inspect,
      );

      await this.closeOwnedConnection(connection);
      return container
        ? { ok: true, container }
        : { ok: false, reason: "state_persistence_failed" };
    } catch {
      await this.closeOwnedConnection(connection);
      return { ok: false, reason: "state_persistence_failed" };
    }
  }

  async streamLogs(input: RunnerLogStreamInput): Promise<AgentLogPage> {
    const connection = this.createConnection();

    try {
      const target = await this.resolveContainerTarget(
        connection,
        input.agentId,
        input.containerId,
      );

      if (target.ok) {
        const latestCursor = await getLatestDockerRunnerLogCursor({
          db: connection.db,
          agentId: input.agentId,
          containerId: target.target.stored.containerId,
        });
        const dockerLogs = await this.dockerCli([
          "logs",
          "--timestamps",
          target.target.stored.containerId,
        ]);
        const parsedLines = parseDockerLogOutput(dockerLogs).filter((line) =>
          shouldAppendDockerLogLine(line, latestCursor),
        );

        if (parsedLines.length > 0) {
          await appendDockerRunnerLogLines({
            db: connection.db,
            containerId: target.target.stored.containerId,
            lines: parsedLines,
          });
        }

        const logs = await listDockerRunnerContainerLogs({
          db: connection.db,
          agentId: input.agentId,
          containerId: target.target.stored.containerId,
          ...(input.after === undefined ? {} : { after: input.after }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });

        await this.closeOwnedConnection(connection);
        return {
          logs,
          nextAfter: logs.at(-1)?.sequence ?? input.after ?? null,
        };
      }

      await this.closeOwnedConnection(connection);
      return {
        logs: [],
        nextAfter: input.after ?? null,
      };
    } catch {
      await this.closeOwnedConnection(connection);
      return {
        logs: [],
        nextAfter: input.after ?? null,
      };
    }
  }

  private async resolveContainerTarget(
    connection: DatabaseConnection,
    agentId: string,
    containerId?: string,
  ): Promise<
    | { ok: true; target: ResolvedContainerTarget }
    | { ok: false; reason: "no_container" | "docker_inspect_failed" | "label_mismatch" }
  > {
    const stored = await getDockerRunnerContainerForDevelopmentUser({
      db: connection.db,
      agentId,
      ...(containerId === undefined ? {} : { containerId }),
    });

    if (!stored) {
      return { ok: false, reason: "no_container" };
    }

    const inspected = await this.inspectExpectedContainer(stored.containerId, agentId);

    if (!inspected.ok) {
      return inspected;
    }

    return {
      ok: true,
      target: {
        stored,
        inspect: inspected.inspect,
      },
    };
  }

  private async inspectExpectedContainer(
    containerId: string,
    agentId: string,
  ): Promise<
    | { ok: true; inspect: DockerInspectContainer }
    | { ok: false; reason: "docker_inspect_failed" | "label_mismatch" }
  > {
    let inspect: DockerInspectContainer;

    try {
      inspect = parseDockerInspectJson(
        await this.dockerCli(["inspect", "--format", "{{json .}}", containerId]),
      );
    } catch {
      return { ok: false, reason: "docker_inspect_failed" };
    }

    if (inspect.Config?.Labels?.[AGENTBAY_AGENT_ID_LABEL] !== agentId) {
      return { ok: false, reason: "label_mismatch" };
    }

    return { ok: true, inspect };
  }

  private async recordInspectedContainer(
    connection: DatabaseConnection,
    stored: DockerRunnerContainerDto,
    inspect: DockerInspectContainer,
  ): Promise<DockerRunnerContainerDto | null> {
    return recordDockerRunnerContainerForDevelopmentUser({
      db: connection.db,
      agentId: stored.agentId,
      containerId: stored.containerId,
      containerName: stored.containerName,
      image: inspect.Config?.Image ?? stored.image,
      observedStatus: observedStatusFromInspect(inspect),
      metadata: stored.metadata,
      observedAt: this.now(),
      startedAt: dockerTimestampToDate(inspect.State?.StartedAt),
      finishedAt: dockerTimestampToDate(inspect.State?.FinishedAt),
    });
  }

  private async cleanupStartedContainer(containerId: string, agentId: string): Promise<void> {
    const inspected = await this.inspectExpectedContainer(containerId, agentId);

    if (!inspected.ok) {
      return;
    }

    try {
      await this.dockerCli(["rm", "--force", containerId]);
    } catch {
      // Best-effort cleanup only; never hide the original start failure.
    }
  }

  private async closeOwnedConnection(connection: DatabaseConnection): Promise<void> {
    if (this.ownsConnections) {
      await connection.close();
    }
  }
}

export function resolveDockerRunnerCommand(
  input: Record<string, string | undefined> = process.env,
): DockerRunnerCommand {
  return {
    image: resolveDockerTextEnv(DOCKER_RUNNER_IMAGE_ENV, DEFAULT_DOCKER_RUNNER_IMAGE, input),
    args: parseDockerRunnerArgs(input[DOCKER_RUNNER_ARGS_ENV]),
  };
}

export function resolveDockerRunnerMounts(
  input: Partial<DockerRunnerMounts> = {},
  env: Record<string, string | undefined> = process.env,
): DockerRunnerMounts {
  const envConfigPath = env[DOCKER_RUNNER_CONFIG_PATH_ENV]?.trim();
  const workspaceRoot = input.workspaceRoot ?? env[DOCKER_RUNNER_WORKSPACE_ROOT_ENV]?.trim();

  return {
    ...((input.configPath ?? envConfigPath)
      ? { configPath: resolve(/* turbopackIgnore: true */ input.configPath ?? envConfigPath ?? "") }
      : {}),
    configTarget: input.configTarget ?? DEFAULT_DOCKER_CONFIG_TARGET,
    workspaceRoot: resolve(
      /* turbopackIgnore: true */ workspaceRoot || join(tmpdir(), "agentbay-docker-workspaces"),
    ),
    workspaceTarget: input.workspaceTarget ?? DEFAULT_DOCKER_WORKSPACE_TARGET,
  };
}

export function buildDockerRunPlan(input: {
  agentId: string;
  command: DockerRunnerCommand;
  mounts: DockerRunnerMounts;
  nameSuffix: string;
  resources: DockerRunnerResources;
}): DockerRunPlan {
  const containerName = dockerContainerName(input.agentId, input.nameSuffix);
  const workspacePath = resolve(
    /* turbopackIgnore: true */ input.mounts.workspaceRoot,
    input.agentId,
  );
  const args = [
    "run",
    "--detach",
    "--name",
    containerName,
    "--label",
    `${AGENTBAY_AGENT_ID_LABEL}=${input.agentId}`,
    "--cpus",
    input.resources.cpus,
    "--memory",
    input.resources.memory,
    "--mount",
    `type=bind,source=${workspacePath},target=${input.mounts.workspaceTarget}`,
    "--workdir",
    input.mounts.workspaceTarget,
    "--env",
    `AGENTBAY_AGENT_ID=${input.agentId}`,
    "--env",
    `AGENTBAY_WORKSPACE=${input.mounts.workspaceTarget}`,
  ];

  if (input.mounts.configPath) {
    args.push(
      "--mount",
      `type=bind,source=${input.mounts.configPath},target=${input.mounts.configTarget},readonly`,
      "--env",
      `AGENTBAY_CONFIG_PATH=${input.mounts.configTarget}`,
    );
  }

  args.push(input.command.image, ...input.command.args);

  return {
    args,
    containerName,
    workspacePath,
  };
}

export function parseDockerLogOutput(result: DockerCliResult): DockerRunnerLogLineInput[] {
  return [
    ...parseDockerLogStream("stdout", result.stdout),
    ...parseDockerLogStream("stderr", result.stderr),
  ].sort((left, right) => (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0));
}

function runDockerCli(args: readonly string[]): Promise<DockerCliResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "docker",
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

function parseDockerRunnerArgs(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [...DUMMY_DOCKER_RUNNER_ARGS];
  }

  const parsed: unknown = JSON.parse(value);

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${DOCKER_RUNNER_ARGS_ENV} must be a JSON string array.`);
  }

  return parsed;
}

function parseDockerInspectJson(result: DockerCliResult): DockerInspectContainer {
  const parsed: unknown = JSON.parse(result.stdout.trim());

  if (!isRecord(parsed)) {
    throw new Error("Docker inspect did not return an object.");
  }

  return parsed;
}

function observedStatusFromInspect(inspect: DockerInspectContainer): string {
  return inspect.State?.Status?.trim() || "unknown";
}

function dockerRunnerMetadata(input: {
  agentId: string;
  command: DockerRunnerCommand;
  mounts: DockerRunnerMounts;
  plan: DockerRunPlan;
  resources: DockerRunnerResources;
}): Record<string, unknown> {
  return {
    labels: {
      [AGENTBAY_AGENT_ID_LABEL]: input.agentId,
    },
    command: {
      image: input.command.image,
      args: input.command.args,
    },
    mounts: {
      workspaceSource: input.plan.workspacePath,
      workspaceTarget: input.mounts.workspaceTarget,
      workspaceReadonly: false,
      ...(input.mounts.configPath
        ? {
            configSource: input.mounts.configPath,
            configTarget: input.mounts.configTarget,
            configReadonly: true,
          }
        : {}),
    },
    resources: input.resources,
  };
}

function dockerTimestampToDate(value: string | undefined): Date | null {
  if (!value || value.startsWith("0001-01-01")) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDockerLogStream(
  stream: DockerRunnerLogLineInput["stream"],
  content: string,
): DockerRunnerLogLineInput[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => parseDockerLogLine(stream, line))
    .filter((line): line is DockerRunnerLogLineInput => line !== null);
}

function parseDockerLogLine(
  stream: DockerRunnerLogLineInput["stream"],
  line: string,
): DockerRunnerLogLineInput | null {
  const match = /^(\S+)\s(.*)$/.exec(line);

  if (!match) {
    return {
      stream,
      message: line,
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
      message: line,
    };
  }

  return {
    stream,
    message,
    createdAt: timestamp,
  };
}

function shouldAppendDockerLogLine(
  line: DockerRunnerLogLineInput,
  latestCursor: { createdAt: Date } | null,
): boolean {
  if (!latestCursor || !line.createdAt) {
    return true;
  }

  return line.createdAt > latestCursor.createdAt;
}

function dockerContainerName(agentId: string, suffix: string): string {
  return `agentbay-${agentId}-${suffix}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
}

function resolveDockerTextEnv(
  name: string,
  fallback: string,
  input: Record<string, string | undefined> = process.env,
): string {
  return input[name]?.trim() || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
