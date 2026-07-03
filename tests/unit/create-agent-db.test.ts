import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentPersistenceError,
  createAgentForDevelopmentUser,
} from "@/src/server/agents/create-agent";
import { listActiveAgentsForDevelopmentUser } from "@/src/server/agents/list-agents";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentEvents, agents, appMetadata, users } from "@/src/server/db/schema";

describe("create agent persistence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetCreateAgentTables(connection);
  });

  afterEach(async () => {
    await resetCreateAgentTables(connection);
    await connection.close();
  });

  it("creates a stopped agent, reuses the development user, and records exactly one event", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Research Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const second = await createAgentForDevelopmentUser(
      { name: "Inbox Agent", templateKey: "inbox_triage_agent" },
      { createConnection: () => connection },
    );
    const persistedAgents = await connection.db.select().from(agents).orderBy(agents.createdAt);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .orderBy(agentEvents.createdAt);
    const persistedUsers = await connection.db.select().from(users);
    const metadata = await connection.db.select().from(appMetadata);

    expect(created.agent).toMatchObject({
      userId: second.agent.userId,
      name: "Research Agent",
      templateKey: "research_agent",
      status: "stopped",
      statusReason: null,
      deletedAt: null,
    });
    expect(persistedUsers).toHaveLength(1);
    expect(persistedAgents).toHaveLength(2);
    expect(persistedEvents).toHaveLength(2);
    expect(persistedEvents.filter((event) => event.agentId === created.agent.id)).toHaveLength(1);
    expect(persistedEvents[0]).toMatchObject({
      actorUserId: created.agent.userId,
      type: "agent.created",
      metadata: {
        templateKey: "research_agent",
        status: "stopped",
      },
    });
    expect(metadata).toContainEqual(
      expect.objectContaining({
        key: "local_development_user_id",
        value: created.agent.userId,
      }),
    );
  });

  it("rolls back the agent and development user when event creation fails", async () => {
    await expect(
      createAgentForDevelopmentUser(
        { name: "Research Agent", templateKey: "research_agent" },
        {
          createConnection: () => connection,
          insertCreatedEvent: async () => {
            throw new Error("synthetic event failure");
          },
        },
      ),
    ).rejects.toBeInstanceOf(AgentPersistenceError);

    await expectTableCount(connection, "users", 0);
    await expectTableCount(connection, "agents", 0);
    await expectTableCount(connection, "agent_events", 0);
    await expectTableCount(connection, "app_metadata", 0);
  });

  it("lists active persisted agents with stopped status and stable links", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";

    const [oldAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Inbox Agent",
        templateKey: "inbox_triage_agent",
        status: "stopped",
        createdAt: new Date("2026-07-03T04:00:00.000Z"),
      })
      .returning();
    const [newAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Research Agent",
        templateKey: "research_agent",
        status: "stopped",
        createdAt: new Date("2026-07-03T05:00:00.000Z"),
      })
      .returning();
    await connection.db.insert(agents).values({
      userId,
      name: "Deleted Agent",
      templateKey: "github_issue_agent",
      status: "stopped",
      deletedAt: new Date("2026-07-03T06:00:00.000Z"),
    });

    const listed = await listActiveAgentsForDevelopmentUser({ createConnection: () => connection });

    expect(oldAgent).toBeDefined();
    expect(newAgent).toBeDefined();
    expect(listed).toEqual([
      {
        id: newAgent?.id,
        name: "Research Agent",
        templateKey: "research_agent",
        status: "stopped",
        href: `/agents/${newAgent?.id}`,
        createdAt: "2026-07-03T05:00:00.000Z",
      },
      {
        id: oldAgent?.id,
        name: "Inbox Agent",
        templateKey: "inbox_triage_agent",
        status: "stopped",
        href: `/agents/${oldAgent?.id}`,
        createdAt: "2026-07-03T04:00:00.000Z",
      },
    ]);
  });
});

async function resetCreateAgentTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_events, agents, app_metadata, users restart identity cascade`;
}

async function expectTableCount(
  connection: DatabaseConnection,
  tableName: "users" | "agents" | "agent_events" | "app_metadata",
  expected: number,
): Promise<void> {
  const [row] = await connection.db.execute<{ count: string }>(
    sql.raw(`select count(*)::text as count from ${tableName}`),
  );

  expect(Number(row?.count)).toBe(expected);
}
