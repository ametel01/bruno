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
  SIMULATED_ERROR_EVENT_TYPE,
  SIMULATED_ERROR_STATUS_REASON,
  START_COMPLETED_EVENT_TYPE,
  START_REQUESTED_EVENT_TYPE,
  STOP_COMPLETED_EVENT_TYPE,
  STOP_REQUESTED_EVENT_TYPE,
  deleteAgentForDevelopmentUser,
  restartAgentForDevelopmentUser,
  settleDueFakeRunnerTransitions,
  settleDueStartingAgents,
  simulateErrorAgentForDevelopmentUser,
  startAgentForDevelopmentUser,
  stopAgentForDevelopmentUser,
  type AgentLifecycleStatus,
} from "@/src/server/agents/lifecycle";
import {
  getActiveAgentForDevelopmentUser,
  listActiveAgentsForDevelopmentUser,
} from "@/src/server/agents/list-agents";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentEvents, agentLogs, agents, appMetadata, users } from "@/src/server/db/schema";
import {
  listAgentEventFeed,
  listLatestAgentActivity,
  recordAgentEventInTransaction,
  recordAgentEventsInTransaction,
} from "@/src/server/events/agent-events";
import {
  SIMULATED_RUNTIME_LOG_CYCLE_INTERVAL_MS,
  SIMULATED_RUNTIME_LOG_MESSAGES,
  generateSimulatedRuntimeLogsForRunningAgent,
  listAgentLogs,
  mapAgentLogToDto,
} from "@/src/server/logs/agent-logs";

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

  it("simulates errors for accepted non-deleted statuses with persisted reason and one event", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const simulatableStatuses: AgentLifecycleStatus[] = [
      "idle",
      "stopped",
      "starting",
      "running",
      "restarting",
    ];

    for (const status of simulatableStatuses) {
      const [agent] = await connection.db
        .insert(agents)
        .values({
          userId,
          name: `${status} Simulate Error Agent`,
          templateKey: "research_agent",
          status,
          statusReason: `${status} preserved reason.`,
          createdAt: new Date("2026-07-03T05:00:00.000Z"),
          updatedAt: new Date("2026-07-03T05:30:00.000Z"),
        })
        .returning();

      expect(agent).toBeDefined();

      const result = await simulateErrorAgentForDevelopmentUser(agent?.id ?? "", {
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
          status: "error",
          statusReason: SIMULATED_ERROR_STATUS_REASON,
          updatedAt: "2026-07-03T06:00:00.000Z",
        },
        event: {
          type: SIMULATED_ERROR_EVENT_TYPE,
        },
      });
      expect(persistedAgent).toMatchObject({
        status: "error",
        statusReason: SIMULATED_ERROR_STATUS_REASON,
        updatedAt: now,
      });
      expect(persistedEvents).toHaveLength(1);
      expect(persistedEvents[0]).toMatchObject({
        actorUserId: userId,
        type: SIMULATED_ERROR_EVENT_TYPE,
        message: `Simulated error requested for agent "${status} Simulate Error Agent".`,
        metadata: {
          fromStatus: status,
          toStatus: "error",
          source: "development_simulator",
        },
      });
    }
  });

  it("rejects malformed, missing, absent, soft-deleted, error, and deleting simulations without mutation or events", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const invalidStatuses: AgentLifecycleStatus[] = ["error", "deleting"];
    const invalidAgents: { id: string; status: AgentLifecycleStatus }[] = [];

    for (const status of invalidStatuses) {
      const [agent] = await connection.db
        .insert(agents)
        .values({
          userId,
          name: `${status} Simulate Rejected Agent`,
          templateKey: "research_agent",
          status,
          statusReason: `${status} preserved reason.`,
          createdAt: new Date("2026-07-03T05:00:00.000Z"),
          updatedAt: now,
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
        name: "Deleted Simulate Error Agent",
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
      simulateErrorAgentForDevelopmentUser("", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "missing_agent_id" });
    await expect(
      simulateErrorAgentForDevelopmentUser("not-a-uuid", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed_agent_id" });
    await expect(
      simulateErrorAgentForDevelopmentUser("00000000-0000-4000-8000-000000000000", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });
    await expect(
      simulateErrorAgentForDevelopmentUser(deletedAgent?.id ?? "", {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });

    for (const agent of invalidAgents) {
      await expect(
        simulateErrorAgentForDevelopmentUser(agent.id, {
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

  it("exposes the simulate-error route success, validation, not-found, deleted, invalid status, and event behavior", async () => {
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
        name: "Route Simulate Error Agent",
        templateKey: "research_agent",
        status: "running",
        statusReason: "Fake runner is running.",
      })
      .returning();
    const [errorAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Already Error Route Agent",
        templateKey: "research_agent",
        status: "error",
      })
      .returning();
    const [deletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Deleted Simulate Error Route Agent",
        templateKey: "research_agent",
        status: "running",
        deletedAt: new Date("2026-07-03T06:00:00.000Z"),
      })
      .returning();
    const [productionGuardAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Production Guard Simulate Error Agent",
        templateKey: "research_agent",
        status: "running",
        statusReason: "Production guard must preserve this.",
      })
      .returning();

    expect(runningAgent).toBeDefined();
    expect(errorAgent).toBeDefined();
    expect(deletedAgent).toBeDefined();
    expect(productionGuardAgent).toBeDefined();
    const runningAgentId = runningAgent?.id ?? "";
    const errorAgentId = errorAgent?.id ?? "";
    const deletedAgentId = deletedAgent?.id ?? "";
    const productionGuardAgentId = productionGuardAgent?.id ?? "";

    const { POST } = await import("@/app/api/agents/[agentId]/actions/simulate-error/route");
    const successResponse = await POST(new Request("http://localhost/api/agents/simulate-error"), {
      params: Promise.resolve({ agentId: runningAgentId }),
    });
    const successBody = await successResponse.json();

    expect(successResponse.status).toBe(200);
    expect(successBody).toMatchObject({
      ok: true,
      agent: {
        id: runningAgent?.id,
        status: "error",
        statusReason: SIMULATED_ERROR_STATUS_REASON,
      },
      event: { type: SIMULATED_ERROR_EVENT_TYPE },
    });

    const [persistedAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, runningAgentId))
      .limit(1);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, runningAgentId));

    expect(persistedAgent).toMatchObject({
      status: "error",
      statusReason: SIMULATED_ERROR_STATUS_REASON,
    });
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]).toMatchObject({
      type: SIMULATED_ERROR_EVENT_TYPE,
      metadata: {
        fromStatus: "running",
        toStatus: "error",
        source: "development_simulator",
      },
    });

    const missingIdResponse = await POST(
      new Request("http://localhost/api/agents/simulate-error"),
      {
        params: Promise.resolve({}),
      },
    );
    const malformedResponse = await POST(
      new Request("http://localhost/api/agents/simulate-error"),
      {
        params: Promise.resolve({ agentId: "not-a-uuid" }),
      },
    );
    const missingAgentResponse = await POST(
      new Request("http://localhost/api/agents/simulate-error"),
      {
        params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000000" }),
      },
    );
    const deletedResponse = await POST(new Request("http://localhost/api/agents/simulate-error"), {
      params: Promise.resolve({ agentId: deletedAgentId }),
    });
    const invalidStatusResponse = await POST(
      new Request("http://localhost/api/agents/simulate-error"),
      {
        params: Promise.resolve({ agentId: errorAgentId }),
      },
    );

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
      error: { code: "invalid_agent_status", status: "error" },
    });

    const originalNodeEnv = process.env.NODE_ENV;
    setNodeEnvForTest("production");

    try {
      const productionResponse = await POST(
        new Request("http://localhost/api/agents/simulate-error"),
        {
          params: Promise.resolve({ agentId: productionGuardAgentId }),
        },
      );

      expect(productionResponse.status).toBe(403);
      expect(await productionResponse.json()).toEqual({
        error: {
          code: "development_only_action",
          message: "Simulated error actions are unavailable in production.",
        },
      });
    } finally {
      setNodeEnvForTest(originalNodeEnv);
    }

    const [persistedProductionGuardAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, productionGuardAgentId))
      .limit(1);
    const persistedProductionGuardEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, productionGuardAgentId));
    const eventCount = await countRows(connection, "agent_events");
    const logCount = await countRows(connection, "agent_logs");

    expect(persistedProductionGuardAgent).toMatchObject({
      status: "running",
      statusReason: "Production guard must preserve this.",
    });
    expect(persistedProductionGuardEvents).toHaveLength(0);
    expect(eventCount).toBe(1);
    expect(logCount).toBe(0);
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

  it("records one or many events through the shared transactional event helper", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const [agent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Helper Agent",
        templateKey: "research_agent",
        status: "stopped",
      })
      .returning();

    expect(agent).toBeDefined();
    const agentId = agent?.id ?? "";

    await connection.db.transaction(async (tx) => {
      await recordAgentEventInTransaction(tx, {
        agentId,
        actorUserId: userId,
        type: "agent.created",
        message: 'Created agent "Helper Agent".',
        metadata: {
          templateKey: "research_agent",
          status: "stopped",
        },
      });
      await recordAgentEventsInTransaction(tx, [
        {
          agentId,
          actorUserId: userId,
          type: START_REQUESTED_EVENT_TYPE,
          message: 'Start requested for agent "Helper Agent".',
          metadata: {
            fromStatus: "stopped",
            toStatus: "starting",
          },
        },
        {
          agentId,
          actorUserId: userId,
          type: START_COMPLETED_EVENT_TYPE,
          message: 'Start completed for agent "Helper Agent".',
          metadata: {
            fromStatus: "starting",
            toStatus: "running",
          },
        },
      ]);
    });

    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, agentId))
      .orderBy(agentEvents.createdAt);

    expect(persistedEvents.map((event) => [event.type, event.message, event.metadata])).toEqual([
      [
        "agent.created",
        'Created agent "Helper Agent".',
        {
          templateKey: "research_agent",
          status: "stopped",
        },
      ],
      [
        START_REQUESTED_EVENT_TYPE,
        'Start requested for agent "Helper Agent".',
        {
          fromStatus: "stopped",
          toStatus: "starting",
        },
      ],
      [
        START_COMPLETED_EVENT_TYPE,
        'Start completed for agent "Helper Agent".',
        {
          fromStatus: "starting",
          toStatus: "running",
        },
      ],
    ]);
  });

  it("queries per-agent event feeds newest-first with a stable cursor", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const [agent] = await connection.db
      .insert(agents)
      .values({
        id: "00000000-0000-4000-8000-000000000201",
        userId,
        name: "Feed Agent",
        templateKey: "research_agent",
        status: "running",
      })
      .returning();
    const [otherAgent] = await connection.db
      .insert(agents)
      .values({
        id: "00000000-0000-4000-8000-000000000202",
        userId,
        name: "Other Agent",
        templateKey: "github_issue_agent",
        status: "running",
      })
      .returning();

    expect(agent).toBeDefined();
    expect(otherAgent).toBeDefined();

    await connection.db.insert(agentEvents).values([
      {
        id: "00000000-0000-4000-8000-000000000301",
        agentId: "00000000-0000-4000-8000-000000000201",
        actorUserId: userId,
        type: "agent.created",
        message: 'Created agent "Feed Agent".',
        metadata: {
          templateKey: "research_agent",
          status: "stopped",
        },
        createdAt: new Date("2026-07-04T05:59:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000302",
        agentId: "00000000-0000-4000-8000-000000000201",
        actorUserId: userId,
        type: START_REQUESTED_EVENT_TYPE,
        message: 'Start requested for agent "Feed Agent".',
        metadata: {
          fromStatus: "stopped",
          toStatus: "starting",
        },
        createdAt: new Date("2026-07-04T06:00:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000303",
        agentId: "00000000-0000-4000-8000-000000000201",
        actorUserId: userId,
        type: START_COMPLETED_EVENT_TYPE,
        message: 'Start completed for agent "Feed Agent".',
        metadata: {
          fromStatus: "starting",
          toStatus: "running",
        },
        createdAt: new Date("2026-07-04T06:00:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000401",
        agentId: "00000000-0000-4000-8000-000000000202",
        actorUserId: userId,
        type: START_COMPLETED_EVENT_TYPE,
        message: 'Start completed for agent "Other Agent".',
        metadata: {
          fromStatus: "starting",
          toStatus: "running",
        },
        createdAt: new Date("2026-07-04T06:30:00.000Z"),
      },
    ]);

    const firstPage = await listAgentEventFeed({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
      limit: 2,
    });

    expect(firstPage).toMatchObject({ ok: true });

    if (!firstPage.ok) {
      throw firstPage.error;
    }

    expect(firstPage.page.events.map((event) => event.id)).toEqual([
      "00000000-0000-4000-8000-000000000303",
      "00000000-0000-4000-8000-000000000302",
    ]);
    expect(firstPage.page.nextCursor).toBeTruthy();

    const secondPage = await listAgentEventFeed({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
      cursor: firstPage.page.nextCursor,
      limit: 2,
    });

    expect(secondPage).toMatchObject({ ok: true });

    if (!secondPage.ok) {
      throw secondPage.error;
    }

    expect(secondPage.page.events.map((event) => event.id)).toEqual([
      "00000000-0000-4000-8000-000000000301",
    ]);
    expect(secondPage.page.nextCursor).toBeNull();
    await expect(
      listAgentEventFeed({
        db: connection.db,
        agentId: "00000000-0000-4000-8000-000000000201",
        cursor: "not a cursor",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({ reason: "invalid_encoding" }),
    });
  });

  it("exposes the per-agent event route with active-agent validation and stable pagination", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    await connection.db.insert(agents).values([
      {
        id: "00000000-0000-4000-8000-000000000221",
        userId,
        name: "Route Feed Agent",
        templateKey: "research_agent",
        status: "running",
        createdAt: new Date("2026-07-04T05:00:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000222",
        userId,
        name: "Empty Route Feed Agent",
        templateKey: "github_issue_agent",
        status: "stopped",
        createdAt: new Date("2026-07-04T05:05:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000223",
        userId,
        name: "Other Route Feed Agent",
        templateKey: "social_content_agent",
        status: "running",
        createdAt: new Date("2026-07-04T05:10:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000224",
        userId,
        name: "Deleted Route Feed Agent",
        templateKey: "inbox_triage_agent",
        status: "stopped",
        createdAt: new Date("2026-07-04T05:15:00.000Z"),
        deletedAt: new Date("2026-07-04T06:40:00.000Z"),
      },
    ]);
    await connection.db.insert(agentEvents).values([
      {
        id: "00000000-0000-4000-8000-000000000321",
        agentId: "00000000-0000-4000-8000-000000000221",
        actorUserId: userId,
        type: START_REQUESTED_EVENT_TYPE,
        message: 'Start requested for agent "Route Feed Agent".',
        metadata: {
          fromStatus: "stopped",
          toStatus: "starting",
        },
        createdAt: new Date("2026-07-04T05:30:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000322",
        agentId: "00000000-0000-4000-8000-000000000221",
        actorUserId: userId,
        type: START_REQUESTED_EVENT_TYPE,
        message: 'Start requested again for agent "Route Feed Agent".',
        metadata: {
          fromStatus: "stopped",
          toStatus: "starting",
        },
        createdAt: new Date("2026-07-04T06:00:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000323",
        agentId: "00000000-0000-4000-8000-000000000221",
        actorUserId: userId,
        type: START_COMPLETED_EVENT_TYPE,
        message: 'Start completed for agent "Route Feed Agent".',
        metadata: {
          fromStatus: "starting",
          toStatus: "running",
        },
        createdAt: new Date("2026-07-04T06:00:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000421",
        agentId: "00000000-0000-4000-8000-000000000223",
        actorUserId: userId,
        type: STOP_COMPLETED_EVENT_TYPE,
        message: 'Stop completed for agent "Other Route Feed Agent".',
        metadata: {
          fromStatus: "running",
          toStatus: "stopped",
        },
        createdAt: new Date("2026-07-04T06:30:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000521",
        agentId: "00000000-0000-4000-8000-000000000224",
        actorUserId: userId,
        type: DELETE_EVENT_TYPE,
        message: 'Agent "Deleted Route Feed Agent" deleted from active views.',
        metadata: {
          fromStatus: "stopped",
          toStatus: "deleted",
        },
        createdAt: new Date("2026-07-04T06:40:00.000Z"),
      },
    ]);

    const { GET } = await import("@/app/api/agents/[agentId]/events/route");
    const firstPageResponse = await GET(
      new Request("http://localhost/api/agents/route-feed/events?limit=2"),
      {
        params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000221" }),
      },
    );
    const firstPage = (await firstPageResponse.json()) as {
      events: Array<{ id: string; agentId: string; actorUserId?: string }>;
      nextCursor: string | null;
    };

    expect(firstPageResponse.status).toBe(200);
    expect(firstPage.events.map((event) => event.id)).toEqual([
      "00000000-0000-4000-8000-000000000323",
      "00000000-0000-4000-8000-000000000322",
    ]);
    expect(
      firstPage.events.every((event) => event.agentId === "00000000-0000-4000-8000-000000000221"),
    ).toBe(true);
    expect(firstPage.events[0]).not.toHaveProperty("actorUserId");
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPageResponse = await GET(
      new Request(
        `http://localhost/api/agents/route-feed/events?cursor=${encodeURIComponent(
          firstPage.nextCursor ?? "",
        )}&limit=2`,
      ),
      {
        params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000221" }),
      },
    );
    const secondPage = (await secondPageResponse.json()) as {
      events: Array<{ id: string }>;
      nextCursor: string | null;
    };

    expect(secondPageResponse.status).toBe(200);
    expect(secondPage.events.map((event) => event.id)).toEqual([
      "00000000-0000-4000-8000-000000000321",
    ]);
    expect(secondPage.nextCursor).toBeNull();

    const emptyPageResponse = await GET(
      new Request("http://localhost/api/agents/route-feed/events"),
      {
        params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000222" }),
      },
    );

    expect(emptyPageResponse.status).toBe(200);
    await expect(emptyPageResponse.json()).resolves.toEqual({
      events: [],
      nextCursor: null,
    });

    const deletedAgentResponse = await GET(
      new Request("http://localhost/api/agents/route-feed/events"),
      {
        params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000224" }),
      },
    );
    const missingAgentResponse = await GET(
      new Request("http://localhost/api/agents/route-feed/events"),
      {
        params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000000" }),
      },
    );
    const malformedCursorResponse = await GET(
      new Request("http://localhost/api/agents/route-feed/events?cursor=not%20a%20cursor"),
      {
        params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000221" }),
      },
    );

    expect(deletedAgentResponse.status).toBe(404);
    await expect(deletedAgentResponse.json()).resolves.toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(missingAgentResponse.status).toBe(404);
    await expect(missingAgentResponse.json()).resolves.toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(malformedCursorResponse.status).toBe(400);
    await expect(malformedCursorResponse.json()).resolves.toMatchObject({
      error: { code: "validation_failed" },
    });
  });

  it("queries latest dashboard activity with deleted-agent audit context", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    await connection.db.insert(agents).values([
      {
        id: "00000000-0000-4000-8000-000000000211",
        userId,
        name: "Active Feed Agent",
        templateKey: "research_agent",
        status: "running",
        createdAt: new Date("2026-07-04T05:00:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000212",
        userId,
        name: "Deleted Feed Agent",
        templateKey: "github_issue_agent",
        status: "stopped",
        createdAt: new Date("2026-07-04T05:10:00.000Z"),
        updatedAt: new Date("2026-07-04T06:30:00.000Z"),
        deletedAt: new Date("2026-07-04T06:30:00.000Z"),
      },
    ]);
    await connection.db.insert(agentEvents).values([
      {
        id: "00000000-0000-4000-8000-000000000311",
        agentId: "00000000-0000-4000-8000-000000000211",
        actorUserId: userId,
        type: START_COMPLETED_EVENT_TYPE,
        message: 'Start completed for agent "Active Feed Agent".',
        metadata: {
          fromStatus: "starting",
          toStatus: "running",
        },
        createdAt: new Date("2026-07-04T06:00:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000411",
        agentId: "00000000-0000-4000-8000-000000000212",
        actorUserId: userId,
        type: DELETE_EVENT_TYPE,
        message: 'Agent "Deleted Feed Agent" deleted from active views.',
        metadata: {
          fromStatus: "stopped",
          toStatus: "deleted",
          deletedAt: "2026-07-04T06:30:00.000Z",
        },
        createdAt: new Date("2026-07-04T06:30:00.000Z"),
      },
    ]);

    const page = await listLatestAgentActivity({
      db: connection.db,
      limit: 2,
    });
    const activeAgents = await listActiveAgentsForDevelopmentUser({
      createConnection: () => connection,
    });

    expect(page).toMatchObject({ ok: true });

    if (!page.ok) {
      throw page.error;
    }

    expect(page.page.events.map((event) => event.id)).toEqual([
      "00000000-0000-4000-8000-000000000411",
      "00000000-0000-4000-8000-000000000311",
    ]);
    expect(page.page.events[0]?.agent).toEqual({
      id: "00000000-0000-4000-8000-000000000212",
      name: "Deleted Feed Agent",
      templateKey: "github_issue_agent",
      status: "stopped",
      deletedAt: "2026-07-04T06:30:00.000Z",
    });
    expect(activeAgents.map((activeAgent) => activeAgent.id)).toEqual([
      "00000000-0000-4000-8000-000000000211",
    ]);
  });

  it("maps persisted log rows to the public DTO shape", () => {
    expect(
      mapAgentLogToDto({
        id: "00000000-0000-4000-8000-000000000301",
        agentId: "00000000-0000-4000-8000-000000000201",
        runnerId: null,
        stream: "stdout",
        level: "info",
        message: "Agent booted.",
        sequence: 1,
        createdAt: new Date("2026-07-04T06:00:00.000Z"),
      }),
    ).toEqual({
      id: "00000000-0000-4000-8000-000000000301",
      agentId: "00000000-0000-4000-8000-000000000201",
      runnerId: null,
      stream: "stdout",
      level: "info",
      message: "Agent booted.",
      sequence: 1,
      createdAt: "2026-07-04T06:00:00.000Z",
    });
  });

  it("queries durable agent logs oldest-first after the accepted per-agent sequence cursor", async () => {
    const [createdUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.id ?? "";
    await connection.db.insert(agents).values({
      id: "00000000-0000-4000-8000-000000000201",
      userId,
      name: "Active Log Agent",
      templateKey: "research_agent",
      status: "running",
    });
    await connection.db
      .insert(agentLogs)
      .values([
        logValue("00000000-0000-4000-8000-000000000201", 1, "stdout", "info", "line 1"),
        logValue("00000000-0000-4000-8000-000000000201", 2, "stderr", "warn", "line 2"),
        logValue("00000000-0000-4000-8000-000000000201", 3, "stdout", "info", "line 3"),
        logValue("00000000-0000-4000-8000-000000000201", 4, "stdout", "info", "line 4"),
      ]);

    const firstPage = await listAgentLogs({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
      limit: 2,
    });
    const secondPage = await listAgentLogs({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
      after: firstPage.nextAfter,
      limit: 2,
    });

    expect(firstPage.logs.map((log) => [log.sequence, log.message])).toEqual([
      [1, "line 1"],
      [2, "line 2"],
    ]);
    expect(firstPage.nextAfter).toBe(2);
    expect(secondPage.logs.map((log) => [log.sequence, log.message])).toEqual([
      [3, "line 3"],
      [4, "line 4"],
    ]);
    expect(secondPage.nextAfter).toBe(4);
  });

  it("filters durable logs strictly by agent and returns accepted after for empty pages", async () => {
    const [createdUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.id ?? "";
    await connection.db.insert(agents).values([
      {
        id: "00000000-0000-4000-8000-000000000201",
        userId,
        name: "Active Log Agent",
        templateKey: "research_agent",
        status: "running",
      },
      {
        id: "00000000-0000-4000-8000-000000000202",
        userId,
        name: "Other Log Agent",
        templateKey: "research_agent",
        status: "running",
      },
    ]);
    await connection.db
      .insert(agentLogs)
      .values([
        logValue("00000000-0000-4000-8000-000000000201", 1, "stdout", "info", "active line 1"),
        logValue("00000000-0000-4000-8000-000000000202", 2, "stdout", "info", "other line 2"),
        logValue("00000000-0000-4000-8000-000000000201", 3, "stdout", "info", "active line 3"),
        logValue("00000000-0000-4000-8000-000000000202", 4, "stdout", "info", "other line 4"),
      ]);

    const activePage = await listAgentLogs({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
      limit: 100,
    });
    const emptyPageAfterCursor = await listAgentLogs({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
      after: 3,
      limit: 100,
    });
    const emptyPageWithoutCursor = await listAgentLogs({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000999",
      limit: 100,
    });

    expect(activePage.logs.map((log) => log.message)).toEqual(["active line 1", "active line 3"]);
    expect(
      activePage.logs.every((log) => log.agentId === "00000000-0000-4000-8000-000000000201"),
    ).toBe(true);
    expect(activePage.nextAfter).toBe(3);
    expect(emptyPageAfterCursor).toEqual({
      logs: [],
      nextAfter: 3,
    });
    expect(emptyPageWithoutCursor).toEqual({
      logs: [],
      nextAfter: null,
    });
  });

  it("generates one deterministic four-line cycle immediately for active running agents", async () => {
    const [createdUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.id ?? "";
    const runningStartedAt = new Date("2026-07-04T06:00:00.000Z");
    const firstReadAt = new Date("2026-07-04T06:00:01.000Z");
    await connection.db.insert(agents).values({
      id: "00000000-0000-4000-8000-000000000201",
      userId,
      name: "Running Generator Agent",
      templateKey: "research_agent",
      status: "running",
      updatedAt: runningStartedAt,
    });

    await expect(
      generateSimulatedRuntimeLogsForRunningAgent({
        db: connection.db,
        agentId: "00000000-0000-4000-8000-000000000201",
        now: firstReadAt,
      }),
    ).resolves.toEqual({ inserted: SIMULATED_RUNTIME_LOG_MESSAGES.length });

    const page = await listAgentLogs({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
    });
    const persistedEvents = await connection.db.select().from(agentEvents);

    expect(page.logs.map((log) => [log.sequence, log.runnerId, log.message])).toEqual([
      [1, null, "Checking task queue..."],
      [2, null, "No pending tasks."],
      [3, null, "Heartbeat OK."],
      [4, null, "Memory loaded."],
    ]);
    expect(page.logs.every((log) => log.stream === "stdout" && log.level === "info")).toBe(true);
    expect(page.logs.every((log) => log.createdAt === firstReadAt.toISOString())).toBe(true);
    expect(persistedEvents).toHaveLength(0);
  });

  it("keeps repeated reads at the same logical time idempotent and adds the next cycle only after the interval", async () => {
    const [createdUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.id ?? "";
    const runningStartedAt = new Date("2026-07-04T06:00:00.000Z");
    const firstReadAt = new Date("2026-07-04T06:00:01.000Z");
    const beforeIntervalAt = new Date(
      firstReadAt.getTime() + SIMULATED_RUNTIME_LOG_CYCLE_INTERVAL_MS - 1,
    );
    const nextCycleAt = new Date(firstReadAt.getTime() + SIMULATED_RUNTIME_LOG_CYCLE_INTERVAL_MS);
    await connection.db.insert(agents).values({
      id: "00000000-0000-4000-8000-000000000201",
      userId,
      name: "Idempotent Generator Agent",
      templateKey: "research_agent",
      status: "running",
      updatedAt: runningStartedAt,
    });

    await generateSimulatedRuntimeLogsForRunningAgent({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
      now: firstReadAt,
    });
    await expect(
      generateSimulatedRuntimeLogsForRunningAgent({
        db: connection.db,
        agentId: "00000000-0000-4000-8000-000000000201",
        now: firstReadAt,
      }),
    ).resolves.toEqual({ inserted: 0 });
    await expect(
      generateSimulatedRuntimeLogsForRunningAgent({
        db: connection.db,
        agentId: "00000000-0000-4000-8000-000000000201",
        now: beforeIntervalAt,
      }),
    ).resolves.toEqual({ inserted: 0 });
    await expect(
      generateSimulatedRuntimeLogsForRunningAgent({
        db: connection.db,
        agentId: "00000000-0000-4000-8000-000000000201",
        now: nextCycleAt,
      }),
    ).resolves.toEqual({ inserted: SIMULATED_RUNTIME_LOG_MESSAGES.length });

    const page = await listAgentLogs({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
    });

    expect(page.logs.map((log) => log.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(page.logs.map((log) => log.message)).toEqual([
      ...SIMULATED_RUNTIME_LOG_MESSAGES,
      ...SIMULATED_RUNTIME_LOG_MESSAGES,
    ]);
    expect(page.logs.slice(0, 4).every((log) => log.createdAt === firstReadAt.toISOString())).toBe(
      true,
    );
    expect(page.logs.slice(4).every((log) => log.createdAt === nextCycleAt.toISOString())).toBe(
      true,
    );
  });

  it("does not generate for non-running, missing, or soft-deleted agents", async () => {
    const [createdUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.id ?? "";
    const now = new Date("2026-07-04T06:00:00.000Z");
    const pendingTransitionAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS + 1);
    const inactiveAgents: { id: string; expectedLogs: number }[] = [];
    const statuses: AgentLifecycleStatus[] = [
      "idle",
      "stopped",
      "starting",
      "restarting",
      "error",
      "deleting",
    ];

    for (const [index, status] of statuses.entries()) {
      const [agent] = await connection.db
        .insert(agents)
        .values({
          userId,
          name: `${status} Generator Agent`,
          templateKey: "research_agent",
          status,
          updatedAt: status === "starting" || status === "restarting" ? pendingTransitionAt : now,
        })
        .returning({ id: agents.id });

      expect(agent).toBeDefined();
      inactiveAgents.push({ id: agent?.id ?? "", expectedLogs: status === "stopped" ? 1 : 0 });

      if (status === "stopped") {
        await connection.db
          .insert(agentLogs)
          .values(logValue(agent?.id ?? "", index + 1, "stdout", "info", "existing stopped log"));
      }
    }

    const [softDeletedAgent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Soft Deleted Generator Agent",
        templateKey: "research_agent",
        status: "running",
        updatedAt: now,
        deletedAt: now,
      })
      .returning({ id: agents.id });

    expect(softDeletedAgent).toBeDefined();

    for (const agent of inactiveAgents) {
      await expect(
        generateSimulatedRuntimeLogsForRunningAgent({
          db: connection.db,
          agentId: agent.id,
          now,
        }),
      ).resolves.toEqual({ inserted: 0 });
      await expect(countAgentLogs(connection, agent.id)).resolves.toBe(agent.expectedLogs);
    }

    await expect(
      generateSimulatedRuntimeLogsForRunningAgent({
        db: connection.db,
        agentId: softDeletedAgent?.id ?? "",
        now,
      }),
    ).resolves.toEqual({ inserted: 0 });
    await expect(
      generateSimulatedRuntimeLogsForRunningAgent({
        db: connection.db,
        agentId: "00000000-0000-4000-8000-000000000999",
        now,
      }),
    ).resolves.toEqual({ inserted: 0 });
    await expect(countAgentLogs(connection, softDeletedAgent?.id ?? "")).resolves.toBe(0);
  });

  it("allocates monotonic per-agent sequences independently across running agents", async () => {
    const [createdUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.id ?? "";
    const now = new Date("2026-07-04T06:00:01.000Z");
    await connection.db.insert(agents).values([
      {
        id: "00000000-0000-4000-8000-000000000201",
        userId,
        name: "Sequence Agent A",
        templateKey: "research_agent",
        status: "running",
        updatedAt: new Date("2026-07-04T06:00:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000202",
        userId,
        name: "Sequence Agent B",
        templateKey: "research_agent",
        status: "running",
        updatedAt: new Date("2026-07-04T06:00:00.000Z"),
      },
    ]);
    await connection.db
      .insert(agentLogs)
      .values(logValue("00000000-0000-4000-8000-000000000201", 7, "stdout", "info", "prior a"));

    await generateSimulatedRuntimeLogsForRunningAgent({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
      now,
    });
    await generateSimulatedRuntimeLogsForRunningAgent({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000202",
      now,
    });

    const agentAPage = await listAgentLogs({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000201",
    });
    const agentBPage = await listAgentLogs({
      db: connection.db,
      agentId: "00000000-0000-4000-8000-000000000202",
    });

    expect(agentAPage.logs.map((log) => [log.agentId, log.sequence, log.message])).toEqual([
      ["00000000-0000-4000-8000-000000000201", 7, "prior a"],
      ["00000000-0000-4000-8000-000000000201", 8, "Checking task queue..."],
      ["00000000-0000-4000-8000-000000000201", 9, "No pending tasks."],
      ["00000000-0000-4000-8000-000000000201", 10, "Heartbeat OK."],
      ["00000000-0000-4000-8000-000000000201", 11, "Memory loaded."],
    ]);
    expect(agentBPage.logs.map((log) => [log.agentId, log.sequence, log.message])).toEqual([
      ["00000000-0000-4000-8000-000000000202", 1, "Checking task queue..."],
      ["00000000-0000-4000-8000-000000000202", 2, "No pending tasks."],
      ["00000000-0000-4000-8000-000000000202", 3, "Heartbeat OK."],
      ["00000000-0000-4000-8000-000000000202", 4, "Memory loaded."],
    ]);
  });

  it("uses the settled running segment so earlier generated logs do not block restart generation", async () => {
    const [createdUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.id ?? "";
    const firstRunningAt = new Date("2026-07-04T06:00:00.000Z");
    const firstReadAt = new Date("2026-07-04T06:00:01.000Z");
    const restartRequestedAt = new Date("2026-07-04T06:00:05.000Z");
    const restartSettledAt = new Date(
      restartRequestedAt.getTime() + FAKE_RUNNER_START_DELAY_MS + 1,
    );
    const [agent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Restart Segment Generator Agent",
        templateKey: "research_agent",
        status: "running",
        updatedAt: firstRunningAt,
      })
      .returning({ id: agents.id });

    expect(agent).toBeDefined();
    const agentId = agent?.id ?? "";
    await generateSimulatedRuntimeLogsForRunningAgent({
      db: connection.db,
      agentId,
      now: firstReadAt,
    });
    await restartAgentForDevelopmentUser(agentId, {
      createConnection: () => connection,
      now: () => restartRequestedAt,
    });
    await settleDueFakeRunnerTransitions({
      createConnection: () => connection,
      now: () => restartSettledAt,
    });
    await expect(
      generateSimulatedRuntimeLogsForRunningAgent({
        db: connection.db,
        agentId,
        now: restartSettledAt,
      }),
    ).resolves.toEqual({ inserted: SIMULATED_RUNTIME_LOG_MESSAGES.length });

    const page = await listAgentLogs({ db: connection.db, agentId });
    const [persistedAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    expect(persistedAgent).toMatchObject({
      status: "running",
      updatedAt: restartSettledAt,
    });
    expect(page.logs.map((log) => [log.sequence, log.message])).toEqual([
      [1, "Checking task queue..."],
      [2, "No pending tasks."],
      [3, "Heartbeat OK."],
      [4, "Memory loaded."],
      [5, "Checking task queue..."],
      [6, "No pending tasks."],
      [7, "Heartbeat OK."],
      [8, "Memory loaded."],
    ]);
    expect(
      page.logs.slice(4).every((log) => log.createdAt === restartSettledAt.toISOString()),
    ).toBe(true);
  });

  it("settles due start and restart transitions in the logs route before generating", async () => {
    const [createdUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.id ?? "";
    const dueAt = new Date("2000-01-01T00:00:00.000Z");
    await connection.db.insert(agents).values([
      {
        id: "00000000-0000-4000-8000-000000000201",
        userId,
        name: "Due Starting Route Log Agent",
        templateKey: "research_agent",
        status: "starting",
        statusReason: "Start requested.",
        updatedAt: dueAt,
      },
      {
        id: "00000000-0000-4000-8000-000000000202",
        userId,
        name: "Due Restarting Route Log Agent",
        templateKey: "research_agent",
        status: "restarting",
        statusReason: "Restart requested.",
        updatedAt: dueAt,
      },
    ]);

    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");
    const startResponse = await GET(new Request("http://localhost/api/agents/id/logs"), {
      params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000201" }),
    });
    const restartResponse = await GET(new Request("http://localhost/api/agents/id/logs"), {
      params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000202" }),
    });
    const startBody = await startResponse.json();
    const restartBody = await restartResponse.json();
    const completedEvents = await connection.db
      .select()
      .from(agentEvents)
      .orderBy(agentEvents.agentId);

    expect(startResponse.status).toBe(200);
    expect(restartResponse.status).toBe(200);
    expect(startBody.logs.map((log: { message: string }) => log.message)).toEqual([
      ...SIMULATED_RUNTIME_LOG_MESSAGES,
    ]);
    expect(restartBody.logs.map((log: { message: string }) => log.message)).toEqual([
      ...SIMULATED_RUNTIME_LOG_MESSAGES,
    ]);
    expect(completedEvents.map((event) => [event.agentId, event.type])).toEqual([
      ["00000000-0000-4000-8000-000000000201", START_COMPLETED_EVENT_TYPE],
      ["00000000-0000-4000-8000-000000000202", RESTART_COMPLETED_EVENT_TYPE],
    ]);
  });

  it("does not write logs from simulate-error and stops generating after error", async () => {
    const [createdUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.id ?? "";
    const runningAt = new Date("2026-07-04T06:00:00.000Z");
    const firstReadAt = new Date("2026-07-04T06:00:01.000Z");
    const errorAt = new Date("2026-07-04T06:00:02.000Z");
    const afterIntervalAt = new Date(
      firstReadAt.getTime() + SIMULATED_RUNTIME_LOG_CYCLE_INTERVAL_MS,
    );
    const [agent] = await connection.db
      .insert(agents)
      .values({
        userId,
        name: "Error Halt Generator Agent",
        templateKey: "research_agent",
        status: "running",
        updatedAt: runningAt,
      })
      .returning({ id: agents.id });

    expect(agent).toBeDefined();
    const agentId = agent?.id ?? "";
    await generateSimulatedRuntimeLogsForRunningAgent({
      db: connection.db,
      agentId,
      now: firstReadAt,
    });
    await simulateErrorAgentForDevelopmentUser(agentId, {
      createConnection: () => connection,
      now: () => errorAt,
    });
    await expect(
      generateSimulatedRuntimeLogsForRunningAgent({
        db: connection.db,
        agentId,
        now: afterIntervalAt,
      }),
    ).resolves.toEqual({ inserted: 0 });

    const page = await listAgentLogs({ db: connection.db, agentId });
    const errorEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, SIMULATED_ERROR_EVENT_TYPE));

    expect(page.logs).toHaveLength(4);
    expect(errorEvents).toHaveLength(1);
  });
});

async function resetCreateAgentTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_logs, agent_events, agents, app_metadata, users restart identity cascade`;
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
  tableName: "users" | "agents" | "agent_events" | "agent_logs" | "app_metadata",
): Promise<number> {
  const [row] = await connection.db.execute<{ count: string }>(
    sql.raw(`select count(*)::text as count from ${tableName}`),
  );

  return Number(row?.count);
}

async function countAgentLogs(connection: DatabaseConnection, agentId: string): Promise<number> {
  const rows = await connection.db.select().from(agentLogs).where(eq(agentLogs.agentId, agentId));

  return rows.length;
}

function logValue(
  agentId: string,
  sequence: number,
  stream: string,
  level: string,
  message: string,
): typeof agentLogs.$inferInsert {
  return {
    agentId,
    runnerId: null,
    stream,
    level,
    message,
    sequence,
    createdAt: new Date(`2026-07-04T06:00:0${sequence}.000Z`),
  };
}

function setNodeEnvForTest(value: string | undefined) {
  Object.defineProperty(process.env, "NODE_ENV", {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}
