import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeploymentReplacementBudgets,
  agentDeployments,
  agents,
  runnerHeartbeats,
  runnerRegistrationTokens,
  runnerReplacements,
  runners,
  users,
} from "@/src/server/db/schema";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import {
  type DigitalOceanProvider,
  FakeDigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";
import { reconcileNextRunnerReplacement } from "@/src/server/runners/runner-replacement-reconciler";
import { createOrGetRunnerReplacement } from "@/src/server/runners/runner-replacement-store";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno";
const USER_ID = "00000000-0000-4000-8000-000000006001";
const SOURCE_ID = "00000000-0000-4000-8000-000000006101";
const AGENT_ID = "00000000-0000-4000-8000-000000006201";
const SECOND_AGENT_ID = "00000000-0000-4000-8000-000000006202";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000006301";
const SECOND_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000006302";
const RUNNER_OPERATION_ID = "00000000-0000-4000-8000-000000006401";
const SECOND_RUNNER_OPERATION_ID = "00000000-0000-4000-8000-000000006402";
const LEASE_A = "runner-replacement:11111111-1111-4111-8111-111111111111";
const LEASE_B = "runner-replacement:22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-04T09:00:00.000Z");
const IMAGE_DIGEST = `sha256:${"6".repeat(64)}`;
const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:step6@${IMAGE_DIGEST}`;
const REPLACEMENT_OPERATION_KEY = `bruno-replace-${"6".repeat(32)}`;
const PROVISIONING_OPERATION_KEY = `bruno-deploy-${"6".repeat(32)}`;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

describe("runner replacement target reconciliation", () => {
  let databaseName: string;
  let databaseUrl: string;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    ({ databaseName, databaseUrl } = await createDisposableDatabase());
    await runDbMigrate(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    connection = createDatabaseConnection(databaseUrl);
  });

  beforeEach(async () => {
    await resetFixture(connection);
    await seedFixture(connection);
  });

  afterAll(async () => {
    await connection?.close();
    if (databaseName) await dropDisposableDatabase(databaseName);
    restoreEnvironment("DATABASE_URL", ORIGINAL_DATABASE_URL);
    restoreEnvironment("NEXT_PUBLIC_APP_URL", ORIGINAL_NEXT_PUBLIC_APP_URL);
  });

  it("creates, bootstraps, and validates one immutable replacement without touching the source", async () => {
    const replacementId = await createReplacement(connection);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "replacement" });
    const sourceBefore = await sourceSnapshot(connection);

    await expect(reconcile(connection, provider, replacementId)).resolves.toMatchObject({
      outcome: "advanced",
      state: "provisioning_target",
    });
    await expect(reconcile(connection, provider, replacementId)).resolves.toMatchObject({
      outcome: "advanced",
      state: "validating_target",
    });

    const [workflowBeforeValidation] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, replacementId));
    const targetId = workflowBeforeValidation?.targetRunnerId;
    expect(targetId).toBeTruthy();
    if (!targetId) throw new Error("Expected replacement target.");

    const [targetBeforeValidation] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, targetId));
    expect(targetBeforeValidation).toMatchObject({
      provisioningOperationKey: PROVISIONING_OPERATION_KEY,
      provisioningStatus: "waiting_for_runner",
      requiredRunnerImageDigest: IMAGE_DIGEST,
      status: "registering",
    });
    const createCall = provider.calls.find((call) => call.step === "create");
    expect(createCall?.input).toMatchObject({
      name: PROVISIONING_OPERATION_KEY,
      tags: expect.arrayContaining([PROVISIONING_OPERATION_KEY]),
      userData: expect.stringContaining(IMAGE_DIGEST),
    });
    expect(String(createCall?.input.userData)).toContain(RUNNER_BOOT_CONTRACT_VERSION);
    expect(await sourceSnapshot(connection)).toEqual(sourceBefore);

    await expect(
      reconcile(connection, provider, replacementId, {
        confirmReadiness: async (runnerId, dependencies) => {
          expect(dependencies?.compatibilityRequirement).toEqual({
            mode: "hosted",
            release: {
              version: "step6",
              imageDigest: IMAGE_DIGEST,
              bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
            },
          });
          await markTargetReady(connection, runnerId);
          return { outcome: "ready", transitioned: true };
        },
      }),
    ).resolves.toMatchObject({ outcome: "advanced", state: "fencing_source" });

    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, replacementId));
    expect(workflow).toMatchObject({
      state: "fencing_source",
      targetRunnerId: targetId,
      replacementCount: 1,
    });
    expect(await sourceSnapshot(connection)).toEqual(sourceBefore);
    expect(provider.calls.filter((call) => call.step === "create")).toHaveLength(1);
  });

  it("rejects a persisted infrastructure replacement while its source is still provisioning", async () => {
    await connection.db
      .update(runners)
      .set({
        status: "registering",
        provisioningStatus: "waiting_for_runner",
        observedRunnerImageDigest: null,
        observedRunnerReleaseVersion: null,
        observedRunnerBootContractVersion: null,
        compatibilityState: "unknown",
        compatibilityVerifiedAt: null,
        updatedAt: NOW,
      })
      .where(eq(runners.id, SOURCE_ID));
    const created = await createOrGetRunnerReplacement({
      db: connection.db,
      sourceRunnerId: SOURCE_ID,
      triggerDeploymentId: null,
      reason: "release_mismatch",
      operationKey: REPLACEMENT_OPERATION_KEY,
      now: NOW,
    });
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });

    await expect(reconcile(connection, provider, created.replacement.id)).resolves.toEqual({
      outcome: "failed",
      replacementId: created.replacement.id,
      state: "failed",
    });
    const [replacement] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, created.replacement.id));
    expect(replacement).toMatchObject({ state: "failed", terminalCode: "state_invalid" });
    expect(await connection.db.select().from(runners)).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("authoritatively rediscovers an exact owned target after a crash without duplicate create", async () => {
    const replacementId = await createReplacement(connection);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "adopted" });
    await provider.createRunner({
      name: PROVISIONING_OPERATION_KEY,
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: "ubuntu-24-04-x64",
      tags: [PROVISIONING_OPERATION_KEY],
    });
    provider.calls.length = 0;

    await reconcile(connection, provider, replacementId);
    await reconcile(connection, provider, replacementId);

    expect(provider.calls.map((call) => call.step)).toEqual(["discover", "tag", "firewall"]);
    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, replacementId));
    const [target] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, workflow?.targetRunnerId ?? SOURCE_ID));
    expect(target).toMatchObject({
      providerResourceId: "adopted-1",
      provisioningStatus: "waiting_for_runner",
    });
    expect(provider.calls.filter((call) => call.step === "create")).toHaveLength(0);
  });

  it("fails closed on duplicate operation-tag resources and preserves the source", async () => {
    const replacementId = await createReplacement(connection);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "duplicate" });
    for (let index = 0; index < 2; index += 1) {
      await provider.createRunner({
        name: `${PROVISIONING_OPERATION_KEY}-${index}`,
        region: "sfo3",
        sizeSlug: "s-1vcpu-2gb",
        image: "ubuntu-24-04-x64",
        tags: [PROVISIONING_OPERATION_KEY],
      });
    }
    provider.calls.length = 0;
    const sourceBefore = await sourceSnapshot(connection);

    await reconcile(connection, provider, replacementId);
    await expect(reconcile(connection, provider, replacementId)).resolves.toMatchObject({
      outcome: "failed",
      state: "failed",
    });

    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, replacementId));
    expect(workflow).toMatchObject({
      state: "failed",
      terminalCode: "target_provisioning_failed",
    });
    expect(provider.calls.filter((call) => call.step === "cleanup")).toHaveLength(0);
    expect(await sourceSnapshot(connection)).toEqual(sourceBefore);
  });

  it("cleans a known failed create without moving or deleting the source", async () => {
    const replacementId = await createReplacement(connection);
    const provider = new FakeDigitalOceanProvider({
      now: () => NOW,
      fail: { create: "known create failure" },
    });
    const sourceBefore = await sourceSnapshot(connection);

    await reconcile(connection, provider, replacementId);
    await expect(reconcile(connection, provider, replacementId)).resolves.toMatchObject({
      outcome: "failed",
      state: "failed",
    });

    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, replacementId));
    const [target] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, workflow?.targetRunnerId ?? SOURCE_ID));
    expect(workflow).toMatchObject({ terminalCode: "target_provisioning_failed" });
    expect(target).toMatchObject({ status: "deleted", provisioningStatus: "deleted" });
    expect(await sourceSnapshot(connection)).toEqual(sourceBefore);
  });

  it("revokes target access and removes the exact owned target after validation failure", async () => {
    const replacementId = await createReplacement(connection);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "invalid" });
    await advanceToValidation(connection, provider, replacementId);
    const [workflowBefore] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, replacementId));
    const targetId = workflowBefore?.targetRunnerId;
    if (!targetId) throw new Error("Expected replacement target.");
    const sourceBefore = await sourceSnapshot(connection);

    await expect(
      reconcile(connection, provider, replacementId, {
        maxAttempts: 5,
        confirmReadiness: async () => ({
          outcome: "pending",
          reason: "release_incompatible",
        }),
      }),
    ).resolves.toMatchObject({ outcome: "failed", state: "failed" });

    const [target] = await connection.db.select().from(runners).where(eq(runners.id, targetId));
    const tokens = await connection.db
      .select()
      .from(runnerRegistrationTokens)
      .where(eq(runnerRegistrationTokens.runnerId, targetId));
    expect(target).toMatchObject({ status: "deleted", provisioningStatus: "deleted" });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ status: "revoked" });
    expect(provider.calls.filter((call) => call.step === "deleteFirewall")).toHaveLength(1);
    expect(provider.calls.filter((call) => call.step === "deleteDroplet")).toHaveLength(1);
    expect(await sourceSnapshot(connection)).toEqual(sourceBefore);
  });

  it("rejects a ready target that cannot hold all source assignments", async () => {
    await seedSecondAgent(connection);
    const replacementId = await createReplacement(connection);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "capacity" });
    await advanceToValidation(connection, provider, replacementId);
    const sourceBefore = await sourceSnapshot(connection);

    await expect(
      reconcile(connection, provider, replacementId, {
        confirmReadiness: async (runnerId) => {
          await markTargetReady(connection, runnerId);
          return { outcome: "ready", transitioned: true };
        },
      }),
    ).resolves.toMatchObject({ outcome: "failed", state: "failed" });

    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, replacementId));
    expect(workflow).toMatchObject({ terminalCode: "target_validation_failed" });
    expect(await sourceSnapshot(connection)).toEqual(sourceBefore);
  });

  it("rejects and cleans a target with the wrong boot contract", async () => {
    const replacementId = await createReplacement(connection);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "wrong-boot" });
    await advanceToValidation(connection, provider, replacementId);
    const [workflowBefore] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, replacementId));
    const targetId = workflowBefore?.targetRunnerId;
    if (!targetId) throw new Error("Expected replacement target.");
    await connection.db
      .update(runners)
      .set({
        status: "online",
        observedRunnerReleaseVersion: "step6",
        observedRunnerImageDigest: IMAGE_DIGEST,
        observedRunnerBootContractVersion: "bruno.runner.boot.v0",
        compatibilityState: "invalid",
        compatibilityVerifiedAt: NOW,
      })
      .where(eq(runners.id, targetId));

    await expect(
      reconcile(connection, provider, replacementId, {
        maxAttempts: 5,
        confirmReadiness: async (runnerId, dependencies) => {
          expect(runnerId).toBe(targetId);
          expect(dependencies?.compatibilityRequirement).toMatchObject({
            release: { bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION },
          });
          return { outcome: "pending", reason: "release_incompatible" };
        },
      }),
    ).resolves.toMatchObject({ outcome: "failed", state: "failed" });

    const [target] = await connection.db.select().from(runners).where(eq(runners.id, targetId));
    expect(target).toMatchObject({ status: "deleted", provisioningStatus: "deleted" });
  });

  it("refuses a billable create when the deployment replacement budget is exhausted", async () => {
    const replacementId = await createReplacement(connection);
    await connection.db.insert(agentDeploymentReplacementBudgets).values({
      deploymentId: DEPLOYMENT_ID,
      windowStartedAt: NOW,
      replacementCount: 2,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });

    await reconcile(connection, provider, replacementId);
    await expect(reconcile(connection, provider, replacementId)).resolves.toMatchObject({
      outcome: "failed",
      state: "failed",
    });

    const [workflow] = await connection.db
      .select()
      .from(runnerReplacements)
      .where(eq(runnerReplacements.id, replacementId));
    expect(workflow).toMatchObject({ terminalCode: "replacement_budget_exhausted" });
    expect(provider.calls.filter((call) => call.step === "create")).toHaveLength(0);
  });

  it("bounds an aborted provider discovery, schedules retry, and never creates", async () => {
    const replacementId = await createReplacement(connection);
    const base = new FakeDigitalOceanProvider({ now: () => NOW });
    const provider: DigitalOceanProvider = {
      listSshKeys: (context) => base.listSshKeys(context),
      createSshKey: (input, context) => base.createSshKey(input, context),
      createRunner: (input, context) => base.createRunner(input, context),
      discoverResourcesByTag: async (_input, context) => {
        if (!context?.signal.aborted) {
          await new Promise<void>((resolve) =>
            context?.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return { ok: false, reason: "discovery_failed", message: "bounded timeout" };
      },
      readResource: (input, context) => base.readResource(input, context),
      tagResource: (input, context) => base.tagResource(input, context),
      applyFirewall: (input, context) => base.applyFirewall(input, context),
      cleanupResource: (input, context) => base.cleanupResource(input, context),
    };
    await reconcile(connection, provider, replacementId);
    const sourceBefore = await sourceSnapshot(connection);

    await expect(
      reconcile(connection, provider, replacementId, { providerTimeoutMs: 5 }),
    ).resolves.toMatchObject({ outcome: "retry_scheduled" });

    expect(base.calls.filter((call) => call.step === "create")).toHaveLength(0);
    expect(await sourceSnapshot(connection)).toEqual(sourceBefore);
  });

  it("allows only one concurrent claimant and provisions the associated target exactly once", async () => {
    const replacementId = await createReplacement(connection);
    const second = createDatabaseConnection(databaseUrl);
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    try {
      const results = await Promise.all([
        reconcile(connection, provider, replacementId, {}, LEASE_A),
        reconcile(second, provider, replacementId, {}, LEASE_B),
      ]);

      expect(results.every((result) => result.outcome !== "failed")).toBe(true);
      // A claimant advances exactly one persisted workflow phase. When both claims begin while the
      // pending row is locked, the loser may correctly return idle before the winner commits the
      // target association. A later reconcile must provision that target without duplicating it.
      await expect(
        reconcile(connection, provider, replacementId, {}, LEASE_A),
      ).resolves.not.toMatchObject({
        outcome: "failed",
      });
      const [workflow] = await connection.db
        .select()
        .from(runnerReplacements)
        .where(eq(runnerReplacements.id, replacementId));
      expect(workflow).toMatchObject({ state: "validating_target" });
      expect(workflow?.targetRunnerId).toBeTruthy();
      await expect(
        connection.db
          .select({ id: runners.id })
          .from(runners)
          .where(eq(runners.name, "Source runner replacement")),
      ).resolves.toHaveLength(1);
      expect(provider.calls.filter((call) => call.step === "create")).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
});

function reconcile(
  connection: DatabaseConnection,
  provider: DigitalOceanProvider,
  replacementId: string,
  dependencies: Partial<
    NonNullable<Parameters<typeof reconcileNextRunnerReplacement>[0]["dependencies"]>
  > = {},
  leaseOwner = LEASE_A,
) {
  return reconcileNextRunnerReplacement({
    replacementId,
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

async function advanceToValidation(
  connection: DatabaseConnection,
  provider: DigitalOceanProvider,
  replacementId: string,
): Promise<void> {
  for (let step = 0; step < 4; step += 1) {
    await reconcile(connection, provider, replacementId);
  }
  const [workflow] = await connection.db
    .select()
    .from(runnerReplacements)
    .where(eq(runnerReplacements.id, replacementId));
  expect(workflow?.state).toBe("validating_target");
}

function providerConfig(): DigitalOceanProviderConfig {
  return {
    token: "fake-provider-token",
    providerMode: "digitalocean",
    runnerBearerToken: "fake-runner-bearer",
    runnerImage: RUNNER_IMAGE,
    runnerMaxAgents: 1,
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    tags: ["bruno", "bruno-runner"],
    sshKeyIds: ["fake-key"],
    sshSourceAddresses: ["203.0.113.5/32"],
  };
}

async function markTargetReady(connection: DatabaseConnection, runnerId: string): Promise<void> {
  await connection.db
    .update(runners)
    .set({
      status: "online",
      provisioningStatus: "ready",
      observedRunnerReleaseVersion: "step6",
      observedRunnerImageDigest: IMAGE_DIGEST,
      observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      compatibilityState: "compatible",
      compatibilityVerifiedAt: NOW,
      provisioningCompletedAt: NOW,
      updatedAt: NOW,
    })
    .where(eq(runners.id, runnerId));
  await connection.db.insert(runnerHeartbeats).values({
    runnerId,
    status: "online",
    observedAt: NOW,
    createdAt: NOW,
  });
}

async function createReplacement(connection: DatabaseConnection): Promise<string> {
  const created = await createOrGetRunnerReplacement({
    db: connection.db,
    sourceRunnerId: SOURCE_ID,
    triggerDeploymentId: DEPLOYMENT_ID,
    reason: "gateway_deadline",
    operationKey: REPLACEMENT_OPERATION_KEY,
    now: NOW,
  });
  return created.replacement.id;
}

async function sourceSnapshot(connection: DatabaseConnection) {
  const [source] = await connection.db.select().from(runners).where(eq(runners.id, SOURCE_ID));
  const assigned = await connection.db
    .select({ id: agents.id, runnerId: agents.runnerId })
    .from(agents)
    .where(eq(agents.runnerId, SOURCE_ID));
  return { source, assigned };
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

async function seedFixture(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values({ id: USER_ID, createdAt: NOW, updatedAt: NOW });
  await connection.db.insert(runners).values({
    id: SOURCE_ID,
    userId: USER_ID,
    name: "Source runner",
    kind: "digitalocean",
    status: "online",
    provider: "digitalocean",
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: RUNNER_IMAGE,
    provisioningStatus: "ready",
    requiredRunnerImageDigest: IMAGE_DIGEST,
    observedRunnerImageDigest: IMAGE_DIGEST,
    observedRunnerReleaseVersion: "step6",
    observedRunnerBootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
    compatibilityState: "compatible",
    compatibilityVerifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    runnerId: SOURCE_ID,
    name: "Replacement fixture agent",
    templateKey: "research_agent",
    templateVersion: "1.0.0",
    status: "running",
    desiredStatus: "running",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agentDeployments).values({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    stage: "ready",
    configRevision: "cfg-replacement-test",
    idempotencyKey: "replacement-test-deployment",
    runnerOperationId: RUNNER_OPERATION_ID,
    runnerAcceptedAt: NOW,
    canaryState: "passed",
    canaryAttemptedAt: NOW,
    canaryCompletedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedSecondAgent(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(agents).values({
    id: SECOND_AGENT_ID,
    userId: USER_ID,
    runnerId: SOURCE_ID,
    name: "Second replacement fixture agent",
    templateKey: "research_agent",
    templateVersion: "1.0.0",
    status: "running",
    desiredStatus: "running",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agentDeployments).values({
    id: SECOND_DEPLOYMENT_ID,
    agentId: SECOND_AGENT_ID,
    userId: USER_ID,
    stage: "ready",
    configRevision: "cfg-replacement-test-2",
    idempotencyKey: "replacement-test-deployment-2",
    runnerOperationId: SECOND_RUNNER_OPERATION_ID,
    runnerAcceptedAt: NOW,
    canaryState: "passed",
    canaryAttemptedAt: NOW,
    canaryCompletedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function createDisposableDatabase(): Promise<{
  databaseName: string;
  databaseUrl: string;
}> {
  const databaseName = `bruno_runner_reconciler_${process.pid}_${Date.now()}`.toLowerCase();
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
    throw new Error("Runner replacement reconciler tests require loopback PostgreSQL.");
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
    throw new Error("Disposable runner reconciler database name is invalid.");
  }
  return `"${value}"`;
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
