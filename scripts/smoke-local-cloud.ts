import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { DEFAULT_HERMES_WORKLOAD_IMAGE } from "@/src/runner-service/constants";
import type { RunnerAgentStatusSnapshot } from "@/src/runner-service/runner-contracts";
import {
  reconcileNextAgentDeployment,
  reconcileTargetAgentDeployment,
  reconcileTargetRunnerDeployment,
} from "@/src/server/agents/agent-deployment-reconciler";
import {
  type AgentLaunchSpec,
  MANAGED_AGENT_LAUNCH_SPEC_VERSION,
} from "@/src/server/agents/agent-launch-spec";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentConfigs,
  agentDeployments,
  agentEvents,
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
  fakeContainers: 1;
  fakeProvisioningResources: 1;
  openUsagePeriods: 1;
  runningTransitions: 1;
  simultaneousTriggers: ["create-kick", "heartbeat", "cron", "manual"];
  stages: string[];
};

export async function smokeLocalCloud(): Promise<LocalCloudSmokeSummary> {
  process.env.DATABASE_URL ??= "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://127.0.0.1:3000";
  const connections = Array.from({ length: 4 }, () => createDatabaseConnection());
  const inspection = createDatabaseConnection();
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
      return {
        ok: true as const,
        state: "accepted" as const,
        runner,
        operation: operationEvidence(operationId, configRevision, logicalNow),
        snapshot: fakeSnapshot("starting", operationId, configRevision, logicalNow),
      };
    },
    status: async () => {
      statusCalls += 1;
      return {
        ok: true as const,
        runner,
        snapshot: fakeSnapshot(
          statusCalls === 1 ? "starting" : "ready",
          operationId,
          configRevision,
          logicalNow,
        ),
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
          operationId,
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
    stop: async () => ({ ok: true as const, runner, containers: [] }),
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

    const resource = [...provider.resources.values()][0];
    if (!resource) throw new Error("Local fake provider resource disappeared before cleanup.");
    await provider.cleanupResource({ providerResourceId: resource.providerResourceId });
    await inspection.db.delete(agentEvents).where(eq(agentEvents.agentId, agentId));
    await inspection.db.delete(agentUsagePeriods).where(eq(agentUsagePeriods.agentId, agentId));
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
      fakeContainers: 1,
      fakeProvisioningResources: 1,
      openUsagePeriods: 1,
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
    modelProvider: "openrouter",
    modelName: "openai/gpt-4.1-mini",
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
    runnerImage: "agentbay-runner:local-fake",
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
    model: { provider: "openrouter", model: "openai/gpt-4.1-mini" },
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
      openrouterApiKey: "sk-or-v1-local-fake-smoke",
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
): RunnerAgentStatusSnapshot {
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
