import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as restartAgentRoute } from "@/app/api/agents/[agentId]/actions/restart/route";
import { POST as simulateErrorAgentRoute } from "@/app/api/agents/[agentId]/actions/simulate-error/route";
import { POST as startAgentRoute } from "@/app/api/agents/[agentId]/actions/start/route";
import { POST as stopAgentRoute } from "@/app/api/agents/[agentId]/actions/stop/route";
import { GET as agentEventsRoute } from "@/app/api/agents/[agentId]/events/route";
import { GET as agentLogsRoute } from "@/app/api/agents/[agentId]/logs/route";
import {
  DELETE as deleteAgentRoute,
  PATCH as updateAgentRoute,
} from "@/app/api/agents/[agentId]/route";
import { POST as createAgentRoute } from "@/app/api/agents/route";
import { createAgentForUser } from "@/src/server/agents/create-agent";
import {
  type AgentLifecycleDependencies,
  deleteAgentForUser,
  restartAgentForUser,
  simulateErrorAgentForUser,
  startAgentForUser,
  stopAgentForUser,
} from "@/src/server/agents/lifecycle";
import { getActiveAgentForUser, listActiveAgentsForUser } from "@/src/server/agents/list-agents";
import { updateAgentConfigForUser } from "@/src/server/agents/update-agent-config";
import { getCostEstimatesForUser } from "@/src/server/costs/cost-estimates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentApprovals,
  agentConfigs,
  agentEvents,
  agentLogs,
  agentUsagePeriods,
  agents,
  dockerRunnerContainers,
  localRunnerProcesses,
  runnerHeartbeats,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  generateSimulatedRuntimeLogsForUser,
  listAgentLogsForUser,
} from "@/src/server/logs/agent-logs";
import { DockerRunnerMaintenanceAdapter } from "@/src/server/runners/docker-runner-maintenance";
import {
  appendDockerRunnerLogLinesForUser,
  getDockerRunnerContainerForUser,
  listDockerRunnerContainerLogsForUser,
  recordDockerRunnerContainerForUser,
} from "@/src/server/runners/docker-runner-state";
import {
  appendLocalRunnerLogLinesForUser,
  createLocalRunnerProcessForUser,
  listLocalRunnerProcessLogsForUser,
  recordLocalRunnerProcessExitForUser,
} from "@/src/server/runners/local-runner-state";
import {
  appendManualRunnerLogLinesForUser,
  listManualRunnerLogsForUser,
} from "@/src/server/runners/manual-runner-adapter";

const USER_A_ID = "00000000-0000-4000-8000-000000000a21";
const USER_B_ID = "00000000-0000-4000-8000-000000000b21";
const AGENT_A_ID = "00000000-0000-4000-8000-000000000a22";
const AGENT_B_ID = "00000000-0000-4000-8000-000000000b22";
const RUNNER_A_ID = "00000000-0000-4000-8000-000000000a23";
const RUNNER_B_ID = "00000000-0000-4000-8000-000000000b23";
const CONTAINER_B_ID = "00000000-0000-4000-8000-000000000b24";
const MISSING_AGENT_ID = "00000000-0000-4000-8000-000000000404";
const NOW = new Date("2026-07-10T10:00:00.000Z");

describe("agent request-user isolation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
    await seedTwoUsers(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("binds create, list, view, config, logs, events, usage, and costs to the explicit user", async () => {
    const createResponse = await createAgentRoute(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "A-ONLY-CREATED", templateKey: "research_agent" }),
      }),
      undefined,
      routeUser(USER_A_ID),
    );
    const createBody = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(createBody.agent).toMatchObject({ userId: USER_A_ID, name: "A-ONLY-CREATED" });
    const createdAgentId = String(createBody.agent.id);

    const directCreated = await createAgentForUser(
      USER_A_ID,
      { name: "A-ONLY-DIRECT", templateKey: "research_agent" },
      { createConnection: () => connection, autoProvisionCloudRunner: false },
    );
    expect(directCreated.agent.userId).toBe(USER_A_ID);

    const listedForA = await listActiveAgentsForUser(USER_A_ID, {
      createConnection: () => connection,
    });
    expect(listedForA.map((agent) => agent.name).sort()).toEqual(
      ["A-ONLY-CREATED", "A-ONLY-DIRECT", "A-ONLY-AGENT"].sort(),
    );
    expect(JSON.stringify(listedForA)).not.toContain("B-ONLY");
    await expect(
      getActiveAgentForUser(USER_A_ID, AGENT_B_ID, { createConnection: () => connection }),
    ).resolves.toBeNull();

    const updateResponse = await updateAgentRoute(
      new Request(`http://localhost/api/agents/${createdAgentId}`, {
        method: "PATCH",
        body: JSON.stringify({ modelName: "a-only-model" }),
      }),
      { params: Promise.resolve({ agentId: createdAgentId }) },
      routeUser(USER_A_ID),
    );
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      ok: true,
      config: { modelName: "a-only-model" },
    });

    const [configEvent] = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, createdAgentId));
    expect(configEvent).toMatchObject({ actorUserId: USER_A_ID });

    await expect(
      updateAgentConfigForUser(
        USER_A_ID,
        AGENT_B_ID,
        { modelName: "leak" },
        {
          createConnection: () => connection,
        },
      ),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });
    await expect(
      listAgentLogsForUser({ db: connection.db, userId: USER_A_ID, agentId: AGENT_B_ID }),
    ).resolves.toEqual({ logs: [], nextAfter: null });

    const beforeForeignGeneration = await captureState(connection);
    await connection.db
      .update(agents)
      .set({ status: "running", updatedAt: new Date(NOW.getTime() - 1_000) })
      .where(eq(agents.id, AGENT_B_ID));
    const beforeRunningForeignGeneration = await captureState(connection);
    await expect(
      generateSimulatedRuntimeLogsForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ inserted: 0 });
    await expect(captureState(connection)).resolves.toEqual(beforeRunningForeignGeneration);
    await expect(
      generateSimulatedRuntimeLogsForUser({
        db: connection.db,
        userId: USER_B_ID,
        agentId: AGENT_B_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ inserted: 4 });
    expect(beforeForeignGeneration.agents).not.toEqual(beforeRunningForeignGeneration.agents);

    const generatedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, AGENT_B_ID));
    expect(generatedEvents).toEqual([
      expect.objectContaining({ actorUserId: USER_B_ID, type: "approval.requested" }),
    ]);

    const costsForA = JSON.stringify(await getCostEstimatesForUser(USER_A_ID));
    const costsForB = JSON.stringify(await getCostEstimatesForUser(USER_B_ID));
    expect(costsForA).not.toContain("B-ONLY-RUNNER");
    expect(costsForB).toContain("B-ONLY-RUNNER");
  });

  it("makes every foreign and missing agent route identical with zero side effects", async () => {
    const before = await captureState(connection);
    const routePairs = [
      {
        name: "update",
        invoke: (agentId: string) =>
          updateAgentRoute(
            new Request(`http://localhost/api/agents/${agentId}`, {
              method: "PATCH",
              body: JSON.stringify({ modelName: "must-not-persist" }),
            }),
            { params: Promise.resolve({ agentId }) },
            routeUser(USER_A_ID),
          ),
      },
      ...[
        { name: "start", route: startAgentRoute },
        { name: "stop", route: stopAgentRoute },
        { name: "restart", route: restartAgentRoute },
        { name: "simulate error", route: simulateErrorAgentRoute },
      ].map(({ name, route }) => ({
        name,
        invoke: (agentId: string) =>
          route(
            new Request(`http://localhost/api/agents/${agentId}/actions`),
            { params: Promise.resolve({ agentId }) },
            routeUser(USER_A_ID),
          ),
      })),
      {
        name: "delete",
        invoke: (agentId: string) =>
          deleteAgentRoute(
            new Request(`http://localhost/api/agents/${agentId}`, { method: "DELETE" }),
            { params: Promise.resolve({ agentId }) },
            routeUser(USER_A_ID),
          ),
      },
      {
        name: "events",
        invoke: (agentId: string) =>
          agentEventsRoute(
            new Request(`http://localhost/api/agents/${agentId}/events`),
            { params: Promise.resolve({ agentId }) },
            routeUser(USER_A_ID),
          ),
      },
      {
        name: "logs",
        invoke: (agentId: string) =>
          agentLogsRoute(
            new Request(`http://localhost/api/agents/${agentId}/logs`),
            { params: Promise.resolve({ agentId }) },
            routeUser(USER_A_ID),
          ),
      },
    ];

    for (const route of routePairs) {
      const foreign = await route.invoke(AGENT_B_ID);
      const missing = await route.invoke(MISSING_AGENT_ID);
      const foreignBody = await foreign.json();
      const missingBody = await missing.json();

      expect(foreign.status, route.name).toBe(404);
      expect(missing.status, route.name).toBe(404);
      expect(foreignBody, route.name).toEqual(missingBody);
      expect(JSON.stringify(foreignBody), route.name).not.toContain("B-ONLY");
      expect(JSON.stringify(foreignBody), route.name).not.toContain(AGENT_B_ID);
    }

    await expect(captureState(connection)).resolves.toEqual(before);

    const adapter = neverCalledLifecycleAdapter();
    const cleanup = vi.fn(async () => ({ ok: true as const, container: null }));
    const lifecycleDependencies: AgentLifecycleDependencies = {
      createConnection: () => connection,
      runnerAdapter: adapter,
      manualRunnerAdapter: () => adapter,
      dockerRunnerAdapter: { cleanup },
      now: () => NOW,
    };
    const serviceOperations = [
      startAgentForUser,
      stopAgentForUser,
      restartAgentForUser,
      simulateErrorAgentForUser,
      deleteAgentForUser,
    ] as const;

    for (const operation of serviceOperations) {
      await expect(operation(USER_A_ID, AGENT_B_ID, lifecycleDependencies)).resolves.toEqual({
        ok: false,
        reason: "agent_not_found",
      });
      await expect(operation(USER_A_ID, MISSING_AGENT_ID, lifecycleDependencies)).resolves.toEqual({
        ok: false,
        reason: "agent_not_found",
      });
    }

    expect(adapter.start).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(adapter.restart).not.toHaveBeenCalled();
    expect(adapter.status).not.toHaveBeenCalled();
    expect(adapter.streamLogs).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    await expect(captureState(connection)).resolves.toEqual(before);
  });

  it("records owner lifecycle events and usage under the same explicit user", async () => {
    await connection.db.insert(runnerHeartbeats).values({
      runnerId: RUNNER_A_ID,
      status: "online",
      metadata: { metrics: { maxAgents: 4, runningAgents: 0 } },
      observedAt: NOW,
    });
    const adapter = successfulLifecycleAdapter();
    const cleanup = vi.fn(async () => ({ ok: true as const, container: null }));
    const dependencies: AgentLifecycleDependencies = {
      createConnection: () => connection,
      manualRunnerAdapter: () => adapter,
      runnerAdapter: adapter,
      dockerRunnerAdapter: { cleanup },
      now: () => NOW,
    };

    await expect(startAgentForUser(USER_A_ID, AGENT_A_ID, dependencies)).resolves.toMatchObject({
      ok: true,
      agent: { userId: USER_A_ID, status: "running" },
    });
    await expect(restartAgentForUser(USER_A_ID, AGENT_A_ID, dependencies)).resolves.toMatchObject({
      ok: true,
      agent: { userId: USER_A_ID, status: "running" },
    });
    await expect(stopAgentForUser(USER_A_ID, AGENT_A_ID, dependencies)).resolves.toMatchObject({
      ok: true,
      agent: { userId: USER_A_ID, status: "stopped" },
    });
    await expect(
      simulateErrorAgentForUser(USER_A_ID, AGENT_A_ID, dependencies),
    ).resolves.toMatchObject({
      ok: true,
      agent: { userId: USER_A_ID, status: "error" },
    });
    await expect(deleteAgentForUser(USER_A_ID, AGENT_A_ID, dependencies)).resolves.toMatchObject({
      ok: true,
      agent: { userId: USER_A_ID },
    });

    const events = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, AGENT_A_ID));
    expect(events).toHaveLength(8);
    expect(events.every((event) => event.actorUserId === USER_A_ID)).toBe(true);
    const [usagePeriod] = await connection.db
      .select()
      .from(agentUsagePeriods)
      .where(eq(agentUsagePeriods.agentId, AGENT_A_ID));
    expect(usagePeriod).toMatchObject({ runnerId: RUNNER_A_ID, stoppedAt: NOW });
    expect(cleanup).toHaveBeenCalledWith(AGENT_A_ID);
  });

  it("owner-scopes Docker, manual, and local runtime state before adapter effects", async () => {
    const before = await captureState(connection);
    const dockerCli = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const foreignMaintenance = new DockerRunnerMaintenanceAdapter({
      createConnection: () => connection,
      dockerCli,
      userId: USER_A_ID,
    });

    await expect(
      recordDockerRunnerContainerForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
        containerId: CONTAINER_B_ID,
        containerName: "b-only-container",
        image: "busybox:1.36",
        observedStatus: "running",
        observedAt: NOW,
      }),
    ).resolves.toBeNull();
    await expect(
      appendManualRunnerLogLinesForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
        runnerId: RUNNER_B_ID,
        lines: [{ stream: "stdout", message: "must-not-persist" }],
      }),
    ).resolves.toEqual({ inserted: 0, logs: [] });
    await expect(
      createLocalRunnerProcessForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
        pid: 42_001,
        commandMetadata: { command: "must-not-run" },
      }),
    ).resolves.toBeNull();
    await expect(foreignMaintenance.cleanup(AGENT_B_ID)).resolves.toEqual({
      ok: true,
      container: null,
    });
    expect(dockerCli).not.toHaveBeenCalled();
    await expect(captureState(connection)).resolves.toEqual(before);

    const container = await recordDockerRunnerContainerForUser({
      db: connection.db,
      userId: USER_B_ID,
      agentId: AGENT_B_ID,
      containerId: CONTAINER_B_ID,
      containerName: "b-only-container",
      image: "busybox:1.36",
      observedStatus: "running",
      observedAt: NOW,
      startedAt: NOW,
    });
    expect(container).toMatchObject({ agentId: AGENT_B_ID, containerId: CONTAINER_B_ID });
    await expect(
      getDockerRunnerContainerForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
      }),
    ).resolves.toBeNull();
    await expect(
      appendDockerRunnerLogLinesForUser({
        db: connection.db,
        userId: USER_A_ID,
        containerId: CONTAINER_B_ID,
        lines: [{ stream: "stdout", message: "foreign docker log" }],
      }),
    ).resolves.toEqual({ inserted: 0, logs: [] });
    await expect(
      appendDockerRunnerLogLinesForUser({
        db: connection.db,
        userId: USER_B_ID,
        containerId: CONTAINER_B_ID,
        lines: [{ stream: "stdout", message: "B-ONLY-DOCKER-LOG" }],
      }),
    ).resolves.toMatchObject({ inserted: 1 });
    await expect(
      listDockerRunnerContainerLogsForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
        containerId: CONTAINER_B_ID,
      }),
    ).resolves.toEqual([]);

    await expect(
      appendManualRunnerLogLinesForUser({
        db: connection.db,
        userId: USER_B_ID,
        agentId: AGENT_B_ID,
        runnerId: RUNNER_B_ID,
        lines: [{ stream: "stdout", message: "B-ONLY-MANUAL-LOG" }],
      }),
    ).resolves.toMatchObject({ inserted: 1 });
    await expect(
      listManualRunnerLogsForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
        runnerId: RUNNER_B_ID,
      }),
    ).resolves.toEqual([]);

    const process = await createLocalRunnerProcessForUser({
      db: connection.db,
      userId: USER_B_ID,
      agentId: AGENT_B_ID,
      pid: 42_002,
      commandMetadata: { command: "b-only-runner" },
      startedAt: NOW,
    });
    expect(process).toMatchObject({ agentId: AGENT_B_ID, status: "running" });
    if (!process) {
      throw new Error("Expected the owner local process to be created.");
    }
    await expect(
      appendLocalRunnerLogLinesForUser({
        db: connection.db,
        userId: USER_A_ID,
        processId: process.id,
        lines: [{ stream: "stdout", message: "foreign local log" }],
      }),
    ).resolves.toEqual({ inserted: 0, logs: [] });
    await expect(
      appendLocalRunnerLogLinesForUser({
        db: connection.db,
        userId: USER_B_ID,
        processId: process.id,
        lines: [{ stream: "stdout", message: "B-ONLY-LOCAL-LOG" }],
      }),
    ).resolves.toMatchObject({ inserted: 1 });
    await expect(
      listLocalRunnerProcessLogsForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
        processId: process.id,
      }),
    ).resolves.toEqual([]);
    await expect(
      recordLocalRunnerProcessExitForUser({
        db: connection.db,
        userId: USER_A_ID,
        processId: process.id,
        status: "stopped",
        stoppedAt: NOW,
      }),
    ).resolves.toBeNull();
    await expect(
      recordLocalRunnerProcessExitForUser({
        db: connection.db,
        userId: USER_B_ID,
        processId: process.id,
        status: "stopped",
        stoppedAt: NOW,
      }),
    ).resolves.toMatchObject({ status: "stopped" });
  });
});

function routeUser(userId: string) {
  return {
    requireApplicationUser: async () => ({ ok: true as const, userId }),
  };
}

async function seedTwoUsers(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values([
    { id: USER_A_ID, clerkUserId: "agent_user_a" },
    { id: USER_B_ID, clerkUserId: "agent_user_b" },
  ]);
  await connection.db.insert(runners).values([
    {
      id: RUNNER_A_ID,
      userId: USER_A_ID,
      name: "A-ONLY-RUNNER",
      kind: "manual_vps",
      endpointUrl: "https://a-runner.example.test",
      status: "online",
      updatedAt: NOW,
    },
    {
      id: RUNNER_B_ID,
      userId: USER_B_ID,
      name: "B-ONLY-RUNNER",
      kind: "manual_vps",
      endpointUrl: "https://b-runner.example.test",
      status: "offline",
      updatedAt: NOW,
    },
  ]);
  await connection.db.insert(agents).values([
    {
      id: AGENT_A_ID,
      userId: USER_A_ID,
      runnerId: RUNNER_A_ID,
      name: "A-ONLY-AGENT",
      templateKey: "research_agent",
      status: "stopped",
      updatedAt: NOW,
    },
    {
      id: AGENT_B_ID,
      userId: USER_B_ID,
      runnerId: RUNNER_B_ID,
      name: "B-ONLY-AGENT",
      templateKey: "research_agent",
      status: "stopped",
      updatedAt: NOW,
    },
  ]);
  await connection.db
    .insert(agentConfigs)
    .values([agentConfig(AGENT_A_ID, "A-ONLY-PROMPT"), agentConfig(AGENT_B_ID, "B-ONLY-PROMPT")]);
  await connection.db.insert(agentLogs).values({
    agentId: AGENT_B_ID,
    runnerId: RUNNER_B_ID,
    source: "manual_runner",
    stream: "stdout",
    level: "info",
    message: "B-ONLY-LOG",
    sequence: 1,
    createdAt: new Date(NOW.getTime() - 2_000),
  });
  await connection.db.insert(agentUsagePeriods).values({
    agentId: AGENT_B_ID,
    runnerId: RUNNER_B_ID,
    startedAt: new Date(NOW.getTime() - 60_000),
    stoppedAt: NOW,
  });
}

function agentConfig(agentId: string, systemPrompt: string) {
  return {
    agentId,
    systemPrompt,
    modelProvider: "not_configured",
    modelName: "not_configured",
    scheduleMode: "manual" as const,
    timezone: "UTC",
  };
}

function neverCalledLifecycleAdapter() {
  return {
    start: vi.fn(async () => {
      throw new Error("start must not run");
    }),
    stop: vi.fn(async () => {
      throw new Error("stop must not run");
    }),
    restart: vi.fn(async () => {
      throw new Error("restart must not run");
    }),
    status: vi.fn(async () => {
      throw new Error("status must not run");
    }),
    streamLogs: vi.fn(async () => {
      throw new Error("streamLogs must not run");
    }),
  };
}

function successfulLifecycleAdapter(): NonNullable<AgentLifecycleDependencies["runnerAdapter"]> {
  const runner = {
    id: RUNNER_A_ID,
    userId: USER_A_ID,
    name: "A-ONLY-RUNNER",
    kind: "manual_vps" as const,
    endpointUrl: "https://a-runner.example.test",
    status: "online" as const,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    deletedAt: null,
  };

  return {
    start: vi.fn(async (agentId: string) => ({
      ok: true as const,
      runner,
      container: { id: `start-${agentId}`, status: "running" },
    })),
    stop: vi.fn(async (agentId: string) => ({
      ok: true as const,
      runner,
      containers: [{ id: `stop-${agentId}`, status: "exited" }],
    })),
    restart: vi.fn(async (agentId: string) => ({
      ok: true as const,
      runner,
      container: { id: `restart-${agentId}`, status: "running" },
    })),
    status: vi.fn(async (agentId: string) => ({
      ok: true as const,
      runner,
      containers: [{ id: `status-${agentId}`, status: "running" }],
    })),
    streamLogs: vi.fn(async () => ({ logs: [], nextAfter: null })),
  };
}

async function captureState(connection: DatabaseConnection) {
  const [
    agentRows,
    configRows,
    eventRows,
    logRows,
    usageRows,
    runnerRows,
    heartbeatRows,
    approvals,
    containers,
    processes,
  ] = await Promise.all([
    connection.db.select().from(agents).orderBy(asc(agents.id)),
    connection.db.select().from(agentConfigs).orderBy(asc(agentConfigs.agentId)),
    connection.db.select().from(agentEvents).orderBy(asc(agentEvents.id)),
    connection.db.select().from(agentLogs).orderBy(asc(agentLogs.id)),
    connection.db.select().from(agentUsagePeriods).orderBy(asc(agentUsagePeriods.id)),
    connection.db.select().from(runners).orderBy(asc(runners.id)),
    connection.db.select().from(runnerHeartbeats).orderBy(asc(runnerHeartbeats.id)),
    connection.db.select().from(agentApprovals).orderBy(asc(agentApprovals.id)),
    connection.db.select().from(dockerRunnerContainers).orderBy(asc(dockerRunnerContainers.id)),
    connection.db.select().from(localRunnerProcesses).orderBy(asc(localRunnerProcesses.id)),
  ]);

  return {
    agents: agentRows,
    configs: configRows,
    events: eventRows,
    logs: logRows,
    usage: usageRows,
    runners: runnerRows,
    heartbeats: heartbeatRows,
    approvals,
    containers,
    processes,
  };
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_approvals, agent_configs, agent_usage_periods, backups, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
