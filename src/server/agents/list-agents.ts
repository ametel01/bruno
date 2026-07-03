import { desc, isNull } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents } from "@/src/server/db/schema";

export type ListedAgent = {
  id: string;
  name: string;
  templateKey: string;
  status: "stopped";
  href: string;
  createdAt: string;
};

export type ListAgentsDependencies = {
  createConnection?: () => DatabaseConnection;
};

export class AgentListPersistenceError extends Error {
  constructor() {
    super("Agent list failed.");
    this.name = "AgentListPersistenceError";
  }
}

export async function listActiveAgentsForDevelopmentUser(
  dependencies: ListAgentsDependencies = {},
): Promise<ListedAgent[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const rows = await connection.db
      .select({
        id: agents.id,
        name: agents.name,
        templateKey: agents.templateKey,
        status: agents.status,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(isNull(agents.deletedAt))
      .orderBy(desc(agents.createdAt), desc(agents.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      templateKey: row.templateKey,
      status: "stopped",
      href: `/agents/${row.id}`,
      createdAt: row.createdAt.toISOString(),
    }));
  } catch {
    throw new AgentListPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}
