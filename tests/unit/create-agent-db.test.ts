import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentPersistenceError,
  createAgentForDevelopmentUser,
} from "@/src/server/agents/create-agent";
import {
  FAKE_RUNNER_START_DELAY_MS,
  START_COMPLETED_EVENT_TYPE,
  START_REQUESTED_EVENT_TYPE,
  STOP_COMPLETED_EVENT_TYPE,
  STOP_REQUESTED_EVENT_TYPE,
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

  it("lists and loads settled persisted agent lifecycle statuses without hard-coded stopped values", async () => {
    const [createdUser] = await connection.db
      .insert(users)
      .values({})
      .returning({ userId: users.id });

    expect(createdUser).toBeDefined();
    const userId = createdUser?.userId ?? "";
    const now = new Date("2026-07-03T06:00:00.000Z");
    const dueStartingAt = new Date(now.getTime() - FAKE_RUNNER_START_DELAY_MS - 1);

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

    expect(runningAgent).toBeDefined();
    expect(startingAgent).toBeDefined();

    const listed = await listActiveAgentsForDevelopmentUser({ createConnection: () => connection });
    const detail = await getActiveAgentForDevelopmentUser(startingAgent?.id ?? "", {
      createConnection: () => connection,
    });
    const completedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, START_COMPLETED_EVENT_TYPE));

    expect(listed.map((agent) => [agent.name, agent.status])).toEqual([
      ["Due Starting Agent", "running"],
      ["Already Running Agent", "running"],
    ]);
    expect(detail?.status).toBe("running");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({
      agentId: startingAgent?.id,
      actorUserId: userId,
      type: START_COMPLETED_EVENT_TYPE,
      metadata: {
        fromStatus: "starting",
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
