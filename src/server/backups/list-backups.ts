import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import type { BackupStatus } from "@/src/server/backups/backup-manifest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, backups } from "@/src/server/db/schema";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export type AgentBackupSummary = {
  id: string;
  agentId: string;
  status: BackupStatus;
  createdAt: string;
  restoredAt: string | null;
  canRestore: boolean;
};

export type ListAgentBackupsDependencies = {
  createConnection?: () => DatabaseConnection;
};

export class AgentBackupListPersistenceError extends Error {
  constructor() {
    super("Agent backup list failed.");
    this.name = "AgentBackupListPersistenceError";
  }
}

export async function listAgentBackupsForUser(
  userId: string,
  agentId: string,
  dependencies: ListAgentBackupsDependencies = {},
): Promise<AgentBackupSummary[]> {
  if (!isValidAgentId(agentId)) {
    return [];
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const rows = await connection.db.transaction(async (tx) => {
      return await tx
        .select({
          id: backups.id,
          agentId: backups.agentId,
          status: backups.status,
          createdAt: backups.createdAt,
          restoredAt: backups.restoredAt,
        })
        .from(backups)
        .innerJoin(agents, eq(agents.id, backups.agentId))
        .where(
          and(
            eq(backups.agentId, agentId),
            eq(backups.createdBy, userId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
          ),
        )
        .orderBy(desc(backups.createdAt), desc(backups.id));
    });

    return rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      restoredAt: row.restoredAt?.toISOString() ?? null,
      canRestore: row.status === "ready",
    }));
  } catch {
    throw new AgentBackupListPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listAgentBackupsForDevelopmentUser(
  agentId: string,
  dependencies: ListAgentBackupsDependencies = {},
): Promise<AgentBackupSummary[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const userId = await connection.db.transaction((tx) => getDevelopmentUserId(tx));

    if (!userId) {
      return [];
    }

    return await listAgentBackupsForUser(userId, agentId, {
      ...dependencies,
      createConnection: () => connection,
    });
  } catch {
    throw new AgentBackupListPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}
