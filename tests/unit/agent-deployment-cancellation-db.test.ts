import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAgentForUser, stopAgentForUser } from "@/src/server/agents/lifecycle";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentEvents,
  agents,
  agentUsagePeriods,
  runners,
  users,
} from "@/src/server/db/schema";

const USER_ID = "00000000-0000-4000-8000-0000000007a1";
const AGENT_ID = "00000000-0000-4000-8000-0000000007a2";
const RUNNER_ID = "00000000-0000-4000-8000-0000000007a3";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-0000000007a4";
const NOW = new Date("2026-08-03T10:00:00.000Z");

describe("automatic deployment lifecycle cancellation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values({ id: USER_ID });
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("persists desired-stopped and terminal cancellation before runner stop effects", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { status: "starting", runnerId: RUNNER_ID });
    await seedActiveDeployment(connection, "configuring_hermes");
    await connection.db.insert(agentUsagePeriods).values({
      agentId: AGENT_ID,
      runnerId: RUNNER_ID,
      startedAt: new Date(NOW.getTime() - 60_000),
    });
    const stop = vi.fn(async () => {
      const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
      const [deployment] = await connection.db
        .select()
        .from(agentDeployments)
        .where(eq(agentDeployments.id, DEPLOYMENT_ID));
      expect(agent?.desiredStatus).toBe("stopped");
      expect(deployment).toMatchObject({
        stage: "failed",
        errorCode: "deployment_cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        failedAt: NOW,
        ownerCancelledAt: NOW,
      });
      const [usage] = await connection.db.select().from(agentUsagePeriods);
      expect(usage?.stoppedAt).toEqual(NOW);
      return { ok: true as const, containers: [] };
    });

    const result = await stopAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      manualRunnerAdapter: (runner) =>
        ({
          stop: async () => ({ ...(await stop()), runner }),
          streamLogs: async () => ({ logs: [], nextAfter: null }),
        }) as never,
    });

    expect(result).toMatchObject({ ok: true, agent: { status: "stopped" } });
    expect(stop).toHaveBeenCalledOnce();
    const events = await connection.db.select().from(agentEvents).orderBy(agentEvents.createdAt);
    expect(events.map((event) => event.type).sort()).toEqual(
      ["agent.deployment_stage_changed", "agent.stop_requested", "agent.stop_completed"].sort(),
    );
    const deploymentEvent = events.find((event) => event.type === "agent.deployment_stage_changed");
    expect(deploymentEvent?.metadata).toEqual({
      deploymentId: DEPLOYMENT_ID,
      fromStage: "configuring_hermes",
      toStage: "failed",
      errorCode: "deployment_cancelled",
    });
  });

  it("lets an owner stop a still-observed-stopped pending operation without runner effects", async () => {
    await seedAgent(connection, { status: "stopped", runnerId: null });
    await seedActiveDeployment(connection, "pending");
    const runnerStop = vi.fn();

    const result = await stopAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      runnerAdapter: { stop: runnerStop } as never,
    });

    expect(result).toMatchObject({ ok: true, agent: { status: "stopped" } });
    expect(runnerStop).not.toHaveBeenCalled();
    const [deployment] = await connection.db.select().from(agentDeployments);
    expect(deployment).toMatchObject({
      stage: "failed",
      errorCode: "deployment_cancelled",
      ownerCancelledAt: NOW,
    });
  });

  it("lets an owner stop after automatic setup reaches a terminal error", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { status: "error", runnerId: RUNNER_ID });
    await connection.db.insert(agentDeployments).values({
      id: DEPLOYMENT_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      stage: "failed",
      configRevision: "cfg-cancel-1",
      idempotencyKey: "Cancel-Key-001",
      errorCode: "runner_recovery_exhausted",
      failedAt: NOW,
    });
    const stop = vi.fn(async () => ({ ok: true as const, containers: [] }));

    const result = await stopAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      manualRunnerAdapter: (runner) =>
        ({
          stop: async () => ({ ...(await stop()), runner }),
          streamLogs: async () => ({ logs: [], nextAfter: null }),
        }) as never,
    });

    expect(result).toMatchObject({ ok: true, agent: { status: "stopped" } });
    expect(stop).toHaveBeenCalledOnce();
    const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
    expect(agent).toMatchObject({ desiredStatus: "stopped", status: "stopped" });
  });

  it("cancels an active operation before delete cleanup and keeps the stale lease powerless", async () => {
    await seedAgent(connection, { status: "stopped", runnerId: null });
    await seedActiveDeployment(connection, "pending");
    const cleanup = vi.fn(async () => {
      const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
      const [deployment] = await connection.db.select().from(agentDeployments);
      expect(agent).toMatchObject({ desiredStatus: "stopped", deletedAt: null });
      expect(deployment).toMatchObject({
        stage: "failed",
        errorCode: "agent_deleted",
        leaseOwner: null,
      });
      return { ok: true as const, container: null };
    });

    const result = await deleteAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      dockerRunnerAdapter: { cleanup },
    });

    expect(result).toMatchObject({ ok: true, agent: { id: AGENT_ID } });
    expect(cleanup).toHaveBeenCalledOnce();
    const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
    expect(agent).toMatchObject({ desiredStatus: "stopped", deletedAt: NOW });
  });

  it("finishes deletion after cancelling setup even when the assigned runner cannot clean up", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { status: "starting", runnerId: RUNNER_ID });
    await seedActiveDeployment(connection, "configuring_hermes");
    const cleanup = vi.fn(async () => ({ ok: false as const }));

    const result = await deleteAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      dockerRunnerAdapter: {
        cleanup: vi.fn(async () => ({ ok: true as const, container: null })),
      },
      manualRunnerAdapter: () =>
        ({
          cleanup,
          stop: vi.fn(async () => ({ ok: false as const })),
        }) as never,
    });

    expect(result).toMatchObject({
      ok: true,
      agent: { id: AGENT_ID, deletedAt: NOW.toISOString() },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
    const [deployment] = await connection.db.select().from(agentDeployments);

    expect(agent).toMatchObject({ desiredStatus: "stopped", deletedAt: NOW });
    expect(deployment).toMatchObject({ stage: "failed", errorCode: "agent_deleted" });
  });
});

async function seedRunner(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(runners).values({
    id: RUNNER_ID,
    userId: USER_ID,
    name: "Cancellation Runner",
    kind: "manual_vps",
    endpointUrl: "http://127.0.0.1:3045",
    status: "online",
  });
}

async function seedAgent(
  connection: DatabaseConnection,
  input: { status: "starting" | "stopped" | "error"; runnerId: string | null },
): Promise<void> {
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    runnerId: input.runnerId,
    name: "Cancellation Agent",
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status: input.status,
    desiredStatus: "running",
  });
}

async function seedActiveDeployment(
  connection: DatabaseConnection,
  stage: "pending" | "configuring_hermes",
): Promise<void> {
  await connection.db.insert(agentDeployments).values({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    stage,
    configRevision: "cfg-cancel-1",
    idempotencyKey: "Cancel-Key-001",
    attemptCount: 3,
    leaseOwner: "reconcile:11111111-1111-4111-8111-111111111111",
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    nextAttemptAt: new Date(NOW.getTime() + 30_000),
    acceptedAt: new Date(NOW.getTime() - 1_000),
  });
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table agent_events, agent_deployments, agents, runners, users restart identity cascade",
  );
}
