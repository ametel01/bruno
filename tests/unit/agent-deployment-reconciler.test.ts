import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerAgentStatusSnapshot } from "@/src/runner-service/runner-contracts";
import {
  computeDeploymentBackoffMs,
  reconcileNextAgentDeployment,
  reconcileTargetRunnerDeployment,
} from "@/src/server/agents/agent-deployment-reconciler";
import { retryAgentDeploymentForUser } from "@/src/server/agents/agent-deployment-retry";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentConfigs,
  agentDeployments,
  agentEvents,
  agentLogs,
  agentRuntimeReconciliations,
  agents,
  agentUsagePeriods,
  runnerHeartbeats,
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
  users,
} from "@/src/server/db/schema";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import {
  ManualRunnerAdapter,
  RUNNER_BEARER_TOKEN_ENV,
} from "@/src/server/runners/manual-runner-adapter";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";
import { sampleManagedLaunchSpec } from "@/tests/helpers/agent-launch-spec";

const USER_ID = "00000000-0000-4000-8000-00000000a701";
const AGENT_ID = "00000000-0000-4000-8000-00000000a711";
const RUNNER_ID = "00000000-0000-4000-8000-00000000a721";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-00000000a731";
const OPERATION_ID = "00000000-0000-4000-8000-00000000a741";
const NOW = new Date("2026-08-03T08:00:00.000Z");
const CONFIG_REVISION = "cfg-1784000000000";
const CUSTOM_HERMES_IMAGE =
  "ghcr.io/ametel01/agentbay-hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("agent deployment reconciler", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
    await seedUser(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("claims one pending deployment and reserves one eligible runner without runner transport", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: null });
    await seedDeployment(connection, { stage: "pending" });
    const adapterFactory = vi.fn();

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: adapterFactory,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "advanced" });

    expect(adapterFactory).not.toHaveBeenCalled();
    const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    const events = await connection.db.select().from(agentEvents).orderBy(agentEvents.createdAt);

    expect(agent).toMatchObject({
      runnerId: RUNNER_ID,
      status: "starting",
      statusReason: "Automatic deployment is in progress.",
    });
    expect(deployment).toMatchObject({
      stage: "configuring_hermes",
      attemptCount: 1,
      leaseOwner: null,
    });
    expect(events.map((event) => event.type)).toEqual([
      "agent.start_requested",
      "agent.deployment_stage_changed",
    ]);
    expect(JSON.stringify(events)).not.toMatch(/lease|operation|endpoint|secret|ready-key/i);
  });

  it.each([
    ["offline", { status: "offline", maxAgents: 1, runningAgents: 0 }],
    ["full", { status: "online", maxAgents: 1, runningAgents: 1 }],
  ] as const)("keeps an assigned %s runner authoritative and schedules backoff", async (_name, state) => {
    await seedRunner(connection);
    await connection.db
      .update(runners)
      .set({ status: state.status })
      .where(eq(runners.id, RUNNER_ID));
    await connection.db
      .update(runnerHeartbeats)
      .set({
        status: state.status,
        metadata: { metrics: { maxAgents: state.maxAgents, runningAgents: state.runningAgents } },
      })
      .where(eq(runnerHeartbeats.runnerId, RUNNER_ID));
    await seedAgent(connection, { runnerId: RUNNER_ID });
    await seedDeployment(connection, { stage: "pending" });

    await expect(
      reconcileNextAgentDeployment({ createConnection: () => connection, now: () => NOW }),
    ).resolves.toEqual({ processed: 1, outcome: "retry_scheduled" });

    const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(agent?.runnerId).toBe(RUNNER_ID);
    expect(deployment).toMatchObject({ stage: "pending", errorCode: "runner_capacity_wait" });
    expect(await connection.db.select().from(runners)).toHaveLength(1);
  });

  it("accepts one eligible explicitly assigned runner under the capacity lock", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID });
    await seedDeployment(connection, { stage: "pending" });

    await expect(
      reconcileNextAgentDeployment({ createConnection: () => connection, now: () => NOW }),
    ).resolves.toEqual({ processed: 1, outcome: "advanced" });

    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment?.stage).toBe("configuring_hermes");
  });

  it("creates and assigns one exact keyed provisioning runner through the partial unique index", async () => {
    const second = createDatabaseConnection();
    try {
      await seedAgent(connection, { runnerId: null });
      await seedDeployment(connection, { stage: "pending" });
      const dependencies = {
        now: () => NOW,
        readDigitalOceanConfig: () => automaticProviderConfig(),
      };

      const results = await Promise.all([
        reconcileNextAgentDeployment({ ...dependencies, createConnection: () => connection }),
        reconcileNextAgentDeployment({ ...dependencies, createConnection: () => second }),
      ]);

      expect(results).toEqual(
        expect.arrayContaining([
          { processed: 1, outcome: "advanced" },
          { processed: 0, outcome: "idle" },
        ]),
      );
      const provisioned = await connection.db.select().from(runners);
      const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
      expect(provisioned).toHaveLength(1);
      expect(provisioned[0]).toMatchObject({
        userId: USER_ID,
        kind: "digitalocean",
        provisioningStatus: "pending",
        provisioningOperationKey: `agentbay-deploy-${DEPLOYMENT_ID.replaceAll("-", "")}`,
      });
      expect(agent?.runnerId).toBe(provisioned[0]?.id);
    } finally {
      await second.close();
    }
  });

  it("fails closed when an exact provisioning operation key belongs to another owner", async () => {
    const otherUserId = "00000000-0000-4000-8000-00000000a702";
    await connection.db.insert(users).values({ id: otherUserId, createdAt: NOW, updatedAt: NOW });
    await connection.db.insert(runners).values({
      userId: otherUserId,
      name: "Foreign automatic runner",
      kind: "digitalocean",
      status: "provisioning",
      provider: "digitalocean",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "pending",
      provisioningOperationKey: `agentbay-deploy-${DEPLOYMENT_ID.replaceAll("-", "")}`,
      provisioningStartedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await seedAgent(connection, { runnerId: null });
    await seedDeployment(connection, { stage: "pending" });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        readDigitalOceanConfig: () => automaticProviderConfig(),
      }),
    ).resolves.toEqual({ processed: 1, outcome: "failed" });

    const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
    expect(agent?.runnerId).toBeNull();
  });

  it("persists accepted runner operation evidence and advances exactly one stage", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID });
    await seedDeployment(connection, { stage: "configuring_hermes" });
    const launchSpec = sampleManagedLaunchSpec({
      agent: { ...sampleManagedLaunchSpec().agent, id: AGENT_ID, configRevision: CONFIG_REVISION },
      image: { ref: CUSTOM_HERMES_IMAGE },
    });
    const launchSpecBuilder = vi.fn(async () => ({ ok: true as const, spec: launchSpec }));
    const readHermesWorkloadImage = vi.fn(() => CUSTOM_HERMES_IMAGE);
    const adapter = fakeRunnerAdapter({
      start: vi.fn(async () => ({
        ok: true,
        state: "accepted" as const,
        runner: manualRunner(),
        operation: {
          id: OPERATION_ID,
          action: "start" as const,
          target: {
            image: launchSpec.image.ref,
            launchSpecVersion: launchSpec.version,
            configRevision: CONFIG_REVISION,
          },
          acceptedAt: NOW.toISOString(),
        },
        snapshot: readySnapshot(),
      })),
    });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        readHermesWorkloadImage,
        launchSpec: launchSpecBuilder,
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "advanced" });

    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledWith(AGENT_ID, launchSpec);
    expect(adapter.status).not.toHaveBeenCalled();
    expect(readHermesWorkloadImage).toHaveBeenCalledOnce();
    expect(launchSpecBuilder).toHaveBeenCalledWith(USER_ID, AGENT_ID, {
      hermesWorkloadImage: CUSTOM_HERMES_IMAGE,
    });
    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));

    expect(deployment).toMatchObject({
      stage: "starting_gateway",
      runnerOperationId: OPERATION_ID,
      canaryState: "not_started",
    });
  });

  it("runs exactly one bounded provisioning phase and stops at the same deployment stage", async () => {
    await seedAutomaticRunner(connection, {
      status: "provisioning",
      provisioningStatus: "pending",
    });
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, { stage: "provisioning_runner" });
    const provisioner = vi.fn(async (_connection, _work, _now, context) => {
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect(context.remainingMs()).toBe(45_000);
      return { ok: true as const, state: "pending" as const };
    });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        provisioner,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "retry_scheduled" });

    expect(provisioner).toHaveBeenCalledTimes(1);
    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment).toMatchObject({ stage: "provisioning_runner", attemptCount: 1 });
  });

  it("keeps a provider-ready runner in provisioning until a current heartbeat proves capacity", async () => {
    await seedAutomaticRunner(connection, { status: "online", provisioningStatus: "ready" });
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, { stage: "provisioning_runner" });
    const provisioner = vi.fn();

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        provisioner,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "retry_scheduled" });

    expect(provisioner).not.toHaveBeenCalled();
    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment).toMatchObject({
      stage: "provisioning_runner",
      errorCode: "runner_capacity_wait",
    });
  });

  it("advances a provider-ready runner only after current heartbeat and locked capacity validation", async () => {
    await seedAutomaticRunner(connection, { status: "online", provisioningStatus: "ready" });
    await connection.db.insert(runnerHeartbeats).values({
      runnerId: RUNNER_ID,
      status: "online",
      metadata: { metrics: { maxAgents: 1, runningAgents: 0 } },
      observedAt: NOW,
      createdAt: NOW,
    });
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, { stage: "provisioning_runner" });

    await expect(
      reconcileNextAgentDeployment({ createConnection: () => connection, now: () => NOW }),
    ).resolves.toEqual({ processed: 1, outcome: "advanced" });

    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment?.stage).toBe("configuring_hermes");
  });

  it("does not let a foreign-owner runner heartbeat claim malformed cross-owner work", async () => {
    const otherUserId = "00000000-0000-4000-8000-00000000a702";
    await connection.db.insert(users).values({ id: otherUserId, createdAt: NOW, updatedAt: NOW });
    await connection.db.insert(runners).values({
      id: RUNNER_ID,
      userId: otherUserId,
      name: "Foreign runner",
      kind: "manual_vps",
      endpointUrl: "http://127.0.0.1:3045",
      status: "online",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await connection.db.insert(runnerHeartbeats).values({
      runnerId: RUNNER_ID,
      status: "online",
      metadata: { metrics: { maxAgents: 1, runningAgents: 0 } },
      observedAt: NOW,
      createdAt: NOW,
    });
    await seedAgent(connection, { runnerId: RUNNER_ID });
    await seedDeployment(connection, { stage: "configuring_hermes" });
    const adapterFactory = vi.fn();

    await expect(
      reconcileTargetRunnerDeployment(RUNNER_ID, {
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: adapterFactory,
      }),
    ).resolves.toEqual({ processed: 0, outcome: "idle" });
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("dispatches one canary, then finalizes running and one open usage period", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID });
    await connection.db.update(agents).set({ status: "starting" }).where(eq(agents.id, AGENT_ID));
    await seedDeployment(connection, {
      stage: "verifying_model",
      runnerOperationId: OPERATION_ID,
      runnerAcceptedAt: NOW,
    });
    const adapter = fakeRunnerAdapter({
      canary: vi.fn(async () => ({
        ok: true,
        runner: manualRunner(),
        response: {
          ok: true,
          contractVersion: "agentbay.runner.canary.v1",
          agentId: AGENT_ID,
          action: "canary",
          operationId: OPERATION_ID,
          configRevision: CONFIG_REVISION,
          observation: {
            state: "passed",
            reason: null,
            observedAt: NOW.toISOString(),
            latencyMs: 10,
          },
        },
      })),
      status: vi.fn(async () => ({ ok: true, runner: manualRunner(), snapshot: readySnapshot() })),
    });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "advanced" });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => new Date(NOW.getTime() + 91_000),
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "ready" });

    expect(adapter.canary).toHaveBeenCalledTimes(1);
    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
    const usage = await connection.db.select().from(agentUsagePeriods);
    const events = await connection.db.select().from(agentEvents);

    expect(deployment).toMatchObject({ stage: "ready", canaryState: "passed" });
    expect(agent).toMatchObject({
      status: "running",
      statusReason: "Hermes gateway is ready.",
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ agentId: AGENT_ID, runnerId: RUNNER_ID, stoppedAt: null });
    expect(events.map((event) => event.type)).toEqual([
      "agent.deployment_stage_changed",
      "agent.deployment_stage_changed",
      "agent.start_completed",
    ]);
  });

  it("fails outcome-unknown after a crash following canary dispatch and lets owner retry once", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID });
    await seedDeployment(connection, {
      stage: "verifying_model",
      runnerOperationId: OPERATION_ID,
      runnerAcceptedAt: NOW,
      canaryState: "started",
      canaryAttemptedAt: NOW,
    });
    const adapter = fakeRunnerAdapter();

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "failed" });

    expect(adapter.canary).not.toHaveBeenCalled();
    const retry = await retryAgentDeploymentForUser({
      userId: USER_ID,
      agentId: AGENT_ID,
      idempotencyKey: "Retry-Key-001",
      dependencies: { createConnection: () => connection, now: () => NOW },
    });
    const replay = await retryAgentDeploymentForUser({
      userId: USER_ID,
      agentId: AGENT_ID,
      idempotencyKey: "Retry-Key-001",
      dependencies: { createConnection: () => connection, now: () => NOW },
    });

    expect(retry.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(retry.ok && replay.ok ? retry.deployment.id : null).toBe(
      retry.ok && replay.ok ? replay.deployment.id : null,
    );
    const deployments = await connection.db.select().from(agentDeployments);
    expect(deployments).toHaveLength(2);
    expect(deployments.map((deployment) => deployment.stage).sort()).toEqual(["failed", "pending"]);
  });

  it.each([
    ["absent", convergenceSnapshot("absent")],
    ["terminal", convergenceSnapshot("terminal")],
    ["revision mismatch", convergenceSnapshot("revision_mismatch")],
  ])("performs one same-v3 convergence launch for %s status", async (_name, snapshot) => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, {
      stage: "starting_gateway",
      runnerOperationId: OPERATION_ID,
      runnerAcceptedAt: NOW,
    });
    const launchSpec = managedLaunchSpec({ image: { ref: CUSTOM_HERMES_IMAGE } });
    const launchSpecBuilder = vi.fn(async () => ({ ok: true as const, spec: launchSpec }));
    const readHermesWorkloadImage = vi.fn(() => CUSTOM_HERMES_IMAGE);
    const replacementOperationId = "00000000-0000-4000-8000-00000000a742";
    const adapter = fakeRunnerAdapter({
      status: vi.fn(async () => ({ ok: true, runner: manualRunner(), snapshot })),
      start: vi.fn(async () => acceptedStart(launchSpec, replacementOperationId)),
    });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        readHermesWorkloadImage,
        launchSpec: launchSpecBuilder,
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "advanced" });

    expect(adapter.status).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(readHermesWorkloadImage).toHaveBeenCalledOnce();
    expect(launchSpecBuilder).toHaveBeenCalledWith(USER_ID, AGENT_ID, {
      hermesWorkloadImage: CUSTOM_HERMES_IMAGE,
    });
    expect(adapter.canary).not.toHaveBeenCalled();
    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment).toMatchObject({
      stage: "starting_gateway",
      runnerOperationId: replacementOperationId,
    });
  });

  it("fails and cleans up one timed-out gateway instead of restarting it indefinitely", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, {
      stage: "starting_gateway",
      runnerOperationId: OPERATION_ID,
      runnerAcceptedAt: NOW,
    });
    const snapshot: RunnerAgentStatusSnapshot = {
      ...startingSnapshot(),
      phase: "failed",
      gateway: { state: "unknown", observedAt: NOW.toISOString() },
      apiServer: { required: true, state: "unknown", observedAt: NOW.toISOString() },
      telegram: { required: true, state: "unknown", observedAt: NOW.toISOString() },
      readinessReason: "readiness_timeout",
    };
    const adapter = fakeRunnerAdapter({
      status: vi.fn(async () => ({ ok: true, runner: manualRunner(), snapshot })),
    });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "failed" });

    expect(adapter.start).not.toHaveBeenCalled();
    expect(adapter.streamLogs).toHaveBeenCalledWith({ agentId: AGENT_ID, limit: 100 });
    expect(adapter.stop).toHaveBeenCalledWith(AGENT_ID);
    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment).toMatchObject({
      stage: "failed",
      errorCode: "runner_start_failed",
      nextAttemptAt: null,
    });
  });

  it("adopts exact legacy-ready launch evidence, then replaces compatibility correlation on exact convergence", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, { stage: "configuring_hermes" });
    const launchSpec = managedLaunchSpec();
    const replacementOperationId = "00000000-0000-4000-8000-00000000a743";
    const adapter = fakeRunnerAdapter({
      start: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          state: "ready",
          runner: manualRunner(),
          container: { id: "legacy", status: "running" },
          target: {
            image: launchSpec.image.ref,
            launchSpecVersion: launchSpec.version,
            configRevision: CONFIG_REVISION,
          },
        })
        .mockResolvedValueOnce(acceptedStart(launchSpec, replacementOperationId)),
      status: vi.fn(async () => ({
        ok: true,
        runner: manualRunner(),
        snapshot: convergenceSnapshot("absent"),
      })),
    });
    const dependencies = {
      createConnection: () => connection,
      now: () => NOW,
      launchSpec: async () => ({ ok: true as const, spec: launchSpec }),
      manualRunnerAdapter: () => adapter as never,
    };

    await expect(reconcileNextAgentDeployment(dependencies)).resolves.toEqual({
      processed: 1,
      outcome: "advanced",
    });
    const [compatibility] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(compatibility?.runnerOperationId).toMatch(/^[0-9a-f-]{36}$/);

    await expect(reconcileNextAgentDeployment(dependencies)).resolves.toEqual({
      processed: 1,
      outcome: "advanced",
    });
    const [converged] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(converged?.runnerOperationId).toBe(replacementOperationId);
    expect(adapter.start).toHaveBeenCalledTimes(2);
  });

  it("clears a canary marker and backs off only for exact 409 no-dispatch proof", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, {
      stage: "verifying_model",
      runnerOperationId: OPERATION_ID,
      runnerAcceptedAt: NOW,
    });
    const adapter = fakeRunnerAdapter({
      canary: vi.fn(async () => ({ ok: false, reason: "canary_not_dispatched" })),
    });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "retry_scheduled" });

    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment).toMatchObject({
      stage: "verifying_model",
      canaryState: "not_started",
      canaryAttemptedAt: null,
      errorCode: "gateway_starting",
    });
    expect(adapter.canary).toHaveBeenCalledTimes(1);
    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it("treats ambiguous canary transport as terminal and captures redacted logs before bounded stop", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, {
      stage: "verifying_model",
      runnerOperationId: OPERATION_ID,
      runnerAcceptedAt: NOW,
    });
    const secretCanary = "OPENROUTER_API_KEY=sk-or-v1-reconciler-secret";
    const requests: string[] = [];

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: (runner, options) =>
          new ManualRunnerAdapter(runner, {
            createConnection: () => connection,
            env: { [RUNNER_BEARER_TOKEN_ENV]: "bounded-runner-token" },
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            fetch: async (input) => {
              const action = new URL(String(input)).pathname.split("/").at(-1) ?? "";
              requests.push(action);

              if (action === "canary") {
                throw new TypeError("ambiguous transport");
              }

              if (action === "logs") {
                return Response.json({
                  ok: true,
                  logs: [{ stream: "stderr", message: secretCanary }],
                });
              }

              return Response.json({ ok: true, containers: [] });
            },
          }),
      }),
    ).resolves.toEqual({ processed: 1, outcome: "failed" });

    expect(requests).toEqual(["canary", "logs", "stop"]);
    const logs = await connection.db
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.agentId, AGENT_ID));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toContain("[redacted-env-value]");
    expect(JSON.stringify(logs)).not.toContain("sk-or-v1-reconciler-secret");
    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment).toMatchObject({
      stage: "failed",
      canaryState: "outcome_unknown",
      errorCode: "model_canary_outcome_unknown",
    });
  });

  it("propagates one shared 45-second signal budget to every runner transport", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, { stage: "configuring_hermes" });
    const launchSpec = managedLaunchSpec();
    const seen: Array<{ signal: AbortSignal; timeoutMs: number }> = [];
    const adapter = fakeRunnerAdapter({
      start: vi.fn(async () => acceptedStart(launchSpec, OPERATION_ID)),
    });

    await reconcileNextAgentDeployment({
      createConnection: () => connection,
      now: () => NOW,
      launchSpec: async () => ({ ok: true, spec: launchSpec }),
      manualRunnerAdapter: (_runner, options) => {
        seen.push(options);
        return adapter as never;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.timeoutMs).toBe(45_000);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails attempt 64 in the same call without leaving a claimable attempt 65", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, {
      stage: "starting_gateway",
      runnerOperationId: OPERATION_ID,
      runnerAcceptedAt: NOW,
      attemptCount: 63,
    });
    const adapter = fakeRunnerAdapter({
      status: vi.fn(async () => ({
        ok: true,
        runner: manualRunner(),
        snapshot: startingSnapshot(),
      })),
    });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "failed" });

    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment).toMatchObject({
      stage: "failed",
      attemptCount: 64,
      errorCode: "deployment_attempts_exhausted",
      nextAttemptAt: null,
      leaseOwner: null,
    });
    await expect(
      reconcileNextAgentDeployment({ createConnection: () => connection, now: () => NOW }),
    ).resolves.toEqual({ processed: 0, outcome: "idle" });
  });

  it("discards a ready result after a separate connection cancels desired state", async () => {
    const second = createDatabaseConnection();
    try {
      await seedRunner(connection);
      await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
      await seedDeployment(connection, {
        stage: "starting_gateway",
        runnerOperationId: OPERATION_ID,
        runnerAcceptedAt: NOW,
      });
      let resolveStatus: ((value: unknown) => void) | undefined;
      const statusResult = new Promise((resolve) => {
        resolveStatus = resolve;
      });
      const adapter = fakeRunnerAdapter({ status: vi.fn(() => statusResult) });
      const reconcile = reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      });
      await vi.waitFor(() => expect(adapter.status).toHaveBeenCalledTimes(1));

      await second.db
        .update(agents)
        .set({ desiredStatus: "stopped", status: "stopped", updatedAt: NOW })
        .where(eq(agents.id, AGENT_ID));
      await second.db
        .update(agentDeployments)
        .set({
          stage: "failed",
          errorCode: "deployment_cancelled",
          errorDetail: "Automatic deployment was cancelled.",
          failedAt: NOW,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: NOW,
        })
        .where(eq(agentDeployments.id, DEPLOYMENT_ID));
      resolveStatus?.({ ok: true, runner: manualRunner(), snapshot: readySnapshot() });

      await expect(reconcile).resolves.toEqual({ processed: 1, outcome: "retry_scheduled" });
      const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
      const [deployment] = await connection.db
        .select()
        .from(agentDeployments)
        .where(eq(agentDeployments.id, DEPLOYMENT_ID));
      expect(agent).toMatchObject({ desiredStatus: "stopped", status: "stopped" });
      expect(deployment).toMatchObject({ stage: "failed", errorCode: "deployment_cancelled" });
      expect(await connection.db.select().from(agentUsagePeriods)).toHaveLength(0);
    } finally {
      await second.close();
    }
  });

  it("serializes two separate-connection claims to one stage action and one event pair", async () => {
    const second = createDatabaseConnection();
    try {
      await seedRunner(connection);
      await seedAgent(connection, { runnerId: null });
      await seedDeployment(connection, { stage: "pending" });

      const results = await Promise.all([
        reconcileNextAgentDeployment({ createConnection: () => connection, now: () => NOW }),
        reconcileNextAgentDeployment({ createConnection: () => second, now: () => NOW }),
      ]);

      expect(results).toEqual(
        expect.arrayContaining([
          { processed: 1, outcome: "advanced" },
          { processed: 0, outcome: "idle" },
        ]),
      );
      const [deployment] = await connection.db
        .select()
        .from(agentDeployments)
        .where(eq(agentDeployments.id, DEPLOYMENT_ID));
      expect(deployment).toMatchObject({ stage: "configuring_hermes", attemptCount: 1 });
      const events = await connection.db.select().from(agentEvents);
      expect(events.map((event) => event.type)).toEqual([
        "agent.start_requested",
        "agent.deployment_stage_changed",
      ]);
    } finally {
      await second.close();
    }
  });

  it("revalidates max-one capacity after the advisory lock before assigning concurrent agents", async () => {
    const second = createDatabaseConnection();
    const otherAgentId = "00000000-0000-4000-8000-00000000a712";
    const otherDeploymentId = "00000000-0000-4000-8000-00000000a732";
    try {
      await seedRunner(connection);
      await seedAgent(connection, { runnerId: null });
      await seedDeployment(connection, { stage: "pending" });
      await connection.db.insert(agents).values({
        id: otherAgentId,
        userId: USER_ID,
        runnerId: null,
        name: "Concurrent automatic agent",
        templateKey: "research_agent",
        templateVersion: "1.0.0",
        templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
        status: "stopped",
        desiredStatus: "running",
        createdAt: new Date(NOW.getTime() + 1),
        updatedAt: NOW,
      });
      await connection.db.insert(agentConfigs).values({
        agentId: otherAgentId,
        systemPrompt: "Concurrent capacity test.",
        modelProvider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
        maxDailySpendCents: 0,
        scheduleMode: "manual",
        timezone: "UTC",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await connection.db.insert(agentDeployments).values({
        id: otherDeploymentId,
        agentId: otherAgentId,
        userId: USER_ID,
        stage: "pending",
        configRevision: "cfg-concurrent-2",
        idempotencyKey: "ready-key-002",
        createdAt: new Date(NOW.getTime() + 1),
        updatedAt: NOW,
      });
      const dependencies = {
        now: () => NOW,
        readDigitalOceanConfig: () => automaticProviderConfig(),
      };

      await Promise.all([
        reconcileNextAgentDeployment({ ...dependencies, createConnection: () => connection }),
        reconcileNextAgentDeployment({ ...dependencies, createConnection: () => second }),
      ]);

      const agentRows = await connection.db.select().from(agents);
      const deploymentRows = await connection.db.select().from(agentDeployments);
      const runnerRows = await connection.db.select().from(runners);
      expect(agentRows.filter((agent) => agent.runnerId === RUNNER_ID)).toHaveLength(1);
      expect(deploymentRows.map((deployment) => deployment.stage).sort()).toEqual([
        "configuring_hermes",
        "provisioning_runner",
      ]);
      expect(runnerRows).toHaveLength(2);
      expect(runnerRows.filter((runner) => runner.kind === "digitalocean")).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it.each([
    ["connecting", "connecting", "retry_scheduled"],
    ["disconnected", "disconnected", "retry_scheduled"],
    ["failed", "failed", "failed"],
    ["disabled", "disabled", "failed"],
  ] as const)("classifies Telegram %s evidence without weakening terminal states", async (_name, telegramState, expectedOutcome) => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, {
      stage: "connecting_telegram",
      runnerOperationId: OPERATION_ID,
      runnerAcceptedAt: NOW,
      canaryState: "passed",
      canaryAttemptedAt: NOW,
      canaryCompletedAt: NOW,
    });
    const snapshot: RunnerAgentStatusSnapshot = {
      ...readySnapshot(),
      phase: telegramState === "failed" || telegramState === "disabled" ? "failed" : "starting",
      telegram: { required: true, state: telegramState, observedAt: NOW.toISOString() },
      readinessReason: "telegram_not_connected",
    };
    const adapter = fakeRunnerAdapter({
      status: vi.fn(async () => ({ ok: true, runner: manualRunner(), snapshot })),
      streamLogs: vi.fn(async () => ({ logs: [], nextAfter: null })),
      stop: vi.fn(async () => ({ ok: true, runner: manualRunner(), containers: [] })),
    });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: expectedOutcome });

    const [deployment] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, DEPLOYMENT_ID));
    expect(deployment?.stage).toBe(expectedOutcome === "failed" ? "failed" : "connecting_telegram");
  });

  it("terminally fails wrong-revision Telegram evidence without finalizing usage", async () => {
    await seedRunner(connection);
    await seedAgent(connection, { runnerId: RUNNER_ID, status: "starting" });
    await seedDeployment(connection, {
      stage: "connecting_telegram",
      runnerOperationId: OPERATION_ID,
      runnerAcceptedAt: NOW,
      canaryState: "passed",
      canaryAttemptedAt: NOW,
      canaryCompletedAt: NOW,
    });
    const adapter = fakeRunnerAdapter({
      status: vi.fn(async () => ({
        ok: true,
        runner: manualRunner(),
        snapshot: {
          ...readySnapshot(),
          revision: { ...readySnapshot().revision, state: "mismatch" as const },
          readinessReason: "revision_mismatch" as const,
        },
      })),
      streamLogs: vi.fn(async () => ({ logs: [], nextAfter: null })),
      stop: vi.fn(async () => ({ ok: true, runner: manualRunner(), containers: [] })),
    });

    await expect(
      reconcileNextAgentDeployment({
        createConnection: () => connection,
        now: () => NOW,
        manualRunnerAdapter: () => adapter as never,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "failed" });
    expect(await connection.db.select().from(agentUsagePeriods)).toHaveLength(0);
  });

  it("uses the bounded deterministic backoff schedule", () => {
    expect([1, 2, 3, 4, 5, 6, 64].map(computeDeploymentBackoffMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });
});

async function seedUser(connection: DatabaseConnection) {
  await connection.db.insert(users).values({
    id: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedRunner(connection: DatabaseConnection) {
  await connection.db.insert(runners).values({
    id: RUNNER_ID,
    userId: USER_ID,
    name: "Runner",
    kind: "manual_vps",
    endpointUrl: "http://127.0.0.1:3045",
    status: "online",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(runnerHeartbeats).values({
    runnerId: RUNNER_ID,
    status: "online",
    metadata: {
      metrics: {
        maxAgents: 1,
        runningAgents: 0,
      },
    },
    observedAt: NOW,
    createdAt: NOW,
  });
}

async function seedAutomaticRunner(
  connection: DatabaseConnection,
  input: { status: "online" | "provisioning"; provisioningStatus: "pending" | "ready" },
) {
  await connection.db.insert(runners).values({
    id: RUNNER_ID,
    userId: USER_ID,
    name: "Automatic runner",
    kind: "digitalocean",
    status: input.status,
    provider: "digitalocean",
    endpointUrl: input.provisioningStatus === "ready" ? "https://192-0-2-10.sslip.io" : null,
    region: "sfo3",
    sizeSlug: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    provisioningStatus: input.provisioningStatus,
    provisioningOperationKey: `agentbay-deploy-${DEPLOYMENT_ID.replaceAll("-", "")}`,
    provisioningStartedAt: NOW,
    provisioningCompletedAt: input.provisioningStatus === "ready" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function automaticProviderConfig(): DigitalOceanProviderConfig {
  return {
    token: "local-fake-token",
    providerMode: "digitalocean",
    runnerBearerToken: "local-fake-runner-token",
    runnerImage: "agentbay-runner:test",
    region: "sfo3",
    sizeSlug: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    tags: ["agentbay", "agentbay-runner"],
    sshKeyIds: ["fake-key"],
    sshSourceAddresses: ["203.0.113.5/32"],
  };
}

async function seedAgent(
  connection: DatabaseConnection,
  input: {
    runnerId: string | null;
    status?: "starting" | "stopped";
  },
) {
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    runnerId: input.runnerId,
    name: "Automatic Ready Agent",
    templateKey: "research_agent",
    templateVersion: "1.0.0",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status: input.status ?? "stopped",
    desiredStatus: "running",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agentConfigs).values({
    agentId: AGENT_ID,
    systemPrompt: "You are a careful test agent.",
    modelProvider: "openrouter",
    modelName: "openai/gpt-4.1-mini",
    maxDailySpendCents: 0,
    scheduleMode: "manual",
    scheduleCron: null,
    timezone: "UTC",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedDeployment(
  connection: DatabaseConnection,
  input: {
    stage:
      | "pending"
      | "provisioning_runner"
      | "configuring_hermes"
      | "starting_gateway"
      | "verifying_model"
      | "connecting_telegram";
    runnerOperationId?: string;
    runnerAcceptedAt?: Date;
    canaryState?: "not_started" | "passed" | "started";
    canaryAttemptedAt?: Date;
    canaryCompletedAt?: Date;
    attemptCount?: number;
  },
) {
  await connection.db.insert(agentDeployments).values({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    stage: input.stage,
    configRevision: CONFIG_REVISION,
    idempotencyKey: "ready-key-001",
    runnerOperationId: input.runnerOperationId ?? null,
    runnerAcceptedAt: input.runnerAcceptedAt ?? null,
    canaryState: input.canaryState ?? "not_started",
    canaryAttemptedAt: input.canaryAttemptedAt ?? null,
    canaryCompletedAt: input.canaryCompletedAt ?? null,
    attemptCount: input.attemptCount ?? 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

type FakeRunnerAdapter = {
  start: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  streamLogs: ReturnType<typeof vi.fn>;
  canary: ReturnType<typeof vi.fn>;
};

function fakeRunnerAdapter(overrides: Partial<FakeRunnerAdapter> = {}): FakeRunnerAdapter {
  return {
    start: vi.fn(),
    status: vi.fn(),
    stop: vi.fn(),
    streamLogs: vi.fn(),
    canary: vi.fn(),
    ...overrides,
  };
}

function manualRunner(): ManualRunnerRecord {
  return {
    id: RUNNER_ID,
    userId: USER_ID,
    name: "Runner",
    kind: "manual_vps",
    endpointUrl: "http://127.0.0.1:3045",
    status: "online",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    deletedAt: null,
  };
}

function readySnapshot(): RunnerAgentStatusSnapshot {
  return {
    phase: "ready",
    operation: {
      id: OPERATION_ID,
      action: "start",
      target: {
        image: sampleManagedLaunchSpec().image.ref,
        launchSpecVersion: sampleManagedLaunchSpec().version,
        configRevision: CONFIG_REVISION,
      },
      acceptedAt: NOW.toISOString(),
    },
    container: {
      id: "container-001",
      name: "agentbay-runner",
      image: sampleManagedLaunchSpec().image.ref,
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

function managedLaunchSpec(overrides: Partial<ReturnType<typeof sampleManagedLaunchSpec>> = {}) {
  return sampleManagedLaunchSpec({
    agent: { ...sampleManagedLaunchSpec().agent, id: AGENT_ID, configRevision: CONFIG_REVISION },
    ...overrides,
  });
}

function acceptedStart(launchSpec: ReturnType<typeof managedLaunchSpec>, operationId: string) {
  return {
    ok: true,
    state: "accepted" as const,
    runner: manualRunner(),
    operation: {
      id: operationId,
      action: "start" as const,
      target: {
        image: launchSpec.image.ref,
        launchSpecVersion: launchSpec.version,
        configRevision: launchSpec.agent.configRevision,
      },
      acceptedAt: NOW.toISOString(),
    },
    snapshot: readySnapshot(),
  };
}

function startingSnapshot(): RunnerAgentStatusSnapshot {
  return {
    ...readySnapshot(),
    phase: "starting",
    gateway: { state: "starting", observedAt: NOW.toISOString() },
    apiServer: { required: true, state: "connecting", observedAt: NOW.toISOString() },
    telegram: { required: true, state: "connecting", observedAt: NOW.toISOString() },
    readinessReason: "gateway_starting",
  };
}

function convergenceSnapshot(
  kind: "absent" | "revision_mismatch" | "terminal",
): RunnerAgentStatusSnapshot {
  if (kind === "absent") {
    return {
      ...startingSnapshot(),
      phase: "idle",
      operation: null,
      container: {
        ...startingSnapshot().container,
        id: null,
        name: null,
        image: null,
        state: "absent",
        startedAt: null,
      },
      revision: {
        ...startingSnapshot().revision,
        state: "unknown",
        requested: null,
        containerLabel: null,
        projectionMarker: null,
      },
      readinessReason: "container_absent",
    };
  }

  if (kind === "revision_mismatch") {
    return {
      ...startingSnapshot(),
      phase: "failed",
      revision: {
        ...startingSnapshot().revision,
        state: "mismatch",
        containerLabel: "cfg-stale",
      },
      readinessReason: "revision_mismatch",
    };
  }

  return {
    ...startingSnapshot(),
    phase: "failed",
    container: {
      ...startingSnapshot().container,
      state: "exited",
      finishedAt: NOW.toISOString(),
    },
    readinessReason: "container_terminal",
  };
}

async function resetTables(connection: DatabaseConnection) {
  await connection.db.delete(agentLogs);
  await connection.db.delete(agentEvents);
  await connection.db.delete(agentUsagePeriods);
  await connection.db.delete(agentRuntimeReconciliations);
  await connection.db.delete(agentDeployments);
  await connection.db.delete(agentConfigs);
  await connection.db.delete(agents);
  await connection.db.delete(runnerHeartbeats);
  await connection.db.delete(runnerProvisioningEvents);
  await connection.db.delete(runnerRegistrationTokens);
  await connection.db.delete(runners);
  await connection.db.delete(users);
}
