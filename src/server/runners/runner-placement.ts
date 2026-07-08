import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, runnerHeartbeats, runners } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import { reconcileStaleRunnerHeartbeatsInTransaction } from "@/src/server/runners/runner-heartbeat";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export const DEFAULT_RUNNER_MAX_AGENTS = 1;

const RUNNER_PLACEMENT_AGENT_STATUSES = ["starting", "running", "restarting"] as const;
const RUNNER_CAPACITY_LIMITS = {
  max_agents: { min: 0, max: 10_000, fallback: DEFAULT_RUNNER_MAX_AGENTS },
  running_agents: { min: 0, max: 10_000, fallback: 0 },
  cpu_used_percent: { min: 0, max: 100, fallback: 0 },
  memory_used_mb: { min: 0, max: 16_777_216, fallback: 0 },
  memory_total_mb: { min: 0, max: 16_777_216, fallback: 0 },
  disk_used_mb: { min: 0, max: 1_073_741_824, fallback: 0 },
  disk_total_mb: { min: 0, max: 1_073_741_824, fallback: 0 },
} as const;

type RunnerPlacementCandidate = {
  id: string;
  name: string;
  kind: string;
  endpointUrl: string;
  status: string;
  updatedAt: Date;
  latestHeartbeat: {
    status: string;
    metadata: Record<string, unknown>;
    observedAt: Date;
  } | null;
};

export type RunnerCapacitySnapshot = {
  max_agents: number;
  running_agents: number;
  cpu_used_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  disk_used_mb: number;
  disk_total_mb: number;
};

export type RunnerPlacementSelection = {
  id: string;
  kind: string;
  status: "online";
  capacity: RunnerCapacitySnapshot;
  latestHeartbeatAt: string | null;
};

export type RunnerPlacementResult =
  | {
      ok: true;
      runner: RunnerPlacementSelection;
    }
  | {
      ok: false;
      reason: "no_online_runner";
    }
  | {
      ok: false;
      reason: "plan_limit_reached";
      currentAgents: number;
      maxAgents: number;
    }
  | {
      ok: false;
      reason: "runner_capacity_reached";
      runner: RunnerPlacementSelection;
    };

export type RunnerPlacementInput = {
  planMaxAgents?: number | null | undefined;
  runnerId?: string | null | undefined;
};

export type RunnerPlacementTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export class RunnerPlacementPersistenceError extends Error {
  constructor() {
    super("Runner placement failed.");
    this.name = "RunnerPlacementPersistenceError";
  }
}

export async function selectRunnerPlacementForDevelopmentUser(
  input: RunnerPlacementInput = {},
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
  } = {},
): Promise<RunnerPlacementResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction((tx) =>
      selectRunnerPlacementForDevelopmentUserInTransaction(tx, input, { now }),
    );
  } catch {
    throw new RunnerPlacementPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function selectRunnerPlacementForDevelopmentUserInTransaction(
  tx: RunnerPlacementTransaction,
  input: RunnerPlacementInput = {},
  options: { now?: Date } = {},
): Promise<RunnerPlacementResult> {
  const userId = await getDevelopmentUserId(tx);

  if (!userId) {
    return { ok: false, reason: "no_online_runner" } as const;
  }

  await reconcileStaleRunnerHeartbeatsInTransaction(tx, { now: options.now ?? new Date() });

  const activeAgentRows = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, userId), isNull(agents.deletedAt)));
  const planMaxAgents = normalizePlanMaxAgents(input.planMaxAgents);

  if (planMaxAgents !== null && activeAgentRows.length >= planMaxAgents) {
    return {
      ok: false,
      reason: "plan_limit_reached",
      currentAgents: activeAgentRows.length,
      maxAgents: planMaxAgents,
    } as const;
  }

  const runnerFilters = [
    eq(runners.userId, userId),
    eq(runners.status, "online"),
    isNotNull(runners.endpointUrl),
    isNull(runners.deletedAt),
  ];

  if (input.runnerId) {
    runnerFilters.push(eq(runners.id, input.runnerId));
  }

  const runnerRows = await tx
    .select({
      id: runners.id,
      name: runners.name,
      kind: runners.kind,
      endpointUrl: runners.endpointUrl,
      status: runners.status,
      updatedAt: runners.updatedAt,
    })
    .from(runners)
    .where(and(...runnerFilters))
    .orderBy(desc(runners.updatedAt), desc(runners.createdAt));

  const candidates: RunnerPlacementSelection[] = [];

  for (const row of runnerRows) {
    if (!row.endpointUrl) {
      continue;
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
    const assignedRunningAgents = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.runnerId, row.id),
          eq(agents.userId, userId),
          inArray(agents.status, [...RUNNER_PLACEMENT_AGENT_STATUSES]),
          isNull(agents.deletedAt),
        ),
      );
    const capacity = normalizeRunnerCapacitySnapshot(
      latestHeartbeat?.metadata,
      assignedRunningAgents.length,
    );
    const candidate = toRunnerPlacementSelection(
      {
        ...row,
        endpointUrl: row.endpointUrl,
        latestHeartbeat: latestHeartbeat ?? null,
      },
      capacity,
    );

    candidates.push(candidate);

    if (hasAvailableRunnerCapacity(capacity)) {
      return { ok: true, runner: candidate } as const;
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: "no_online_runner" } as const;
  }

  const [firstCandidate] = candidates;

  if (!firstCandidate) {
    return { ok: false, reason: "no_online_runner" } as const;
  }

  return {
    ok: false,
    reason: "runner_capacity_reached",
    runner: firstCandidate,
  } as const;
}

export async function lockRunnerPlacementCapacityInTransaction(
  tx: RunnerPlacementTransaction,
  runnerId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runnerId}))`);
}

export function normalizeRunnerCapacitySnapshot(
  metadata: Record<string, unknown> | null | undefined,
  assignedRunningAgents = 0,
): RunnerCapacitySnapshot {
  const metrics =
    metadata && typeof metadata.metrics === "object" && !Array.isArray(metadata.metrics)
      ? (metadata.metrics as Record<string, unknown>)
      : {};
  const capacity: RunnerCapacitySnapshot = {
    max_agents: readBoundedMetric(metrics, "maxAgents", "max_agents"),
    running_agents: readBoundedMetric(metrics, "runningAgents", "running_agents"),
    cpu_used_percent: readBoundedMetric(metrics, "cpuPercent", "cpu_used_percent"),
    memory_used_mb: readBoundedMetric(metrics, "memoryUsedMb", "memory_used_mb"),
    memory_total_mb: readBoundedMetric(metrics, "memoryTotalMb", "memory_total_mb"),
    disk_used_mb: readBoundedMetric(metrics, "diskUsedMb", "disk_used_mb"),
    disk_total_mb: readBoundedMetric(metrics, "diskTotalMb", "disk_total_mb"),
  };

  capacity.running_agents = clampMetric(
    "running_agents",
    Math.max(capacity.running_agents, assignedRunningAgents),
  );

  return capacity;
}

export function hasAvailableRunnerCapacity(capacity: RunnerCapacitySnapshot): boolean {
  return capacity.running_agents < capacity.max_agents;
}

function toRunnerPlacementSelection(
  candidate: RunnerPlacementCandidate,
  capacity: RunnerCapacitySnapshot,
): RunnerPlacementSelection {
  return {
    id: candidate.id,
    kind: candidate.kind,
    status: "online",
    capacity,
    latestHeartbeatAt: candidate.latestHeartbeat
      ? candidate.latestHeartbeat.observedAt.toISOString()
      : null,
  };
}

function normalizePlanMaxAgents(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.floor(value));
}

function readBoundedMetric(
  metrics: Record<string, unknown>,
  camelKey: string,
  snakeKey: keyof RunnerCapacitySnapshot,
): number {
  const rawValue = metrics[camelKey] ?? metrics[snakeKey];

  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    return RUNNER_CAPACITY_LIMITS[snakeKey].fallback;
  }

  return clampMetric(snakeKey, rawValue);
}

function clampMetric(key: keyof RunnerCapacitySnapshot, value: number): number {
  const limit = RUNNER_CAPACITY_LIMITS[key];
  return Math.min(Math.max(value, limit.min), limit.max);
}
