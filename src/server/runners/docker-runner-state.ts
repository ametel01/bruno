import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { agentLogs, agents, dockerRunnerContainers } from "@/src/server/db/schema";
import { mapAgentLogToDto, type AgentLogDto } from "@/src/server/logs/agent-logs";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export const DOCKER_RUNNER_LOG_SOURCE = "docker";
export const DOCKER_RUNNER_METADATA_REDACTION = "[redacted]";

const MAX_DOCKER_TEXT_LENGTH = 500;
const MAX_DOCKER_METADATA_DEPTH = 4;
const MAX_DOCKER_METADATA_ARRAY_LENGTH = 20;
const MAX_DOCKER_METADATA_KEYS = 40;
const SECRET_ENV_ASSIGNMENT_PATTERN =
  /(^|[\s"'`])([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE[_-]?KEY|BEARER|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*)([^\s"'`]+)/gi;
const SECRET_OPTION_ASSIGNMENT_PATTERN =
  /(^|[\s"'`])(--?(?:api[-_]?key|token|password|secret|credential|private[-_]?key|bearer|authorization)=)([^\s"'`]+)/gi;
const DATABASE_DSN_PATTERN = /\b(?:postgres(?:ql)?):\/\/[^\s"'`]+/gi;

type DockerRunnerStateDatabase = Pick<PostgresJsDatabase<typeof schema>, "transaction">;
type DockerRunnerStateTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];
type DockerRunnerContainerRow = typeof dockerRunnerContainers.$inferSelect;

export type DockerRunnerContainerDto = {
  id: string;
  agentId: string;
  containerId: string;
  containerName: string;
  image: string;
  observedStatus: string;
  metadata: Record<string, unknown>;
  observedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DockerRunnerLogLineInput = {
  stream: "stdout" | "stderr";
  message: string;
  level?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
};

const dockerContainerSelection = {
  id: dockerRunnerContainers.id,
  agentId: dockerRunnerContainers.agentId,
  containerId: dockerRunnerContainers.containerId,
  containerName: dockerRunnerContainers.containerName,
  image: dockerRunnerContainers.image,
  observedStatus: dockerRunnerContainers.observedStatus,
  metadata: dockerRunnerContainers.metadata,
  observedAt: dockerRunnerContainers.observedAt,
  startedAt: dockerRunnerContainers.startedAt,
  finishedAt: dockerRunnerContainers.finishedAt,
  createdAt: dockerRunnerContainers.createdAt,
  updatedAt: dockerRunnerContainers.updatedAt,
};

const dockerLogSelection = {
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

export async function recordDockerRunnerContainerForDevelopmentUser(input: {
  db: DockerRunnerStateDatabase;
  agentId: string;
  containerId: string;
  containerName: string;
  image: string;
  observedStatus: string;
  metadata?: Record<string, unknown>;
  observedAt?: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}): Promise<DockerRunnerContainerDto | null> {
  const userId = await getDevelopmentUserForDatabase(input.db);

  return userId ? recordDockerRunnerContainerForUser({ ...input, userId }) : null;
}

export async function recordDockerRunnerContainerForUser(input: {
  db: DockerRunnerStateDatabase;
  userId: string;
  agentId: string;
  containerId: string;
  containerName: string;
  image: string;
  observedStatus: string;
  metadata?: Record<string, unknown>;
  observedAt?: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}): Promise<DockerRunnerContainerDto | null> {
  return input.db.transaction(async (tx) => {
    const [activeAgent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.userId, input.userId),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);

    if (!activeAgent) {
      return null;
    }

    const observedAt = input.observedAt ?? new Date();
    const values = {
      agentId: activeAgent.id,
      containerId: normalizeRequiredDockerText(input.containerId, "Docker container ID"),
      containerName: normalizeRequiredDockerText(input.containerName, "Docker container name"),
      image: normalizeRequiredDockerText(input.image, "Docker image"),
      observedStatus: normalizeRequiredDockerText(input.observedStatus, "Docker observed status"),
      metadata: normalizeDockerMetadata(input.metadata ?? {}),
      observedAt,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      updatedAt: observedAt,
    };
    const [existingContainer] = await tx
      .select(dockerContainerSelection)
      .from(dockerRunnerContainers)
      .where(eq(dockerRunnerContainers.containerId, values.containerId))
      .limit(1);

    if (existingContainer && existingContainer.agentId !== activeAgent.id) {
      return null;
    }

    if (existingContainer) {
      const [updatedContainer] = await tx
        .update(dockerRunnerContainers)
        .set(values)
        .where(eq(dockerRunnerContainers.id, existingContainer.id))
        .returning(dockerContainerSelection);

      if (!updatedContainer) {
        throw new Error("Docker runtime metadata update returned no rows.");
      }

      return mapDockerRunnerContainerToDto(updatedContainer);
    }

    const [insertedContainer] = await tx
      .insert(dockerRunnerContainers)
      .values({
        ...values,
        createdAt: observedAt,
      })
      .returning(dockerContainerSelection);

    if (!insertedContainer) {
      throw new Error("Docker runtime metadata insert returned no rows.");
    }

    return mapDockerRunnerContainerToDto(insertedContainer);
  });
}

export async function appendDockerRunnerLogLines(input: {
  db: DockerRunnerStateDatabase;
  containerId: string;
  lines: readonly DockerRunnerLogLineInput[];
  now?: Date;
}): Promise<{ inserted: number; logs: AgentLogDto[] }> {
  const userId = await getDevelopmentUserForDatabase(input.db);

  return userId
    ? appendDockerRunnerLogLinesForUser({ ...input, userId })
    : { inserted: 0, logs: [] };
}

export async function appendDockerRunnerLogLinesForUser(input: {
  db: DockerRunnerStateDatabase;
  userId: string;
  containerId: string;
  lines: readonly DockerRunnerLogLineInput[];
  now?: Date;
}): Promise<{ inserted: number; logs: AgentLogDto[] }> {
  if (input.lines.length === 0) {
    return { inserted: 0, logs: [] };
  }

  for (const line of input.lines) {
    assertValidDockerLogLine(line);
  }

  return input.db.transaction(async (tx) => {
    const [containerRow] = await lockActiveDockerContainerInTransaction(
      tx,
      input.containerId,
      input.userId,
    );

    if (!containerRow) {
      return { inserted: 0, logs: [] };
    }

    await lockAgentLogSequenceInTransaction(tx, containerRow.agent_id);

    const [latestAgentLog] = await tx
      .select({ sequence: agentLogs.sequence })
      .from(agentLogs)
      .where(eq(agentLogs.agentId, containerRow.agent_id))
      .orderBy(desc(agentLogs.sequence))
      .limit(1);

    const firstSequence = (latestAgentLog?.sequence ?? 0) + 1;
    const now = input.now ?? new Date();
    const insertedRows = await tx
      .insert(agentLogs)
      .values(
        input.lines.map((line, index) => ({
          agentId: containerRow.agent_id,
          runnerId: null,
          localRunnerProcessId: null,
          dockerRunnerContainerId: containerRow.id,
          source: DOCKER_RUNNER_LOG_SOURCE,
          stream: line.stream,
          level: line.level ?? defaultLevelForStream(line.stream),
          message: line.message,
          metadata: normalizeDockerMetadata(line.metadata ?? {}),
          sequence: firstSequence + index,
          createdAt: line.createdAt ?? now,
        })),
      )
      .returning(dockerLogSelection);

    return {
      inserted: insertedRows.length,
      logs: insertedRows.map((row) => mapAgentLogToDto(row)),
    };
  });
}

export async function getDockerRunnerContainerForDevelopmentUser(input: {
  db: DockerRunnerStateDatabase;
  agentId: string;
  containerId?: string;
}): Promise<DockerRunnerContainerDto | null> {
  const userId = await getDevelopmentUserForDatabase(input.db);

  return userId ? getDockerRunnerContainerForUser({ ...input, userId }) : null;
}

export async function getDockerRunnerContainerForUser(input: {
  db: DockerRunnerStateDatabase;
  userId: string;
  agentId: string;
  containerId?: string;
}): Promise<DockerRunnerContainerDto | null> {
  return input.db.transaction(async (tx) => {
    const predicates = [
      eq(dockerRunnerContainers.agentId, input.agentId),
      eq(agents.id, input.agentId),
      eq(agents.userId, input.userId),
      isNull(agents.deletedAt),
    ];

    if (input.containerId) {
      predicates.push(eq(dockerRunnerContainers.containerId, input.containerId));
    }

    const targetOrder =
      input.containerId === undefined
        ? [
            desc(
              sql<number>`case when ${dockerRunnerContainers.observedStatus} = 'running' then 1 else 0 end`,
            ),
            desc(dockerRunnerContainers.observedAt),
            desc(dockerRunnerContainers.createdAt),
          ]
        : [desc(dockerRunnerContainers.observedAt), desc(dockerRunnerContainers.createdAt)];

    const [containerRow] = await tx
      .select(dockerContainerSelection)
      .from(dockerRunnerContainers)
      .innerJoin(agents, eq(agents.id, dockerRunnerContainers.agentId))
      .where(and(...predicates))
      .orderBy(...targetOrder)
      .limit(1);

    return containerRow ? mapDockerRunnerContainerToDto(containerRow) : null;
  });
}

export async function getLatestDockerRunnerLogCursor(input: {
  db: DockerRunnerStateDatabase;
  agentId: string;
  containerId: string;
}): Promise<{ sequence: number; createdAt: Date } | null> {
  const userId = await getDevelopmentUserForDatabase(input.db);

  return userId ? getLatestDockerRunnerLogCursorForUser({ ...input, userId }) : null;
}

export async function getLatestDockerRunnerLogCursorForUser(input: {
  db: DockerRunnerStateDatabase;
  userId: string;
  agentId: string;
  containerId: string;
}): Promise<{ sequence: number; createdAt: Date } | null> {
  const [latestLog] = await input.db.transaction(async (tx) => {
    return tx
      .select({
        sequence: agentLogs.sequence,
        createdAt: agentLogs.createdAt,
      })
      .from(agentLogs)
      .innerJoin(
        dockerRunnerContainers,
        eq(dockerRunnerContainers.id, agentLogs.dockerRunnerContainerId),
      )
      .innerJoin(agents, eq(agents.id, dockerRunnerContainers.agentId))
      .where(
        and(
          eq(agentLogs.agentId, input.agentId),
          eq(dockerRunnerContainers.agentId, input.agentId),
          eq(dockerRunnerContainers.containerId, input.containerId),
          eq(agents.id, input.agentId),
          eq(agents.userId, input.userId),
          isNull(agents.deletedAt),
        ),
      )
      .orderBy(desc(agentLogs.createdAt), desc(agentLogs.sequence))
      .limit(1);
  });

  return latestLog ?? null;
}

export async function listDockerRunnerContainerLogs(input: {
  db: DockerRunnerStateDatabase;
  agentId: string;
  containerId: string;
  after?: number | null;
  limit?: number;
}): Promise<AgentLogDto[]> {
  const userId = await getDevelopmentUserForDatabase(input.db);

  return userId ? listDockerRunnerContainerLogsForUser({ ...input, userId }) : [];
}

export async function listDockerRunnerContainerLogsForUser(input: {
  db: DockerRunnerStateDatabase;
  userId: string;
  agentId: string;
  containerId: string;
  after?: number | null;
  limit?: number;
}): Promise<AgentLogDto[]> {
  const limit =
    typeof input.limit === "number" && Number.isInteger(input.limit)
      ? Math.min(Math.max(input.limit, 1), 100)
      : 100;
  const rows = await input.db.transaction(async (tx) => {
    const predicates = [
      eq(agentLogs.agentId, input.agentId),
      eq(dockerRunnerContainers.agentId, input.agentId),
      eq(dockerRunnerContainers.containerId, input.containerId),
      eq(agents.id, input.agentId),
      eq(agents.userId, input.userId),
      isNull(agents.deletedAt),
    ];

    if (input.after !== null && input.after !== undefined) {
      predicates.push(gt(agentLogs.sequence, input.after));
    }

    return tx
      .select(dockerLogSelection)
      .from(agentLogs)
      .innerJoin(
        dockerRunnerContainers,
        eq(dockerRunnerContainers.id, agentLogs.dockerRunnerContainerId),
      )
      .innerJoin(agents, eq(agents.id, dockerRunnerContainers.agentId))
      .where(and(...predicates))
      .orderBy(asc(agentLogs.sequence))
      .limit(limit);
  });

  return rows.map((row) => mapAgentLogToDto(row));
}

function getDevelopmentUserForDatabase(db: DockerRunnerStateDatabase): Promise<string | null> {
  return db.transaction((tx) => getDevelopmentUserId(tx));
}

export function mapDockerRunnerContainerToDto(
  row: DockerRunnerContainerRow,
): DockerRunnerContainerDto {
  return {
    id: row.id,
    agentId: row.agentId,
    containerId: row.containerId,
    containerName: row.containerName,
    image: row.image,
    observedStatus: row.observedStatus,
    metadata: row.metadata,
    observedAt: row.observedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeDockerMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return normalizeMetadataRecord(metadata, 0);
}

function normalizeMetadataRecord(
  metadata: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  if (depth >= MAX_DOCKER_METADATA_DEPTH) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata)
      .slice(0, MAX_DOCKER_METADATA_KEYS)
      .map(([key, value]) => [key, normalizeMetadataValue(value, depth + 1)]),
  );
}

function normalizeMetadataValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeDockerText(value);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DOCKER_METADATA_ARRAY_LENGTH)
      .map((item) => normalizeMetadataValue(item, depth + 1));
  }

  if (isRecord(value)) {
    return normalizeMetadataRecord(value, depth + 1);
  }

  return String(value);
}

function normalizeRequiredDockerText(value: string, label: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (!normalized) {
    throw new Error(`${label} must not be empty.`);
  }

  return normalized.slice(0, MAX_DOCKER_TEXT_LENGTH);
}

function sanitizeDockerText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(DATABASE_DSN_PATTERN, DOCKER_RUNNER_METADATA_REDACTION)
    .replace(
      SECRET_ENV_ASSIGNMENT_PATTERN,
      (_match, prefix: string, keyPrefix: string) =>
        `${prefix}${keyPrefix}${DOCKER_RUNNER_METADATA_REDACTION}`,
    )
    .replace(
      SECRET_OPTION_ASSIGNMENT_PATTERN,
      (_match, prefix: string, optionPrefix: string) =>
        `${prefix}${optionPrefix}${DOCKER_RUNNER_METADATA_REDACTION}`,
    )
    .slice(0, MAX_DOCKER_TEXT_LENGTH);
}

function defaultLevelForStream(stream: DockerRunnerLogLineInput["stream"]): string {
  return stream === "stderr" ? "error" : "info";
}

function assertValidDockerLogLine(line: DockerRunnerLogLineInput): void {
  if (line.stream !== "stdout" && line.stream !== "stderr") {
    throw new Error("Docker runner log stream must be stdout or stderr.");
  }

  if (line.message.trim().length === 0) {
    throw new Error("Docker runner log message must not be empty.");
  }
}

function lockActiveDockerContainerInTransaction(
  tx: DockerRunnerStateTransaction,
  containerId: string,
  userId: string,
): Promise<{ id: string; agent_id: string }[]> {
  return tx.execute<{ id: string; agent_id: string }>(sql`
    select ${dockerRunnerContainers.id} as id,
           ${dockerRunnerContainers.agentId} as agent_id
    from ${dockerRunnerContainers}
    inner join ${agents}
      on ${agents.id} = ${dockerRunnerContainers.agentId}
    where ${dockerRunnerContainers.containerId} = ${containerId}
      and ${agents.userId} = ${userId}
      and ${agents.deletedAt} is null
    for update
  `);
}

function lockAgentLogSequenceInTransaction(
  tx: DockerRunnerStateTransaction,
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
