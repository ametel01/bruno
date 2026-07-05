import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { validateManualRunnerEndpointUrl } from "@/src/env/validation";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, runners } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import {
  getDevelopmentUserId,
  getOrCreateDevelopmentUserId,
} from "@/src/server/users/development-user";

export const DEFAULT_MANUAL_RUNNER_NAME = "Manual VPS Runner";
export const MANUAL_RUNNER_KIND = "manual_vps";
export const ACTIVE_RUNNER_STATUS = "active";

export type ManualRunnerRecord = {
  id: string;
  userId: string;
  name: string;
  kind: typeof MANUAL_RUNNER_KIND;
  endpointUrl: string;
  status: typeof ACTIVE_RUNNER_STATUS | "inactive";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type ManualRunnerBootstrapConfig = {
  name: string;
  kind: typeof MANUAL_RUNNER_KIND;
  endpointUrl: string;
  status: typeof ACTIVE_RUNNER_STATUS;
};

export type AssignRunnerToAgentResult =
  | {
      ok: true;
      agent: {
        id: string;
        runnerId: string;
      };
    }
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id" | "agent_not_found" | "runner_not_found";
    };

type ManualRunnerTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export function readManualRunnerBootstrapConfig(
  input: Record<string, string | undefined> = process.env,
): ManualRunnerBootstrapConfig | null {
  const rawEndpointUrl = input.AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL;

  if (rawEndpointUrl === undefined) {
    return null;
  }

  const endpointUrl = validateManualRunnerEndpointUrl(rawEndpointUrl);
  const name = input.AGENTBAY_MANUAL_RUNNER_NAME?.trim() || DEFAULT_MANUAL_RUNNER_NAME;

  return {
    name,
    kind: MANUAL_RUNNER_KIND,
    endpointUrl,
    status: ACTIVE_RUNNER_STATUS,
  };
}

export async function bootstrapManualRunnerForDevelopmentUser(
  dependencies: {
    createConnection?: () => DatabaseConnection;
    env?: Record<string, string | undefined>;
    now?: () => Date;
  } = {},
): Promise<ManualRunnerRecord | null> {
  const config = readManualRunnerBootstrapConfig(dependencies.env);

  if (!config) {
    return null;
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const userId = await getOrCreateDevelopmentUserId(tx);

      return upsertManualRunnerInTransaction(tx, {
        userId,
        config,
        now,
      });
    });
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function assignRunnerToActiveAgentForDevelopmentUser(
  input: {
    agentId: string;
    runnerId: string;
  },
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
  } = {},
): Promise<AssignRunnerToAgentResult> {
  const normalizedAgentId = input.agentId.trim();
  const normalizedRunnerId = input.runnerId.trim();

  if (normalizedAgentId.length === 0) {
    return { ok: false, reason: "missing_agent_id" };
  }

  if (!isValidAgentId(normalizedAgentId) || !isValidAgentId(normalizedRunnerId)) {
    return { ok: false, reason: "malformed_agent_id" };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      const [runner] = await tx
        .select({ id: runners.id })
        .from(runners)
        .where(
          and(
            eq(runners.id, normalizedRunnerId),
            eq(runners.userId, userId),
            eq(runners.status, ACTIVE_RUNNER_STATUS),
            isNull(runners.deletedAt),
          ),
        )
        .limit(1);

      if (!runner) {
        return { ok: false, reason: "runner_not_found" } as const;
      }

      const [agent] = await tx
        .update(agents)
        .set({
          runnerId: runner.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
          ),
        )
        .returning({ id: agents.id, runnerId: agents.runnerId });

      if (!agent?.runnerId) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      return {
        ok: true,
        agent: {
          id: agent.id,
          runnerId: agent.runnerId,
        },
      } as const;
    });
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function getAssignedRunnerForActiveAgentDevelopmentUser(
  agentId: string,
  dependencies: {
    createConnection?: () => DatabaseConnection;
  } = {},
): Promise<ManualRunnerRecord | null> {
  const normalizedAgentId = agentId.trim();

  if (!isValidAgentId(normalizedAgentId)) {
    return null;
  }

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
          userId: runners.userId,
          name: runners.name,
          kind: runners.kind,
          endpointUrl: runners.endpointUrl,
          status: runners.status,
          createdAt: runners.createdAt,
          updatedAt: runners.updatedAt,
          deletedAt: runners.deletedAt,
        })
        .from(agents)
        .innerJoin(runners, eq(runners.id, agents.runnerId))
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
            eq(runners.userId, userId),
            eq(runners.status, ACTIVE_RUNNER_STATUS),
            isNull(runners.deletedAt),
          ),
        )
        .limit(1);

      return row ? toManualRunnerRecord(row) : null;
    });
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function upsertManualRunnerInTransaction(
  tx: ManualRunnerTransaction,
  input: {
    userId: string;
    config: ManualRunnerBootstrapConfig;
    now: Date;
  },
): Promise<ManualRunnerRecord> {
  const [existingRunner] = await tx
    .select()
    .from(runners)
    .where(
      and(
        eq(runners.userId, input.userId),
        eq(runners.endpointUrl, input.config.endpointUrl),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  if (existingRunner) {
    const [updatedRunner] = await tx
      .update(runners)
      .set({
        name: input.config.name,
        kind: input.config.kind,
        status: input.config.status,
        updatedAt: input.now,
      })
      .where(eq(runners.id, existingRunner.id))
      .returning();

    if (!updatedRunner) {
      throw new Error("Manual runner update returned no rows.");
    }

    return toManualRunnerRecord(updatedRunner);
  }

  const [createdRunner] = await tx
    .insert(runners)
    .values({
      userId: input.userId,
      name: input.config.name,
      kind: input.config.kind,
      endpointUrl: input.config.endpointUrl,
      status: input.config.status,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();

  if (!createdRunner) {
    throw new Error("Manual runner insert returned no rows.");
  }

  return toManualRunnerRecord(createdRunner);
}

function toManualRunnerRecord(
  row: Pick<
    typeof runners.$inferSelect,
    | "id"
    | "userId"
    | "name"
    | "kind"
    | "endpointUrl"
    | "status"
    | "createdAt"
    | "updatedAt"
    | "deletedAt"
  >,
): ManualRunnerRecord {
  if (!row.endpointUrl) {
    throw new Error("Manual runner row is missing an endpoint URL.");
  }

  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    kind: row.kind as typeof MANUAL_RUNNER_KIND,
    endpointUrl: row.endpointUrl,
    status: row.status as ManualRunnerRecord["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
