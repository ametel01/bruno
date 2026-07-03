import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentPersistenceError,
  createAgentForDevelopmentUser,
} from "@/src/server/agents/create-agent";
import {
  DELETE_EVENT_TYPE,
  FAKE_RUNNER_START_DELAY_MS,
  RESTART_COMPLETED_EVENT_TYPE,
  RESTART_REQUESTED_EVENT_TYPE,
  START_COMPLETED_EVENT_TYPE,
  START_REQUESTED_EVENT_TYPE,
  STOP_COMPLETED_EVENT_TYPE,
  STOP_REQUESTED_EVENT_TYPE,
  deleteAgentForDevelopmentUser,
  restartAgentForDevelopmentUser,
  settleDueFakeRunnerTransitions,
  settleDueStartingAgents,
  startAgentForDevelopmentUser,
  stopAgentForDevelopmentUser,
  type AgentLifecycleStatus,
} from "@/src/server/agents/lifecycle";
import {
  getActiveAgentForDevelopmentUser,
  listActiveAgentsForDevelopmentUser,
} from "@/src/server/agents/list-agents";
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
        templateLabel: "Research Agent",
        status: "stopped",
        href: `/agents/${newAgent?.id}`,
        createdAt: "2026-07-03T05:00:00.000Z",
      },
      {
        id: oldAgent?.id,
        name: "Inbox Agent",
        templateKey: "inbox_triage_agent",
        templateLabel: "Inbox Triage Agent",
        status: "stopped",
        href: `/agents/${oldAgent?.id}`,
        createdAt: "2026-07-03T04:00:00.000Z",
      },
    ]);
  });

  it("lists and loads settled start and restart lifecycle statuses without hard-coded stopped values", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const dueStartingAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS - 1);
    const dueRestartingAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS - 2);

    const [runningAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Already Running Agent",
        templateKey: "research_agent",
        status: "running",
        createdAt: new Date("2026-07-03T04:00:00.000Z"),
        updatedAt: new Date("2026-07-03T04:00:00.000Z"),
      })
      .returning();
    const [startingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Due Starting Agent",
        templateKey: "github_issue_agent",
        status: "starting",
        createdAt: new Date("2026-07-03T05:00:00.000Z"),
        updatedAt: dueStartingAt,
      })
      .returning();
    const [restartingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Due Restarting Agent",
        templateKey: "social_content_agent",
        status: "restarting",
        statusReason: "Restart requested.",
        createdAt: new Date("2026-07-03T05:30:00.000Z"),
        updatedAt: dueRestartingAt,
      })
      .returning();

    expect(runningAgent).toBeDefined();
    expect(startingAgent).toBeDefined();
    expect(restartingAgent).toBeDefined();

    const listed = await listActiveAgentsForDevelopmentUser({ createConnection: () => connection });
    const startingDetail = await getActiveAgentForDevelopmentUser(startingAgent?.id ?? "", {
      createConnection: () => connection,
    });
    const restartingDetail = await getActiveAgentForDevelopmentUser(restartingAgent?.id ?? "", {
      createConnection: () => connection,
    });
    const startCompletedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, START_COMPLETED_EVENT_TYPE));
    const restartCompletedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, RESTART_COMPLETED_EVENT_TYPE));

    expect(listed.map((agent) => [agent.name, agent.status])).toEqual([
      ["Due Restarting Agent", "running"],
      ["Due Starting Agent", "running"],
      ["Already Running Agent", "running"],
    ]);
    expect(startingDetail?.status).toBe("running");
    expect(restartingDetail).toMatchObject({
      status: "running",
      statusReason: "Fake runner is running.",
    });
    expect(startCompletedEvents).toHaveLength(1);
    expect(startCompletedEvents[0]).toMatchObject({
      agentId: startingAgent?.id,
      actorUserId: userId,
      type: START_COMPLETED_EVENT_TYPE,
      metadata: {
        fromStatus: "starting",
        toStatus: "running",
      },
    });
    expect(restartCompletedEvents).toHaveLength(1);
    expect(restartCompletedEvents[0]).toMatchObject({
      agentId: restartingAgent?.id,
      actorUserId: userId,
      type: RESTART_COMPLETED_EVENT_TYPE,
      metadata: {
        fromStatus: "restarting",
        toStatus: "running",
      },
    });
  });

  it("loads active agent detail records with timestamps and status reason", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";

    const [createdAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "GitHub Agent",
        templateKey: "github_issue_agent",
        status: "stopped",
        statusReason: "Waiting for issue selection.",
        createdAt: new Date("2026-07-03T04:00:00.000Z"),
        updatedAt: new Date("2026-07-03T05:00:00.000Z"),
      })
      .returning();

    expect(createdAgent).toBeDefined();
    const detail = await getActiveAgentForDevelopmentUser(createdAgent?.id ?? "", {
      createConnection: () => connection,
    });

    expect(detail).toEqual({
      id: createdAgent?.id,
      name: "GitHub Agent",
      templateKey: "github_issue_agent",
      templateLabel: "GitHub Issue Agent",
      status: "stopped",
      statusReason: "Waiting for issue selection.",
      href: `/agents/${createdAgent?.id}`,
      createdAt: "2026-07-03T04:00:00.000Z",
      updatedAt: "2026-07-03T05:00:00.000Z",
    });
  });

  it("returns no detail for missing, malformed, or soft-deleted agent IDs", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";

    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Deleted Agent",
        templateKey: "research_agent",
        status: "stopped",
        deletedAt: new Date("2026-07-03T06:00:00.000Z"),
      })
      .returning();

    expect(deletedAgent).toBeDefined();

    await expect(
      getActiveAgentForDevelopmentUser("not-a-uuid", { createConnection: () => connection }),
    ).resolves.toBeNull();
    await expect(
      getActiveAgentForDevelopmentUser("00000000-0000-4000-8000-000000000000", {
        createConnection: () => connection,
      }),
    ).resolves.toBeNull();
    await expect(
      getActiveAgentForDevelopmentUser(deletedAgent?.id ?? "", {
        createConnection: () => connection,
      }),
    ).resolves.toBeNull();
  });

  it("starts idle, stopped, and error agents by persisting starting status and one requested event", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const statuses: AgentLifecycleStatus[] = ["idle", "stopped", "error"];
    const now = new Date("2026-07-03T06:00:00.000Z");

    for (const status of statuses) {
      const [agent] = await connection.db
        .insert(agents)
        .values({
          userId,
          name: `${status} Agent`,
          templateKey: "research_agent",
          status,
          statusReason: "Previous status reason.",
          createdAt: new Date("2026-07-03T05:00:00.000Z"),
          updatedAt: new Date("2026-07-03T05:00:00.000Z"),
        })
        .returning();

      expect(agent).toBeDefined();

      const result = await startAgentForDevelopmentUser(agent?.id ?? "", {
        createConnection: () => connection,
        now: () => now,
      });

      const [persistedAgent] = await connection.db
        .select()
        .from(agents)
        .where(eq(agents.id, agent?.id ?? ""))
        .limit(1);
      const persistedEvents = await connection.db
        .select()
        .from(agentEvents)
        .where(eq(agentEvents.agentId, agent?.id ?? ""));

      expect(result).toMatchObject({
        ok: true,
        agent: {
          id: agent?.id,
          status: "starting",
          statusReason: "Start requested.",
          updatedAt: "2026-07-03T06:00:00.000Z",
        },
        event: {
          type: START_REQUESTED_EVENT_TYPE,
        },
      });
      expect(persistedAgent).toMatchObject({
        status: "starting",
        statusReason: "Start requested.",
        updatedAt: now,
      });
      expect(persistedEvents).toHaveLength(1);
      expect(persistedEvents[0]).toMatchObject({
        actorUserId: userId,
        type: START_REQUESTED_EVENT_TYPE,
        metadata: {
          fromStatus: status,
          toStatus: "starting",
        },
      });
    }
  });

  it("rejects malformed, missing, soft-deleted, starting, and running starts without mutation or events", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const dueStartingAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS - 1);
    const [startingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Starting Agent",
        templateKey: "research_agent",
        status: "starting",
        updatedAt: dueStartingAt,
      })
      .returning();
    const [runningAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Running Agent",
        templateKey: "research_agent",
        status: "running",
        statusReason: "Already running.",
        updatedAt: now,
      })
      .returning();
    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Deleted Agent",
        templateKey: "research_agent",
        status: "stopped",
        statusReason: "Deleted.",
        updatedAt: now,
        deletedAt: now,
      })
      .returning();

    expect(startingAgent).toBeDefined();
    expect(runningAgent).toBeDefined();
    expect(deletedAgent).toBeDefined();

    await expect(
      startAgentForDevelopmentUser("", { createConnection: () => connection, now: () => now }),
    ).resolves.toEqual({ ok: false, reason: "missing_agent_id" });
    await expect(
      startAgentForDevelopmentUser("not-a-uuid", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed_agent_id" });
    await expect(
      startAgentForDevelopmentUser("00000000-0000-4000-8000-000000000000", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });
    await expect(
      startAgentForDevelopmentUser(deletedAgent?.id ?? "", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });
    await expect(
      startAgentForDevelopmentUser(startingAgent?.id ?? "", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_status", status: "starting" });
    await expect(
      startAgentForDevelopmentUser(runningAgent?.id ?? "", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_status", status: "running" });

    const persistedAgents = await connection.db.select().from(agents).orderBy(agents.name);
    const persistedEvents = await connection.db.select().from(agentEvents);

    expect(persistedAgents).toEqual([
      expect.objectContaining({
        id: deletedAgent?.id,
        status: "stopped",
        statusReason: "Deleted.",
        deletedAt: now,
      }),
      expect.objectContaining({
        id: runningAgent?.id,
        status: "running",
        statusReason: "Already running.",
      }),
      expect.objectContaining({
        id: startingAgent?.id,
        status: "starting",
        updatedAt: dueStartingAt,
      }),
    ]);
    expect(persistedEvents).toHaveLength(0);
  });

  it("settles only due starting agents and creates exactly one completed event after repeated polling", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const dueStartingAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS - 1);
    const pendingStartingAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS + 1);
    const [dueAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Due Agent",
        templateKey: "research_agent",
        status: "starting",
        updatedAt: dueStartingAt,
      })
      .returning();
    const [pendingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Pending Agent",
        templateKey: "research_agent",
        status: "starting",
        updatedAt: pendingStartingAt,
      })
      .returning();

    expect(dueAgent).toBeDefined();
    expect(pendingAgent).toBeDefined();

    await expect(
      settleDueStartingAgents({ createConnection: () => connection, now: () => now }),
    ).resolves.toBe(1);
    await expect(
      settleDueStartingAgents({ createConnection: () => connection, now: () => now }),
    ).resolves.toBe(0);

    const persistedAgents = await connection.db.select().from(agents).orderBy(agents.name);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, START_COMPLETED_EVENT_TYPE));

    expect(persistedAgents).toEqual([
      expect.objectContaining({
        id: dueAgent?.id,
        status: "running",
        statusReason: "Fake runner is running.",
        updatedAt: now,
      }),
      expect.objectContaining({
        id: pendingAgent?.id,
        status: "starting",
        updatedAt: pendingStartingAt,
      }),
    ]);
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]).toMatchObject({
      agentId: dueAgent?.id,
      actorUserId: userId,
      type: START_COMPLETED_EVENT_TYPE,
    });
  });

  it("exposes the start route success, validation, not-found, deleted, invalid status, and event behavior", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const [stoppedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Route Agent",
        templateKey: "research_agent",
        status: "stopped",
      })
      .returning();
    const [runningAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Running Route Agent",
        templateKey: "research_agent",
        status: "running",
      })
      .returning();
    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Deleted Route Agent",
        templateKey: "research_agent",
        status: "stopped",
        deletedAt: new Date("2026-07-03T06:00:00.000Z"),
      })
      .returning();

    expect(stoppedAgent).toBeDefined();
    expect(runningAgent).toBeDefined();
    expect(deletedAgent).toBeDefined();
    const stoppedAgentId = stoppedAgent?.id ?? "";
    const runningAgentId = runningAgent?.id ?? "";
    const deletedAgentId = deletedAgent?.id ?? "";

    const { POST } = await import("@/app/api/agents/[agentId]/actions/start/route");
    const successResponse = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: stoppedAgentId }),
    });
    const successBody = await successResponse.json();

    expect(successResponse.status).toBe(202);
    expect(successBody).toMatchObject({
      ok: true,
      agent: {
        id: stoppedAgent?.id,
        status: "starting",
      },
      event: {
        type: START_REQUESTED_EVENT_TYPE,
      },
    });

    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, stoppedAgentId));

    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]).toMatchObject({
      type: START_REQUESTED_EVENT_TYPE,
      metadata: {
        fromStatus: "stopped",
        toStatus: "starting",
      },
    });

    const missingIdResponse = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({}),
    });
    const malformedResponse = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "not-a-uuid" }),
    });
    const missingAgentResponse = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000000" }),
    });
    const deletedResponse = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: deletedAgentId }),
    });
    const invalidStatusResponse = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: runningAgentId }),
    });

    expect(missingIdResponse.status).toBe(400);
    expect(await missingIdResponse.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(missingAgentResponse.status).toBe(404);
    expect(await missingAgentResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(deletedResponse.status).toBe(404);
    expect(await deletedResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(invalidStatusResponse.status).toBe(409);
    expect(await invalidStatusResponse.json()).toMatchObject({
      error: { code: "invalid_agent_status", status: "running" },
    });

    const eventCount = await countRows(connection, "agent_events");

    expect(eventCount).toBe(1);
  });

  it("restarts running agents by persisting restarting status and one requested event", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const [runningAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Running Restart Agent",
        templateKey: "research_agent",
        status: "running",
        statusReason: "Fake runner is running.",
        createdAt: new Date("2026-07-03T05:00:00.000Z"),
        updatedAt: new Date("2026-07-03T05:30:00.000Z"),
      })
      .returning();

    expect(runningAgent).toBeDefined();

    const result = await restartAgentForDevelopmentUser(runningAgent?.id ?? "", {
      createConnection: () => connection,
      now: () => now,
    });

    const [persistedAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, runningAgent?.id ?? ""))
      .limit(1);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, runningAgent?.id ?? ""));

    expect(result).toMatchObject({
      ok: true,
      agent: {
        id: runningAgent?.id,
        status: "restarting",
        statusReason: "Restart requested.",
        updatedAt: "2026-07-03T06:00:00.000Z",
      },
      event: {
        type: RESTART_REQUESTED_EVENT_TYPE,
      },
    });
    expect(persistedAgent).toMatchObject({
      status: "restarting",
      statusReason: "Restart requested.",
      updatedAt: now,
    });
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]).toMatchObject({
      actorUserId: userId,
      type: RESTART_REQUESTED_EVENT_TYPE,
      metadata: {
        fromStatus: "running",
        toStatus: "restarting",
      },
    });
  });

  it("settles due restarts to running once without duplicate completed events", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const dueRestartingAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS - 1);
    const pendingRestartingAt = new Date("2099-07-03T06:00:00.000Z");
    const [dueAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Due Restart Agent",
        templateKey: "research_agent",
        status: "restarting",
        statusReason: "Restart requested.",
        updatedAt: dueRestartingAt,
      })
      .returning();
    const [pendingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Pending Restart Agent",
        templateKey: "research_agent",
        status: "restarting",
        statusReason: "Restart requested.",
        updatedAt: pendingRestartingAt,
      })
      .returning();

    expect(dueAgent).toBeDefined();
    expect(pendingAgent).toBeDefined();

    await expect(
      settleDueFakeRunnerTransitions({ createConnection: () => connection, now: () => now }),
    ).resolves.toBe(1);
    await expect(
      settleDueFakeRunnerTransitions({ createConnection: () => connection, now: () => now }),
    ).resolves.toBe(0);
    await getActiveAgentForDevelopmentUser(dueAgent?.id ?? "", {
      createConnection: () => connection,
    });
    await listActiveAgentsForDevelopmentUser({ createConnection: () => connection });

    const persistedAgents = await connection.db.select().from(agents).orderBy(agents.name);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, RESTART_COMPLETED_EVENT_TYPE));

    expect(persistedAgents).toEqual([
      expect.objectContaining({
        id: dueAgent?.id,
        status: "running",
        statusReason: "Fake runner is running.",
        updatedAt: now,
      }),
      expect.objectContaining({
        id: pendingAgent?.id,
        status: "restarting",
        statusReason: "Restart requested.",
        updatedAt: pendingRestartingAt,
      }),
    ]);
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]).toMatchObject({
      agentId: dueAgent?.id,
      actorUserId: userId,
      type: RESTART_COMPLETED_EVENT_TYPE,
      metadata: {
        fromStatus: "restarting",
        toStatus: "running",
      },
    });
  });

  it("settles due start and restart transitions before evaluating restart", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const dueAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS - 1);
    const [startingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Due Start Before Restart Agent",
        templateKey: "research_agent",
        status: "starting",
        statusReason: "Start requested.",
        updatedAt: dueAt,
      })
      .returning();
    const [restartingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Due Restart Before Restart Agent",
        templateKey: "research_agent",
        status: "restarting",
        statusReason: "Restart requested.",
        updatedAt: dueAt,
      })
      .returning();

    expect(startingAgent).toBeDefined();
    expect(restartingAgent).toBeDefined();

    const result = await restartAgentForDevelopmentUser(restartingAgent?.id ?? "", {
      createConnection: () => connection,
      now: () => now,
    });

    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, restartingAgent?.id ?? ""));
    const [persistedStartingAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, startingAgent?.id ?? ""))
      .limit(1);
    const [persistedRestartingAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, restartingAgent?.id ?? ""))
      .limit(1);

    expect(result).toMatchObject({
      ok: true,
      agent: {
        id: restartingAgent?.id,
        status: "restarting",
      },
    });
    expect(persistedStartingAgent).toMatchObject({
      status: "running",
      statusReason: "Fake runner is running.",
    });
    expect(persistedRestartingAgent).toMatchObject({
      status: "restarting",
      statusReason: "Restart requested.",
      updatedAt: now,
    });
    expect(persistedEvents.map((event) => event.type).sort()).toEqual([
      RESTART_COMPLETED_EVENT_TYPE,
      RESTART_REQUESTED_EVENT_TYPE,
    ]);
  });

  it("rejects malformed, missing, absent, soft-deleted, and non-running restarts without mutation or events", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const pendingTransitionAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS + 1);
    const invalidStatuses: AgentLifecycleStatus[] = [
      "idle",
      "stopped",
      "starting",
      "restarting",
      "error",
      "deleting",
    ];
    const invalidAgents: { id: string; status: AgentLifecycleStatus }[] = [];

    for (const status of invalidStatuses) {
      const [agent] = await connection.db
        .insert(agents)
        .values({
          userId,
          name: `${status} Restart Agent`,
          templateKey: "research_agent",
          status,
          statusReason: `${status} preserved reason.`,
          createdAt: new Date("2026-07-03T05:00:00.000Z"),
          updatedAt: status === "starting" || status === "restarting" ? pendingTransitionAt : now,
        })
        .returning({ id: agents.id, status: agents.status });

      expect(agent).toBeDefined();

      if (agent) {
        invalidAgents.push(agent);
      }
    }

    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Deleted Restart Agent",
        templateKey: "research_agent",
        status: "running",
        statusReason: "Deleted preserved reason.",
        updatedAt: now,
        deletedAt: now,
      })
      .returning();

    expect(deletedAgent).toBeDefined();

    const beforeAgents = await connection.db.select().from(agents).orderBy(agents.name);

    await expect(
      restartAgentForDevelopmentUser("", { createConnection: () => connection, now: () => now }),
    ).resolves.toEqual({ ok: false, reason: "missing_agent_id" });
    await expect(
      restartAgentForDevelopmentUser("not-a-uuid", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed_agent_id" });
    await expect(
      restartAgentForDevelopmentUser("00000000-0000-4000-8000-000000000000", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });
    await expect(
      restartAgentForDevelopmentUser(deletedAgent?.id ?? "", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });

    for (const agent of invalidAgents) {
      await expect(
        restartAgentForDevelopmentUser(agent.id, {
          createConnection: () => connection,
          now: () => now,
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid_status", status: agent.status });
    }

    const afterAgents = await connection.db.select().from(agents).orderBy(agents.name);
    const persistedEvents = await connection.db.select().from(agentEvents);

    expect(afterAgents).toEqual(beforeAgents);
    expect(persistedEvents).toHaveLength(0);
  });

  it("exposes the restart route success, validation, not-found, deleted, invalid status, and event behavior", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const [runningAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Route Restart Agent",
        templateKey: "research_agent",
        status: "running",
        statusReason: "Fake runner is running.",
      })
      .returning();
    const [stoppedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Stopped Restart Route Agent",
        templateKey: "research_agent",
        status: "stopped",
      })
      .returning();
    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Deleted Restart Route Agent",
        templateKey: "research_agent",
        status: "running",
        deletedAt: new Date("2026-07-03T06:00:00.000Z"),
      })
      .returning();

    expect(runningAgent).toBeDefined();
    expect(stoppedAgent).toBeDefined();
    expect(deletedAgent).toBeDefined();
    const runningAgentId = runningAgent?.id ?? "";
    const stoppedAgentId = stoppedAgent?.id ?? "";
    const deletedAgentId = deletedAgent?.id ?? "";

    const { POST } = await import("@/app/api/agents/[agentId]/actions/restart/route");
    const successResponse = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({ agentId: runningAgentId }),
    });
    const successBody = await successResponse.json();

    expect(successResponse.status).toBe(202);
    expect(successBody).toMatchObject({
      ok: true,
      agent: {
        id: runningAgent?.id,
        status: "restarting",
        statusReason: "Restart requested.",
      },
      event: { type: RESTART_REQUESTED_EVENT_TYPE },
    });

    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, runningAgentId));

    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]).toMatchObject({
      type: RESTART_REQUESTED_EVENT_TYPE,
      metadata: {
        fromStatus: "running",
        toStatus: "restarting",
      },
    });

    const missingIdResponse = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({}),
    });
    const malformedResponse = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({ agentId: "not-a-uuid" }),
    });
    const missingAgentResponse = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000000" }),
    });
    const deletedResponse = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({ agentId: deletedAgentId }),
    });
    const invalidStatusResponse = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({ agentId: stoppedAgentId }),
    });

    expect(missingIdResponse.status).toBe(400);
    expect(await missingIdResponse.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(missingAgentResponse.status).toBe(404);
    expect(await missingAgentResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(deletedResponse.status).toBe(404);
    expect(await deletedResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(invalidStatusResponse.status).toBe(409);
    expect(await invalidStatusResponse.json()).toMatchObject({
      error: { code: "invalid_agent_status", status: "stopped" },
    });

    const eventCount = await countRows(connection, "agent_events");

    expect(eventCount).toBe(1);
  });

  it("soft-deletes active non-transitioning agents while preserving existing events", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const deletableStatuses: AgentLifecycleStatus[] = ["idle", "running", "stopped", "error"];

    for (const status of deletableStatuses) {
      const [agent] = await connection.db
        .insert(agents)
        .values({
          userId,
          name: `${status} Delete Agent`,
          templateKey: "research_agent",
          status,
          statusReason: `${status} preserved reason.`,
          createdAt: new Date("2026-07-03T05:00:00.000Z"),
          updatedAt: new Date("2026-07-03T05:30:00.000Z"),
        })
        .returning();

      expect(agent).toBeDefined();

      await connection.db.insert(agentEvents).values({
        agentId: agent?.id ?? "",
        actorUserId: userId,
        type: "agent.created",
        message: "Existing event.",
        metadata: {
          status,
        },
      });

      const result = await deleteAgentForDevelopmentUser(agent?.id ?? "", {
        createConnection: () => connection,
        now: () => now,
      });

      const [persistedAgent] = await connection.db
        .select()
        .from(agents)
        .where(eq(agents.id, agent?.id ?? ""))
        .limit(1);
      const persistedEvents = await connection.db
        .select()
        .from(agentEvents)
        .where(eq(agentEvents.agentId, agent?.id ?? ""));
      const listed = await listActiveAgentsForDevelopmentUser({
        createConnection: () => connection,
      });
      const detail = await getActiveAgentForDevelopmentUser(agent?.id ?? "", {
        createConnection: () => connection,
      });

      expect(result).toMatchObject({
        ok: true,
        agent: {
          id: agent?.id,
          status,
          statusReason: `${status} preserved reason.`,
          updatedAt: "2026-07-03T06:00:00.000Z",
          deletedAt: "2026-07-03T06:00:00.000Z",
        },
        event: {
          type: DELETE_EVENT_TYPE,
        },
      });
      expect(persistedAgent).toMatchObject({
        status,
        statusReason: `${status} preserved reason.`,
        updatedAt: now,
        deletedAt: now,
      });
      expect(persistedEvents).toHaveLength(2);
      expect(persistedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "agent.created",
            metadata: { status },
          }),
          expect.objectContaining({
            actorUserId: userId,
            type: DELETE_EVENT_TYPE,
            metadata: {
              fromStatus: status,
              toStatus: "deleted",
              deletedAt: "2026-07-03T06:00:00.000Z",
            },
          }),
        ]),
      );
      expect(listed.some((listedAgent) => listedAgent.id === agent?.id)).toBe(false);
      expect(detail).toBeNull();
    }
  });

  it("settles due start and restart transitions before evaluating delete", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const dueAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS - 1);
    const [startingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Due Start Before Delete Agent",
        templateKey: "research_agent",
        status: "starting",
        statusReason: "Start requested.",
        updatedAt: dueAt,
      })
      .returning();
    const [restartingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Due Restart Before Delete Agent",
        templateKey: "research_agent",
        status: "restarting",
        statusReason: "Restart requested.",
        updatedAt: dueAt,
      })
      .returning();

    expect(startingAgent).toBeDefined();
    expect(restartingAgent).toBeDefined();

    const result = await deleteAgentForDevelopmentUser(startingAgent?.id ?? "", {
      createConnection: () => connection,
      now: () => now,
    });

    const [persistedStartingAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, startingAgent?.id ?? ""))
      .limit(1);
    const [persistedRestartingAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, restartingAgent?.id ?? ""))
      .limit(1);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .orderBy(agentEvents.type);

    expect(result).toMatchObject({
      ok: true,
      agent: {
        id: startingAgent?.id,
        status: "running",
        deletedAt: "2026-07-03T06:00:00.000Z",
      },
    });
    expect(persistedStartingAgent).toMatchObject({
      status: "running",
      statusReason: "Fake runner is running.",
      deletedAt: now,
    });
    expect(persistedRestartingAgent).toMatchObject({
      status: "running",
      statusReason: "Fake runner is running.",
      deletedAt: null,
    });
    expect(persistedEvents.map((event) => event.type).sort()).toEqual([
      DELETE_EVENT_TYPE,
      RESTART_COMPLETED_EVENT_TYPE,
      START_COMPLETED_EVENT_TYPE,
    ]);
  });

  it("rejects malformed, missing, absent, soft-deleted, transitioning, and deleting deletes without mutation or delete events", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const pendingTransitionAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS + 1);
    const invalidStatuses: AgentLifecycleStatus[] = ["starting", "restarting", "deleting"];
    const invalidAgents: { id: string; status: AgentLifecycleStatus }[] = [];

    for (const status of invalidStatuses) {
      const [agent] = await connection.db
        .insert(agents)
        .values({
          userId,
          name: `${status} Delete Agent`,
          templateKey: "research_agent",
          status,
          statusReason: `${status} preserved reason.`,
          createdAt: new Date("2026-07-03T05:00:00.000Z"),
          updatedAt: status === "deleting" ? now : pendingTransitionAt,
        })
        .returning({ id: agents.id, status: agents.status });

      expect(agent).toBeDefined();

      if (agent) {
        invalidAgents.push(agent);
      }
    }

    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Already Deleted Agent",
        templateKey: "research_agent",
        status: "stopped",
        statusReason: "Deleted preserved reason.",
        updatedAt: now,
        deletedAt: now,
      })
      .returning();

    expect(deletedAgent).toBeDefined();

    const beforeAgents = await connection.db.select().from(agents).orderBy(agents.name);

    await expect(
      deleteAgentForDevelopmentUser("", { createConnection: () => connection, now: () => now }),
    ).resolves.toEqual({ ok: false, reason: "missing_agent_id" });
    await expect(
      deleteAgentForDevelopmentUser("not-a-uuid", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed_agent_id" });
    await expect(
      deleteAgentForDevelopmentUser("00000000-0000-4000-8000-000000000000", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });
    await expect(
      deleteAgentForDevelopmentUser(deletedAgent?.id ?? "", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });

    for (const agent of invalidAgents) {
      await expect(
        deleteAgentForDevelopmentUser(agent.id, {
          createConnection: () => connection,
          now: () => now,
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid_status", status: agent.status });
    }

    const afterAgents = await connection.db.select().from(agents).orderBy(agents.name);
    const persistedEvents = await connection.db.select().from(agentEvents);

    expect(afterAgents).toEqual(beforeAgents);
    expect(persistedEvents).toHaveLength(0);
  });

  it("exposes the delete route success, validation, not-found, deleted, invalid status, and event behavior", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const [stoppedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Route Delete Agent",
        templateKey: "research_agent",
        status: "stopped",
      })
      .returning();
    const [transitioningAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Transitioning Delete Agent",
        templateKey: "research_agent",
        status: "starting",
        updatedAt: new Date("2099-07-03T06:00:00.000Z"),
      })
      .returning();
    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Deleted Delete Route Agent",
        templateKey: "research_agent",
        status: "stopped",
        deletedAt: new Date("2026-07-03T06:00:00.000Z"),
      })
      .returning();

    expect(stoppedAgent).toBeDefined();
    expect(transitioningAgent).toBeDefined();
    expect(deletedAgent).toBeDefined();
    const stoppedAgentId = stoppedAgent?.id ?? "";
    const transitioningAgentId = transitioningAgent?.id ?? "";
    const deletedAgentId = deletedAgent?.id ?? "";

    const { DELETE } = await import("@/app/api/agents/[agentId]/route");
    const successResponse = await DELETE(new Request("http://localhost/api/agents/delete"), {
      params: Promise.resolve({ agentId: stoppedAgentId }),
    });
    const successBody = await successResponse.json();

    expect(successResponse.status).toBe(200);
    expect(successBody).toMatchObject({
      ok: true,
      agent: {
        id: stoppedAgent?.id,
        status: "stopped",
      },
      event: { type: DELETE_EVENT_TYPE },
    });

    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, stoppedAgentId));

    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]).toMatchObject({
      type: DELETE_EVENT_TYPE,
      metadata: {
        fromStatus: "stopped",
        toStatus: "deleted",
      },
    });

    const missingIdResponse = await DELETE(new Request("http://localhost/api/agents/delete"), {
      params: Promise.resolve({}),
    });
    const malformedResponse = await DELETE(new Request("http://localhost/api/agents/delete"), {
      params: Promise.resolve({ agentId: "not-a-uuid" }),
    });
    const missingAgentResponse = await DELETE(new Request("http://localhost/api/agents/delete"), {
      params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000000" }),
    });
    const deletedResponse = await DELETE(new Request("http://localhost/api/agents/delete"), {
      params: Promise.resolve({ agentId: deletedAgentId }),
    });
    const invalidStatusResponse = await DELETE(new Request("http://localhost/api/agents/delete"), {
      params: Promise.resolve({ agentId: transitioningAgentId }),
    });

    expect(missingIdResponse.status).toBe(400);
    expect(await missingIdResponse.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(missingAgentResponse.status).toBe(404);
    expect(await missingAgentResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(deletedResponse.status).toBe(404);
    expect(await deletedResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(invalidStatusResponse.status).toBe(409);
    expect(await invalidStatusResponse.json()).toMatchObject({
      error: { code: "invalid_agent_status", status: "starting" },
    });

    const eventCount = await countRows(connection, "agent_events");

    expect(eventCount).toBe(1);
  });

  it("persists the complete Milestone 2 lifecycle event inventory through active-view deletion", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const startRequestedAt = new Date("2026-07-03T06:00:00.000Z");
    const startCompletedAt = new Date(startRequestedAt.getTime() + FAKE_RUNNER_START_DELAY_MS + 1);
    const restartRequestedAt = new Date("2026-07-03T06:01:00.000Z");
    const restartCompletedAt = new Date(
      restartRequestedAt.getTime() + FAKE_RUNNER_START_DELAY_MS + 1,
    );
    const stopAt = new Date("2026-07-03T06:02:00.000Z");
    const deleteAt = new Date("2026-07-03T06:03:00.000Z");
    const [agent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Milestone 2 Lifecycle Agent",
        templateKey: "research_agent",
        status: "stopped",
        statusReason: null,
        createdAt: new Date("2026-07-03T05:00:00.000Z"),
        updatedAt: new Date("2026-07-03T05:00:00.000Z"),
      })
      .returning();

    expect(agent).toBeDefined();
    const agentId = agent?.id ?? "";

    await expect(
      startAgentForDevelopmentUser(agentId, {
        createConnection: () => connection,
        now: () => startRequestedAt,
      }),
    ).resolves.toMatchObject({
      ok: true,
      agent: { status: "starting" },
      event: { type: START_REQUESTED_EVENT_TYPE },
    });
    await expect(
      settleDueFakeRunnerTransitions({
        createConnection: () => connection,
        now: () => startCompletedAt,
      }),
    ).resolves.toBe(1);
    await expect(
      restartAgentForDevelopmentUser(agentId, {
        createConnection: () => connection,
        now: () => restartRequestedAt,
      }),
    ).resolves.toMatchObject({
      ok: true,
      agent: { status: "restarting" },
      event: { type: RESTART_REQUESTED_EVENT_TYPE },
    });
    await expect(
      settleDueFakeRunnerTransitions({
        createConnection: () => connection,
        now: () => restartCompletedAt,
      }),
    ).resolves.toBe(1);
    await expect(
      stopAgentForDevelopmentUser(agentId, {
        createConnection: () => connection,
        now: () => stopAt,
      }),
    ).resolves.toMatchObject({
      ok: true,
      agent: { status: "stopped" },
      events: [{ type: STOP_REQUESTED_EVENT_TYPE }, { type: STOP_COMPLETED_EVENT_TYPE }],
    });
    await expect(
      deleteAgentForDevelopmentUser(agentId, {
        createConnection: () => connection,
        now: () => deleteAt,
      }),
    ).resolves.toMatchObject({
      ok: true,
      agent: {
        status: "stopped",
        deletedAt: "2026-07-03T06:03:00.000Z",
      },
      event: { type: DELETE_EVENT_TYPE },
    });

    const [persistedAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    const activeAgents = await listActiveAgentsForDevelopmentUser({
      createConnection: () => connection,
    });
    const activeDetail = await getActiveAgentForDevelopmentUser(agentId, {
      createConnection: () => connection,
    });
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, agentId));
    const eventTypes = persistedEvents.map((event) => event.type).sort();

    expect(persistedAgent).toMatchObject({
      id: agentId,
      status: "stopped",
      statusReason: null,
      deletedAt: deleteAt,
    });
    expect(activeAgents.some((activeAgent) => activeAgent.id === agentId)).toBe(false);
    expect(activeDetail).toBeNull();
    expect(eventTypes).toEqual([
      DELETE_EVENT_TYPE,
      RESTART_COMPLETED_EVENT_TYPE,
      RESTART_REQUESTED_EVENT_TYPE,
      START_COMPLETED_EVENT_TYPE,
      START_REQUESTED_EVENT_TYPE,
      STOP_COMPLETED_EVENT_TYPE,
      STOP_REQUESTED_EVENT_TYPE,
    ]);
    expect(persistedEvents.filter((event) => event.type === DELETE_EVENT_TYPE)).toHaveLength(1);
    expect(persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: userId,
          type: START_REQUESTED_EVENT_TYPE,
          metadata: { fromStatus: "stopped", toStatus: "starting" },
        }),
        expect.objectContaining({
          actorUserId: userId,
          type: START_COMPLETED_EVENT_TYPE,
          metadata: { fromStatus: "starting", toStatus: "running" },
        }),
        expect.objectContaining({
          actorUserId: userId,
          type: RESTART_REQUESTED_EVENT_TYPE,
          metadata: { fromStatus: "running", toStatus: "restarting" },
        }),
        expect.objectContaining({
          actorUserId: userId,
          type: RESTART_COMPLETED_EVENT_TYPE,
          metadata: { fromStatus: "restarting", toStatus: "running" },
        }),
        expect.objectContaining({
          actorUserId: userId,
          type: STOP_REQUESTED_EVENT_TYPE,
          metadata: { fromStatus: "running", toStatus: "stopped" },
        }),
        expect.objectContaining({
          actorUserId: userId,
          type: STOP_COMPLETED_EVENT_TYPE,
          metadata: { fromStatus: "running", toStatus: "stopped" },
        }),
        expect.objectContaining({
          actorUserId: userId,
          type: DELETE_EVENT_TYPE,
          metadata: {
            fromStatus: "stopped",
            toStatus: "deleted",
            deletedAt: "2026-07-03T06:03:00.000Z",
          },
        }),
      ]),
    );
  });

  it("stops running agents by persisting stopped status and requested/completed events", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const [runningAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Running Stop Agent",
        templateKey: "research_agent",
        status: "running",
        statusReason: "Fake runner is running.",
        createdAt: new Date("2026-07-03T05:00:00.000Z"),
        updatedAt: new Date("2026-07-03T05:30:00.000Z"),
      })
      .returning();

    expect(runningAgent).toBeDefined();

    const result = await stopAgentForDevelopmentUser(runningAgent?.id ?? "", {
      createConnection: () => connection,
      now: () => now,
    });

    const [persistedAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, runningAgent?.id ?? ""))
      .limit(1);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, runningAgent?.id ?? ""));

    expect(result).toMatchObject({
      ok: true,
      agent: {
        id: runningAgent?.id,
        status: "stopped",
        statusReason: null,
        updatedAt: "2026-07-03T06:00:00.000Z",
      },
      events: [{ type: STOP_REQUESTED_EVENT_TYPE }, { type: STOP_COMPLETED_EVENT_TYPE }],
    });
    expect(persistedAgent).toMatchObject({
      status: "stopped",
      statusReason: null,
      updatedAt: now,
    });
    expect(persistedEvents).toHaveLength(2);
    expect(persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: userId,
          type: STOP_REQUESTED_EVENT_TYPE,
          metadata: {
            fromStatus: "running",
            toStatus: "stopped",
          },
        }),
        expect.objectContaining({
          actorUserId: userId,
          type: STOP_COMPLETED_EVENT_TYPE,
          metadata: {
            fromStatus: "running",
            toStatus: "stopped",
          },
        }),
      ]),
    );
  });

  it("settles due start transitions before evaluating stop", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const dueStartingAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS - 1);
    const [startingAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Due Stop Agent",
        templateKey: "research_agent",
        status: "starting",
        statusReason: "Start requested.",
        updatedAt: dueStartingAt,
      })
      .returning();

    expect(startingAgent).toBeDefined();

    const result = await stopAgentForDevelopmentUser(startingAgent?.id ?? "", {
      createConnection: () => connection,
      now: () => now,
    });

    const [persistedAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, startingAgent?.id ?? ""))
      .limit(1);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, startingAgent?.id ?? ""));

    expect(result).toMatchObject({
      ok: true,
      agent: {
        id: startingAgent?.id,
        status: "stopped",
        statusReason: null,
      },
    });
    expect(persistedAgent).toMatchObject({
      status: "stopped",
      statusReason: null,
      updatedAt: now,
    });
    expect(persistedEvents.map((event) => event.type).sort()).toEqual([
      START_COMPLETED_EVENT_TYPE,
      STOP_COMPLETED_EVENT_TYPE,
      STOP_REQUESTED_EVENT_TYPE,
    ]);
    expect(persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: userId,
          type: START_COMPLETED_EVENT_TYPE,
          metadata: {
            fromStatus: "starting",
            toStatus: "running",
          },
        }),
        expect.objectContaining({
          actorUserId: userId,
          type: STOP_REQUESTED_EVENT_TYPE,
          metadata: {
            fromStatus: "running",
            toStatus: "stopped",
          },
        }),
        expect.objectContaining({
          actorUserId: userId,
          type: STOP_COMPLETED_EVENT_TYPE,
          metadata: {
            fromStatus: "running",
            toStatus: "stopped",
          },
        }),
      ]),
    );
  });

  it("rejects malformed, missing, absent, soft-deleted, and non-running stops without mutation or events", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const pendingStartingAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS + 1);
    const invalidStatuses: AgentLifecycleStatus[] = [
      "idle",
      "stopped",
      "starting",
      "restarting",
      "error",
      "deleting",
    ];
    const invalidAgents: { id: string; status: AgentLifecycleStatus }[] = [];

    for (const status of invalidStatuses) {
      const [agent] = await connection.db
        .insert(agents)
        .values({
          userId,
          name: `${status} Stop Agent`,
          templateKey: "research_agent",
          status,
          statusReason: `${status} preserved reason.`,
          createdAt: new Date("2026-07-03T05:00:00.000Z"),
          updatedAt: status === "starting" ? pendingStartingAt : now,
        })
        .returning({ id: agents.id, status: agents.status });

      expect(agent).toBeDefined();

      if (agent) {
        invalidAgents.push(agent);
      }
    }

    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Deleted Stop Agent",
        templateKey: "research_agent",
        status: "running",
        statusReason: "Deleted preserved reason.",
        updatedAt: now,
        deletedAt: now,
      })
      .returning();

    expect(deletedAgent).toBeDefined();

    const beforeAgents = await connection.db.select().from(agents).orderBy(agents.name);

    await expect(
      stopAgentForDevelopmentUser("", { createConnection: () => connection, now: () => now }),
    ).resolves.toEqual({ ok: false, reason: "missing_agent_id" });
    await expect(
      stopAgentForDevelopmentUser("not-a-uuid", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed_agent_id" });
    await expect(
      stopAgentForDevelopmentUser("00000000-0000-4000-8000-000000000000", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });
    await expect(
      stopAgentForDevelopmentUser(deletedAgent?.id ?? "", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });

    for (const agent of invalidAgents) {
      await expect(
        stopAgentForDevelopmentUser(agent.id, {
          createConnection: () => connection,
          now: () => now,
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid_status", status: agent.status });
    }

    const afterAgents = await connection.db.select().from(agents).orderBy(agents.name);
    const persistedEvents = await connection.db.select().from(agentEvents);

    expect(afterAgents).toEqual(beforeAgents);
    expect(persistedEvents).toHaveLength(0);
  });

  it("exposes the stop route success, validation, not-found, deleted, invalid status, and event behavior", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const [runningAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Route Stop Agent",
        templateKey: "research_agent",
        status: "running",
        statusReason: "Fake runner is running.",
      })
      .returning();
    const [stoppedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Stopped Route Agent",
        templateKey: "research_agent",
        status: "stopped",
      })
      .returning();
    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Deleted Stop Route Agent",
        templateKey: "research_agent",
        status: "running",
        deletedAt: new Date("2026-07-03T06:00:00.000Z"),
      })
      .returning();

    expect(runningAgent).toBeDefined();
    expect(stoppedAgent).toBeDefined();
    expect(deletedAgent).toBeDefined();
    const runningAgentId = runningAgent?.id ?? "";
    const stoppedAgentId = stoppedAgent?.id ?? "";
    const deletedAgentId = deletedAgent?.id ?? "";

    const { POST } = await import("@/app/api/agents/[agentId]/actions/stop/route");
    const successResponse = await POST(new Request("http://localhost/api/agents/stop"), {
      params: Promise.resolve({ agentId: runningAgentId }),
    });
    const successBody = await successResponse.json();

    expect(successResponse.status).toBe(200);
    expect(successBody).toMatchObject({
      ok: true,
      agent: {
        id: runningAgent?.id,
        status: "stopped",
        statusReason: null,
      },
      events: [{ type: STOP_REQUESTED_EVENT_TYPE }, { type: STOP_COMPLETED_EVENT_TYPE }],
    });

    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, runningAgentId));

    expect(persistedEvents).toHaveLength(2);
    expect(persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: STOP_REQUESTED_EVENT_TYPE,
          metadata: {
            fromStatus: "running",
            toStatus: "stopped",
          },
        }),
        expect.objectContaining({
          type: STOP_COMPLETED_EVENT_TYPE,
          metadata: {
            fromStatus: "running",
            toStatus: "stopped",
          },
        }),
      ]),
    );

    const missingIdResponse = await POST(new Request("http://localhost/api/agents/stop"), {
      params: Promise.resolve({}),
    });
    const malformedResponse = await POST(new Request("http://localhost/api/agents/stop"), {
      params: Promise.resolve({ agentId: "not-a-uuid" }),
    });
    const missingAgentResponse = await POST(new Request("http://localhost/api/agents/stop"), {
      params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000000" }),
    });
    const deletedResponse = await POST(new Request("http://localhost/api/agents/stop"), {
      params: Promise.resolve({ agentId: deletedAgentId }),
    });
    const invalidStatusResponse = await POST(new Request("http://localhost/api/agents/stop"), {
      params: Promise.resolve({ agentId: stoppedAgentId }),
    });

    expect(missingIdResponse.status).toBe(400);
    expect(await missingIdResponse.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(missingAgentResponse.status).toBe(404);
    expect(await missingAgentResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(deletedResponse.status).toBe(404);
    expect(await deletedResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(invalidStatusResponse.status).toBe(409);
    expect(await invalidStatusResponse.json()).toMatchObject({
      error: { code: "invalid_agent_status", status: "stopped" },
    });

    const eventCount = await countRows(connection, "agent_events");

    expect(eventCount).toBe(2);
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
  await expect(countRows(connection, tableName)).resolves.toBe(expected);
}

async function countRows(
  connection: DatabaseConnection,
  tableName: "users" | "agents" | "agent_events" | "app_metadata",
): Promise<number> {
  const [row] = await connection.db.execute<{ count: string }>(
    sql.raw(`select count(*)::text as count from ${tableName}`),
  );

  return Number(row?.count);
}
