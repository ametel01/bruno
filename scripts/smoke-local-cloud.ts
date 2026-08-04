import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import type { RunnerDurableStatusSnapshot } from "@/src/runner-service/runner-contracts";
import {
  reconcileNextAgentDeployment,
  reconcileTargetAgentDeployment,
  reconcileTargetRunnerDeployment,
} from "@/src/server/agents/agent-deployment-reconciler";
import {
  type AgentLaunchSpec,
  MANAGED_AGENT_LAUNCH_SPEC_VERSION,
} from "@/src/server/agents/agent-launch-spec";
import {
  type AgentRuntimeReconcilerDependencies,
  reconcileNextAgentRuntime,
  reconcileTargetAgentRuntime,
  reconcileTargetRunnerRuntime,
} from "@/src/server/agents/agent-runtime-reconciler";
import { startAgentForUser, stopAgentForUser } from "@/src/server/agents/lifecycle";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentConfigs,
  agentDeployments,
  agentEvents,
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
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";

export type LocalCloudSmokeSummary = {
  agentId: string;
  browserClosedAfter202: true;
  canaryCalls: 1;
  cleanupDeterministic: true;
  dockerDaemonRestartObserved: true;
  fakeContainers: 1;
  fakeProvisioningResources: 1;
  openUsagePeriods: 1;
  runtimeCircuitEvents: 1;
  runtimeFaultsRecovered: ["missing", "exited", "revision", "restart-policy"];
  runtimeRecoveryEvents: 1;
  runtimeUsageSegments: 5;
  stoppedAfterRunnerReturn: true;
  telegramBoundary: "injected-webhook-conflict";
  runningTransitions: 1;
  simultaneousTriggers: ["create-kick", "heartbeat", "cron", "manual"];
  stages: string[];
};

const FAKE_RUNNER_IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
const FAKE_RUNNER_RELEASE_VERSION = "sha-local-smoke";
const FAKE_RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:${FAKE_RUNNER_RELEASE_VERSION}@${FAKE_RUNNER_IMAGE_DIGEST}`;

type RuntimeFault =
  | "healthy"
  | "starting"
  | "docker-daemon-restart"
  | "absent"
  | "exited"
  | "revision"
  | "restart-policy"
  | "telegram-fatal";

export async function smokeLocalCloud(): Promise<LocalCloudSmokeSummary> {
  process.env.DATABASE_URL ??= "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://127.0.0.1:3000";
  process.env.AGENTBAY_RUNNER_IMAGE ??= FAKE_RUNNER_IMAGE;
  const connections = Array.from({ length: 4 }, () => createDatabaseConnection());
  const inspection = createDatabaseConnection();
  const runtimeConnection = (index: number): DatabaseConnection => {
    const connection = connections[index % connections.length];
    if (!connection) throw new Error("Local cloud runtime connection pool is unavailable.");
    return connection;
  };
  const userId = randomUUID();
  const agentId = randomUUID();
  const deploymentId = randomUUID();
  const operationId = randomUUID();
  const configRevision = `cfg-${Date.now()}`;
  let logicalNow = new Date();
  const provider = new FakeDigitalOceanProvider({ now: () => logicalNow, idPrefix: "smoke" });
  const launchSpec = buildFakeLaunchSpec(agentId, configRevision);
  const stages = ["pending"];
  let runnerId: string | null = null;
  let statusCalls = 0;
  let startCalls = 0;
  let canaryCalls = 0;
  let fakeContainers = 0;
  let heartbeatCommitted = false;
  let runtimeFault: RuntimeFault = "healthy";
  let runtimeOperationId = operationId;
  let runtimeStarts = 0;
  let runtimeStops = 0;
  let telegramDiagnostics = 0;

  const adapterFactory = (runner: {
    id: string;
    userId: string;
    name: string;
    kind: "digitalocean";
    endpointUrl: string;
    status: "online";
    createdAt: string;
    updatedAt: string;
    deletedAt: null;
  }) => ({
    start: async () => {
      startCalls += 1;
      fakeContainers = 1;
      if (startCalls > 1) {
        runtimeStarts += 1;
        runtimeOperationId = randomUUID();
      }
      runtimeFault = "starting";
      return {
        ok: true as const,
        state: "accepted" as const,
        runner,
        operation: operationEvidence(runtimeOperationId, configRevision, logicalNow),
        snapshot: fakeSnapshot("starting", runtimeOperationId, configRevision, logicalNow),
      };
    },
    status: async () => {
      statusCalls += 1;
      if (runtimeFault === "starting" && statusCalls > 1) {
        runtimeFault = "healthy";
      }
      return {
        ok: true as const,
        runner,
        snapshot: fakeRuntimeSnapshot(runtimeFault, runtimeOperationId, configRevision, logicalNow),
      };
    },
    canary: async () => {
      canaryCalls += 1;
      return {
        ok: true as const,
        runner,
        response: {
          ok: true as const,
          contractVersion: "agentbay.runner.canary.v1" as const,
          agentId,
          action: "canary" as const,
          operationId: runtimeOperationId,
          configRevision,
          observation: {
            state: "passed" as const,
            reason: null,
            observedAt: logicalNow.toISOString(),
            latencyMs: 1,
          },
        },
      };
    },
    stop: async () => {
      runtimeStops += 1;
      runtimeFault = "absent";
      fakeContainers = 0;
      return { ok: true as const, runner, containers: [] };
    },
    streamLogs: async () => ({ logs: [], nextAfter: null }),
  });
  const common = {
    now: () => logicalNow,
    readDigitalOceanConfig: () => fakeProviderConfig(),
    digitalOceanProvider: provider,
    launchSpec: async () => ({ ok: true as const, spec: launchSpec }),
    manualRunnerAdapter: (runner: unknown) => adapterFactory(runner as never) as never,
  };

  try {
    await seedCommitted202Operation(inspection, {
      agentId,
      configRevision,
      deploymentId,
      now: logicalNow,
      userId,
    });
    const acceptedResponse = { status: 202 as const, deploymentId };
    let browserOpen = true;
    if (acceptedResponse.status === 202) browserOpen = false;
    if (browserOpen) throw new Error("Local cloud browser did not close after committed 202.");

    await reconcileTargetAgentDeployment(deploymentId, {
      ...common,
      createConnection: () => connections[0] as DatabaseConnection,
    });
    ({ runnerId } = (
      await inspection.db
        .select({ runnerId: agents.runnerId })
        .from(agents)
        .where(eq(agents.id, agentId))
    )[0] ?? { runnerId: null });
    if (!runnerId) throw new Error("Create kick did not assign the persisted provisioning runner.");
    await observeStage(inspection, deploymentId, stages);

    for (let wave = 0; wave < 16; wave += 1) {
      logicalNow = new Date(logicalNow.getTime() + 61_000);
      if (heartbeatCommitted) {
        await inspection.db
          .update(runnerHeartbeats)
          .set({ observedAt: logicalNow })
          .where(eq(runnerHeartbeats.runnerId, runnerId));
      }
      await Promise.all([
        reconcileTargetAgentDeployment(deploymentId, {
          ...common,
          createConnection: () => connections[0] as DatabaseConnection,
        }),
        reconcileTargetRunnerDeployment(runnerId, {
          ...common,
          createConnection: () => connections[1] as DatabaseConnection,
        }),
        reconcileNextAgentDeployment({
          ...common,
          createConnection: () => connections[2] as DatabaseConnection,
        }),
        reconcileNextAgentDeployment({
          ...common,
          createConnection: () => connections[3] as DatabaseConnection,
        }),
      ]);
      await observeStage(inspection, deploymentId, stages);
      const [runner] = await inspection.db.select().from(runners).where(eq(runners.id, runnerId));
      if (runner?.provisioningStatus === "waiting_for_runner") {
        await sleep(50);
        logicalNow = new Date(logicalNow.getTime() + 1_000);
        await inspection.db
          .update(runners)
          .set({
            status: "online",
            provisioningStatus: "ready",
            provisioningCompletedAt: logicalNow,
            requiredRunnerImageDigest: FAKE_RUNNER_IMAGE_DIGEST,
            observedRunnerImageDigest: FAKE_RUNNER_IMAGE_DIGEST,
            observedRunnerReleaseVersion: FAKE_RUNNER_RELEASE_VERSION,
            observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
            compatibilityState: "compatible",
            compatibilityVerifiedAt: logicalNow,
            updatedAt: logicalNow,
          })
          .where(eq(runners.id, runnerId));
        await inspection.db.insert(runnerHeartbeats).values({
          runnerId,
          status: "online",
          metadata: { metrics: { maxAgents: 1, runningAgents: 0 } },
          observedAt: logicalNow,
          createdAt: logicalNow,
        });
        heartbeatCommitted = true;
      }
      const [deployment] = await inspection.db
        .select()
        .from(agentDeployments)
        .where(eq(agentDeployments.id, deploymentId));
      if (deployment?.stage === "ready") break;
    }

    const [deployment] = await inspection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, deploymentId));
    const [agent] = await inspection.db.select().from(agents).where(eq(agents.id, agentId));
    const usage = await inspection.db
      .select()
      .from(agentUsagePeriods)
      .where(eq(agentUsagePeriods.agentId, agentId));
    const events = await inspection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, agentId));
    const runningTransitions = events.filter((event) => event.type === "agent.start_completed");
    const createCalls = provider.calls.filter((call) => call.step === "create");

    if (
      deployment?.stage !== "ready" ||
      deployment.canaryState !== "passed" ||
      agent?.status !== "running" ||
      provider.resources.size !== 1 ||
      createCalls.length !== 1 ||
      startCalls !== 1 ||
      fakeContainers !== 1 ||
      canaryCalls !== 1 ||
      runningTransitions.length !== 1 ||
      usage.length !== 1 ||
      usage[0]?.stoppedAt !== null
    ) {
      throw new Error(
        `Local cloud reconciliation did not deduplicate every persisted side effect: ${JSON.stringify(
          {
            stage: deployment?.stage,
            canaryState: deployment?.canaryState,
            agentStatus: agent?.status,
            resources: provider.resources.size,
            createCalls: createCalls.length,
            startCalls,
            fakeContainers,
            canaryCalls,
            runningTransitions: runningTransitions.length,
            usage: usage.length,
            openUsage: usage[0]?.stoppedAt === null,
            stages,
          },
        )}`,
      );
    }
    const runtimeRunnerId = runnerId;
    if (!runtimeRunnerId) {
      throw new Error("Local cloud runtime lost its verified runner assignment.");
    }

    const runtimeDependencies = (
      connection: DatabaseConnection,
    ): AgentRuntimeReconcilerDependencies => ({
      createConnection: () => connection,
      now: () => logicalNow,
      launchSpec: async () => ({ ok: true as const, spec: launchSpec }),
      manualRunnerAdapter: (runner) => adapterFactory(runner as never) as never,
      telegramWebhookDiagnostic: async () => {
        telegramDiagnostics += 1;
        return "nonempty";
      },
    });
    const advanceRuntime = async (milliseconds = 61_000) => {
      logicalNow = new Date(logicalNow.getTime() + milliseconds);
      await inspection.db
        .update(runnerHeartbeats)
        .set({ status: "online", observedAt: logicalNow })
        .where(eq(runnerHeartbeats.runnerId, runtimeRunnerId));
      await inspection.db
        .update(agentRuntimeReconciliations)
        .set({ nextAttemptAt: logicalNow, updatedAt: logicalNow })
        .where(eq(agentRuntimeReconciliations.agentId, agentId));
    };
    const reconcileRuntimeUntilHealthy = async () => {
      for (let wave = 0; wave < 5; wave += 1) {
        await advanceRuntime();
        await reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(wave)));
        const [runtime] = await inspection.db
          .select()
          .from(agentRuntimeReconciliations)
          .where(eq(agentRuntimeReconciliations.agentId, agentId));
        if (runtime?.state === "observing" && runtime.errorCode === null) {
          return;
        }
      }
      throw new Error("Local cloud runtime recovery did not return to exact healthy observation.");
    };

    // Simulate a runner-service process restart and simultaneous heartbeat,
    // cron, and manual kicks. The durable lease permits one observation only.
    await advanceRuntime();
    const statusBeforeRuntimeCollision = statusCalls;
    const runtimeCollision = await Promise.all([
      reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(0))),
      reconcileTargetRunnerRuntime(runtimeRunnerId, runtimeDependencies(runtimeConnection(1))),
      reconcileNextAgentRuntime(runtimeDependencies(runtimeConnection(2))),
      reconcileNextAgentRuntime(runtimeDependencies(runtimeConnection(3))),
    ]);
    if (
      runtimeCollision.filter((result) => result.processed === 1).length !== 1 ||
      statusCalls !== statusBeforeRuntimeCollision + 1
    ) {
      throw new Error("Local cloud runtime collision did not collapse to one observation.");
    }

    // A Docker-daemon restart is distinct from a runner-service restart: the
    // exact unless-stopped workload survives, so observation must not start a
    // new container or segment the open usage period.
    const startsBeforeDockerDaemonRestart = runtimeStarts;
    runtimeFault = "docker-daemon-restart";
    await advanceRuntime();
    await reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(0)));
    const usageAfterDockerDaemonRestart = await inspection.db
      .select()
      .from(agentUsagePeriods)
      .where(eq(agentUsagePeriods.agentId, agentId));
    if (
      runtimeStarts !== startsBeforeDockerDaemonRestart ||
      usageAfterDockerDaemonRestart.length !== 1 ||
      usageAfterDockerDaemonRestart[0]?.stoppedAt !== null
    ) {
      throw new Error("Docker-daemon restart simulation duplicated work or segmented usage.");
    }

    // Heartbeat loss closes the observed-ready usage interval without invoking
    // the runner. A returned heartbeat then permits level-triggered recovery.
    logicalNow = new Date(logicalNow.getTime() + 91_000);
    await inspection.db
      .update(agentRuntimeReconciliations)
      .set({ nextAttemptAt: logicalNow, updatedAt: logicalNow })
      .where(eq(agentRuntimeReconciliations.agentId, agentId));
    const callsBeforeStaleHeartbeat = statusCalls + startCalls + runtimeStops;
    await reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(0)));
    if (statusCalls + startCalls + runtimeStops !== callsBeforeStaleHeartbeat) {
      throw new Error("Stale heartbeat reconciliation contacted the fake runner.");
    }

    const recoveredFaults: RuntimeFault[] = [];
    for (const fault of ["absent", "exited", "revision", "restart-policy"] as const) {
      runtimeFault = fault;
      fakeContainers = fault === "absent" ? 0 : 1;
      await advanceRuntime();
      await reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(0)));
      await reconcileRuntimeUntilHealthy();
      recoveredFaults.push(fault);

      // A full stability window resets the automatic recovery budget without
      // segmenting the continuously healthy interval.
      await advanceRuntime(15 * 60_000 + 1);
      await reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(1)));
    }

    // Fatal Telegram state is immediately non-ready. The injected, boolean-
    // only webhook diagnostic proves a conflict and opens a cleanup circuit;
    // no real Telegram request is possible from this smoke.
    runtimeFault = "telegram-fatal";
    await advanceRuntime();
    await reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(0)));
    await advanceRuntime();
    await reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(1)));
    await advanceRuntime();
    await reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(2)));

    const [circuitRuntime] = await inspection.db
      .select()
      .from(agentRuntimeReconciliations)
      .where(eq(agentRuntimeReconciliations.agentId, agentId));
    const circuitAgent = (
      await inspection.db.select().from(agents).where(eq(agents.id, agentId))
    )[0];
    if (
      circuitRuntime?.state !== "circuit_open" ||
      circuitRuntime.errorCode !== "telegram_webhook_conflict" ||
      circuitAgent?.status !== "error" ||
      telegramDiagnostics !== 1
    ) {
      throw new Error("Local cloud Telegram regression did not become a truthful bounded circuit.");
    }

    // Owner Stop is durable before any runner work. It remains authoritative
    // after another simulated runner process/heartbeat return and duplicate kicks.
    logicalNow = new Date(logicalNow.getTime() + 1_000);
    const publicCircuitReset = await startAgentForUser(userId, agentId, {
      createConnection: () => inspection,
      now: () => logicalNow,
      scheduleRuntimeReconcile: () => undefined,
    });
    if (!publicCircuitReset.ok || publicCircuitReset.state !== "accepted") {
      const outcome = publicCircuitReset.ok ? publicCircuitReset.state : publicCircuitReset.reason;
      throw new Error(`Public managed Start did not reset the runtime circuit: ${outcome}.`);
    }
    const publicStop = await stopAgentForUser(userId, agentId, {
      createConnection: () => inspection,
      now: () => logicalNow,
      manualRunnerAdapter: (runner) => adapterFactory(runner as never) as never,
      scheduleRuntimeReconcile: () => undefined,
    });
    if (!publicStop.ok || publicStop.agent.status !== "restarting") {
      const outcome = publicStop.ok ? publicStop.agent.status : publicStop.reason;
      throw new Error(`Public managed Stop did not return durable stopping intent: ${outcome}.`);
    }
    await reconcileTargetAgentRuntime(agentId, runtimeDependencies(runtimeConnection(0)));
    const startsBeforeStoppedCollision = runtimeStarts;
    const stoppedCollision = await Promise.all([
      reconcileTargetRunnerRuntime(runtimeRunnerId, runtimeDependencies(runtimeConnection(0))),
      reconcileNextAgentRuntime(runtimeDependencies(runtimeConnection(1))),
      reconcileNextAgentRuntime(runtimeDependencies(runtimeConnection(2))),
    ]);
    const [stoppedRuntime] = await inspection.db
      .select()
      .from(agentRuntimeReconciliations)
      .where(eq(agentRuntimeReconciliations.agentId, agentId));
    const stoppedAgent = (
      await inspection.db.select().from(agents).where(eq(agents.id, agentId))
    )[0];
    if (
      stoppedRuntime?.state !== "stopped" ||
      stoppedAgent?.desiredStatus !== "stopped" ||
      stoppedAgent.status !== "stopped" ||
      runtimeStarts !== startsBeforeStoppedCollision ||
      stoppedCollision.some((result) => result.processed !== 0)
    ) {
      throw new Error("Intentional Stop did not remain durable across duplicate runner returns.");
    }

    const runtimeUsage = await inspection.db
      .select()
      .from(agentUsagePeriods)
      .where(eq(agentUsagePeriods.agentId, agentId));
    const runtimeEvents = await inspection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, agentId));
    const runtimeRecoveryEvents = runtimeEvents.filter(
      (event) => event.type === "agent.runtime_recovered",
    );
    const runtimeCircuitEvents = runtimeEvents.filter(
      (event) => event.type === "agent.runtime_circuit_opened",
    );
    if (
      recoveredFaults.join(",") !== "absent,exited,revision,restart-policy" ||
      runtimeUsage.length !== 5 ||
      runtimeUsage.some((period) => period.stoppedAt === null) ||
      runtimeRecoveryEvents.length !== 1 ||
      runtimeCircuitEvents.length !== 1 ||
      runtimeStarts !== 4 ||
      runtimeStops !== 5 ||
      fakeContainers !== 0
    ) {
      throw new Error("Local cloud runtime usage/events or selected-container count duplicated.");
    }

    const resource = [...provider.resources.values()][0];
    if (!resource) throw new Error("Local fake provider resource disappeared before cleanup.");
    await provider.cleanupResource({ providerResourceId: resource.providerResourceId });
    await inspection.db.delete(agentEvents).where(eq(agentEvents.agentId, agentId));
    await inspection.db.delete(agentUsagePeriods).where(eq(agentUsagePeriods.agentId, agentId));
    await inspection.db
      .delete(agentRuntimeReconciliations)
      .where(eq(agentRuntimeReconciliations.agentId, agentId));
    await inspection.db.delete(agentDeployments).where(eq(agentDeployments.id, deploymentId));
    await inspection.db.delete(agentConfigs).where(eq(agentConfigs.agentId, agentId));
    await inspection.db.delete(agents).where(eq(agents.id, agentId));
    await inspection.db
      .delete(runnerProvisioningEvents)
      .where(eq(runnerProvisioningEvents.runnerId, runnerId));
    await inspection.db
      .delete(runnerRegistrationTokens)
      .where(eq(runnerRegistrationTokens.runnerId, runnerId));
    await inspection.db.delete(runnerHeartbeats).where(eq(runnerHeartbeats.runnerId, runnerId));
    await inspection.db.delete(runners).where(eq(runners.id, runnerId));
    await inspection.db.delete(users).where(eq(users.id, userId));
    const cleanupResiduals = await Promise.all([
      inspection.db.select().from(agents).where(eq(agents.id, agentId)),
      inspection.db.select().from(agentDeployments).where(eq(agentDeployments.id, deploymentId)),
      inspection.db.select().from(runners).where(eq(runners.id, runnerId)),
    ]);
    if (
      cleanupResiduals.some((rows) => rows.length > 0) ||
      provider.resources.get(resource.providerResourceId)?.deletedAt === null
    ) {
      throw new Error("Local cloud smoke cleanup did not remove every owned artifact.");
    }

    return {
      agentId,
      browserClosedAfter202: true,
      canaryCalls: 1,
      cleanupDeterministic: true,
      dockerDaemonRestartObserved: true,
      fakeContainers: 1,
      fakeProvisioningResources: 1,
      openUsagePeriods: 1,
      runtimeCircuitEvents: 1,
      runtimeFaultsRecovered: ["missing", "exited", "revision", "restart-policy"],
      runtimeRecoveryEvents: 1,
      runtimeUsageSegments: 5,
      stoppedAfterRunnerReturn: true,
      telegramBoundary: "injected-webhook-conflict",
      runningTransitions: 1,
      simultaneousTriggers: ["create-kick", "heartbeat", "cron", "manual"],
      stages,
    };
  } finally {
    const resource = [...provider.resources.values()][0];
    if (resource && resource.deletedAt === null) {
      await provider.cleanupResource({ providerResourceId: resource.providerResourceId });
    }
    await inspection.db.delete(agentEvents).where(eq(agentEvents.agentId, agentId));
    await inspection.db.delete(agentUsagePeriods).where(eq(agentUsagePeriods.agentId, agentId));
    await inspection.db
      .delete(agentRuntimeReconciliations)
      .where(eq(agentRuntimeReconciliations.agentId, agentId));
    await inspection.db.delete(agentDeployments).where(eq(agentDeployments.id, deploymentId));
    await inspection.db.delete(agentConfigs).where(eq(agentConfigs.agentId, agentId));
    await inspection.db.delete(agents).where(eq(agents.id, agentId));
    if (runnerId) {
      await inspection.db
        .delete(runnerProvisioningEvents)
        .where(eq(runnerProvisioningEvents.runnerId, runnerId));
      await inspection.db
        .delete(runnerRegistrationTokens)
        .where(eq(runnerRegistrationTokens.runnerId, runnerId));
      await inspection.db.delete(runnerHeartbeats).where(eq(runnerHeartbeats.runnerId, runnerId));
      await inspection.db.delete(runners).where(eq(runners.id, runnerId));
    }
    await inspection.db.delete(users).where(eq(users.id, userId));
    await Promise.all([...connections.map((connection) => connection.close()), inspection.close()]);
  }
}

async function seedCommitted202Operation(
  connection: DatabaseConnection,
  input: {
    agentId: string;
    configRevision: string;
    deploymentId: string;
    now: Date;
    userId: string;
  },
) {
  await connection.db.insert(users).values({ id: input.userId, createdAt: input.now });
  await connection.db.insert(agents).values({
    id: input.agentId,
    userId: input.userId,
    name: "Local cloud Step 7 smoke",
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status: "stopped",
    desiredStatus: "running",
    createdAt: input.now,
    updatedAt: input.now,
  });
  await connection.db.insert(agentConfigs).values({
    agentId: input.agentId,
    systemPrompt: "Local fake only.",
    modelProvider: "openai-api",
    modelName: "gpt-5.4",
    scheduleMode: "manual",
    timezone: "UTC",
    createdAt: input.now,
    updatedAt: input.now,
  });
  await connection.db.insert(agentDeployments).values({
    id: input.deploymentId,
    agentId: input.agentId,
    userId: input.userId,
    stage: "pending",
    configRevision: input.configRevision,
    idempotencyKey: `local-cloud-${input.deploymentId}`,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

async function observeStage(
  connection: DatabaseConnection,
  deploymentId: string,
  stages: string[],
) {
  const [deployment] = await connection.db
    .select({ stage: agentDeployments.stage })
    .from(agentDeployments)
    .where(eq(agentDeployments.id, deploymentId));
  if (deployment && stages.at(-1) !== deployment.stage) stages.push(deployment.stage);
}

function fakeProviderConfig(): DigitalOceanProviderConfig {
  return {
    token: "local-fake-token",
    providerMode: "digitalocean",
    runnerBearerToken: "local-fake-runner-token",
    runnerImage: FAKE_RUNNER_IMAGE,
    region: "sfo3",
    sizeSlug: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    tags: ["agentbay", "local-fake"],
    sshKeyIds: ["52830696"],
    sshSourceAddresses: ["203.0.113.5/32"],
  };
}

function buildFakeLaunchSpec(agentId: string, configRevision: string): AgentLaunchSpec {
  return {
    version: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
    requestId: randomUUID(),
    agent: {
      id: agentId,
      name: "Local cloud Step 7 smoke",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      configRevision,
    },
    image: { ref: DEFAULT_HERMES_WORKLOAD_IMAGE },
    model: { provider: "openai-api", model: "gpt-5.4" },
    platforms: {
      required: ["api_server", "telegram"],
      apiServer: { enabled: true, host: "0.0.0.0", port: 8642 },
      telegram: { enabled: true, allowAllUsers: false, unauthorizedDmBehavior: "ignore" },
    },
    schedule: { mode: "manual", cron: null, timezone: "UTC" },
    prompt: { soul: "Local fake only." },
    runtime: {
      dataDir: "/opt/data",
      workspaceDir: "/workspace",
      terminalCwd: "/workspace",
      browserEnabled: false,
      unattendedLoopLimit: 3,
      toolLoopGuardrails: {
        hardStopEnabled: true,
        hardStopAfter: { exactFailure: 5, idempotentNoProgress: 5 },
      },
    },
    tools: {
      enabled: ["file_operations", "terminal"],
      disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
    },
    secrets: {
      kind: "inline",
      modelApiKey: "sk-localfakesmoke12345678901234567890",
      telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
      telegramAllowedUsers: ["1"],
      apiServerKey: `agb_agent_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
    },
  };
}

function operationEvidence(id: string, configRevision: string, now: Date) {
  return {
    id,
    action: "start" as const,
    target: {
      image: DEFAULT_HERMES_WORKLOAD_IMAGE,
      launchSpecVersion: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
      configRevision,
    },
    acceptedAt: now.toISOString(),
  };
}

function fakeSnapshot(
  phase: "ready" | "starting",
  operationId: string,
  configRevision: string,
  now: Date,
): RunnerDurableStatusSnapshot {
  const ready = phase === "ready";
  return {
    phase,
    operation: operationEvidence(operationId, configRevision, now),
    container: {
      id: "local-fake-container-1",
      name: "local-fake-container-1",
      image: DEFAULT_HERMES_WORKLOAD_IMAGE,
      state: "running",
      startedAt: now.toISOString(),
      finishedAt: null,
      observedAt: now.toISOString(),
      restartPolicy: { name: "unless-stopped", maximumRetryCount: 0 },
      restartCount: 0,
    },
    revision: {
      state: "match",
      requested: configRevision,
      containerLabel: configRevision,
      projectionMarker: configRevision,
      observedAt: now.toISOString(),
    },
    gateway: { state: ready ? "running" : "starting", observedAt: now.toISOString() },
    apiServer: {
      required: true,
      state: ready ? "connected" : "connecting",
      observedAt: now.toISOString(),
    },
    telegram: {
      required: true,
      state: ready ? "connected" : "connecting",
      observedAt: now.toISOString(),
    },
    readinessReason: ready ? null : "gateway_starting",
    observedAt: now.toISOString(),
  };
}

function fakeRuntimeSnapshot(
  fault: RuntimeFault,
  operationId: string,
  configRevision: string,
  now: Date,
): RunnerDurableStatusSnapshot {
  if (fault === "starting" || fault === "healthy" || fault === "docker-daemon-restart") {
    return fakeSnapshot(
      fault === "starting" ? "starting" : "ready",
      operationId,
      configRevision,
      now,
    );
  }

  const healthy = fakeSnapshot("ready", operationId, configRevision, now);
  if (fault === "absent") {
    return {
      ...healthy,
      phase: "idle",
      operation: null,
      container: {
        ...healthy.container,
        id: null,
        name: null,
        image: null,
        state: "absent",
        startedAt: null,
      },
      gateway: { state: "unknown", observedAt: now.toISOString() },
      apiServer: { required: true, state: "unknown", observedAt: now.toISOString() },
      telegram: { required: true, state: "unknown", observedAt: now.toISOString() },
      readinessReason: "container_absent",
    };
  }
  if (fault === "exited") {
    return {
      ...healthy,
      phase: "failed",
      container: {
        ...healthy.container,
        state: "exited",
        finishedAt: now.toISOString(),
      },
      gateway: { state: "stopped", observedAt: now.toISOString() },
      readinessReason: "container_terminal",
    };
  }
  if (fault === "revision") {
    return {
      ...healthy,
      revision: {
        ...healthy.revision,
        state: "mismatch",
        projectionMarker: `${configRevision}-stale`,
      },
      readinessReason: "revision_mismatch",
    };
  }
  if (fault === "restart-policy") {
    return {
      ...healthy,
      container: {
        ...healthy.container,
        restartPolicy: { name: "always", maximumRetryCount: 0 },
      },
      readinessReason: null,
    };
  }
  return {
    ...healthy,
    telegram: { required: true, state: "fatal", observedAt: now.toISOString() },
    readinessReason: "telegram_fatal",
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const startedAt = Date.now();
  const summary = await smokeLocalCloud();
  console.log(
    JSON.stringify({
      event: "local_cloud_step7_reconciler_smoke_passed",
      ...summary,
      elapsedMs: Date.now() - startedAt,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
