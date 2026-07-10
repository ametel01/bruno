import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, runnerHeartbeats, runners } from "@/src/server/db/schema";
import { DIGITALOCEAN_RUNNER_KIND } from "@/src/server/runners/digitalocean-provider";
import { MANUAL_RUNNER_KIND } from "@/src/server/runners/manual-runner-persistence";
import {
  normalizeRunnerCapacitySnapshot,
  type RunnerPlacementTransaction,
} from "@/src/server/runners/runner-placement";
import { reconcileStaleRunnerHeartbeatsInTransaction } from "@/src/server/runners/runner-heartbeat";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export type ManualRunnerDisplayStatus = "online" | "offline" | "degraded" | "unknown";

export type ManualRunnerCapacitySummary = {
  runningAgents: number;
  maxAgents: number;
  cpuUsedPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  diskUsedMb: number | null;
  diskTotalMb: number | null;
  blocker: "runner_capacity_reached" | null;
};

export type ManualRunnerStatusSummary = {
  name: string;
  kind: typeof MANUAL_RUNNER_KIND | typeof DIGITALOCEAN_RUNNER_KIND;
  endpointHost: string;
  status: ManualRunnerDisplayStatus;
  capacity: ManualRunnerCapacitySummary;
  version: string | null;
  lastSeenAt: string | null;
  updatedAt: string;
};

export type SettingsRunnerManagementSummary = ManualRunnerStatusSummary & {
  managementId: string;
};

export type AssignedManualRunnerStatusSummary = ManualRunnerStatusSummary & {
  provisioningStatus: string | null;
  assignmentNotice: string;
  alertState: "offline" | "degraded" | null;
  alertMessage: string | null;
};

type ManualRunnerStatusRow = {
  id?: string;
  name: string;
  kind: string;
  endpointUrl: string | null;
  status: string;
  provisioningStatus?: string | null;
  updatedAt: Date | string;
  latestHeartbeat?: {
    status: string;
    metadata: Record<string, unknown>;
    observedAt: Date | string;
  } | null;
  assignedRunningAgents?: number;
};

const RUNNER_STATUS_RUNNING_AGENT_STATES = ["starting", "running", "restarting"] as const;

export class ManualRunnerStatusPersistenceError extends Error {
  constructor() {
    super("Manual runner status failed.");
    this.name = "ManualRunnerStatusPersistenceError";
  }
}

export async function listManualRunnerStatusSummariesForDevelopmentUser(
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<ManualRunnerStatusSummary[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId) {
        return [];
      }

      await reconcileStaleRunnerHeartbeatsInTransaction(tx, { now });

      const rows = await tx
        .select({
          id: runners.id,
          name: runners.name,
          kind: runners.kind,
          endpointUrl: runners.endpointUrl,
          status: runners.status,
          provisioningStatus: runners.provisioningStatus,
          updatedAt: runners.updatedAt,
        })
        .from(runners)
        .where(
          and(
            eq(runners.userId, userId),
            eq(runners.kind, MANUAL_RUNNER_KIND),
            isNull(runners.deletedAt),
          ),
        )
        .orderBy(desc(runners.updatedAt), desc(runners.createdAt))
        .limit(10);

      const summaries: ManualRunnerStatusSummary[] = [];

      for (const row of rows) {
        const [latestHeartbeat] = await tx
          .select({
            status: runnerHeartbeats.status,
            metadata: runnerHeartbeats.metadata,
            observedAt: runnerHeartbeats.observedAt,
          })
          .from(runnerHeartbeats)
          .where(eq(runnerHeartbeats.runnerId, row.id))
          .orderBy(desc(runnerHeartbeats.observedAt))
          .limit(1);
        const assignedRunningAgents = await countAssignedRunningAgents(tx, row.id, userId);

        summaries.push(
          toManualRunnerStatusSummary({
            ...row,
            latestHeartbeat: latestHeartbeat ?? null,
            assignedRunningAgents,
          }),
        );
      }

      return summaries;
    });
  } catch {
    throw new ManualRunnerStatusPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listManualRunnerStatusSummariesForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<ManualRunnerStatusSummary[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      await reconcileStaleRunnerHeartbeatsInTransaction(tx, { now, userId });

      const rows = await tx
        .select({
          id: runners.id,
          name: runners.name,
          kind: runners.kind,
          endpointUrl: runners.endpointUrl,
          status: runners.status,
          provisioningStatus: runners.provisioningStatus,
          updatedAt: runners.updatedAt,
        })
        .from(runners)
        .where(
          and(
            eq(runners.userId, userId),
            eq(runners.kind, MANUAL_RUNNER_KIND),
            isNull(runners.deletedAt),
          ),
        )
        .orderBy(desc(runners.updatedAt), desc(runners.createdAt))
        .limit(10);

      const summaries: ManualRunnerStatusSummary[] = [];

      for (const row of rows) {
        const [latestHeartbeat] = await tx
          .select({
            status: runnerHeartbeats.status,
            metadata: runnerHeartbeats.metadata,
            observedAt: runnerHeartbeats.observedAt,
          })
          .from(runnerHeartbeats)
          .where(eq(runnerHeartbeats.runnerId, row.id))
          .orderBy(desc(runnerHeartbeats.observedAt))
          .limit(1);
        const assignedRunningAgents = await countAssignedRunningAgents(tx, row.id, userId);

        summaries.push(
          toManualRunnerStatusSummary({
            ...row,
            latestHeartbeat: latestHeartbeat ?? null,
            assignedRunningAgents,
          }),
        );
      }

      return summaries;
    });
  } catch {
    throw new ManualRunnerStatusPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listSettingsRunnerManagementSummariesForDevelopmentUser(
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<SettingsRunnerManagementSummary[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    const userId = await connection.db.transaction((tx) => getDevelopmentUserId(tx));

    return userId
      ? await listSettingsRunnerManagementSummariesForUser(userId, {
          createConnection: () => connection,
          now: () => now,
        })
      : [];
  } catch {
    throw new ManualRunnerStatusPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listSettingsRunnerManagementSummariesForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<SettingsRunnerManagementSummary[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      await reconcileStaleRunnerHeartbeatsInTransaction(tx, { now, userId });

      const rows = await tx
        .select({
          id: runners.id,
          name: runners.name,
          kind: runners.kind,
          endpointUrl: runners.endpointUrl,
          status: runners.status,
          provisioningStatus: runners.provisioningStatus,
          updatedAt: runners.updatedAt,
        })
        .from(runners)
        .where(
          and(
            eq(runners.userId, userId),
            eq(runners.kind, MANUAL_RUNNER_KIND),
            isNull(runners.deletedAt),
          ),
        )
        .orderBy(desc(runners.updatedAt), desc(runners.createdAt))
        .limit(10);

      const summaries: SettingsRunnerManagementSummary[] = [];

      for (const row of rows) {
        const [latestHeartbeat] = await tx
          .select({
            status: runnerHeartbeats.status,
            metadata: runnerHeartbeats.metadata,
            observedAt: runnerHeartbeats.observedAt,
          })
          .from(runnerHeartbeats)
          .where(eq(runnerHeartbeats.runnerId, row.id))
          .orderBy(desc(runnerHeartbeats.observedAt))
          .limit(1);
        const assignedRunningAgents = await countAssignedRunningAgents(tx, row.id, userId);

        summaries.push(
          toSettingsRunnerManagementSummary({
            ...row,
            latestHeartbeat: latestHeartbeat ?? null,
            assignedRunningAgents,
          }),
        );
      }

      return summaries;
    });
  } catch {
    throw new ManualRunnerStatusPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function getAssignedManualRunnerStatusForDevelopmentUserAgent(
  agentId: string,
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
  } = {},
): Promise<AssignedManualRunnerStatusSummary | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId) {
        return null;
      }

      await reconcileStaleRunnerHeartbeatsInTransaction(tx, { now });

      const [row] = await tx
        .select({
          id: runners.id,
          name: runners.name,
          kind: runners.kind,
          endpointUrl: runners.endpointUrl,
          status: runners.status,
          updatedAt: runners.updatedAt,
        })
        .from(agents)
        .innerJoin(runners, eq(runners.id, agents.runnerId))
        .where(
          and(
            eq(agents.id, agentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
            isNotNull(agents.runnerId),
            eq(runners.userId, userId),
            isNull(runners.deletedAt),
          ),
        )
        .limit(1);

      if (!row) {
        return null;
      }

      const [latestHeartbeat] = await tx
        .select({
          status: runnerHeartbeats.status,
          metadata: runnerHeartbeats.metadata,
          observedAt: runnerHeartbeats.observedAt,
        })
        .from(runnerHeartbeats)
        .where(eq(runnerHeartbeats.runnerId, row.id))
        .orderBy(desc(runnerHeartbeats.observedAt))
        .limit(1);
      const assignedRunningAgents = await countAssignedRunningAgents(tx, row.id, userId);

      return toAssignedManualRunnerStatusSummary({
        ...row,
        latestHeartbeat: latestHeartbeat ?? null,
        assignedRunningAgents,
      });
    });
  } catch {
    throw new ManualRunnerStatusPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function getAssignedManualRunnerStatusForUserAgent(
  userId: string,
  agentId: string,
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<AssignedManualRunnerStatusSummary | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const [ownedRunner] = await tx
        .select({ id: runners.id })
        .from(agents)
        .innerJoin(runners, eq(runners.id, agents.runnerId))
        .where(
          and(
            eq(agents.id, agentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
            isNotNull(agents.runnerId),
            eq(runners.userId, userId),
            isNull(runners.deletedAt),
          ),
        )
        .limit(1);

      if (!ownedRunner) {
        return null;
      }

      await reconcileStaleRunnerHeartbeatsInTransaction(tx, {
        now,
        userId,
        runnerId: ownedRunner.id,
      });

      const [row] = await tx
        .select({
          id: runners.id,
          name: runners.name,
          kind: runners.kind,
          endpointUrl: runners.endpointUrl,
          status: runners.status,
          provisioningStatus: runners.provisioningStatus,
          updatedAt: runners.updatedAt,
        })
        .from(agents)
        .innerJoin(runners, eq(runners.id, agents.runnerId))
        .where(
          and(
            eq(agents.id, agentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
            isNotNull(agents.runnerId),
            eq(runners.userId, userId),
            isNull(runners.deletedAt),
          ),
        )
        .limit(1);

      if (!row) {
        return null;
      }

      const [latestHeartbeat] = await tx
        .select({
          status: runnerHeartbeats.status,
          metadata: runnerHeartbeats.metadata,
          observedAt: runnerHeartbeats.observedAt,
        })
        .from(runnerHeartbeats)
        .where(eq(runnerHeartbeats.runnerId, row.id))
        .orderBy(desc(runnerHeartbeats.observedAt))
        .limit(1);
      const assignedRunningAgents = await countAssignedRunningAgents(tx, row.id, userId);

      return toAssignedManualRunnerStatusSummary({
        ...row,
        latestHeartbeat: latestHeartbeat ?? null,
        assignedRunningAgents,
      });
    });
  } catch {
    throw new ManualRunnerStatusPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export function toManualRunnerStatusSummary(row: ManualRunnerStatusRow): ManualRunnerStatusSummary {
  const endpointHost = extractEndpointHost(row.endpointUrl);
  const status = toDisplayStatus({
    endpointHost,
    heartbeatStatus: row.latestHeartbeat?.status ?? null,
    runnerStatus: row.status,
  });

  return {
    name: summarizeOperationalText(row.name, "Manual runner"),
    kind: toSupportedRunnerKind(row.kind),
    endpointHost,
    status,
    capacity: toCapacitySummary(row.latestHeartbeat?.metadata, row.assignedRunningAgents ?? 0),
    version: toSafeVersion(row.latestHeartbeat?.metadata),
    lastSeenAt: row.latestHeartbeat ? toIsoTimestamp(row.latestHeartbeat.observedAt) : null,
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

export function toSettingsRunnerManagementSummary(
  row: ManualRunnerStatusRow & { id: string },
): SettingsRunnerManagementSummary {
  return {
    ...toManualRunnerStatusSummary(row),
    managementId: row.id,
  };
}

export function toAssignedManualRunnerStatusSummary(
  row: ManualRunnerStatusRow,
): AssignedManualRunnerStatusSummary {
  const summary = toManualRunnerStatusSummary(row);
  const alertState =
    summary.status === "offline" ? "offline" : summary.status === "degraded" ? "degraded" : null;

  return {
    ...summary,
    provisioningStatus: row.provisioningStatus ?? null,
    assignmentNotice: `This agent is assigned to ${summary.name}.`,
    alertState,
    alertMessage:
      alertState === null
        ? null
        : alertState === "offline"
          ? "Assigned runner is inactive or unreachable. Check the runner host and service before restarting work."
          : "Assigned runner has incomplete endpoint information. Check the runner configuration before restarting work.",
  };
}

function toSupportedRunnerKind(
  kind: string,
): typeof MANUAL_RUNNER_KIND | typeof DIGITALOCEAN_RUNNER_KIND {
  if (kind === DIGITALOCEAN_RUNNER_KIND) {
    return DIGITALOCEAN_RUNNER_KIND;
  }

  return MANUAL_RUNNER_KIND;
}

function toDisplayStatus(input: {
  endpointHost: string;
  heartbeatStatus: string | null;
  runnerStatus: string;
}): ManualRunnerDisplayStatus {
  if (input.runnerStatus === "offline" || input.runnerStatus === "degraded") {
    return input.runnerStatus;
  }

  if (
    input.heartbeatStatus === "online" ||
    input.heartbeatStatus === "offline" ||
    input.heartbeatStatus === "degraded"
  ) {
    return input.heartbeatStatus;
  }

  if (input.runnerStatus === "online") {
    return input.runnerStatus;
  }

  if (input.endpointHost === "Endpoint unavailable") {
    return "degraded";
  }

  if (input.runnerStatus === "inactive") {
    return "offline";
  }

  return "unknown";
}

function toSafeVersion(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata.version !== "string") {
    return null;
  }

  const version = summarizeOperationalText(metadata.version, "");

  return version.length > 0 ? version : null;
}

function toCapacitySummary(
  metadata: Record<string, unknown> | null | undefined,
  assignedRunningAgents: number,
): ManualRunnerCapacitySummary {
  const normalized = normalizeRunnerCapacitySnapshot(metadata, assignedRunningAgents);
  const metrics = getMetrics(metadata);

  return {
    runningAgents: normalized.running_agents,
    maxAgents: normalized.max_agents,
    cpuUsedPercent: hasReportedMetric(metrics, "cpuPercent", "cpu_used_percent")
      ? normalized.cpu_used_percent
      : null,
    memoryUsedMb: hasReportedMetric(metrics, "memoryUsedMb", "memory_used_mb")
      ? normalized.memory_used_mb
      : null,
    memoryTotalMb: hasReportedMetric(metrics, "memoryTotalMb", "memory_total_mb")
      ? normalized.memory_total_mb
      : null,
    diskUsedMb: hasReportedMetric(metrics, "diskUsedMb", "disk_used_mb")
      ? normalized.disk_used_mb
      : null,
    diskTotalMb: hasReportedMetric(metrics, "diskTotalMb", "disk_total_mb")
      ? normalized.disk_total_mb
      : null,
    blocker: normalized.running_agents >= normalized.max_agents ? "runner_capacity_reached" : null,
  };
}

function getMetrics(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!metadata || typeof metadata.metrics !== "object" || Array.isArray(metadata.metrics)) {
    return {};
  }

  return metadata.metrics as Record<string, unknown>;
}

function hasReportedMetric(metrics: Record<string, unknown>, camelKey: string, snakeKey: string) {
  return isFiniteNumber(metrics[camelKey]) || isFiniteNumber(metrics[snakeKey]);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function countAssignedRunningAgents(
  tx: RunnerPlacementTransaction,
  runnerId: string,
  userId: string,
): Promise<number> {
  const rows = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.runnerId, runnerId),
        eq(agents.userId, userId),
        inArray(agents.status, [...RUNNER_STATUS_RUNNING_AGENT_STATES]),
        isNull(agents.deletedAt),
      ),
    );

  return rows.length;
}

function extractEndpointHost(endpointUrl: string | null): string {
  if (!endpointUrl) {
    return "Endpoint unavailable";
  }

  try {
    const parsedUrl = new URL(endpointUrl);
    return parsedUrl.host || "Endpoint unavailable";
  } catch {
    return "Endpoint unavailable";
  }
}

function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
