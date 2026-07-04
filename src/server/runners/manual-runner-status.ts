import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, runners } from "@/src/server/db/schema";
import {
  ACTIVE_RUNNER_STATUS,
  MANUAL_RUNNER_KIND,
} from "@/src/server/runners/manual-runner-persistence";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export type ManualRunnerDisplayStatus = "online" | "offline" | "degraded" | "unknown";

export type ManualRunnerStatusSummary = {
  name: string;
  kind: typeof MANUAL_RUNNER_KIND;
  endpointHost: string;
  status: ManualRunnerDisplayStatus;
  updatedAt: string;
  checkedAt: string | null;
};

export type AssignedManualRunnerStatusSummary = ManualRunnerStatusSummary & {
  assignmentNotice: string;
  alertState: "offline" | "degraded" | null;
  alertMessage: string | null;
};

type ManualRunnerStatusRow = {
  name: string;
  kind: string;
  endpointUrl: string;
  status: string;
  updatedAt: Date | string;
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
        .limit(3);

      return rows.map(toManualRunnerStatusSummary);
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
            eq(runners.kind, MANUAL_RUNNER_KIND),
            isNull(runners.deletedAt),
          ),
        )
        .limit(1);

      return row ? toAssignedManualRunnerStatusSummary(row) : null;
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
  const status = toDisplayStatus(row.status, endpointHost);

  return {
    name: summarizeOperationalText(row.name, "Manual runner"),
    kind: MANUAL_RUNNER_KIND,
    endpointHost,
    status,
    updatedAt: toIsoTimestamp(row.updatedAt),
    checkedAt: null,
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
          ? "Assigned manual runner is inactive or unreachable. Check the runner host and service before restarting work."
          : "Assigned manual runner has incomplete endpoint information. Check the runner configuration before restarting work.",
  };
}

function toDisplayStatus(rawStatus: string, endpointHost: string): ManualRunnerDisplayStatus {
  if (endpointHost === "Endpoint unavailable") {
    return "degraded";
  }

  if (rawStatus === ACTIVE_RUNNER_STATUS) {
    return "online";
  }

  if (rawStatus === "inactive") {
    return "offline";
  }

  return "unknown";
}

function extractEndpointHost(endpointUrl: string): string {
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
