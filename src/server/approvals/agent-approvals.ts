import { and, desc, eq, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/lifecycle";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentApprovals, agents } from "@/src/server/db/schema";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export type PendingApprovalDto = {
  id: string;
  agentId: string;
  agentName: string;
  agentHref: string;
  title: string;
  description: string;
  status: "pending";
  requestedBy: string;
  createdAt: string;
  expiresAt: string | null;
};

export type CreatePendingApprovalInput = {
  agentId: string;
  title: string;
  description: string;
  payloadJson: Record<string, unknown>;
  requestedBy: string;
  expiresAt?: Date | null;
  createdAt?: Date;
};

export type AgentApprovalDependencies = {
  createConnection?: () => DatabaseConnection;
};

export class AgentApprovalPersistenceError extends Error {
  constructor() {
    super("Approval request failed.");
    this.name = "AgentApprovalPersistenceError";
  }
}

export async function createPendingApprovalForDevelopmentUser(
  input: CreatePendingApprovalInput,
  dependencies: AgentApprovalDependencies = {},
): Promise<PendingApprovalDto | null> {
  if (!isValidAgentId(input.agentId)) {
    return null;
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const developmentUserId = await getDevelopmentUserId(tx);

      if (!developmentUserId) {
        return null;
      }

      const [agent] = await tx
        .select({
          id: agents.id,
          name: agents.name,
        })
        .from(agents)
        .where(
          and(
            eq(agents.id, input.agentId),
            eq(agents.userId, developmentUserId),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);

      if (!agent) {
        return null;
      }

      const [approval] = await tx
        .insert(agentApprovals)
        .values({
          agentId: agent.id,
          title: input.title,
          description: input.description,
          status: "pending",
          payloadJson: input.payloadJson,
          requestedBy: input.requestedBy,
          resolvedBy: null,
          resolvedAt: null,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();

      if (!approval) {
        throw new Error("Approval insert returned no rows.");
      }

      return toPendingApprovalDto(approval, agent);
    });
  } catch {
    throw new AgentApprovalPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listPendingApprovalsForDevelopmentUser(
  dependencies: AgentApprovalDependencies = {},
): Promise<PendingApprovalDto[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const developmentUserId = await connection.db.transaction((tx) => getDevelopmentUserId(tx));

    if (!developmentUserId) {
      return [];
    }

    const rows = await connection.db
      .select({
        id: agentApprovals.id,
        agentId: agentApprovals.agentId,
        title: agentApprovals.title,
        description: agentApprovals.description,
        status: agentApprovals.status,
        requestedBy: agentApprovals.requestedBy,
        createdAt: agentApprovals.createdAt,
        expiresAt: agentApprovals.expiresAt,
        agentName: agents.name,
      })
      .from(agentApprovals)
      .innerJoin(agents, eq(agents.id, agentApprovals.agentId))
      .where(
        and(
          eq(agentApprovals.status, "pending"),
          eq(agents.userId, developmentUserId),
          isNull(agents.deletedAt),
        ),
      )
      .orderBy(desc(agentApprovals.createdAt), desc(agentApprovals.id));

    return rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      agentHref: `/agents/${row.agentId}`,
      title: row.title,
      description: row.description,
      status: "pending",
      requestedBy: row.requestedBy,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }));
  } catch {
    throw new AgentApprovalPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listPendingApprovalsForDevelopmentUserAgent(
  agentId: string,
  dependencies: AgentApprovalDependencies = {},
): Promise<PendingApprovalDto[]> {
  if (!isValidAgentId(agentId)) {
    return [];
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const developmentUserId = await connection.db.transaction((tx) => getDevelopmentUserId(tx));

    if (!developmentUserId) {
      return [];
    }

    const rows = await connection.db
      .select({
        id: agentApprovals.id,
        agentId: agentApprovals.agentId,
        title: agentApprovals.title,
        description: agentApprovals.description,
        status: agentApprovals.status,
        requestedBy: agentApprovals.requestedBy,
        createdAt: agentApprovals.createdAt,
        expiresAt: agentApprovals.expiresAt,
        agentName: agents.name,
      })
      .from(agentApprovals)
      .innerJoin(agents, eq(agents.id, agentApprovals.agentId))
      .where(
        and(
          eq(agentApprovals.agentId, agentId),
          eq(agentApprovals.status, "pending"),
          eq(agents.userId, developmentUserId),
          isNull(agents.deletedAt),
        ),
      )
      .orderBy(desc(agentApprovals.createdAt), desc(agentApprovals.id));

    return rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      agentHref: `/agents/${row.agentId}`,
      title: row.title,
      description: row.description,
      status: "pending",
      requestedBy: row.requestedBy,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }));
  } catch {
    throw new AgentApprovalPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function toPendingApprovalDto(
  approval: typeof agentApprovals.$inferSelect,
  agent: { id: string; name: string },
): PendingApprovalDto {
  return {
    id: approval.id,
    agentId: approval.agentId,
    agentName: agent.name,
    agentHref: `/agents/${agent.id}`,
    title: approval.title,
    description: approval.description,
    status: "pending",
    requestedBy: approval.requestedBy,
    createdAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt?.toISOString() ?? null,
  };
}
