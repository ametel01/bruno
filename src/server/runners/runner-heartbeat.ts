import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerCredentials, runnerHeartbeats, runners } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import { DIGITALOCEAN_RUNNER_KIND } from "@/src/server/runners/digitalocean-provider";
import { hashRunnerSecret } from "@/src/server/runners/runner-auth-secrets";
import { markCloudRunnerReadyAfterFirstHeartbeat } from "@/src/server/runners/runner-provisioning-events";

export const RUNNER_HEARTBEAT_ONLINE_STATUS = "online";
export const RUNNER_HEARTBEAT_DEGRADED_STATUS = "degraded";
export const RUNNER_HEARTBEAT_OFFLINE_STATUS = "offline";
export const RUNNER_HEARTBEAT_STALE_THRESHOLD_MS = 90_000;

const MAX_VERSION_LENGTH = 80;
const METRIC_LIMITS = {
  cpuPercent: { min: 0, max: 100 },
  memoryUsedMb: { min: 0, max: 16_777_216 },
  memoryTotalMb: { min: 0, max: 16_777_216 },
  diskUsedMb: { min: 0, max: 1_073_741_824 },
  diskTotalMb: { min: 0, max: 1_073_741_824 },
  runningAgents: { min: 0, max: 10_000 },
  maxAgents: { min: 0, max: 10_000 },
} as const;

type RunnerHeartbeatStatus =
  | typeof RUNNER_HEARTBEAT_ONLINE_STATUS
  | typeof RUNNER_HEARTBEAT_DEGRADED_STATUS;

type RunnerHeartbeatMetadata = {
  version?: string;
  metrics?:
    | Record<keyof typeof METRIC_LIMITS, number>
    | Partial<Record<keyof typeof METRIC_LIMITS, number>>;
};

type RunnerHeartbeatValidation =
  | {
      ok: true;
      value: {
        runnerId: string;
        status: RunnerHeartbeatStatus;
        metadata: RunnerHeartbeatMetadata;
      };
    }
  | {
      ok: false;
      reason: "invalid_payload";
      issues: Array<{ field: string; message: string }>;
    };

type RunnerCredentialValidation =
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      reason: "missing_credential" | "malformed_credential";
    };

export type RunnerHeartbeatReconciliationResult = {
  offlineCount: number;
  runnerIds: string[];
  cutoff: string;
};

export type RunnerHeartbeatTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type RecordRunnerHeartbeatResult =
  | {
      ok: true;
      runner: {
        id: string;
        status: RunnerHeartbeatStatus;
        observedAt: string;
      };
    }
  | {
      ok: false;
      reason:
        | "missing_credential"
        | "malformed_credential"
        | "invalid_credential"
        | "wrong_runner"
        | "invalid_payload";
      issues?: Array<{ field: string; message: string }>;
    };

export class RunnerHeartbeatPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Runner heartbeat failed.");
    this.name = "RunnerHeartbeatPersistenceError";
    this.cause = cause;
  }
}

export async function recordRunnerHeartbeat(
  input: {
    authorizationHeader: string | null;
    payload: unknown;
  },
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
  } = {},
): Promise<RecordRunnerHeartbeatResult> {
  const credential = parseRunnerBearerCredential(input.authorizationHeader);

  if (!credential.ok) {
    return { ok: false, reason: credential.reason };
  }

  const payload = validateRunnerHeartbeatPayload(input.payload);

  if (!payload.ok) {
    return { ok: false, reason: payload.reason, issues: payload.issues };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const credentialHash = hashRunnerSecret(credential.value);
      const [row] = await tx
        .select({
          credentialId: runnerCredentials.id,
          credentialRunnerId: runnerCredentials.runnerId,
          credentialStatus: runnerCredentials.status,
          expiresAt: runnerCredentials.expiresAt,
          runnerId: runners.id,
          runnerKind: runners.kind,
          provisioningStatus: runners.provisioningStatus,
        })
        .from(runnerCredentials)
        .innerJoin(runners, eq(runners.id, runnerCredentials.runnerId))
        .where(and(eq(runnerCredentials.credentialHash, credentialHash), isNull(runners.deletedAt)))
        .limit(1);

      if (row?.credentialStatus !== "active" || isExpired(row.expiresAt, now)) {
        return { ok: false, reason: "invalid_credential" } as const;
      }

      if (
        row.credentialRunnerId !== payload.value.runnerId ||
        row.runnerId !== payload.value.runnerId
      ) {
        return { ok: false, reason: "wrong_runner" } as const;
      }

      await tx.insert(runnerHeartbeats).values({
        runnerId: payload.value.runnerId,
        status: payload.value.status,
        metadata: payload.value.metadata,
        observedAt: now,
        createdAt: now,
      });

      await tx
        .update(runnerCredentials)
        .set({
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(eq(runnerCredentials.id, row.credentialId));

      if (
        row.runnerKind === DIGITALOCEAN_RUNNER_KIND &&
        payload.value.status === RUNNER_HEARTBEAT_ONLINE_STATUS &&
        row.provisioningStatus !== "ready"
      ) {
        await markCloudRunnerReadyAfterFirstHeartbeat(tx, {
          runnerId: payload.value.runnerId,
          now,
          heartbeatStatus: payload.value.status,
        });
      } else {
        await tx
          .update(runners)
          .set({
            status: payload.value.status,
            updatedAt: now,
          })
          .where(eq(runners.id, payload.value.runnerId));
      }

      return {
        ok: true,
        runner: {
          id: payload.value.runnerId,
          status: payload.value.status,
          observedAt: now.toISOString(),
        },
      } as const;
    });
  } catch (error) {
    throw new RunnerHeartbeatPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function reconcileStaleRunnerHeartbeats(
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
    staleThresholdMs?: number;
  } = {},
): Promise<RunnerHeartbeatReconciliationResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction((tx) =>
      reconcileStaleRunnerHeartbeatsInTransaction(tx, {
        now,
        ...(dependencies.staleThresholdMs === undefined
          ? {}
          : { staleThresholdMs: dependencies.staleThresholdMs }),
      }),
    );
  } catch (error) {
    throw new RunnerHeartbeatPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function reconcileStaleRunnerHeartbeatsInTransaction(
  tx: RunnerHeartbeatTransaction,
  input: { now: Date; staleThresholdMs?: number; userId?: string; runnerId?: string },
): Promise<RunnerHeartbeatReconciliationResult> {
  const staleThresholdMs = input.staleThresholdMs ?? RUNNER_HEARTBEAT_STALE_THRESHOLD_MS;
  const cutoff = new Date(input.now.getTime() - staleThresholdMs);
  const runnerFilters = [
    inArray(runners.status, [RUNNER_HEARTBEAT_ONLINE_STATUS, RUNNER_HEARTBEAT_DEGRADED_STATUS]),
    isNull(runners.deletedAt),
  ];

  if (input.userId) {
    runnerFilters.push(eq(runners.userId, input.userId));
  }

  if (input.runnerId) {
    runnerFilters.push(eq(runners.id, input.runnerId));
  }

  const candidateRunners = await tx
    .select({ id: runners.id })
    .from(runners)
    .where(and(...runnerFilters));
  const staleRunnerIds: string[] = [];

  for (const candidate of candidateRunners) {
    const [latestHeartbeat] = await tx
      .select({ observedAt: runnerHeartbeats.observedAt })
      .from(runnerHeartbeats)
      .where(eq(runnerHeartbeats.runnerId, candidate.id))
      .orderBy(desc(runnerHeartbeats.observedAt))
      .limit(1);

    if (!latestHeartbeat || latestHeartbeat.observedAt < cutoff) {
      staleRunnerIds.push(candidate.id);
    }
  }

  if (staleRunnerIds.length > 0) {
    await tx
      .update(runners)
      .set({
        status: RUNNER_HEARTBEAT_OFFLINE_STATUS,
        updatedAt: input.now,
      })
      .where(and(inArray(runners.id, staleRunnerIds), isNull(runners.deletedAt)));
  }

  return {
    offlineCount: staleRunnerIds.length,
    runnerIds: staleRunnerIds,
    cutoff: cutoff.toISOString(),
  };
}

export function validateRunnerHeartbeatPayload(payload: unknown): RunnerHeartbeatValidation {
  const issues: Array<{ field: string; message: string }> = [];

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      ok: false,
      reason: "invalid_payload",
      issues: [{ field: "body", message: "Request body must be an object." }],
    };
  }

  const body = payload as Record<string, unknown>;
  const runnerId = typeof body.runnerId === "string" ? body.runnerId.trim() : "";

  if (!isUuid(runnerId)) {
    issues.push({ field: "runnerId", message: "Runner ID must be a valid UUID." });
  }

  const parsedStatus = parseHeartbeatStatus(body.status);

  if (!parsedStatus) {
    issues.push({
      field: "status",
      message: "Status must be online or degraded when provided.",
    });
  }

  const version = sanitizeVersion(body.version);
  const metrics = sanitizeMetrics(body.metrics);
  const metadata: RunnerHeartbeatMetadata = {};

  if (version) {
    metadata.version = version;
  }

  if (Object.keys(metrics).length > 0) {
    metadata.metrics = metrics;
  }

  if (issues.length > 0) {
    return { ok: false, reason: "invalid_payload", issues };
  }

  return {
    ok: true,
    value: {
      runnerId,
      status: parsedStatus ?? RUNNER_HEARTBEAT_ONLINE_STATUS,
      metadata,
    },
  };
}

function parseRunnerBearerCredential(
  authorizationHeader: string | null,
): RunnerCredentialValidation {
  if (!authorizationHeader) {
    return { ok: false, reason: "missing_credential" };
  }

  const trimmedHeader = authorizationHeader.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmedHeader);

  if (!match) {
    return { ok: false, reason: "malformed_credential" };
  }

  const credential = match[1]?.trim();

  if (!credential || /\s/.test(credential)) {
    return { ok: false, reason: "malformed_credential" };
  }

  return { ok: true, value: credential };
}

function parseHeartbeatStatus(value: unknown): RunnerHeartbeatStatus | null {
  if (value === undefined || value === null || value === RUNNER_HEARTBEAT_ONLINE_STATUS) {
    return RUNNER_HEARTBEAT_ONLINE_STATUS;
  }

  if (value === RUNNER_HEARTBEAT_DEGRADED_STATUS) {
    return RUNNER_HEARTBEAT_DEGRADED_STATUS;
  }

  return null;
}

function sanitizeVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim().replace(/[^\w .:/+-]/g, "");

  return trimmedValue ? trimmedValue.slice(0, MAX_VERSION_LENGTH) : undefined;
}

function sanitizeMetrics(value: unknown): Partial<Record<keyof typeof METRIC_LIMITS, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const metrics = value as Record<string, unknown>;
  const sanitizedMetrics: Partial<Record<keyof typeof METRIC_LIMITS, number>> = {};

  for (const key of Object.keys(METRIC_LIMITS) as Array<keyof typeof METRIC_LIMITS>) {
    const rawValue = metrics[key];

    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      continue;
    }

    const limit = METRIC_LIMITS[key];
    sanitizedMetrics[key] = Math.min(Math.max(rawValue, limit.min), limit.max);
  }

  return sanitizedMetrics;
}

function isExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt <= now;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
