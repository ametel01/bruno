import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileNextAgentDeployment } from "@/src/server/agents/agent-deployment-reconciler";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentEvents,
  agentUsagePeriods,
  agents,
  runners,
  users,
} from "@/src/server/db/schema";
import type { RunnerAgentStatusSnapshot } from "@/src/runner-service/runner-contracts";
import { sampleManagedLaunchSpec } from "@/tests/helpers/agent-launch-spec";

const USER_ID = "00000000-0000-4000-8000-0000000007b1";
const AGENT_ID = "00000000-0000-4000-8000-0000000007b2";
const RUNNER_ID = "00000000-0000-4000-8000-0000000007b3";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-0000000007b4";
const OPERATION_ID = "00000000-0000-4000-8000-0000000007b5";
const CONFIG_REVISION = "cfg-final-race-1";
const NOW = new Date("2026-08-03T11:00:00.000Z");

describe("automatic deployment finalization race", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await seedFinalizableDeployment(connection);
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("uses separate connections and SKIP LOCKED to finalize one running transition and usage", async () => {
    const first = createDatabaseConnection();
    const second = createDatabaseConnection();
    let releaseStatus: (() => void) | undefined;
    const statusEntered = Promise.withResolvers<void>();
    const status = vi.fn(
      async () =>
        await new Promise<{
          ok: true;
          runner: ReturnType<typeof manualRunner>;
          snapshot: RunnerAgentStatusSnapshot;
        }>((resolve) => {
          statusEntered.resolve();
          releaseStatus = () =>
            resolve({ ok: true, runner: manualRunner(), snapshot: readySnapshot() });
        }),
    );
    const adapter = {
      status,
      start: vi.fn(),
      stop: vi.fn(),
      streamLogs: vi.fn(),
      canary: vi.fn(),
    };

    try {
      const firstRun = reconcileNextAgentDeployment({
        createConnection: () => first,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      });
      await statusEntered.promise;
      const secondRun = reconcileNextAgentDeployment({
        createConnection: () => second,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      });

      await expect(secondRun).resolves.toEqual({ processed: 0, outcome: "idle" });
      releaseStatus?.();
      await expect(firstRun).resolves.toEqual({ processed: 1, outcome: "ready" });

      expect(status).toHaveBeenCalledOnce();
      const [deployment] = await connection.db.select().from(agentDeployments);
      const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
      const usage = await connection.db.select().from(agentUsagePeriods);
      const events = await connection.db.select().from(agentEvents);
      expect(deployment).toMatchObject({ stage: "ready", completedAt: NOW });
      expect(agent).toMatchObject({ status: "running", desiredStatus: "running" });
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ agentId: AGENT_ID, runnerId: RUNNER_ID, startedAt: NOW });
      expect(events.filter((event) => event.type === "agent.start_completed")).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "agent.deployment_stage_changed"),
      ).toHaveLength(1);
    } finally {
      releaseStatus?.();
      await Promise.all([first.close(), second.close()]);
    }
  });
});

async function seedFinalizableDeployment(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values({ id: USER_ID });
  await connection.db.insert(runners).values({
    id: RUNNER_ID,
    userId: USER_ID,
    name: "Finalization Runner",
    kind: "manual_vps",
    endpointUrl: "http://127.0.0.1:3045",
    status: "online",
  });
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    runnerId: RUNNER_ID,
    name: "Finalization Agent",
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status: "starting",
    desiredStatus: "running",
  });
  await connection.db.insert(agentDeployments).values({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    stage: "connecting_telegram",
    configRevision: CONFIG_REVISION,
    idempotencyKey: "Finalize-Key-001",
    runnerOperationId: OPERATION_ID,
    runnerAcceptedAt: NOW,
    canaryState: "passed",
    canaryAttemptedAt: new Date(NOW.getTime() - 2_000),
    canaryCompletedAt: new Date(NOW.getTime() - 1_000),
  });
}

function manualRunner() {
  return {
    id: RUNNER_ID,
    userId: USER_ID,
    name: "Finalization Runner",
    kind: "manual_vps" as const,
    endpointUrl: "http://127.0.0.1:3045",
    status: "online" as const,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    deletedAt: null,
  };
}

function readySnapshot(): RunnerAgentStatusSnapshot {
  const launch = sampleManagedLaunchSpec();
  return {
    phase: "ready",
    operation: {
      id: OPERATION_ID,
      action: "start",
      target: {
        image: launch.image.ref,
        launchSpecVersion: launch.version,
        configRevision: CONFIG_REVISION,
      },
      acceptedAt: NOW.toISOString(),
    },
    container: {
      id: "bounded-test-container",
      name: "bounded-test-container",
      image: launch.image.ref,
      state: "running",
      startedAt: NOW.toISOString(),
      finishedAt: null,
      observedAt: NOW.toISOString(),
    },
    revision: {
      state: "match",
      requested: CONFIG_REVISION,
      containerLabel: CONFIG_REVISION,
      projectionMarker: CONFIG_REVISION,
      observedAt: NOW.toISOString(),
    },
    gateway: { state: "running", observedAt: NOW.toISOString() },
    apiServer: { required: true, state: "connected", observedAt: NOW.toISOString() },
    telegram: { required: true, state: "connected", observedAt: NOW.toISOString() },
    readinessReason: null,
    observedAt: NOW.toISOString(),
  };
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table agent_events, agent_usage_periods, agent_deployments, agents, runners, users restart identity cascade",
  );
}
