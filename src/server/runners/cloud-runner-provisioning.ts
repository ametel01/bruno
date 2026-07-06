import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerHeartbeats, runners } from "@/src/server/db/schema";
import {
  DIGITALOCEAN_PROVIDER,
  DIGITALOCEAN_RUNNER_KIND,
  type DigitalOceanProvisioningStatus,
} from "@/src/server/runners/digitalocean-provider";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

const DEFAULT_CLOUD_RUNNER_NAME = "DigitalOcean Runner";
const READY_RUNNER_STATUSES = new Set(["online", "ready"]);

const PROVISIONING_PHASES = [
  "pending",
  "creating",
  "tagging",
  "firewall_configuring",
  "bootstrapping",
  "waiting_for_runner",
  "ready",
  "failed",
  "cleaning_up",
  "deleted",
] as const satisfies readonly DigitalOceanProvisioningStatus[];

const READY_COMPLETED_PHASES = new Set<DigitalOceanProvisioningStatus>([
  "pending",
  "creating",
  "tagging",
  "firewall_configuring",
  "bootstrapping",
  "waiting_for_runner",
  "ready",
]);

type CloudRunnerReadinessStatus =
  | "provisioning"
  | "online"
  | "offline"
  | "degraded"
  | "failed"
  | "deleted"
  | "unknown";

type CloudRunnerProvisioningPhaseStatus = "pending" | "current" | "completed" | "failed";

export type CloudRunnerProvisioningPhase = {
  name: DigitalOceanProvisioningStatus;
  status: CloudRunnerProvisioningPhaseStatus;
  startedAt: string | null;
  completedAt: string | null;
};

export type CloudRunnerProvisioningSummary = {
  id: string;
  name: string;
  kind: typeof DIGITALOCEAN_RUNNER_KIND;
  status: string;
  readinessStatus: CloudRunnerReadinessStatus;
  provider: typeof DIGITALOCEAN_PROVIDER;
  providerResourceId: string | null;
  region: string;
  sizeSlug: string;
  image: string;
  latestHeartbeatAt: string | null;
  provisioning: {
    status: DigitalOceanProvisioningStatus;
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
    phases: CloudRunnerProvisioningPhase[];
  };
};

type CloudRunnerRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  provider: string | null;
  providerResourceId: string | null;
  region: string | null;
  sizeSlug: string | null;
  image: string | null;
  provisioningStatus: string | null;
  provisioningError: string | null;
  provisioningStartedAt: Date | string | null;
  provisioningCompletedAt: Date | string | null;
};

type LatestHeartbeatRow = {
  status: string;
  observedAt: Date | string;
} | null;

export class CloudRunnerProvisioningPersistenceError extends Error {
  constructor(readonly cause?: unknown) {
    super("Cloud runner provisioning persistence failed.");
    this.name = "CloudRunnerProvisioningPersistenceError";
  }
}

export async function listCloudRunnerProvisioningSummariesForDevelopmentUser(
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<CloudRunnerProvisioningSummary[]> {
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
          status: runners.status,
          provider: runners.provider,
          providerResourceId: runners.providerResourceId,
          region: runners.region,
          sizeSlug: runners.sizeSlug,
          image: runners.image,
          provisioningStatus: runners.provisioningStatus,
          provisioningError: runners.provisioningError,
          provisioningStartedAt: runners.provisioningStartedAt,
          provisioningCompletedAt: runners.provisioningCompletedAt,
        })
        .from(runners)
        .where(
          and(
            eq(runners.userId, userId),
            eq(runners.kind, DIGITALOCEAN_RUNNER_KIND),
            isNull(runners.deletedAt),
          ),
        )
        .orderBy(desc(runners.updatedAt), desc(runners.createdAt))
        .limit(10);

      const summaries: CloudRunnerProvisioningSummary[] = [];

      for (const row of rows) {
        const [latestHeartbeat] = await tx
          .select({
            status: runnerHeartbeats.status,
            observedAt: runnerHeartbeats.observedAt,
          })
          .from(runnerHeartbeats)
          .where(eq(runnerHeartbeats.runnerId, row.id))
          .orderBy(desc(runnerHeartbeats.observedAt))
          .limit(1);

        summaries.push(toCloudRunnerProvisioningSummary(row, latestHeartbeat ?? null));
      }

      return summaries;
    });
  } catch (error) {
    throw new CloudRunnerProvisioningPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export function toCloudRunnerProvisioningSummary(
  row: CloudRunnerRow,
  latestHeartbeat: LatestHeartbeatRow = null,
): CloudRunnerProvisioningSummary {
  const provisioningStatus = toProvisioningStatus(row.provisioningStatus);
  const startedAt = toIsoTimestamp(row.provisioningStartedAt);
  const completedAt = toIsoTimestamp(row.provisioningCompletedAt);

  return {
    id: row.id,
    name: summarizeOperationalText(row.name, DEFAULT_CLOUD_RUNNER_NAME),
    kind: DIGITALOCEAN_RUNNER_KIND,
    status: row.status,
    readinessStatus: toReadinessStatus(row.status, provisioningStatus),
    provider: DIGITALOCEAN_PROVIDER,
    providerResourceId: safeProviderResourceId(row.providerResourceId),
    region: row.region?.trim() || "unknown",
    sizeSlug: row.sizeSlug?.trim() || "unknown",
    image: row.image?.trim() || "unknown",
    latestHeartbeatAt: latestHeartbeat ? toIsoTimestamp(latestHeartbeat.observedAt) : null,
    provisioning: {
      status: provisioningStatus,
      error: toSafeProvisioningError(row.provisioningError, provisioningStatus),
      startedAt,
      completedAt,
      phases: buildProvisioningPhases({
        status: provisioningStatus,
        startedAt,
        completedAt,
      }),
    },
  };
}

function buildProvisioningPhases(input: {
  status: DigitalOceanProvisioningStatus;
  startedAt: string | null;
  completedAt: string | null;
}): CloudRunnerProvisioningPhase[] {
  const currentIndex = PROVISIONING_PHASES.indexOf(input.status);

  return PROVISIONING_PHASES.map((name, index) => {
    let status: CloudRunnerProvisioningPhaseStatus = "pending";

    if (input.status === "ready" && READY_COMPLETED_PHASES.has(name)) {
      status = "completed";
    } else if (input.status === "failed" && name === "failed") {
      status = "failed";
    } else if (index < currentIndex) {
      status = "completed";
    } else if (index === currentIndex) {
      status = "current";
    }

    return {
      name,
      status,
      startedAt:
        status === "current" || status === "completed" || status === "failed"
          ? input.startedAt
          : null,
      completedAt: status === "completed" ? input.completedAt : null,
    };
  });
}

function toProvisioningStatus(value: string | null): DigitalOceanProvisioningStatus {
  return PROVISIONING_PHASES.includes(value as DigitalOceanProvisioningStatus)
    ? (value as DigitalOceanProvisioningStatus)
    : "pending";
}

function toReadinessStatus(
  runnerStatus: string,
  provisioningStatus: DigitalOceanProvisioningStatus,
): CloudRunnerReadinessStatus {
  if (runnerStatus === "online" || READY_RUNNER_STATUSES.has(runnerStatus)) {
    return "online";
  }

  if (runnerStatus === "offline" || runnerStatus === "degraded" || runnerStatus === "deleted") {
    return runnerStatus;
  }

  if (runnerStatus === "provision_failed" || provisioningStatus === "failed") {
    return "failed";
  }

  if (runnerStatus === "provisioning") {
    return "provisioning";
  }

  return "unknown";
}

function safeProviderResourceId(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return summarizeOperationalText(value, "Resource id unavailable");
}

function toSafeProvisioningError(
  value: string | null,
  status: DigitalOceanProvisioningStatus,
): string | null {
  if (!value && status !== "failed") {
    return null;
  }

  return summarizeOperationalText(
    value,
    "Provisioning failed. Check provider configuration, retry Create runner, or contact support.",
  );
}

function toIsoTimestamp(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
