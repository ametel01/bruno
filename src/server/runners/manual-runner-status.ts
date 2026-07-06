import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, runnerHeartbeats, runners } from "@/src/server/db/schema";
import { DIGITALOCEAN_RUNNER_KIND } from "@/src/server/runners/digitalocean-provider";
import { MANUAL_RUNNER_KIND } from "@/src/server/runners/manual-runner-persistence";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export type ManualRunnerDisplayStatus = "online" | "offline" | "degraded" | "unknown";

export type ManualRunnerStatusSummary = {
  name: string;
  kind: typeof MANUAL_RUNNER_KIND | typeof DIGITALOCEAN_RUNNER_KIND;
  endpointHost: string;
  status: ManualRunnerDisplayStatus;
  version: string | null;
  lastSeenAt: string | null;
  updatedAt: string;
};

export type SettingsRunnerManagementSummary = ManualRunnerStatusSummary & {
  managementId: string;
};

export type AssignedManualRunnerStatusSummary = ManualRunnerStatusSummary & {
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
  updatedAt: Date | string;
  latestHeartbeat?: {
    status: string;
    metadata: Record<string, unknown>;
    observedAt: Date | string;
  } | null;
};

export class ManualRunnerStatusPersistenceError extends Error {
  constructor() {
    super("Manual runner status failed.");
    this.name = "ManualRunnerStatusPersistenceError";
  }
}

export async function listManualRunnerStatusSummariesForDevelopmentUser(
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<ManualRunnerStatusSummary[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId) {
        return [];
      }

      const rows = await tx
        .select({
          id: runners.id,
          name: runners.name,
          kind: runners.kind,
          endpointUrl: runners.endpointUrl,
          status: runners.status,
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

        summaries.push(
          toManualRunnerStatusSummary({
            ...row,
            latestHeartbeat: latestHeartbeat ?? null,
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
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<SettingsRunnerManagementSummary[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId) {
        return [];
      }

      const rows = await tx
        .select({
          id: runners.id,
          name: runners.name,
          kind: runners.kind,
          endpointUrl: runners.endpointUrl,
          status: runners.status,
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

        summaries.push(
          toSettingsRunnerManagementSummary({
            ...row,
            latestHeartbeat: latestHeartbeat ?? null,
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
  } = {},
): Promise<AssignedManualRunnerStatusSummary | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId) {
        return null;
      }

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

      return toAssignedManualRunnerStatusSummary({
        ...row,
        latestHeartbeat: latestHeartbeat ?? null,
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
