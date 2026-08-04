import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentEvents,
  agentRuntimeReconciliations,
  agents,
  agentUsagePeriods,
  runnerCredentials,
  runnerHeartbeats,
  runnerReplacements,
  runners,
  users,
} from "@/src/server/db/schema";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import { digitalOceanRunnerFirewallName } from "@/src/server/runners/runner-provisioning";
import { reconcileNextRunnerReplacement } from "@/src/server/runners/runner-replacement-reconciler";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";
const USER_ID = "00000000-0000-4000-8000-000000007001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000007002";
const SOURCE_ID = "00000000-0000-4000-8000-000000007101";
const TARGET_ID = "00000000-0000-4000-8000-000000007102";
const RUNNING_AGENT_ID = "00000000-0000-4000-8000-000000007201";
const STOPPED_AGENT_ID = "00000000-0000-4000-8000-000000007202";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000007203";
const INITIAL_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000007301";
const INITIAL_OPERATION_ID = "00000000-0000-4000-8000-000000007401";
const REPLACEMENT_ID = "00000000-0000-4000-8000-000000007501";
const LEASE_A = "runner-replacement:11111111-1111-4111-8111-111111111111";
const LEASE_B = "runner-replacement:22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-04T10:00:00.000Z");
const IMAGE_DIGEST = `sha256:${"7".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:step7@${IMAGE_DIGEST}`;
const SOURCE_OPERATION_KEY = `agentbay-deploy-${"7".repeat(32)}`;
const TARGET_OPERATION_KEY = `agentbay-deploy-${"8".repeat(32)}`;
const REPLACEMENT_OPERATION_KEY = `agentbay-replace-${"7".repeat(32)}`;

describe("runner replacement handover", () => {
  let databaseName: string;
  let databaseUrl: string;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    ({ databaseName, databaseUrl } = await createDisposableDatabase());
    await runDbMigrate(databaseUrl);
    connection = createDatabaseConnection(databaseUrl);
  });

  beforeEach(async () => {
    await resetFixture(connection);
    await seedFixture(connection, "fencing_source");
  });

  afterAll(async () => {
    await connection?.close();
    if (databaseName) await dropDisposableDatabase(databaseName);
  });

  it("fences, atomically moves, converges, and retires the source while stopped agents stay stopped", async () => {
    const provider = await sourceProvider();
    const stopped: string[] = [];
    const deploymentTriggers: string[] = [];
    const runtimeTriggers: string[] = [];

    await expect(
      reconcile(connection, provider, {
        stopSourceAgent: async (_source, agentId) => stopped.push(agentId),
      }),
    ).resolves.toMatchObject({ outcome: "advanced", state: "reassigning" });
    expect(stopped).toEqual([RUNNING_AGENT_ID]);
    const [fencedSource] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, SOURCE_ID));
    const [credential] = await connection.db
      .select()
      .from(runnerCredentials)
      .where(eq(runnerCredentials.runnerId, SOURCE_ID));
    expect(fencedSource?.status).toBe("degraded");
    expect(credential).toMatchObject({ status: "revoked", revokedAt: NOW });
    expect(await assignedRunnerIds(connection)).toEqual([SOURCE_ID, SOURCE_ID]);

    await expect(
      reconcile(connection, provider, {
        triggerDeployment: (deploymentId) => deploymentTriggers.push(deploymentId),
        triggerRuntime: (agentId) => runtimeTriggers.push(agentId),
      }),
    ).resolves.toMatchObject({ outcome: "advanced", state: "converging_agents" });

    const assigned = await connection.db
      .select({ id: agents.id, runnerId: agents.runnerId, desiredStatus: agents.desiredStatus })
      .from(agents)
      .orderBy(agents.id);
    expect(assigned).toEqual([
      { id: RUNNING_AGENT_ID, runnerId: TARGET_ID, desiredStatus: "running" },
      { id: STOPPED_AGENT_ID, runnerId: TARGET_ID, desiredStatus: "stopped" },
    ]);
    expect(deploymentTriggers).toHaveLength(1);
    expect(runtimeTriggers).toEqual([RUNNING_AGENT_ID]);
    const [usage] = await connection.db
      .select()
      .from(agentUsagePeriods)
      .where(eq(agentUsagePeriods.agentId, RUNNING_AGENT_ID));
    expect(usage?.stoppedAt).toEqual(NOW);
    await expect(
      connection.db
        .select()
        .from(agentRuntimeReconciliations)
        .where(eq(agentRuntimeReconciliations.agentId, RUNNING_AGENT_ID)),
    ).resolves.toHaveLength(0);
    const [stoppedAgent] = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.id, STOPPED_AGENT_ID));
    expect(stoppedAgent).toMatchObject({ desiredStatus: "stopped", status: "stopped" });

    await expect(
      reconcile(connection, provider, {
        triggerDeployment: (deploymentId) => deploymentTriggers.push(deploymentId),
      }),
    ).resolves.toMatchObject({ outcome: "retry_scheduled", state: "converging_agents" });
    expect(deploymentTriggers).toHaveLength(2);

    const freshDeployment = await latestDeployment(connection, RUNNING_AGENT_ID);
    await markDeploymentAndRuntimeReady(connection, freshDeployment.id);
    await expect(reconcile(connection, provider)).resolves.toMatchObject({
      outcome: "advanced",
      state: "cleaning_source",
    });
    await expect(reconcile(connection, provider)).resolves.toMatchObject({
      outcome: "advanced",
      state: "complete",
    });

    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, REPLACEMENT_ID));
    const [source] = await connection.db.select().from(runners).where(eq(runners.id, SOURCE_ID));
    expect(workflow).toMatchObject({ state: "complete", targetRunnerId: TARGET_ID });
    expect(source).toMatchObject({ status: "deleted", provisioningStatus: "deleted" });
    expect(source?.deletedAt).toEqual(NOW);
    expect(provider.firewalls.size).toBe(0);
    expect(provider.resources.get("source-1")?.deletedAt).toBe(NOW.toISOString());
    expect(await assignedRunnerIds(connection)).toEqual([TARGET_ID, TARGET_ID]);
    const eventTypes = (
      await connection.db.select({ type: agentEvents.type }).from(agentEvents)
    ).map((event) => event.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "agent.runner_replacement_fenced",
        "agent.runner_reassigned",
        "agent.runner_replacement_completed",
      ]),
    );
  });

  it("resumes reassignment after process death without duplicating deployments or events", async () => {
    await prepareReassigning(connection);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    const second = createDatabaseConnection(databaseUrl);
    try {
      const results = await Promise.all([
        reconcile(connection, provider, {}, LEASE_A),
        reconcile(second, provider, {}, LEASE_B),
      ]);
      expect(results.every((result) => result.outcome !== "failed")).toBe(true);
      const deployments = await connection.db
        .select()
        .from(agentDeployments)
        .where(eq(agentDeployments.agentId, RUNNING_AGENT_ID));
      expect(deployments).toHaveLength(2);
      const reassignedEvents = await connection.db
        .select()
        .from(agentEvents)
        .where(eq(agentEvents.type, "agent.runner_reassigned"));
      expect(reassignedEvents).toHaveLength(2);
      expect(await assignedRunnerIds(connection)).toEqual([TARGET_ID, TARGET_ID]);
    } finally {
      await second.close();
    }
  });

  it("creates one deterministic retry when target deployment convergence terminally fails", async () => {
    await prepareReassigning(connection);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    await reconcile(connection, provider);
    const fresh = await latestDeployment(connection, RUNNING_AGENT_ID);
    await connection.db
      .update(agentDeployments)
      .set({
        stage: "failed",
        errorCode: "gateway_failed",
        errorDetail: "Safe test failure.",
        nextAttemptAt: null,
        failedAt: NOW,
        updatedAt: NOW,
      })
      .where(eq(agentDeployments.id, fresh.id));
    const triggered: string[] = [];

    await expect(
      reconcile(connection, provider, {
        triggerDeployment: (deploymentId) => triggered.push(deploymentId),
      }),
    ).resolves.toMatchObject({ outcome: "retry_scheduled", state: "converging_agents" });

    const deployments = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.agentId, RUNNING_AGENT_ID))
      .orderBy(agentDeployments.createdAt, agentDeployments.id);
    expect(deployments).toHaveLength(3);
    expect(triggered).toHaveLength(1);
    expect(deployments.find((deployment) => deployment.id === triggered[0])).toMatchObject({
      stage: "pending",
      nextAttemptAt: null,
    });
  });

  it("fails reassignment atomically when an assigned agent crosses owner boundaries", async () => {
    await prepareReassigning(connection);
    await connection.db.insert(agents).values({
      id: OTHER_AGENT_ID,
      userId: OTHER_USER_ID,
      runnerId: SOURCE_ID,
      name: "Cross-owner fixture agent",
      templateKey: "research_agent",
      status: "stopped",
      desiredStatus: "stopped",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });

    await expect(reconcile(connection, provider)).resolves.toMatchObject({
      outcome: "failed",
      state: "failed",
    });

    expect(await assignedRunnerIds(connection)).toEqual([SOURCE_ID, SOURCE_ID, SOURCE_ID]);
    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, REPLACEMENT_ID));
    expect(workflow).toMatchObject({ terminalCode: "reassignment_failed" });
    await expect(
      connection.db
        .select()
        .from(agentDeployments)
        .where(sql`${agentDeployments.idempotencyKey} like 'runner-replacement:%'`),
    ).resolves.toHaveLength(0);
  });

  it("keeps cleanup durable and never rolls agents back when ownership is ambiguous", async () => {
    await prepareCleaningSource(connection);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "ambiguous" });
    for (let index = 0; index < 2; index += 1) {
      await provider.createRunner({
        name: `${SOURCE_OPERATION_KEY}-${index}`,
        region: "sfo3",
        sizeSlug: "s-1vcpu-2gb",
        image: "ubuntu-24-04-x64",
        tags: [SOURCE_OPERATION_KEY],
      });
    }

    await expect(reconcile(connection, provider)).resolves.toMatchObject({
      outcome: "retry_scheduled",
      state: "cleaning_source",
    });

    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, REPLACEMENT_ID));
    const [source] = await connection.db.select().from(runners).where(eq(runners.id, SOURCE_ID));
    expect(workflow?.state).toBe("cleaning_source");
    expect(source?.deletedAt).toBeNull();
    expect(await assignedRunnerIds(connection)).toEqual([TARGET_ID, TARGET_ID]);
    expect(provider.calls.filter((call) => call.step === "deleteDroplet")).toHaveLength(0);
  });

  it("resumes after provider cleanup succeeds but before database completion", async () => {
    await prepareCleaningSource(connection);
    const provider = await sourceProvider();
    const expectation = {
      operationTag: SOURCE_OPERATION_KEY,
      providerResourceId: "source-1",
      providerFirewallId: "source-firewall-1",
      expectedName: SOURCE_OPERATION_KEY,
      expectedRegion: "sfo3",
      expectedSizeSlug: "s-1vcpu-2gb",
      expectedFirewallName: digitalOceanRunnerFirewallName("source-1"),
    };
    await provider.deleteFirewall(expectation);
    await provider.deleteDroplet(expectation);
    provider.calls.length = 0;

    await expect(reconcile(connection, provider)).resolves.toMatchObject({
      outcome: "advanced",
      state: "complete",
    });

    const [source] = await connection.db.select().from(runners).where(eq(runners.id, SOURCE_ID));
    expect(source?.deletedAt).toEqual(NOW);
    expect(provider.calls.map((call) => call.step)).toEqual(["discover", "observeOwnedSet"]);
  });
});

function reconcile(
  connection: DatabaseConnection,
  provider: FakeDigitalOceanProvider,
  dependencies: Partial<
    NonNullable<Parameters<typeof reconcileNextRunnerReplacement>[0]["dependencies"]>
  > = {},
  leaseOwner = LEASE_A,
) {
  return reconcileNextRunnerReplacement({
    replacementId: REPLACEMENT_ID,
    leaseOwner,
    dependencies: {
      createConnection: () => connection,
      now: () => NOW,
      provider,
      readConfig: providerConfig,
      retryMs: 0,
      ...dependencies,
    },
  });
}

function providerConfig(): DigitalOceanProviderConfig {
  return {
    token: "fake-provider-token",
    providerMode: "digitalocean",
    runnerBearerToken: "fake-runner-bearer",
    runnerImage: RUNNER_IMAGE,
    runnerMaxAgents: 2,
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    tags: ["agentbay", "agentbay-runner"],
    sshKeyIds: ["fake-key"],
    sshSourceAddresses: ["203.0.113.5/32"],
  };
}

async function sourceProvider(): Promise<FakeDigitalOceanProvider> {
  const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "source" });
  await provider.createRunner({
    name: SOURCE_OPERATION_KEY,
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    tags: [SOURCE_OPERATION_KEY],
  });
  await provider.applyFirewall({
    providerResourceId: "source-1",
    firewallName: digitalOceanRunnerFirewallName("source-1"),
  });
  provider.calls.length = 0;
  return provider;
}

async function prepareReassigning(connection: DatabaseConnection): Promise<void> {
  await connection.db
    .update(runnerReplacements)
    .set({ state: "reassigning", nextAttemptAt: NOW, updatedAt: NOW })
    .where(eq(runnerReplacements.id, REPLACEMENT_ID));
  await connection.db
    .update(runners)
    .set({ status: "degraded", updatedAt: NOW })
    .where(eq(runners.id, SOURCE_ID));
  await connection.db
    .update(runnerCredentials)
    .set({ status: "revoked", revokedAt: NOW, updatedAt: NOW })
    .where(eq(runnerCredentials.runnerId, SOURCE_ID));
}

async function prepareCleaningSource(connection: DatabaseConnection): Promise<void> {
  await connection.db
    .update(runnerReplacements)
    .set({ state: "cleaning_source", nextAttemptAt: NOW, updatedAt: NOW })
    .where(eq(runnerReplacements.id, REPLACEMENT_ID));
  await connection.db
    .update(runners)
    .set({ status: "degraded", updatedAt: NOW })
    .where(eq(runners.id, SOURCE_ID));
  await connection.db
    .update(agents)
    .set({ runnerId: TARGET_ID, updatedAt: NOW })
    .where(eq(agents.runnerId, SOURCE_ID));
}

async function latestDeployment(connection: DatabaseConnection, agentId: string) {
  const [deployment] = await connection.db
    .select()
    .from(agentDeployments)
    .where(eq(agentDeployments.agentId, agentId))
    .orderBy(sql`${agentDeployments.createdAt} desc`, sql`${agentDeployments.id} desc`)
    .limit(1);
  if (!deployment) throw new Error("Expected agent deployment.");
  return deployment;
}

async function markDeploymentAndRuntimeReady(
  connection: DatabaseConnection,
  deploymentId: string,
): Promise<void> {
  const operationId = "00000000-0000-4000-8000-000000007499";
  await connection.db
    .update(agentDeployments)
    .set({
      stage: "ready",
      runnerOperationId: operationId,
      runnerAcceptedAt: NOW,
      canaryState: "passed",
      canaryAttemptedAt: NOW,
      canaryCompletedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      nextAttemptAt: null,
      updatedAt: NOW,
    })
    .where(eq(agentDeployments.id, deploymentId));
  await connection.db.insert(agentRuntimeReconciliations).values({
    agentId: RUNNING_AGENT_ID,
    userId: USER_ID,
    state: "observing",
    configRevision: "cfg-step7",
    operationId,
    stableSince: NOW,
    lastObservedAt: NOW,
    lastReadyAt: NOW,
    nextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db
    .update(agents)
    .set({ status: "running", statusReason: null, updatedAt: NOW })
    .where(eq(agents.id, RUNNING_AGENT_ID));
}

async function assignedRunnerIds(connection: DatabaseConnection): Promise<Array<string | null>> {
  return (
    await connection.db.select({ runnerId: agents.runnerId }).from(agents).orderBy(agents.id)
  ).map((agent) => agent.runnerId);
}

async function resetFixture(connection: DatabaseConnection): Promise<void> {
  await connection.db.execute(sql`
    truncate table agent_deployment_replacement_budgets, runner_replacements,
      agent_runtime_reconciliations, agent_events, agent_usage_periods,
      agent_deployments, agent_secrets, agent_configs, agent_approvals,
      agent_logs, docker_runner_containers, local_runner_processes,
      runner_heartbeats, runner_credentials, runner_registration_tokens,
      runner_provisioning_events, backups, agents, runners, users restart identity cascade
  `);
}

async function seedFixture(
  connection: DatabaseConnection,
  state: "fencing_source" | "reassigning" | "converging_agents" | "cleaning_source",
): Promise<void> {
  await connection.db.insert(users).values([
    { id: USER_ID, createdAt: NOW, updatedAt: NOW },
    { id: OTHER_USER_ID, createdAt: NOW, updatedAt: NOW },
  ]);
  await connection.db.insert(runners).values([
    {
      id: SOURCE_ID,
      userId: USER_ID,
      name: SOURCE_OPERATION_KEY,
      kind: "digitalocean",
      endpointUrl: "https://source.example.test",
      status: "online",
      provider: "digitalocean",
      providerResourceId: "source-1",
      providerFirewallId: "source-firewall-1",
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: RUNNER_IMAGE,
      provisioningStatus: "ready",
      provisioningOperationKey: SOURCE_OPERATION_KEY,
      requiredRunnerImageDigest: IMAGE_DIGEST,
      observedRunnerImageDigest: IMAGE_DIGEST,
      observedRunnerReleaseVersion: "step7",
      observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      compatibilityState: "compatible",
      compatibilityVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: TARGET_ID,
      userId: USER_ID,
      name: TARGET_OPERATION_KEY,
      kind: "digitalocean",
      endpointUrl: "https://target.example.test",
      status: "online",
      provider: "digitalocean",
      providerResourceId: "target-1",
      providerFirewallId: "target-firewall-1",
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: RUNNER_IMAGE,
      provisioningStatus: "ready",
      provisioningOperationKey: TARGET_OPERATION_KEY,
      requiredRunnerImageDigest: IMAGE_DIGEST,
      observedRunnerImageDigest: IMAGE_DIGEST,
      observedRunnerReleaseVersion: "step7",
      observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      compatibilityState: "compatible",
      compatibilityVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  await connection.db.insert(agents).values([
    {
      id: RUNNING_AGENT_ID,
      userId: USER_ID,
      runnerId: SOURCE_ID,
      name: "Running replacement agent",
      templateKey: "research_agent",
      status: "running",
      desiredStatus: "running",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: STOPPED_AGENT_ID,
      userId: USER_ID,
      runnerId: SOURCE_ID,
      name: "Stopped replacement agent",
      templateKey: "research_agent",
      status: "stopped",
      desiredStatus: "stopped",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  await connection.db.insert(agentDeployments).values({
    id: INITIAL_DEPLOYMENT_ID,
    agentId: RUNNING_AGENT_ID,
    userId: USER_ID,
    stage: "ready",
    configRevision: "cfg-step7",
    idempotencyKey: "initial-step7-deployment",
    runnerOperationId: INITIAL_OPERATION_ID,
    runnerAcceptedAt: NOW,
    canaryState: "passed",
    canaryAttemptedAt: NOW,
    canaryCompletedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agentRuntimeReconciliations).values({
    agentId: RUNNING_AGENT_ID,
    userId: USER_ID,
    state: "observing",
    configRevision: "cfg-step7",
    operationId: INITIAL_OPERATION_ID,
    stableSince: NOW,
    lastObservedAt: NOW,
    lastReadyAt: NOW,
    nextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agentUsagePeriods).values({
    agentId: RUNNING_AGENT_ID,
    runnerId: SOURCE_ID,
    source: "lifecycle",
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(runnerCredentials).values({
    runnerId: SOURCE_ID,
    credentialHash: "step7-source-credential-hash",
    credentialPrefix: "agb_run_step7",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(runnerHeartbeats).values({
    runnerId: TARGET_ID,
    status: "online",
    observedAt: NOW,
    createdAt: NOW,
  });
  await connection.db.insert(runnerReplacements).values({
    id: REPLACEMENT_ID,
    sourceRunnerId: SOURCE_ID,
    targetRunnerId: TARGET_ID,
    reason: "stale_heartbeat",
    state,
    operationKey: REPLACEMENT_OPERATION_KEY,
    nextAttemptAt: NOW,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function createDisposableDatabase(): Promise<{
  databaseName: string;
  databaseUrl: string;
}> {
  const databaseName = `plingpling_runner_handover_${process.pid}_${Date.now()}`.toLowerCase();
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.end();
  }
  return { databaseName, databaseUrl: databaseUrlFor(databaseName) };
}

async function dropDisposableDatabase(databaseName: string): Promise<void> {
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
  } finally {
    await admin.end();
  }
}

async function runDbMigrate(databaseUrl: string): Promise<void> {
  await execFileAsync("bun", ["run", "db:migrate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 30_000,
  });
}

function validatedBaseUrl(): URL {
  const parsed = new URL(BASE_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Runner replacement handover tests require loopback PostgreSQL.");
  }
  return parsed;
}

function adminDatabaseUrl(): string {
  const url = validatedBaseUrl();
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(databaseName: string): string {
  const url = validatedBaseUrl();
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error("Disposable runner handover database name is invalid.");
  }
  return `"${value}"`;
}
