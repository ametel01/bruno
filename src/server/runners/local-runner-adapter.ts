import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  appendLocalRunnerLogLines,
  createLocalRunnerProcessForDevelopmentUser,
  getLatestLocalRunnerProcessForDevelopmentUser,
  listLocalRunnerProcessLogs,
  type LocalRunnerLogLineInput,
  type LocalRunnerProcessDto,
  recordLocalRunnerProcessExit,
} from "@/src/server/runners/local-runner-state";
import { listAgentLogs, type AgentLogPage } from "@/src/server/logs/agent-logs";

const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const RUNNING_PROCESS_STATUSES = ["starting", "running"] as const;
const CONFIGURED_RUNNER_ARGS_ENV = "AGENTBAY_LOCAL_RUNNER_ARGS_JSON";
const CONFIGURED_RUNNER_EXECUTABLE_ENV = "AGENTBAY_LOCAL_RUNNER_EXECUTABLE";
const DUMMY_RUNNER_SCRIPT = `
const agentId = process.env.AGENTBAY_AGENT_ID || "unknown";
console.log("agentbay dummy runner started for " + agentId);
console.error("agentbay dummy runner stderr ready for " + agentId);
const interval = setInterval(() => {
  console.log("agentbay dummy runner heartbeat for " + agentId);
}, 1000);
process.on("SIGTERM", () => {
  clearInterval(interval);
  console.log("agentbay dummy runner stopping for " + agentId);
  process.exit(0);
});
`;

export type LocalRunnerCommand = {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export type LocalRunnerStartResult =
  | { ok: true; process: LocalRunnerProcessDto }
  | { ok: false; reason: "agent_not_found" | "spawn_failed" | "state_persistence_failed" };

export type LocalRunnerStopResult =
  | { ok: true; process: LocalRunnerProcessDto }
  | { ok: false; reason: "no_process" | "process_not_managed" | "state_persistence_failed" };

export type LocalRunnerRestartResult =
  | { ok: true; process: LocalRunnerProcessDto }
  | {
      ok: false;
      reason:
        | Extract<LocalRunnerStopResult, { ok: false }>["reason"]
        | Extract<LocalRunnerStartResult, { ok: false }>["reason"];
    };

export type LocalRunnerStatusResult =
  | { ok: true; process: LocalRunnerProcessDto | null }
  | { ok: false; reason: "state_persistence_failed" };

export type LocalRunnerSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type LocalRunnerAdapterDependencies = {
  command?: LocalRunnerCommand;
  createConnection?: () => DatabaseConnection;
  spawnProcess?: LocalRunnerSpawn;
  stopTimeoutMs?: number;
};

type ManagedChildProcess = {
  agentId: string;
  child: ChildProcessWithoutNullStreams;
  process: LocalRunnerProcessDto;
  stdoutRemainder: string;
  stderrRemainder: string;
  stopRequested: boolean;
  logQueue: Promise<void>;
  terminalUpdate: Promise<LocalRunnerProcessDto | null> | null;
};

export interface RunnerAdapter {
  start(agentId: string): Promise<LocalRunnerStartResult>;
  stop(agentId: string): Promise<LocalRunnerStopResult>;
  restart(agentId: string): Promise<LocalRunnerRestartResult>;
  status(agentId: string): Promise<LocalRunnerStatusResult>;
  streamLogs(input: {
    agentId: string;
    processId?: string;
    after?: number;
    limit?: number;
  }): Promise<AgentLogPage>;
}

export class LocalRunnerAdapter implements RunnerAdapter {
  private readonly command: LocalRunnerCommand;
  private readonly createConnection: () => DatabaseConnection;
  private readonly ownsConnections: boolean;
  private readonly spawnProcess: LocalRunnerSpawn;
  private readonly stopTimeoutMs: number;
  private readonly managedByProcessId = new Map<string, ManagedChildProcess>();

  constructor(dependencies: LocalRunnerAdapterDependencies = {}) {
    this.command = dependencies.command ?? resolveLocalRunnerCommand();
    this.createConnection = dependencies.createConnection ?? createDatabaseConnection;
    this.ownsConnections = !dependencies.createConnection;
    this.spawnProcess = dependencies.spawnProcess ?? spawnConfiguredChildProcess;
    this.stopTimeoutMs = dependencies.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  async start(agentId: string): Promise<LocalRunnerStartResult> {
    const connection = this.createConnection();
    let child: ChildProcessWithoutNullStreams | null = null;

    try {
      child = this.spawnProcess(this.command.executable, this.command.args, {
        ...(this.command.cwd === undefined ? {} : { cwd: this.command.cwd }),
        env: {
          ...process.env,
          ...this.command.env,
          AGENTBAY_AGENT_ID: agentId,
        },
        shell: false,
        stdio: "pipe",
      });

      if (!child.pid) {
        await terminateUntrackedChildProcess(child, this.stopTimeoutMs);
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "spawn_failed" };
      }

      const processRow = await createLocalRunnerProcessForDevelopmentUser({
        db: connection.db,
        agentId,
        pid: child.pid,
        commandMetadata: {
          command: this.command.executable,
          args: this.command.args,
          ...(this.command.cwd === undefined ? {} : { cwd: this.command.cwd }),
          envKeys: Object.keys(this.command.env ?? {}).sort(),
        },
        status: "running",
      });

      if (!processRow) {
        await terminateUntrackedChildProcess(child, this.stopTimeoutMs);
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "agent_not_found" };
      }

      const managed: ManagedChildProcess = {
        agentId,
        child,
        process: processRow,
        stdoutRemainder: "",
        stderrRemainder: "",
        stopRequested: false,
        logQueue: Promise.resolve(),
        terminalUpdate: null,
      };

      this.managedByProcessId.set(processRow.id, managed);
      attachProcessLogCapture(managed, connection);
      attachProcessCloseRecording(managed, connection, () => {
        this.managedByProcessId.delete(processRow.id);
        void this.closeOwnedConnection(connection);
      });

      return { ok: true, process: processRow };
    } catch {
      await terminateUntrackedChildProcess(child, this.stopTimeoutMs);
      await this.closeOwnedConnection(connection);
      return { ok: false, reason: "state_persistence_failed" };
    }
  }

  async stop(agentId: string): Promise<LocalRunnerStopResult> {
    const connection = this.createConnection();

    try {
      const latestProcess = await getLatestLocalRunnerProcessForDevelopmentUser({
        db: connection.db,
        agentId,
        statuses: RUNNING_PROCESS_STATUSES,
      });

      if (!latestProcess) {
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "no_process" };
      }

      const managed = this.managedByProcessId.get(latestProcess.id);

      if (!managed) {
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "process_not_managed" };
      }

      managed.stopRequested = true;

      if (!managed.child.killed) {
        managed.child.kill("SIGTERM");
      }

      const terminalProcess = await waitForManagedProcessStop(managed, this.stopTimeoutMs);

      if (!terminalProcess) {
        await this.closeOwnedConnection(connection);
        return { ok: false, reason: "state_persistence_failed" };
      }

      await this.closeOwnedConnection(connection);
      return { ok: true, process: terminalProcess };
    } catch {
      await this.closeOwnedConnection(connection);
      return { ok: false, reason: "state_persistence_failed" };
    }
  }

  async restart(agentId: string): Promise<LocalRunnerRestartResult> {
    const stopResult = await this.stop(agentId);

    if (!stopResult.ok && stopResult.reason !== "no_process") {
      return stopResult;
    }

    return this.start(agentId);
  }

  async status(agentId: string): Promise<LocalRunnerStatusResult> {
    const connection = this.createConnection();

    try {
      const processRow = await getLatestLocalRunnerProcessForDevelopmentUser({
        db: connection.db,
        agentId,
      });

      return { ok: true, process: processRow };
    } catch {
      return { ok: false, reason: "state_persistence_failed" };
    } finally {
      await this.closeOwnedConnection(connection);
    }
  }

  async streamLogs(input: {
    agentId: string;
    processId?: string;
    after?: number;
    limit?: number;
  }): Promise<AgentLogPage> {
    const connection = this.createConnection();

    try {
      if (input.processId) {
        const logs = await listLocalRunnerProcessLogs({
          db: connection.db,
          agentId: input.agentId,
          processId: input.processId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });

        return {
          logs,
          nextAfter: logs.at(-1)?.sequence ?? input.after ?? null,
        };
      }

      return listAgentLogs({
        db: connection.db,
        agentId: input.agentId,
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    } finally {
      await this.closeOwnedConnection(connection);
    }
  }

  private async closeOwnedConnection(connection: DatabaseConnection): Promise<void> {
    if (this.ownsConnections) {
      await connection.close();
    }
  }
}

export function resolveLocalRunnerCommand(
  input: Record<string, string | undefined> = process.env,
): LocalRunnerCommand {
  const configuredExecutable = input[CONFIGURED_RUNNER_EXECUTABLE_ENV]?.trim();

  if (!configuredExecutable) {
    return {
      executable: process.execPath,
      args: ["-e", DUMMY_RUNNER_SCRIPT],
    };
  }

  return {
    executable: configuredExecutable,
    args: parseConfiguredRunnerArgs(input[CONFIGURED_RUNNER_ARGS_ENV]),
  };
}

export function spawnConfiguredChildProcess(
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(executable, [...args], {
    ...options,
    shell: false,
  });
}

function parseConfiguredRunnerArgs(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  const parsed: unknown = JSON.parse(value);

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${CONFIGURED_RUNNER_ARGS_ENV} must be a JSON string array.`);
  }

  return parsed;
}

function attachProcessLogCapture(
  managed: ManagedChildProcess,
  connection: DatabaseConnection,
): void {
  managed.child.stdout.on("data", (chunk: Buffer) => {
    managed.stdoutRemainder = captureLogChunk({
      managed,
      connection,
      stream: "stdout",
      remainder: managed.stdoutRemainder,
      chunk,
    });
  });
  managed.child.stderr.on("data", (chunk: Buffer) => {
    managed.stderrRemainder = captureLogChunk({
      managed,
      connection,
      stream: "stderr",
      remainder: managed.stderrRemainder,
      chunk,
    });
  });
}

function attachProcessCloseRecording(
  managed: ManagedChildProcess,
  connection: DatabaseConnection,
  onRecorded: () => void,
): void {
  managed.child.once("close", (exitCode, signal) => {
    flushLogRemainder(managed, connection, "stdout");
    flushLogRemainder(managed, connection, "stderr");

    managed.terminalUpdate = managed.logQueue
      .then(() => {
        const exitInput = {
          db: connection.db,
          processId: managed.process.id,
          exitCode: managed.stopRequested ? null : exitCode,
          signal: managed.stopRequested ? null : signal,
          ...(managed.stopRequested ? { status: "stopped" as const } : {}),
          ...(!managed.stopRequested && exitCode !== 0
            ? {
                lastError: `Local runner exited with code ${exitCode ?? "unknown"}.`,
              }
            : {}),
        };

        return recordLocalRunnerProcessExit(exitInput);
      })
      .finally(onRecorded);
  });
}

function captureLogChunk(input: {
  managed: ManagedChildProcess;
  connection: DatabaseConnection;
  stream: LocalRunnerLogLineInput["stream"];
  remainder: string;
  chunk: Buffer;
}): string {
  const content = input.remainder + input.chunk.toString("utf8");
  const lines = content.split(/\r?\n/);
  const remainder = lines.pop() ?? "";

  enqueueLogLines(
    input.managed,
    input.connection,
    input.stream,
    lines.filter((line) => line.trim().length > 0),
  );

  return remainder;
}

function flushLogRemainder(
  managed: ManagedChildProcess,
  connection: DatabaseConnection,
  stream: LocalRunnerLogLineInput["stream"],
): void {
  const remainder = stream === "stdout" ? managed.stdoutRemainder : managed.stderrRemainder;

  if (stream === "stdout") {
    managed.stdoutRemainder = "";
  } else {
    managed.stderrRemainder = "";
  }

  if (remainder.trim().length > 0) {
    enqueueLogLines(managed, connection, stream, [remainder]);
  }
}

function enqueueLogLines(
  managed: ManagedChildProcess,
  connection: DatabaseConnection,
  stream: LocalRunnerLogLineInput["stream"],
  lines: readonly string[],
): void {
  if (lines.length === 0) {
    return;
  }

  managed.logQueue = managed.logQueue.then(async () => {
    await appendLocalRunnerLogLines({
      db: connection.db,
      processId: managed.process.id,
      lines: lines.map((message) => ({ stream, message })),
    });
  });
}

async function waitForManagedProcessStop(
  managed: ManagedChildProcess,
  stopTimeoutMs: number,
): Promise<LocalRunnerProcessDto | null> {
  const terminalUpdate = await Promise.race([
    waitForTerminalUpdate(managed),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), stopTimeoutMs);
    }),
  ]);

  if (terminalUpdate === "timeout") {
    managed.child.kill("SIGKILL");
    return waitForTerminalUpdate(managed);
  }

  return terminalUpdate;
}

async function terminateUntrackedChildProcess(
  child: ChildProcessWithoutNullStreams | null,
  stopTimeoutMs: number,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const closePromise = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  try {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  } catch {
    return;
  }

  const timedOut = await Promise.race([
    closePromise.then(() => false),
    new Promise<true>((resolve) => {
      setTimeout(() => resolve(true), stopTimeoutMs);
    }),
  ]);

  if (!timedOut || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }

  await Promise.race([
    closePromise,
    new Promise<void>((resolve) => {
      setTimeout(() => resolve(), stopTimeoutMs);
    }),
  ]);
}

function waitForTerminalUpdate(
  managed: ManagedChildProcess,
): Promise<LocalRunnerProcessDto | null> {
  if (managed.terminalUpdate) {
    return managed.terminalUpdate;
  }

  return new Promise((resolve) => {
    managed.child.once("close", () => {
      resolve(managed.terminalUpdate ?? null);
    });
  }).then(() => managed.terminalUpdate ?? null);
}
