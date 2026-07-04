import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { agentLogs, agents, localRunnerProcesses } from "@/src/server/db/schema";
import {
  mapAgentLogToDto,
  type AgentLogDto,
  type AgentLogQueryExecutor,
} from "@/src/server/logs/agent-logs";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export const LOCAL_RUNNER_LAST_ERROR_FALLBACK =
  "Local runner error. Check captured process logs for details.";
export const LOCAL_RUNNER_COMMAND_METADATA_REDACTION = "[redacted]";

const MAX_SAFE_LAST_ERROR_LENGTH = 500;
const UNSAFE_ERROR_PATTERN =
  /(postgres(?:ql)?:\/\/\S+|[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE[_-]?KEY|BEARER|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*\S+)/i;
const SECRET_OPTION_PATTERN =
  /^--?(?:api[-_]?key|token|password|secret|credential|private[-_]?key|bearer|authorization)$/i;
const SECRET_OPTION_ASSIGNMENT_PATTERN =
  /(^|[\s"'`])(--?(?:api[-_]?key|token|password|secret|credential|private[-_]?key|bearer|authorization)=)([^\s"'`]+)/gi;
const SECRET_ENV_ASSIGNMENT_PATTERN =
  /(^|[\s"'`])([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE[_-]?KEY|BEARER|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*)([^\s"'`]+)/gi;
const DATABASE_DSN_PATTERN = /\b(?:postgres(?:ql)?):\/\/[^\s"'`]+/gi;

type LocalRunnerStateDatabase = Pick<PostgresJsDatabase<typeof schema>, "transaction">;
type LocalRunnerStateTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type LocalRunnerProcessStatus = "starting" | "running" | "stopped" | "exited" | "failed";

export type LocalRunnerCommandMetadata = {
  command: string;
  args?: string[];
  cwd?: string;
  envKeys?: string[];
};

export type LocalRunnerProcessDto = {
  id: string;
  agentId: string;
  pid: number;
  commandMetadata: Record<string, unknown>;
  status: LocalRunnerProcessStatus;
  startedAt: string;
  stoppedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalRunnerLogLineInput = {
  stream: "stdout" | "stderr";
  message: string;
  level?: string;
  createdAt?: Date;
};

type LocalRunnerProcessRow = typeof localRunnerProcesses.$inferSelect;

const localRunnerProcessSelection = {
  id: localRunnerProcesses.id,
  agentId: localRunnerProcesses.agentId,
  pid: localRunnerProcesses.pid,
  commandMetadata: localRunnerProcesses.commandMetadata,
  status: localRunnerProcesses.status,
  startedAt: localRunnerProcesses.startedAt,
  stoppedAt: localRunnerProcesses.stoppedAt,
  exitCode: localRunnerProcesses.exitCode,
  signal: localRunnerProcesses.signal,
  lastError: localRunnerProcesses.lastError,
  createdAt: localRunnerProcesses.createdAt,
  updatedAt: localRunnerProcesses.updatedAt,
};

const processLogSelection = {
  id: agentLogs.id,
  agentId: agentLogs.agentId,
  runnerId: agentLogs.runnerId,
  localRunnerProcessId: agentLogs.localRunnerProcessId,
  stream: agentLogs.stream,
  level: agentLogs.level,
  message: agentLogs.message,
  sequence: agentLogs.sequence,
  createdAt: agentLogs.createdAt,
};

export async function createLocalRunnerProcessForDevelopmentUser(input: {
  db: LocalRunnerStateDatabase;
  agentId: string;
  pid: number;
  commandMetadata: LocalRunnerCommandMetadata;
  status?: Extract<LocalRunnerProcessStatus, "starting" | "running">;
  startedAt?: Date;
}): Promise<LocalRunnerProcessDto | null> {
  return input.db.transaction(async (tx) => {
    const developmentUserId = await getDevelopmentUserId(tx);

    if (!developmentUserId) {
      return null;
    }

    const [activeAgent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.userId, developmentUserId),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);

    if (!activeAgent) {
      return null;
    }

    const now = input.startedAt ?? new Date();
    const [processRow] = await tx
      .insert(localRunnerProcesses)
      .values({
        agentId: activeAgent.id,
        pid: input.pid,
        commandMetadata: normalizeCommandMetadata(input.commandMetadata),
        status: input.status ?? "running",
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning(localRunnerProcessSelection);

    if (!processRow) {
      throw new Error("Local runner process insert returned no rows.");
    }

    return mapLocalRunnerProcessToDto(processRow);
  });
}

export async function getLatestLocalRunnerProcessForDevelopmentUser(input: {
  db: LocalRunnerStateDatabase;
  agentId: string;
  statuses?: readonly LocalRunnerProcessStatus[];
}): Promise<LocalRunnerProcessDto | null> {
  return input.db.transaction(async (tx) => {
    const developmentUserId = await getDevelopmentUserId(tx);

    if (!developmentUserId) {
      return null;
    }

    const predicates = [
      eq(localRunnerProcesses.agentId, input.agentId),
      eq(agents.id, input.agentId),
      eq(agents.userId, developmentUserId),
      isNull(agents.deletedAt),
    ];

    if (input.statuses && input.statuses.length > 0) {
      predicates.push(inArray(localRunnerProcesses.status, [...input.statuses]));
    }

    const [processRow] = await tx
      .select(localRunnerProcessSelection)
      .from(localRunnerProcesses)
      .innerJoin(agents, eq(agents.id, localRunnerProcesses.agentId))
      .where(and(...predicates))
      .orderBy(desc(localRunnerProcesses.startedAt), desc(localRunnerProcesses.createdAt))
      .limit(1);

    return processRow ? mapLocalRunnerProcessToDto(processRow) : null;
  });
}

export async function recordLocalRunnerProcessExit(input: {
  db: LocalRunnerStateDatabase;
  processId: string;
  status?: Extract<LocalRunnerProcessStatus, "stopped" | "exited" | "failed">;
  stoppedAt?: Date;
  exitCode?: number | null;
  signal?: string | null;
  lastError?: unknown;
}): Promise<LocalRunnerProcessDto | null> {
  return input.db.transaction(async (tx) => {
    const stoppedAt = input.stoppedAt ?? new Date();
    const signal = normalizeOptionalText(input.signal);
    const lastError = sanitizeLocalRunnerLastError(input.lastError);
    const updateValues: Partial<typeof localRunnerProcesses.$inferInsert> = {
      status: normalizeTerminalStatus({
        ...(input.status === undefined ? {} : { requestedStatus: input.status }),
        exitCode: input.exitCode,
        signal,
        lastError,
      }),
      stoppedAt,
      exitCode: input.exitCode ?? null,
      signal,
      lastError,
      updatedAt: stoppedAt,
    };

    const [processRow] = await tx
      .update(localRunnerProcesses)
      .set(updateValues)
      .where(eq(localRunnerProcesses.id, input.processId))
      .returning(localRunnerProcessSelection);

    return processRow ? mapLocalRunnerProcessToDto(processRow) : null;
  });
}

export async function appendLocalRunnerLogLines(input: {
  db: LocalRunnerStateDatabase;
  processId: string;
  lines: readonly LocalRunnerLogLineInput[];
  now?: Date;
}): Promise<{ inserted: number; logs: AgentLogDto[] }> {
  if (input.lines.length === 0) {
    return { inserted: 0, logs: [] };
  }

  for (const line of input.lines) {
    assertValidLogLine(line);
  }

  return input.db.transaction(async (tx) => {
    const [processRow] = await lockLocalRunnerProcessInTransaction(tx, input.processId);

    if (!processRow) {
      return { inserted: 0, logs: [] };
    }

    await lockAgentLogSequenceInTransaction(tx, processRow.agent_id);

    const [latestAgentLog] = await tx
      .select({ sequence: agentLogs.sequence })
      .from(agentLogs)
      .where(eq(agentLogs.agentId, processRow.agent_id))
      .orderBy(desc(agentLogs.sequence))
      .limit(1);

    const firstSequence = (latestAgentLog?.sequence ?? 0) + 1;
    const now = input.now ?? new Date();
    const insertedRows = await tx
      .insert(agentLogs)
      .values(
        input.lines.map((line, index) => ({
          agentId: processRow.agent_id,
          runnerId: processRow.id,
          localRunnerProcessId: processRow.id,
          stream: line.stream,
          level: line.level ?? defaultLevelForStream(line.stream),
          message: line.message,
          sequence: firstSequence + index,
          createdAt: line.createdAt ?? now,
        })),
      )
      .returning(processLogSelection);

    return {
      inserted: insertedRows.length,
      logs: insertedRows.map((row) => mapAgentLogToDto(row)),
    };
  });
}

export async function listLocalRunnerProcessLogs(input: {
  db: AgentLogQueryExecutor;
  processId: string;
  limit?: number;
}): Promise<AgentLogDto[]> {
  const limit =
    typeof input.limit === "number" && Number.isInteger(input.limit)
      ? Math.min(Math.max(input.limit, 1), 100)
      : 100;
  const rows = await input.db
    .select(processLogSelection)
    .from(agentLogs)
    .where(eq(agentLogs.localRunnerProcessId, input.processId))
    .orderBy(asc(agentLogs.sequence))
    .limit(limit);

  return rows.map((row) => mapAgentLogToDto(row));
}

export function mapLocalRunnerProcessToDto(
  processRow: LocalRunnerProcessRow,
): LocalRunnerProcessDto {
  return {
    id: processRow.id,
    agentId: processRow.agentId,
    pid: processRow.pid,
    commandMetadata: processRow.commandMetadata,
    status: processRow.status,
    startedAt: processRow.startedAt.toISOString(),
    stoppedAt: processRow.stoppedAt?.toISOString() ?? null,
    exitCode: processRow.exitCode,
    signal: processRow.signal,
    lastError: processRow.lastError,
    createdAt: processRow.createdAt.toISOString(),
    updatedAt: processRow.updatedAt.toISOString(),
  };
}

export function sanitizeLocalRunnerLastError(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }

  if (UNSAFE_ERROR_PATTERN.test(normalized)) {
    return LOCAL_RUNNER_LAST_ERROR_FALLBACK;
  }

  return normalized.slice(0, MAX_SAFE_LAST_ERROR_LENGTH);
}

export function normalizeCommandMetadata(
  metadata: LocalRunnerCommandMetadata,
): Record<string, unknown> {
  return {
    command: sanitizeCommandMetadataValue(metadata.command),
    ...(metadata.args === undefined ? {} : { args: sanitizeCommandMetadataArgs(metadata.args) }),
    ...(metadata.cwd === undefined ? {} : { cwd: sanitizeCommandMetadataValue(metadata.cwd) }),
    ...(metadata.envKeys === undefined ? {} : { envKeys: metadata.envKeys }),
  };
}

function normalizeTerminalStatus(input: {
  requestedStatus?: Extract<LocalRunnerProcessStatus, "stopped" | "exited" | "failed">;
  exitCode: number | null | undefined;
  signal?: string | null;
  lastError?: string | null;
}): Extract<LocalRunnerProcessStatus, "stopped" | "exited" | "failed"> {
  const inferredStatus = inferStoppedStatus(input);

  return input.requestedStatus === inferredStatus ? input.requestedStatus : inferredStatus;
}

function inferStoppedStatus(input: {
  exitCode: number | null | undefined;
  signal?: string | null;
  lastError?: string | null;
}): Extract<LocalRunnerProcessStatus, "stopped" | "exited" | "failed"> {
  if (input.lastError || input.signal) {
    return "failed";
  }

  if (input.exitCode !== null && input.exitCode !== undefined) {
    return input.exitCode === 0 ? "exited" : "failed";
  }

  return "stopped";
}

function sanitizeCommandMetadataArgs(args: readonly string[]): string[] {
  const sanitizedArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    sanitizedArgs.push(sanitizeCommandMetadataValue(arg));

    if (SECRET_OPTION_PATTERN.test(arg) && index + 1 < args.length) {
      index += 1;
      sanitizedArgs.push(LOCAL_RUNNER_COMMAND_METADATA_REDACTION);
    }
  }

  return sanitizedArgs;
}

function sanitizeCommandMetadataValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return normalized;
  }

  return normalized
    .replace(DATABASE_DSN_PATTERN, LOCAL_RUNNER_COMMAND_METADATA_REDACTION)
    .replace(
      SECRET_ENV_ASSIGNMENT_PATTERN,
      (_match, prefix: string, keyPrefix: string) =>
        `${prefix}${keyPrefix}${LOCAL_RUNNER_COMMAND_METADATA_REDACTION}`,
    )
    .replace(
      SECRET_OPTION_ASSIGNMENT_PATTERN,
      (_match, prefix: string, optionPrefix: string) =>
        `${prefix}${optionPrefix}${LOCAL_RUNNER_COMMAND_METADATA_REDACTION}`,
    );
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();

  return normalized ? normalized : null;
}

function defaultLevelForStream(stream: LocalRunnerLogLineInput["stream"]): string {
  return stream === "stderr" ? "error" : "info";
}

function assertValidLogLine(line: LocalRunnerLogLineInput): void {
  if (line.stream !== "stdout" && line.stream !== "stderr") {
    throw new Error("Local runner log stream must be stdout or stderr.");
  }

  if (line.message.trim().length === 0) {
    throw new Error("Local runner log message must not be empty.");
  }
}

function lockLocalRunnerProcessInTransaction(
  tx: LocalRunnerStateTransaction,
  processId: string,
): Promise<{ id: string; agent_id: string }[]> {
  return tx.execute<{ id: string; agent_id: string }>(sql`
    select ${localRunnerProcesses.id} as id,
           ${localRunnerProcesses.agentId} as agent_id
    from ${localRunnerProcesses}
    where ${localRunnerProcesses.id} = ${processId}
    for update
  `);
}

function lockAgentLogSequenceInTransaction(
  tx: LocalRunnerStateTransaction,
  agentId: string,
): Promise<{ id: string }[]> {
  return tx.execute<{ id: string }>(sql`
    select ${agents.id} as id
    from ${agents}
    where ${agents.id} = ${agentId}
    for update
  `);
}
