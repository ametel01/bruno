import { execFile } from "node:child_process";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  type DockerRunnerContainerDto,
  getDockerRunnerContainerForDevelopmentUser,
  getDockerRunnerContainerForUser,
  recordDockerRunnerContainerForDevelopmentUser,
  recordDockerRunnerContainerForUser,
} from "@/src/server/runners/docker-runner-state";

const BRUNO_AGENT_ID_LABEL = "bruno.agent_id";
const DOCKER_CLI_TIMEOUT_MS = 15_000;

export type DockerCliResult = {
  stdout: string;
  stderr: string;
};

export type DockerCliRunner = (args: readonly string[]) => Promise<DockerCliResult>;

export type DockerRunnerStatusResult =
  | { ok: true; container: DockerRunnerContainerDto | null }
  | {
      ok: false;
      reason: "docker_inspect_failed" | "label_mismatch" | "state_persistence_failed";
    };

export type DockerRunnerCleanupResult =
  | { ok: true; container: DockerRunnerContainerDto | null }
  | {
      ok: false;
      reason:
        | "docker_inspect_failed"
        | "docker_rm_failed"
        | "label_mismatch"
        | "state_persistence_failed";
    };

export type DockerRunnerMaintenanceAdapterDependencies = {
  createConnection?: () => DatabaseConnection;
  dockerCli?: DockerCliRunner;
  now?: () => Date;
  userId?: string;
};

type DockerInspectContainer = {
  Config?: {
    Image?: string;
    Labels?: Record<string, string> | null;
  };
  State?: {
    Error?: string;
    ExitCode?: number;
    OOMKilled?: boolean;
    Status?: string;
    StartedAt?: string;
    FinishedAt?: string;
  };
};

type ResolvedContainerTarget = {
  stored: DockerRunnerContainerDto;
  inspect: DockerInspectContainer;
};

export class DockerRunnerMaintenanceAdapter {
  private readonly createConnection: () => DatabaseConnection;
  private readonly dockerCli: DockerCliRunner;
  private readonly now: () => Date;
  private readonly ownsConnections: boolean;
  private readonly userId: string | undefined;

  constructor(dependencies: DockerRunnerMaintenanceAdapterDependencies = {}) {
    this.createConnection = dependencies.createConnection ?? createDatabaseConnection;
    this.dockerCli = dependencies.dockerCli ?? runDockerCli;
    this.now = dependencies.now ?? (() => new Date());
    this.ownsConnections = !dependencies.createConnection;
    this.userId = dependencies.userId;
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

  async cleanup(agentId: string): Promise<DockerRunnerCleanupResult> {
    const connection = this.createConnection();

    try {
      const target = await this.resolveContainerTarget(connection, agentId);

      if (!target.ok) {
        await this.closeOwnedConnection(connection);
        return target.reason === "no_container"
          ? { ok: true, container: null }
          : { ok: false, reason: target.reason };
      }

      try {
        await this.dockerCli(["rm", "--force", target.target.stored.containerId]);
      } catch {
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "docker_rm_failed" };
      }

      const container = await this.recordInspectedContainer(
        connection,
        target.target.stored,
        target.target.inspect,
        "removed",
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

  private async resolveContainerTarget(
    connection: DatabaseConnection,
    agentId: string,
  ): Promise<
    | { ok: true; target: ResolvedContainerTarget }
    | { ok: false; reason: "no_container" | "docker_inspect_failed" | "label_mismatch" }
  > {
    const containerInput = {
      db: connection.db,
      agentId,
    };
    const stored =
      this.userId === undefined
        ? await getDockerRunnerContainerForDevelopmentUser(containerInput)
        : await getDockerRunnerContainerForUser({
            ...containerInput,
            userId: this.userId,
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

    if (inspect.Config?.Labels?.[BRUNO_AGENT_ID_LABEL] !== agentId) {
      return { ok: false, reason: "label_mismatch" };
    }

    return { ok: true, inspect };
  }

  private async recordInspectedContainer(
    connection: DatabaseConnection,
    stored: DockerRunnerContainerDto,
    inspect: DockerInspectContainer,
    observedStatus = observedStatusFromInspect(inspect),
  ): Promise<DockerRunnerContainerDto | null> {
    const containerInput = {
      db: connection.db,
      agentId: stored.agentId,
      containerId: stored.containerId,
      containerName: stored.containerName,
      image: inspect.Config?.Image ?? stored.image,
      observedStatus,
      metadata: {
        ...stored.metadata,
        dockerState: dockerInspectStateMetadata(inspect),
      },
      observedAt: this.now(),
      startedAt: dockerTimestampToDate(inspect.State?.StartedAt),
      finishedAt: dockerTimestampToDate(inspect.State?.FinishedAt),
    };

    return this.userId === undefined
      ? recordDockerRunnerContainerForDevelopmentUser(containerInput)
      : recordDockerRunnerContainerForUser({ ...containerInput, userId: this.userId });
  }

  private async closeOwnedConnection(connection: DatabaseConnection): Promise<void> {
    if (this.ownsConnections) {
      await connection.close();
    }
  }
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

function dockerInspectStateMetadata(inspect: DockerInspectContainer): Record<string, unknown> {
  return {
    status: observedStatusFromInspect(inspect),
    ...(typeof inspect.State?.ExitCode === "number" ? { exitCode: inspect.State.ExitCode } : {}),
    ...(typeof inspect.State?.OOMKilled === "boolean"
      ? { oomKilled: inspect.State.OOMKilled }
      : {}),
    ...(inspect.State?.Error?.trim() ? { error: inspect.State.Error } : {}),
    ...(inspect.State?.StartedAt ? { startedAt: inspect.State.StartedAt } : {}),
    ...(inspect.State?.FinishedAt ? { finishedAt: inspect.State.FinishedAt } : {}),
  };
}

function dockerTimestampToDate(value: string | undefined): Date | null {
  if (!value || value.startsWith("0001-01-01")) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
