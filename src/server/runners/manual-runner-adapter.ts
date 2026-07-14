import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { validateManualRunnerEndpointUrl } from "@/src/env/validation";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type { AgentLaunchSpec } from "@/src/server/agents/agent-launch-spec";
import { agentLogs, agents } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import {
  mapAgentLogToDto,
  type AgentLogDto,
  type AgentLogPage,
} from "@/src/server/logs/agent-logs";
import { DOCKER_CLI_TIMEOUT_MS } from "@/src/runner-service/constants";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";
import { fingerprintRunnerSecret } from "@/src/server/runners/runner-auth-secrets";
import type {
  RunnerAdapter as RunnerAdapterContract,
  RunnerLogStreamInput,
} from "@/src/server/runners/runner-adapter";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export const MANUAL_RUNNER_LOG_SOURCE = "manual_runner";
export const RUNNER_BEARER_TOKEN_ENV = "AGENTBAY_RUNNER_BEARER_TOKEN";
export const DEFAULT_MANUAL_RUNNER_TIMEOUT_MS = DOCKER_CLI_TIMEOUT_MS + 5_000;

type ManualRunnerAction = "start" | "stop" | "restart" | "status" | "logs";
type ManualRunnerFetch = typeof fetch;
type ManualRunnerStateDatabase = Pick<PostgresJsDatabase<typeof schema>, "transaction">;
type ManualRunnerStateTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type ManualRunnerLogLineInput = {
  stream: "stdout" | "stderr";
  message: string;
  level?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
};

export type ManualRunnerRemoteContainer = {
  id: string;
  name?: string;
  image?: string;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type ManualRunnerStartResult =
  | { ok: true; runner: ManualRunnerRecord; container: ManualRunnerRemoteContainer | null }
  | { ok: false; reason: ManualRunnerFailureReason };

export type ManualRunnerStopResult =
  | { ok: true; runner: ManualRunnerRecord; containers: ManualRunnerRemoteContainer[] }
  | { ok: false; reason: ManualRunnerFailureReason };

export type ManualRunnerRestartResult =
  | { ok: true; runner: ManualRunnerRecord; container: ManualRunnerRemoteContainer | null }
  | { ok: false; reason: ManualRunnerFailureReason };

export type ManualRunnerStatusResult =
  | { ok: true; runner: ManualRunnerRecord; containers: ManualRunnerRemoteContainer[] }
  | { ok: false; reason: ManualRunnerFailureReason };

export type ManualRunnerFailureReason =
  | "runner_token_not_configured"
  | "runner_endpoint_invalid"
  | "runner_request_failed"
  | "runner_response_invalid"
  | "runner_not_running"
  | "runner_readiness_failed";

export type ManualRunnerAdapterDependencies = {
  createConnection?: () => DatabaseConnection;
  env?: Record<string, string | undefined>;
  fetch?: ManualRunnerFetch;
  now?: () => Date;
  timeoutMs?: number;
};

export class ManualRunnerAdapter
  implements
    RunnerAdapterContract<
      ManualRunnerStartResult,
      ManualRunnerStopResult,
      ManualRunnerRestartResult,
      ManualRunnerStatusResult
    >
{
  private readonly createConnection: () => DatabaseConnection;
  private readonly env: Record<string, string | undefined>;
  private readonly fetch: ManualRunnerFetch;
  private readonly now: () => Date;
  private readonly ownsConnections: boolean;
  private readonly runner: ManualRunnerRecord;
  private readonly timeoutMs: number;

  constructor(runner: ManualRunnerRecord, dependencies: ManualRunnerAdapterDependencies = {}) {
    this.createConnection = dependencies.createConnection ?? createDatabaseConnection;
    this.env = dependencies.env ?? process.env;
    this.fetch = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.ownsConnections = !dependencies.createConnection;
    this.runner = runner;
    this.timeoutMs = normalizeTimeoutMs(dependencies.timeoutMs);
  }

  async start(
    agentId: string,
    launchSpec: AgentLaunchSpec | null = null,
  ): Promise<ManualRunnerStartResult> {
    const result = await this.callRunner("start", agentId, "POST", launchSpec);

    if (!result.ok) {
      return result;
    }

    const container = parseContainer(result.body.container);

    if (container?.status !== "running") {
      return { ok: false, reason: "runner_not_running" };
    }

    return { ok: true, runner: this.runner, container };
  }

  async stop(agentId: string): Promise<ManualRunnerStopResult> {
    const result = await this.callRunner("stop", agentId, "POST");

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      runner: this.runner,
      containers: parseContainers(result.body.containers),
    };
  }

  async restart(
    agentId: string,
    launchSpec: AgentLaunchSpec | null = null,
  ): Promise<ManualRunnerRestartResult> {
    const result = await this.callRunner("restart", agentId, "POST", launchSpec);

    if (!result.ok) {
      return result;
    }

    const container = parseContainer(result.body.container);

    if (container?.status !== "running") {
      return { ok: false, reason: "runner_not_running" };
    }

    return { ok: true, runner: this.runner, container };
  }

  async status(agentId: string): Promise<ManualRunnerStatusResult> {
    const result = await this.callRunner("status", agentId, "GET");

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      runner: this.runner,
      containers: parseContainers(result.body.containers),
    };
  }

  async streamLogs(input: RunnerLogStreamInput): Promise<AgentLogPage> {
    const connection = this.createConnection();

    try {
      const result = await this.callRunner("logs", input.agentId, "GET");

      if (result.ok) {
        const latestCursor = await getLatestManualRunnerLogCursorForUser({
          db: connection.db,
          userId: this.runner.userId,
          agentId: input.agentId,
          runnerId: this.runner.id,
        });
        const remoteLines = parseRemoteLogLines(result.body.logs).filter((line) =>
          shouldPersistRemoteLogLine(line, latestCursor),
        );

        await appendManualRunnerLogLinesForUser({
          db: connection.db,
          userId: this.runner.userId,
          agentId: input.agentId,
          runnerId: this.runner.id,
          lines: remoteLines,
          now: this.now(),
        });
      }

      const logs = await listManualRunnerLogsForUser({
        db: connection.db,
        userId: this.runner.userId,
        agentId: input.agentId,
        runnerId: this.runner.id,
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      const lastLog = logs.at(-1);

      return {
        logs,
        nextAfter: lastLog?.sequence ?? input.after ?? null,
      };
    } finally {
      if (this.ownsConnections) {
        await connection.close();
      }
    }
  }

  private async callRunner(
    action: ManualRunnerAction,
    agentId: string,
    method: "GET" | "POST",
    launchSpec: AgentLaunchSpec | null = null,
  ): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; reason: ManualRunnerFailureReason }
  > {
    let endpointUrl: string;

    try {
      endpointUrl = validateManualRunnerEndpointUrl(this.runner.endpointUrl);
    } catch {
      return { ok: false, reason: "runner_endpoint_invalid" };
    }

    const token = this.env[RUNNER_BEARER_TOKEN_ENV]?.trim();

    if (!token) {
      return { ok: false, reason: "runner_token_not_configured" };
    }

    const tokenFingerprint = fingerprintRunnerSecret(token);
    const requestUrl = new URL(
      `/runner/v1/agents/${encodeURIComponent(agentId)}/${action}`,
      normalizeBaseEndpoint(endpointUrl),
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const body = launchSpec ? JSON.stringify(launchSpec) : undefined;
      const response = await this.fetch(requestUrl, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseErrorCode = await readResponseErrorCode(response);
        logManualRunnerRequest("request_failed", {
          action,
          agentId,
          runnerId: this.runner.id,
          runnerKind: this.runner.kind,
          endpointHost: safeEndpointHost(endpointUrl),
          method,
          responseStatus: response.status,
          responseErrorCode,
          runnerBearerTokenFingerprint: tokenFingerprint,
          durationMs: Date.now() - startedAt,
        });
        return {
          ok: false,
          reason:
            responseErrorCode === "hermes_readiness_failed"
              ? "runner_readiness_failed"
              : "runner_request_failed",
        };
      }

      const parsed: unknown = await response.json();

      if (!isRecord(parsed) || parsed.ok !== true) {
        logManualRunnerRequest("response_invalid", {
          action,
          agentId,
          runnerId: this.runner.id,
          runnerKind: this.runner.kind,
          endpointHost: safeEndpointHost(endpointUrl),
          method,
          responseStatus: response.status,
          runnerBearerTokenFingerprint: tokenFingerprint,
          durationMs: Date.now() - startedAt,
        });
        return { ok: false, reason: "runner_response_invalid" };
      }

      return { ok: true, body: parsed };
    } catch (error) {
      logManualRunnerRequest("request_error", {
        action,
        agentId,
        runnerId: this.runner.id,
        runnerKind: this.runner.kind,
        endpointHost: safeEndpointHost(endpointUrl),
        method,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: safeErrorMessage(error),
        timedOut: controller.signal.aborted,
        runnerBearerTokenFingerprint: tokenFingerprint,
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, reason: "runner_request_failed" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function appendManualRunnerLogLines(input: {
  db: ManualRunnerStateDatabase;
  agentId: string;
  runnerId: string;
  lines: readonly ManualRunnerLogLineInput[];
  now?: Date;
}): Promise<{ inserted: number; logs: AgentLogDto[] }> {
  const userId = await getDevelopmentUserForDatabase(input.db);

  return userId
    ? appendManualRunnerLogLinesForUser({ ...input, userId })
    : { inserted: 0, logs: [] };
}

export async function appendManualRunnerLogLinesForUser(input: {
  db: ManualRunnerStateDatabase;
  userId: string;
  agentId: string;
  runnerId: string;
  lines: readonly ManualRunnerLogLineInput[];
  now?: Date;
}): Promise<{ inserted: number; logs: AgentLogDto[] }> {
  const validLines = input.lines.filter((line) => isValidManualLogLine(line));

  if (validLines.length === 0) {
    return { inserted: 0, logs: [] };
  }

  return input.db.transaction(async (tx) => {
    const [activeAgent] = await tx
      .select({ id: agents.id, runnerId: agents.runnerId })
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.userId, input.userId),
          eq(agents.runnerId, input.runnerId),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);

    if (!activeAgent?.runnerId) {
      return { inserted: 0, logs: [] };
    }

    await lockAgentLogSequenceInTransaction(tx, input.agentId);

    const [latestAgentLog] = await tx
      .select({ sequence: agentLogs.sequence })
      .from(agentLogs)
      .where(eq(agentLogs.agentId, input.agentId))
      .orderBy(desc(agentLogs.sequence))
      .limit(1);
    const firstSequence = (latestAgentLog?.sequence ?? 0) + 1;
    const now = input.now ?? new Date();
    const insertedRows = await tx
      .insert(agentLogs)
      .values(
        validLines.map((line, index) => ({
          agentId: input.agentId,
          runnerId: input.runnerId,
          localRunnerProcessId: null,
          dockerRunnerContainerId: null,
          source: MANUAL_RUNNER_LOG_SOURCE,
          stream: line.stream,
          level: line.level ?? defaultLevelForStream(line.stream),
          message: line.message.trim(),
          metadata: normalizeManualRunnerMetadata(line.metadata ?? {}),
          sequence: firstSequence + index,
          createdAt: line.createdAt ?? now,
        })),
      )
      .returning(logSelection);

    return {
      inserted: insertedRows.length,
      logs: insertedRows.map((row) => mapAgentLogToDto(row)),
    };
  });
}

export function getLatestManualRunnerLogCursorForUser(input: {
  db: ManualRunnerStateDatabase;
  userId: string;
  agentId: string;
  runnerId: string;
}): Promise<{ sequence: number; createdAt: Date } | null> {
  return input.db.transaction(async (tx) => {
    const [latestLog] = await tx
      .select({ sequence: agentLogs.sequence, createdAt: agentLogs.createdAt })
      .from(agentLogs)
      .innerJoin(agents, eq(agents.id, agentLogs.agentId))
      .where(
        and(
          eq(agentLogs.agentId, input.agentId),
          eq(agentLogs.runnerId, input.runnerId),
          eq(agentLogs.source, MANUAL_RUNNER_LOG_SOURCE),
          eq(agents.userId, input.userId),
          eq(agents.runnerId, input.runnerId),
          isNull(agents.deletedAt),
        ),
      )
      .orderBy(desc(agentLogs.createdAt), desc(agentLogs.sequence))
      .limit(1);

    return latestLog ?? null;
  });
}

export function listManualRunnerLogsForUser(input: {
  db: ManualRunnerStateDatabase;
  userId: string;
  agentId: string;
  runnerId: string;
  after?: number | null;
  limit?: number;
}): Promise<AgentLogDto[]> {
  const limit =
    typeof input.limit === "number" && Number.isInteger(input.limit)
      ? Math.min(Math.max(input.limit, 1), 100)
      : 100;

  return input.db.transaction(async (tx) => {
    const predicates = [
      eq(agentLogs.agentId, input.agentId),
      eq(agentLogs.runnerId, input.runnerId),
      eq(agentLogs.source, MANUAL_RUNNER_LOG_SOURCE),
      eq(agents.id, input.agentId),
      eq(agents.userId, input.userId),
      eq(agents.runnerId, input.runnerId),
      isNull(agents.deletedAt),
    ];

    if (input.after !== null && input.after !== undefined) {
      predicates.push(gt(agentLogs.sequence, input.after));
    }

    const rows = await tx
      .select(logSelection)
      .from(agentLogs)
      .innerJoin(agents, eq(agents.id, agentLogs.agentId))
      .where(and(...predicates))
      .orderBy(asc(agentLogs.sequence))
      .limit(limit);

    return rows.map((row) => mapAgentLogToDto(row));
  });
}

function getDevelopmentUserForDatabase(db: ManualRunnerStateDatabase): Promise<string | null> {
  return db.transaction((tx) => getDevelopmentUserId(tx));
}

const logSelection = {
  id: agentLogs.id,
  agentId: agentLogs.agentId,
  runnerId: agentLogs.runnerId,
  localRunnerProcessId: agentLogs.localRunnerProcessId,
  dockerRunnerContainerId: agentLogs.dockerRunnerContainerId,
  source: agentLogs.source,
  stream: agentLogs.stream,
  level: agentLogs.level,
  message: agentLogs.message,
  metadata: agentLogs.metadata,
  sequence: agentLogs.sequence,
  createdAt: agentLogs.createdAt,
};

function parseRemoteLogLines(value: unknown): ManualRunnerLogLineInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsedLines: ManualRunnerLogLineInput[] = [];

  for (const line of value) {
    if (!isRecord(line)) {
      continue;
    }

    const stream = line.stream === "stderr" ? "stderr" : line.stream === "stdout" ? "stdout" : null;
    const message = typeof line.message === "string" ? line.message.trim() : "";

    if (!stream || !message) {
      continue;
    }

    const createdAt = parseOptionalDate(line.createdAt);
    parsedLines.push({
      stream,
      message,
      ...(createdAt ? { createdAt } : {}),
    });
  }

  return parsedLines;
}

function shouldPersistRemoteLogLine(
  line: ManualRunnerLogLineInput,
  latestCursor: { sequence: number; createdAt: Date } | null,
): boolean {
  if (!latestCursor || !line.createdAt) {
    return true;
  }

  return line.createdAt.getTime() > latestCursor.createdAt.getTime();
}

function parseContainer(value: unknown): ManualRunnerRemoteContainer | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim() : "";

  if (!id || !status) {
    return null;
  }

  return {
    id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.image === "string" ? { image: value.image } : {}),
    status,
    ...(typeof value.startedAt === "string" || value.startedAt === null
      ? { startedAt: value.startedAt }
      : {}),
    ...(typeof value.finishedAt === "string" || value.finishedAt === null
      ? { finishedAt: value.finishedAt }
      : {}),
  };
}

function parseContainers(value: unknown): ManualRunnerRemoteContainer[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(parseContainer).filter((container): container is ManualRunnerRemoteContainer => {
    return container !== null;
  });
}

function normalizeBaseEndpoint(endpointUrl: string): string {
  return endpointUrl.endsWith("/") ? endpointUrl : `${endpointUrl}/`;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs)) {
    return DEFAULT_MANUAL_RUNNER_TIMEOUT_MS;
  }

  return Math.min(Math.max(timeoutMs, 100), 60_000);
}

async function readResponseErrorCode(response: Response): Promise<string | null> {
  try {
    const parsed: unknown = await response.clone().json();

    if (!isRecord(parsed) || !isRecord(parsed.error) || typeof parsed.error.code !== "string") {
      return null;
    }

    return parsed.error.code.slice(0, 80);
  } catch {
    return null;
  }
}

function safeEndpointHost(endpointUrl: string): string | null {
  try {
    return new URL(endpointUrl).host || null;
  } catch {
    return null;
  }
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown runner request error.";
  }

  return error.message.replace(/\s+/g, " ").trim().slice(0, 200);
}

function logManualRunnerRequest(event: string, metadata: Record<string, unknown>): void {
  console.info("[agentbay] manual_runner.request", { event, ...metadata });
}

function isValidManualLogLine(line: ManualRunnerLogLineInput): boolean {
  return (line.stream === "stdout" || line.stream === "stderr") && line.message.trim().length > 0;
}

function defaultLevelForStream(stream: ManualRunnerLogLineInput["stream"]): string {
  return stream === "stderr" ? "error" : "info";
}

function normalizeManualRunnerMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata)
      .slice(0, 20)
      .map(([key, value]) => [key, normalizeManualRunnerMetadataValue(value)]),
  );
}

function normalizeManualRunnerMetadataValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim().slice(0, 500);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(normalizeManualRunnerMetadataValue);
  }

  if (isRecord(value)) {
    return normalizeManualRunnerMetadata(value);
  }

  return String(value).slice(0, 500);
}

function parseOptionalDate(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

function lockAgentLogSequenceInTransaction(
  tx: ManualRunnerStateTransaction,
  agentId: string,
): Promise<{ id: string }[]> {
  return tx.execute<{ id: string }>(sql`
    select ${agents.id} as id
    from ${agents}
    where ${agents.id} = ${agentId}
    for update
  `);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
