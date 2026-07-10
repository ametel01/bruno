import "server-only";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  getCostEstimatesForDevelopmentUser,
  getCostEstimatesForUser,
  type RunnerCostEstimateDto,
} from "@/src/server/costs/cost-estimates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, runners } from "@/src/server/db/schema";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

type RunnerCostContextDependencies = {
  createConnection?: () => DatabaseConnection;
  loadCostEstimates?: () => Promise<{
    monthly: { runners: RunnerCostEstimateDto[] };
  }>;
  now?: () => Date;
};

export class RunnerCostContextPersistenceError extends Error {
  constructor() {
    super("Runner cost context failed.");
    this.name = "RunnerCostContextPersistenceError";
  }
}

export async function getMonthlyRunnerCostForUserAgent(
  userId: string,
  agentId: string,
  dependencies: RunnerCostContextDependencies = {},
): Promise<RunnerCostEstimateDto | null> {
  if (!isValidAgentId(agentId)) {
    return null;
  }

  try {
    const [runnerId, estimates] = await Promise.all([
      getAssignedRunnerIdForUser(userId, agentId, dependencies.createConnection),
      dependencies.loadCostEstimates?.() ??
        getCostEstimatesForUser(userId, {
          ...(dependencies.now ? { now: dependencies.now } : {}),
        }),
    ]);

    if (!runnerId) {
      return null;
    }

    return estimates.monthly.runners.find((runner) => runner.runnerId === runnerId) ?? null;
  } catch {
    throw new RunnerCostContextPersistenceError();
  }
}

export async function getMonthlyRunnerCostForDevelopmentUserAgent(
  agentId: string,
  dependencies: RunnerCostContextDependencies = {},
): Promise<RunnerCostEstimateDto | null> {
  if (!isValidAgentId(agentId)) {
    return null;
  }

  try {
    const [runnerId, estimates] = await Promise.all([
      getAssignedRunnerId(agentId, dependencies.createConnection),
      dependencies.loadCostEstimates?.() ??
        getCostEstimatesForDevelopmentUser({
          ...(dependencies.now ? { now: dependencies.now } : {}),
        }),
    ]);

    if (!runnerId) {
      return null;
    }

    return estimates.monthly.runners.find((runner) => runner.runnerId === runnerId) ?? null;
  } catch {
    throw new RunnerCostContextPersistenceError();
  }
}

async function getAssignedRunnerId(
  agentId: string,
  createConnection: (() => DatabaseConnection) | undefined,
): Promise<string | null> {
  const connection = createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId) {
        return null;
      }

      const [row] = await tx
        .select({ runnerId: agents.runnerId })
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

      return row?.runnerId ?? null;
    });
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function getAssignedRunnerIdForUser(
  userId: string,
  agentId: string,
  createConnection: (() => DatabaseConnection) | undefined,
): Promise<string | null> {
  const connection = createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ runnerId: agents.runnerId })
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

      return row?.runnerId ?? null;
    });
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}
