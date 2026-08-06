import "server-only";

import { and, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentUsagePeriods, agents, runners } from "@/src/server/db/schema";
import { getDigitalOceanRunnerPriceMetadata } from "@/src/server/costs/provider-prices";
import { DIGITALOCEAN_RUNNER_KIND } from "@/src/server/runners/digitalocean-provider";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MONTH_DAYS = 30;
const MONTH_MS = MONTH_DAYS * DAY_MS;
const RUNNING_AGENT_STATUSES = ["starting", "running", "restarting"] as const;
const ESTIMATE_LABEL = "Estimated raw infrastructure cost" as const;
const RAW_COMPUTE_EXPLANATION =
  "Raw compute estimate only; plans may also include orchestration, monitoring, backups, support, and margin." as const;

export type CostEstimateWindowKey = "daily" | "monthly";

export type CostEstimateUnavailableReason =
  | "incomplete_runner_prices"
  | "manual_runner"
  | "no_active_agents"
  | "unsupported_size";

export type AvailableCostEstimate = {
  available: true;
  cents: number;
  currency: "USD";
  label: typeof ESTIMATE_LABEL;
  explanation: typeof RAW_COMPUTE_EXPLANATION;
};

export type UnavailableCostEstimate = {
  available: false;
  reason: CostEstimateUnavailableReason;
  label: "Estimate unavailable";
  explanation: string;
};

export type CostEstimate = AvailableCostEstimate | UnavailableCostEstimate;

export type RunnerCostEstimateDto = {
  runnerId: string;
  runnerName: string;
  runnerKind: string;
  sizeSlug: string | null;
  uptimeMs: number;
  runningAgentCount: number;
  windowActiveAgentCount: number;
  runnerMonthlyCost: CostEstimate;
  estimatedInfrastructureCost: CostEstimate;
  estimatedInfrastructureCostPerAgent: CostEstimate;
};

export type CostEstimateWindowDto = {
  key: CostEstimateWindowKey;
  startsAt: string;
  endsAt: string;
  durationMs: number;
  runnerCount: number;
  runningAgentCount: number;
  windowActiveAgentCount: number;
  runnerMonthlyCost: CostEstimate;
  estimatedInfrastructureCost: CostEstimate;
  estimatedInfrastructureCostPerAgent: CostEstimate;
  runners: RunnerCostEstimateDto[];
};

export type DevelopmentUserCostEstimatesDto = {
  generatedAt: string;
  daily: CostEstimateWindowDto;
  monthly: CostEstimateWindowDto;
};

export type UsageInterval = {
  startedAt: Date;
  stoppedAt: Date | null;
};

type Window = {
  key: CostEstimateWindowKey;
  startsAt: Date;
  endsAt: Date;
  durationMs: number;
};

type RunnerRow = {
  id: string;
  name: string;
  kind: string;
  sizeSlug: string | null;
  deletedAt: Date | null;
};

type UsagePeriodRow = UsageInterval & {
  agentId: string;
  runnerId: string;
};

type RunningAgentRow = {
  id: string;
  runnerId: string;
};

type InternalRunnerEstimate = {
  dto: RunnerCostEstimateDto;
  monthlyCents: number | null;
  estimatedCents: number | null;
  activeAgentIds: Set<string>;
  runningAgentIds: Set<string>;
};

export class CostEstimatePersistenceError extends Error {
  constructor() {
    super("Cost estimate calculation failed.");
    this.name = "CostEstimatePersistenceError";
  }
}

export async function getCostEstimatesForDevelopmentUser(
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<DevelopmentUserCostEstimatesDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    assertValidClock(now);
    const userId = await connection.db.transaction((tx) => getDevelopmentUserId(tx));

    if (!userId) {
      return toEmptyCostEstimates(createWindows(now), now);
    }

    return await getCostEstimatesForUser(userId, {
      createConnection: () => connection,
      now: () => now,
    });
  } catch (error) {
    if (error instanceof CostEstimatePersistenceError) {
      throw error;
    }

    throw new CostEstimatePersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function getCostEstimatesForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<DevelopmentUserCostEstimatesDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    assertValidClock(now);

    return await connection.db.transaction(async (tx) => {
      const windows = createWindows(now);

      const [runnerRows, runningAgentRows, usageRows] = await Promise.all([
        tx
          .select({
            id: runners.id,
            name: runners.name,
            kind: runners.kind,
            sizeSlug: runners.sizeSlug,
            deletedAt: runners.deletedAt,
          })
          .from(runners)
          .where(eq(runners.userId, userId)),
        tx
          .select({
            id: agents.id,
            runnerId: agents.runnerId,
          })
          .from(agents)
          .where(
            and(
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
              isNotNull(agents.runnerId),
              inArray(agents.status, [...RUNNING_AGENT_STATUSES]),
            ),
          ),
        tx
          .select({
            agentId: agentUsagePeriods.agentId,
            runnerId: runners.id,
            startedAt: agentUsagePeriods.startedAt,
            stoppedAt: agentUsagePeriods.stoppedAt,
          })
          .from(agentUsagePeriods)
          .innerJoin(agents, eq(agentUsagePeriods.agentId, agents.id))
          .innerJoin(runners, eq(agentUsagePeriods.runnerId, runners.id))
          .where(
            and(
              eq(agents.userId, userId),
              eq(runners.userId, userId),
              lt(agentUsagePeriods.startedAt, windows.daily.endsAt),
              or(
                isNull(agentUsagePeriods.stoppedAt),
                gt(agentUsagePeriods.stoppedAt, windows.monthly.startsAt),
              ),
            ),
          ),
      ]);

      const scopedRunningAgentRows = runningAgentRows.flatMap((row) =>
        row.runnerId === null ? [] : [{ id: row.id, runnerId: row.runnerId }],
      );

      return {
        generatedAt: now.toISOString(),
        daily: calculateWindowEstimate(
          windows.daily,
          runnerRows,
          usageRows,
          scopedRunningAgentRows,
        ),
        monthly: calculateWindowEstimate(
          windows.monthly,
          runnerRows,
          usageRows,
          scopedRunningAgentRows,
        ),
      };
    });
  } catch (error) {
    if (error instanceof CostEstimatePersistenceError) {
      throw error;
    }

    throw new CostEstimatePersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export function clipUsageIntervalToWindow(
  interval: UsageInterval,
  window: { startsAt: Date; endsAt: Date },
): { startsAt: Date; endsAt: Date } | null {
  const intervalStartMs = interval.startedAt.getTime();
  const intervalEndMs = (interval.stoppedAt ?? window.endsAt).getTime();
  const windowStartMs = window.startsAt.getTime();
  const windowEndMs = window.endsAt.getTime();

  if (
    !Number.isFinite(intervalStartMs) ||
    !Number.isFinite(intervalEndMs) ||
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(windowEndMs) ||
    intervalEndMs <= intervalStartMs ||
    windowEndMs <= windowStartMs
  ) {
    return null;
  }

  const startsAtMs = Math.max(intervalStartMs, windowStartMs);
  const endsAtMs = Math.min(intervalEndMs, windowEndMs);

  if (endsAtMs <= startsAtMs) {
    return null;
  }

  return {
    startsAt: new Date(startsAtMs),
    endsAt: new Date(endsAtMs),
  };
}

export function unionUsageIntervalDurationMs(
  intervals: UsageInterval[],
  window: { startsAt: Date; endsAt: Date },
): number {
  const clipped = intervals
    .map((interval) => clipUsageIntervalToWindow(interval, window))
    .filter((interval): interval is NonNullable<typeof interval> => interval !== null)
    .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());

  let durationMs = 0;
  let currentStartMs: number | null = null;
  let currentEndMs: number | null = null;

  for (const interval of clipped) {
    const startMs = interval.startsAt.getTime();
    const endMs = interval.endsAt.getTime();

    if (currentStartMs === null || currentEndMs === null) {
      currentStartMs = startMs;
      currentEndMs = endMs;
      continue;
    }

    if (startMs <= currentEndMs) {
      currentEndMs = Math.max(currentEndMs, endMs);
      continue;
    }

    durationMs += currentEndMs - currentStartMs;
    currentStartMs = startMs;
    currentEndMs = endMs;
  }

  if (currentStartMs !== null && currentEndMs !== null) {
    durationMs += currentEndMs - currentStartMs;
  }

  return durationMs;
}

function calculateWindowEstimate(
  window: Window,
  runnerRows: RunnerRow[],
  usageRows: UsagePeriodRow[],
  runningAgentRows: RunningAgentRow[],
): CostEstimateWindowDto {
  const includedRunnerRows = runnerRows.filter(
    (runner) =>
      runner.deletedAt === null ||
      usageRows.some(
        (usage) =>
          usage.runnerId === runner.id && clipUsageIntervalToWindow(usage, window) !== null,
      ),
  );
  const internalRunnerEstimates = includedRunnerRows.map((runner) =>
    calculateRunnerEstimate(window, runner, usageRows, runningAgentRows),
  );
  const allPricesAvailable = internalRunnerEstimates.every(
    (estimate) => estimate.monthlyCents !== null && estimate.estimatedCents !== null,
  );
  const totalMonthlyCents = allPricesAvailable
    ? internalRunnerEstimates.reduce((sum, estimate) => sum + (estimate.monthlyCents ?? 0), 0)
    : null;
  const totalEstimatedCents = allPricesAvailable
    ? internalRunnerEstimates.reduce((sum, estimate) => sum + (estimate.estimatedCents ?? 0), 0)
    : null;
  const activeAgentIds = unionSets(
    internalRunnerEstimates.map((estimate) => estimate.activeAgentIds),
  );
  const runningAgentIds = unionSets(
    internalRunnerEstimates.map((estimate) => estimate.runningAgentIds),
  );

  return {
    key: window.key,
    startsAt: window.startsAt.toISOString(),
    endsAt: window.endsAt.toISOString(),
    durationMs: window.durationMs,
    runnerCount: internalRunnerEstimates.length,
    runningAgentCount: runningAgentIds.size,
    windowActiveAgentCount: activeAgentIds.size,
    runnerMonthlyCost:
      totalMonthlyCents === null
        ? unavailableEstimate(
            "incomplete_runner_prices",
            "A total is unavailable because at least one runner does not have provider price metadata.",
          )
        : availableEstimate(totalMonthlyCents),
    estimatedInfrastructureCost:
      totalEstimatedCents === null
        ? unavailableEstimate(
            "incomplete_runner_prices",
            "A total is unavailable because at least one runner does not have provider price metadata.",
          )
        : availableEstimate(totalEstimatedCents),
    estimatedInfrastructureCostPerAgent:
      totalEstimatedCents === null
        ? unavailableEstimate(
            "incomplete_runner_prices",
            "A per-agent estimate is unavailable because at least one runner does not have provider price metadata.",
          )
        : activeAgentIds.size === 0
          ? unavailableEstimate(
              "no_active_agents",
              "A per-agent estimate is unavailable because no agents were active in this window.",
            )
          : availableEstimate(totalEstimatedCents / activeAgentIds.size),
    runners: internalRunnerEstimates.map((estimate) => estimate.dto),
  };
}

function calculateRunnerEstimate(
  window: Window,
  runner: RunnerRow,
  usageRows: UsagePeriodRow[],
  runningAgentRows: RunningAgentRow[],
): InternalRunnerEstimate {
  const runnerUsageRows = usageRows.filter((row) => row.runnerId === runner.id);
  const activeAgentIds = new Set(
    runnerUsageRows
      .filter((row) => clipUsageIntervalToWindow(row, window) !== null)
      .map((row) => row.agentId),
  );
  const runningAgentIds = new Set<string>();

  for (const row of runningAgentRows) {
    if (row.runnerId === runner.id) {
      runningAgentIds.add(row.id);
    }
  }
  const uptimeMs = unionUsageIntervalDurationMs(runnerUsageRows, window);
  const price =
    runner.kind === DIGITALOCEAN_RUNNER_KIND
      ? getDigitalOceanRunnerPriceMetadata(runner.sizeSlug)
      : null;

  if (!price?.available) {
    const reason = runner.kind === DIGITALOCEAN_RUNNER_KIND ? "unsupported_size" : "manual_runner";
    const explanation =
      reason === "manual_runner"
        ? "Cost estimates are unavailable for manual runners without provider price metadata."
        : "Cost estimates are unavailable for this DigitalOcean runner size.";
    const unavailable = unavailableEstimate(reason, explanation);

    return {
      dto: {
        runnerId: runner.id,
        runnerName: runner.name,
        runnerKind: runner.kind,
        sizeSlug: runner.sizeSlug,
        uptimeMs,
        runningAgentCount: runningAgentIds.size,
        windowActiveAgentCount: activeAgentIds.size,
        runnerMonthlyCost: unavailable,
        estimatedInfrastructureCost: unavailable,
        estimatedInfrastructureCostPerAgent: unavailable,
      },
      monthlyCents: null,
      estimatedCents: null,
      activeAgentIds,
      runningAgentIds,
    };
  }

  const estimatedCents = price.monthlyCents * (uptimeMs / MONTH_MS);

  return {
    dto: {
      runnerId: runner.id,
      runnerName: runner.name,
      runnerKind: runner.kind,
      sizeSlug: price.sizeSlug,
      uptimeMs,
      runningAgentCount: runningAgentIds.size,
      windowActiveAgentCount: activeAgentIds.size,
      runnerMonthlyCost: availableEstimate(price.monthlyCents),
      estimatedInfrastructureCost: availableEstimate(estimatedCents),
      estimatedInfrastructureCostPerAgent:
        activeAgentIds.size === 0
          ? unavailableEstimate(
              "no_active_agents",
              "A per-agent estimate is unavailable because no agents were active on this runner in this window.",
            )
          : availableEstimate(estimatedCents / activeAgentIds.size),
    },
    monthlyCents: price.monthlyCents,
    estimatedCents,
    activeAgentIds,
    runningAgentIds,
  };
}

function createWindows(now: Date): { daily: Window; monthly: Window } {
  return {
    daily: {
      key: "daily",
      startsAt: new Date(now.getTime() - DAY_MS),
      endsAt: new Date(now),
      durationMs: DAY_MS,
    },
    monthly: {
      key: "monthly",
      startsAt: new Date(now.getTime() - MONTH_MS),
      endsAt: new Date(now),
      durationMs: MONTH_MS,
    },
  };
}

function toEmptyCostEstimates(
  windows: { daily: Window; monthly: Window },
  now: Date,
): DevelopmentUserCostEstimatesDto {
  return {
    generatedAt: now.toISOString(),
    daily: calculateWindowEstimate(windows.daily, [], [], []),
    monthly: calculateWindowEstimate(windows.monthly, [], [], []),
  };
}

function availableEstimate(cents: number): AvailableCostEstimate {
  return {
    available: true,
    cents: Math.round(cents),
    currency: "USD",
    label: ESTIMATE_LABEL,
    explanation: RAW_COMPUTE_EXPLANATION,
  };
}

function unavailableEstimate(
  reason: CostEstimateUnavailableReason,
  explanation: string,
): UnavailableCostEstimate {
  return {
    available: false,
    reason,
    label: "Estimate unavailable",
    explanation,
  };
}

function unionSets(sets: Set<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

function assertValidClock(now: Date): void {
  if (!Number.isFinite(now.getTime())) {
    throw new CostEstimatePersistenceError();
  }
}
