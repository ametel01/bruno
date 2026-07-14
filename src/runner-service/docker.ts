import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentLaunchSpec } from "@/src/server/agents/agent-launch-spec";
import {
  AGENTBAY_AGENT_ID_LABEL,
  DEFAULT_MANUAL_RUNNER_IMAGE,
  DOCKER_CLI_TIMEOUT_MS,
} from "@/src/runner-service/constants";
import {
  projectHermesHome,
  type HermesProjectionOptions,
  type HermesProjectionResult,
} from "@/src/runner-service/hermes-projection";

export { AGENTBAY_AGENT_ID_LABEL, DEFAULT_MANUAL_RUNNER_IMAGE, DOCKER_CLI_TIMEOUT_MS };
const DOCKER_RUNNER_IMAGE_ENV = "AGENTBAY_DOCKER_RUNNER_IMAGE";
const DOCKER_RUNNER_ARGS_ENV = "AGENTBAY_DOCKER_RUNNER_ARGS_JSON";
const DOCKER_EXECUTABLE_ENV = "AGENTBAY_RUNNER_DOCKER_EXECUTABLE";
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
  nameSuffix?: () => string;
  projection?: {
    project?: (spec: AgentLaunchSpec) => Promise<HermesProjectionResult>;
    options?: HermesProjectionOptions;
  };
};

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
  createdAt: string | null;
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

type DockerPsLine = {
  ID?: string;
};

export class ManualRunnerDocker {
  private readonly command: DockerRunnerCommand;
  private readonly docker: DockerExecutableRunner;
  private readonly dockerExecutable: string;
  private readonly nameSuffix: () => string;
  private readonly project: (spec: AgentLaunchSpec) => Promise<HermesProjectionResult>;

  constructor(options: ManualRunnerDockerOptions = {}) {
    this.command = options.command ?? resolveManualRunnerCommand();
    this.docker = options.docker ?? runDockerExecutable;
    this.dockerExecutable =
      options.dockerExecutable ?? process.env[DOCKER_EXECUTABLE_ENV]?.trim() ?? "docker";
    this.nameSuffix = options.nameSuffix ?? (() => randomUUID().replaceAll("-", "").slice(0, 12));
    this.project =
      options.projection?.project ??
      ((spec) => projectHermesHome(spec, options.projection?.options));
  }

  async start(
    agentId: string,
    launchSpec: AgentLaunchSpec | null = null,
  ): Promise<{ container: RunnerContainer; projection: HermesProjectionResult | null }> {
    const projection = launchSpec ? await this.project(launchSpec) : null;

    await this.removeSelectedContainers(agentId);
    const containerName = dockerContainerName(agentId, this.nameSuffix());
    const runResult = await this.runDocker([
      "run",
      "--detach",
      "--name",
      containerName,
      "--label",
      `${AGENTBAY_AGENT_ID_LABEL}=${agentId}`,
      "--env",
      `AGENTBAY_AGENT_ID=${agentId}`,
      this.command.image,
      ...this.command.args,
    ]);
    const containerId = runResult.stdout.trim();

    if (!containerId) {
      throw new Error("Docker did not return a container id.");
    }

    return {
      container: await this.inspectSelectedContainer(containerId, agentId),
      projection,
    };
  }

  async stop(agentId: string): Promise<{ containers: RunnerContainer[] }> {
    const containers = await this.listSelectedContainers(agentId);
    const stopped: RunnerContainer[] = [];

    for (const container of containers) {
      if (container.status === "running") {
        await this.runDocker(["stop", container.id]);
      }
      stopped.push(await this.inspectSelectedContainer(container.id, agentId));
    }

    return { containers: stopped };
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

    if (!container) {
      return { container: null, logs: [] };
    }

    const result = await this.runDocker(["logs", "--timestamps", container.id]);

    return {
      container,
      logs: parseDockerLogOutput(result),
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
  ): Promise<RunnerContainer> {
    const result = await this.runDocker(["inspect", "--format", "{{json .}}", containerId]);
    const inspect = parseDockerInspect(result.stdout);

    if (inspect.Config?.Labels?.[AGENTBAY_AGENT_ID_LABEL] !== agentId) {
      throw new Error("Docker container label mismatch.");
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
      message: line,
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
      message: line,
      createdAt: null,
    };
  }

  return {
    stream,
    message,
    createdAt: timestamp.toISOString(),
  };
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
