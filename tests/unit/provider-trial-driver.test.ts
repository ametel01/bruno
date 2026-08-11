import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDeploymentChoices } from "@/src/server/agents/agent-deployment-choices";
import { createProviderTrialCohort } from "@/src/server/agents/provider-trial-cohort";
import {
  initializeProviderTrialDriver,
  providerTrialBenchmarkOwnerIdentityHash,
  providerTrialBenchmarkTelegramIdentityHash,
  providerTrialDeploymentChoicesDigest,
  resumeProviderTrialDriver,
  verifyProviderTrialDriverReport,
} from "@/src/server/agents/provider-trial-driver";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentEvents,
  agentSecrets,
  agents,
  providerTrialRuns,
  providerTrialSlotCleanupEvents,
  providerTrialSlots,
  users,
} from "@/src/server/db/schema";
import {
  LOCAL_DOCKER_DROPLET_CONTAINER_NAME,
  LocalDockerDigitalOceanProvider,
} from "@/src/server/runners/local-docker-digitalocean-provider";
import { LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID } from "@/src/server/runners/local-docker-provider-constants";

const USER_ID = "00000000-0000-4000-8000-000000003001";
const AGENT_ID = "00000000-0000-4000-8000-000000003002";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000003003";
const TELEGRAM_UNIQUENESS_FINGERPRINT = "d".repeat(64);
const DEPLOYMENT_CHOICES: AgentDeploymentChoices = {
  schemaVersion: "bruno.agent-deployment.choices.v1",
  dispatchMode: "cron",
  rolloutConfigurationGeneration: 1,
  provider: {
    mode: "local_docker",
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    tags: ["bruno-provider-trial"],
    runnerImage: `ghcr.io/ametel01/bruno-runner@sha256:${"1".repeat(64)}`,
    runnerBootContractVersion: "bruno.runner.boot.v1",
    hermesWorkloadImage: null,
    hermesStateRoot: null,
    hermesPrivateNetwork: null,
    hermesReadinessTimeoutMs: null,
    hermesDockerCpus: null,
    hermesDockerMemory: null,
    hermesDockerPidsLimit: null,
    runnerMaxAgents: null,
    sshKeyIds: [],
    sshSourceAddresses: [],
    localRunnerEndpointUrl: "http://127.0.0.1:3045",
    localRunnerContainerName: "bruno-local-cloud-runner",
    localRunnerStartDelayMs: 1_000,
    localAgentSmokeMode: false,
    snapshotMode: { mode: "stock" },
  },
  validation: { mode: "full", releaseBundleDigest: null, snapshotBundleDigest: null },
};

describe("resumable Provider Trial driver", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("consumes all 30 original slots sequentially and publishes signed sanitized cleanup evidence", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-001");
    const keys = generateKeyPairSync("ed25519");
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration(),
    });

    const seenSlots: number[] = [];
    for (let slot = 1; slot <= 30; slot += 1) {
      const result = await resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot(attempt) {
            seenSlots.push(attempt.slotNumber);
            return {
              outcome: "pre_commit_failure",
              safeCode: "request_rejected",
              costCents: 1,
              activeProviderResources: 0,
            };
          },
          async cleanup() {
            return { ok: true, authoritative: true, remainingResourceIds: [] };
          },
        },
      );
      expect(result).toMatchObject({
        state: slot === 30 ? "ready_to_finalize" : "running",
        nextSlotNumber: slot + 1,
      });
    }

    const finalized = await resumeProviderTrialDriver(
      connection,
      { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
      {
        async executeSlot() {
          throw new Error("No replacement slot may be executed.");
        },
        async cleanup() {
          return { ok: true, authoritative: true, remainingResourceIds: [] };
        },
        signing: {
          keyId: "provider-trial-local",
          privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        },
      },
    );

    expect(seenSlots).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(finalized).toMatchObject({ state: "complete", spentCents: 30 });
    expect(JSON.stringify(finalized)).not.toMatch(/auth-local-001|privateKey|token|credential/i);
    const [run] = await connection.db.select().from(providerTrialRuns);
    expect(run).toMatchObject({ state: "complete", nextSlotNumber: 31, spentCents: 30 });
    expect(run?.signedReportDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const report = JSON.parse(run?.signedReportBytes ?? "{}") as Record<string, unknown>;
    expect(report.slotCleanup).toHaveLength(30);
    expect(report.stageDistributions).toEqual([]);
    expect(
      verifyProviderTrialDriverReport({
        canonicalBytes: run?.signedReportBytes ?? "",
        digest: run?.signedReportDigest ?? "",
        keyId: run?.signedReportKeyId ?? "",
        signature: run?.signedReportSignature ?? "",
        trustedPublicKeys: {
          "provider-trial-local": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      }),
    ).toBe(true);
    const inconsistent = JSON.parse(run?.signedReportBytes ?? "{}") as Record<string, unknown>;
    (inconsistent.stages as Record<string, unknown>)["1"] = "ready_within_60";
    const inconsistentBytes = canonicalJson(inconsistent);
    expect(
      verifyProviderTrialDriverReport({
        canonicalBytes: inconsistentBytes,
        digest: `sha256:${createHash("sha256").update(inconsistentBytes).digest("hex")}`,
        keyId: "provider-trial-local",
        signature: sign(null, Buffer.from(inconsistentBytes), keys.privateKey).toString(
          "base64url",
        ),
        trustedPublicKeys: {
          "provider-trial-local": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      }),
    ).toBe(false);

    const scopeMismatch = JSON.parse(run?.signedReportBytes ?? "{}") as Record<string, unknown>;
    (scopeMismatch.configuration as Record<string, unknown>).authorizedRegion = "nyc3";
    const scopeMismatchBytes = canonicalJson(scopeMismatch);
    expect(
      verifyProviderTrialDriverReport({
        canonicalBytes: scopeMismatchBytes,
        digest: `sha256:${createHash("sha256").update(scopeMismatchBytes).digest("hex")}`,
        keyId: "provider-trial-local",
        signature: sign(null, Buffer.from(scopeMismatchBytes), keys.privateKey).toString(
          "base64url",
        ),
        trustedPublicKeys: {
          "provider-trial-local": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      }),
    ).toBe(false);

    const unfinished = JSON.parse(run?.signedReportBytes ?? "{}") as Record<string, unknown>;
    const unfinishedCohort = unfinished.cohort as Record<string, unknown>;
    const slots = unfinishedCohort.slots as Array<Record<string, unknown>>;
    const finalSlot = slots.at(29);
    if (!finalSlot) throw new Error("Expected the final Provider Trial report slot.");
    finalSlot.terminalOutcome = null;
    (unfinishedCohort.readiness as Record<string, unknown>).allSlotMisses = 29;
    (unfinishedCohort.readiness as Record<string, unknown>).pending = 1;
    (unfinished.stages as Record<string, unknown>)["30"] = null;
    const unfinishedBytes = canonicalJson(unfinished);
    expect(
      verifyProviderTrialDriverReport({
        canonicalBytes: unfinishedBytes,
        digest: `sha256:${createHash("sha256").update(unfinishedBytes).digest("hex")}`,
        keyId: "provider-trial-local",
        signature: sign(null, Buffer.from(unfinishedBytes), keys.privateKey).toString("base64url"),
        trustedPublicKeys: {
          "provider-trial-local": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      }),
    ).toBe(false);
  });

  it("signs sanitized stage distributions from the exact deployment linked to the ledger", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-stages");
    const keys = generateKeyPairSync("ed25519");
    const acceptedAt = new Date("2026-08-08T10:00:00.000Z");
    await seedOwner(connection);
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration(),
    });
    for (let slot = 1; slot <= 30; slot += 1) {
      const result = await resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot(attempt) {
            if (slot !== 1) {
              return {
                outcome: "pre_commit_failure",
                safeCode: "request_rejected",
                costCents: 0,
                activeProviderResources: 0,
              };
            }
            await seedDeployment(
              connection,
              attempt.requestAttemptId,
              DEPLOYMENT_CHOICES,
              acceptedAt,
            );
            await connection.db
              .update(agentDeployments)
              .set({
                stage: "ready",
                runnerOperationId: "00000000-0000-4000-8000-000000003099",
                runnerAcceptedAt: new Date(acceptedAt.getTime() + 1_000),
                canaryState: "skipped",
                completedAt: new Date(acceptedAt.getTime() + 50_000),
              })
              .where(eq(agentDeployments.id, DEPLOYMENT_ID));
            await connection.db.insert(agentEvents).values([
              {
                agentId: AGENT_ID,
                actorUserId: USER_ID,
                type: "agent.deployment_stage_changed",
                message: "Provider trial entered provisioning.",
                metadata: {
                  deploymentId: DEPLOYMENT_ID,
                  fromStage: "pending",
                  toStage: "provisioning",
                },
                createdAt: new Date(acceptedAt.getTime() + 5_000),
              },
              {
                agentId: AGENT_ID,
                actorUserId: USER_ID,
                type: "agent.deployment_stage_changed",
                message: "Provider trial became ready.",
                metadata: {
                  deploymentId: DEPLOYMENT_ID,
                  fromStage: "provisioning",
                  toStage: "ready",
                },
                createdAt: new Date(acceptedAt.getTime() + 20_000),
              },
            ]);
            return {
              outcome: "committed",
              deploymentId: DEPLOYMENT_ID,
              costCents: 0,
              activeProviderResources: 1,
            };
          },
          async cleanup() {
            return { ok: true, authoritative: true, remainingResourceIds: [] };
          },
        },
      );
      expect(result).toMatchObject({
        state: slot === 30 ? "ready_to_finalize" : "running",
        nextSlotNumber: slot + 1,
      });
    }

    await resumeProviderTrialDriver(
      connection,
      { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
      {
        async executeSlot() {
          throw new Error("No replacement slot may be executed.");
        },
        async cleanup() {
          return { ok: true, authoritative: true, remainingResourceIds: [] };
        },
        signing: {
          keyId: "provider-trial-local",
          privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        },
      },
    );

    const [run] = await connection.db.select().from(providerTrialRuns);
    const report = JSON.parse(run?.signedReportBytes ?? "{}") as {
      stageDistributions?: Array<Record<string, unknown>>;
    };
    expect(report.stageDistributions).toEqual(
      expect.arrayContaining([
        {
          name: "agent:pending",
          source: "agent_event",
          sampleCount: 1,
          missingCount: 0,
          invalidCount: 0,
          duplicateEvidenceCount: 0,
          p50Ms: 5_000,
          p95Ms: 5_000,
          maxMs: 5_000,
        },
        {
          name: "agent:provisioning",
          source: "agent_event",
          sampleCount: 1,
          missingCount: 0,
          invalidCount: 0,
          duplicateEvidenceCount: 0,
          p50Ms: 15_000,
          p95Ms: 15_000,
          maxMs: 15_000,
        },
      ]),
    );
    expect(JSON.stringify(report)).not.toContain(USER_ID);
    expect(JSON.stringify(report)).not.toContain(TELEGRAM_UNIQUENESS_FINGERPRINT);
    expect(
      verifyProviderTrialDriverReport({
        canonicalBytes: run?.signedReportBytes ?? "",
        digest: run?.signedReportDigest ?? "",
        keyId: run?.signedReportKeyId ?? "",
        signature: run?.signedReportSignature ?? "",
        trustedPublicKeys: {
          "provider-trial-local": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      }),
    ).toBe(true);

    const tampered = JSON.parse(run?.signedReportBytes ?? "{}") as {
      stageDistributions: Array<Record<string, unknown>>;
    };
    const firstDistribution = tampered.stageDistributions[0];
    if (!firstDistribution) throw new Error("Expected signed Provider Trial stage evidence.");
    firstDistribution.sampleCount = 0;
    const tamperedBytes = canonicalJson(tampered);
    expect(
      verifyProviderTrialDriverReport({
        canonicalBytes: tamperedBytes,
        digest: `sha256:${createHash("sha256").update(tamperedBytes).digest("hex")}`,
        keyId: "provider-trial-local",
        signature: sign(null, Buffer.from(tamperedBytes), keys.privateKey).toString("base64url"),
        trustedPublicKeys: {
          "provider-trial-local": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      }),
    ).toBe(false);

    const inconsistentCounters = JSON.parse(run?.signedReportBytes ?? "{}") as {
      stageDistributions: Array<Record<string, unknown>>;
    };
    const inconsistentDistribution = inconsistentCounters.stageDistributions[0];
    if (!inconsistentDistribution) {
      throw new Error("Expected signed Provider Trial stage evidence.");
    }
    inconsistentDistribution.missingCount = 1;
    const inconsistentBytes = canonicalJson(inconsistentCounters);
    expect(
      verifyProviderTrialDriverReport({
        canonicalBytes: inconsistentBytes,
        digest: `sha256:${createHash("sha256").update(inconsistentBytes).digest("hex")}`,
        keyId: "provider-trial-local",
        signature: sign(null, Buffer.from(inconsistentBytes), keys.privateKey).toString(
          "base64url",
        ),
        trustedPublicKeys: {
          "provider-trial-local": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      }),
    ).toBe(false);
  });

  it("pauses immediately on a safety violation and requires renewed authorization to resume", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-002");
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration(),
    });

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot() {
            return {
              outcome: "safety_pause",
              safeCode: "safety_failure",
              costCents: 2,
              activeProviderResources: 0,
            };
          },
          async cleanup() {
            return { ok: true, authoritative: true, remainingResourceIds: [] };
          },
        },
      ),
    ).resolves.toMatchObject({ state: "paused", nextSlotNumber: 2 });

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot() {
            throw new Error("Stale authorization must not execute.");
          },
          async cleanup() {
            return { ok: true, authoritative: true, remainingResourceIds: [] };
          },
        },
      ),
    ).rejects.toThrow("renewed authorization");

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-002", generation: 2 } },
        {
          async executeSlot() {
            return {
              outcome: "pre_commit_failure",
              safeCode: "request_rejected",
              costCents: 1,
              activeProviderResources: 0,
            };
          },
          async cleanup() {
            return { ok: true, authoritative: true, remainingResourceIds: [] };
          },
        },
      ),
    ).resolves.toMatchObject({ state: "running", nextSlotNumber: 3 });
  });

  it("rejects mutation of the durable provider authorization configuration", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-config");
    const original = configuration();
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: original,
    });

    await expect(
      connection.db
        .update(providerTrialRuns)
        .set({ configuration: { ...original, maxSpendCents: original.maxSpendCents + 300 } })
        .where(eq(providerTrialRuns.cohortId, cohort.id)),
    ).rejects.toThrow();
    await expect(
      connection.db.delete(providerTrialRuns).where(eq(providerTrialRuns.cohortId, cohort.id)),
    ).rejects.toThrow();
    await expect(
      initializeProviderTrialDriver(connection, {
        cohortId: cohort.id,
        authorization: { id: "auth-local-002", generation: 2 },
        configuration: { ...original, maxSpendCents: original.maxSpendCents + 300 },
      }),
    ).rejects.toThrow();
  });

  it("resumes the original idempotent slot attempt after an interrupted request", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-003");
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration(),
    });

    let interruptedAttemptId = "";
    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot(attempt) {
            interruptedAttemptId = attempt.requestAttemptId;
            throw new Error("simulated process interruption");
          },
          async cleanup() {
            throw new Error("cleanup is not reached after a process interruption");
          },
        },
      ),
    ).resolves.toMatchObject({ state: "paused", nextSlotNumber: 1 });

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-002", generation: 2 } },
        {
          async executeSlot() {
            throw new Error("Reconciliation must preserve the original provider request.");
          },
          async reconcileRequest(attempt, context) {
            expect(attempt.requestAttemptId).toBe(interruptedAttemptId);
            expect(context.idempotencyKey).toBe(`provider-trial:${interruptedAttemptId}`);
            return {
              outcome: "pre_commit_failure",
              safeCode: "request_rejected",
              costCents: 1,
              activeProviderResources: 0,
            };
          },
          async cleanup() {
            return { ok: true, authoritative: true, remainingResourceIds: [] };
          },
        },
      ),
    ).resolves.toMatchObject({ state: "running", nextSlotNumber: 2 });
  });

  it("retains a committed deployment identity when a safety limit pauses the slot", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-004");
    await seedOwner(connection);
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration({ maxSpendCents: 0, maxSlotCostCents: 0 }),
    });

    const result = await resumeProviderTrialDriver(
      connection,
      { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
      {
        async executeSlot(attempt) {
          await seedDeployment(connection, attempt.requestAttemptId);
          return {
            outcome: "committed",
            deploymentId: DEPLOYMENT_ID,
            costCents: 1,
            activeProviderResources: 1,
          };
        },
        async cleanup() {
          return { ok: true, authoritative: true, remainingResourceIds: [] };
        },
      },
    );

    expect(result).toMatchObject({ state: "paused", nextSlotNumber: 2, spentCents: 1 });
    const [slot] = await connection.db
      .select()
      .from(providerTrialSlots)
      .where(eq(providerTrialSlots.slotNumber, 1));
    expect(slot).toMatchObject({
      requestOutcome: "committed",
      deploymentId: DEPLOYMENT_ID,
      terminalOutcome: "safety_failure",
    });
  });

  it("safety-pauses a committed deployment whose durable choices miss the authorized digest", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-choices");
    await seedOwner(connection);
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration(),
    });

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot(attempt) {
            await seedDeployment(connection, attempt.requestAttemptId, {
              ...DEPLOYMENT_CHOICES,
              dispatchMode: "qstash",
            });
            return {
              outcome: "committed",
              deploymentId: DEPLOYMENT_ID,
              costCents: 1,
              activeProviderResources: 1,
            };
          },
          async observeCommittedSlot() {
            throw new Error("Mismatched durable choices must not reach observation.");
          },
          async cleanup() {
            return { ok: true, authoritative: true, remainingResourceIds: [] };
          },
        },
      ),
    ).resolves.toMatchObject({ state: "paused", nextSlotNumber: 2 });
    const [slot] = await connection.db
      .select()
      .from(providerTrialSlots)
      .where(eq(providerTrialSlots.slotNumber, 1));
    expect(slot).toMatchObject({ requestOutcome: "committed", terminalOutcome: "safety_failure" });
  });

  it("fences concurrent resumes with one durable run lease", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-005");
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration(),
    });
    let releaseExecution: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let allowExecution: (() => void) | undefined;
    const executionGate = new Promise<void>((resolve) => {
      allowExecution = resolve;
    });
    const first = resumeProviderTrialDriver(
      connection,
      { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
      {
        async executeSlot() {
          releaseExecution?.();
          await executionGate;
          return {
            outcome: "pre_commit_failure",
            safeCode: "request_rejected",
            costCents: 1,
            activeProviderResources: 0,
          };
        },
        async cleanup() {
          return { ok: true, authoritative: true, remainingResourceIds: [] };
        },
      },
    );
    await executionStarted;

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot() {
            throw new Error("A concurrent resume must not reach the provider.");
          },
          async cleanup() {
            return { ok: true, authoritative: true, remainingResourceIds: [] };
          },
        },
      ),
    ).rejects.toThrow("active lease");
    allowExecution?.();
    await expect(first).resolves.toMatchObject({ state: "running", nextSlotNumber: 2 });
  });

  it("resumes after an outcome checkpoint when cleanup was interrupted", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-006");
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration(),
    });
    const executeSlot = vi.fn(async () => ({
      outcome: "pre_commit_failure" as const,
      safeCode: "request_rejected" as const,
      costCents: 1,
      activeProviderResources: 0,
    }));

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          executeSlot,
          async cleanup() {
            throw new Error("simulated cleanup interruption");
          },
        },
      ),
    ).resolves.toMatchObject({ state: "paused", nextSlotNumber: 1 });

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          executeSlot,
          async cleanup() {
            throw new Error("Stale authorization must not cross the cleanup boundary.");
          },
        },
      ),
    ).rejects.toThrow("renewed authorization");

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-002", generation: 2 } },
        {
          executeSlot,
          async cleanup() {
            return { ok: true, authoritative: true, remainingResourceIds: [] };
          },
        },
      ),
    ).resolves.toMatchObject({ state: "running", nextSlotNumber: 2, spentCents: 1 });
    expect(executeSlot).toHaveBeenCalledOnce();
    const cleanupEvents = await connection.db
      .select()
      .from(providerTrialSlotCleanupEvents)
      .orderBy(providerTrialSlotCleanupEvents.cleanupAttemptNumber);
    expect(cleanupEvents).toMatchObject([
      {
        cleanupAttemptNumber: 1,
        costCents: 1,
        activeProviderResources: 0,
        ok: false,
        authoritative: false,
        remainingResourceCount: 0,
      },
      {
        cleanupAttemptNumber: 2,
        costCents: 1,
        activeProviderResources: 0,
        ok: true,
        authoritative: true,
        remainingResourceCount: 0,
      },
    ]);
  });

  it("does not classify a timed-out request until the stable idempotency key is reconciled", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-007");
    await seedOwner(connection);
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration({ perSlotTimeoutMs: 1_000 }),
    });
    let lateCommitFinished: (() => void) | undefined;
    const lateCommit = new Promise<void>((resolve) => {
      lateCommitFinished = resolve;
    });
    const cleanup = vi.fn(async () => ({
      ok: true,
      authoritative: true,
      remainingResourceIds: [] as string[],
    }));
    let originalSlotDeadlineAt: string | undefined;

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          executeSlot(attempt, context) {
            originalSlotDeadlineAt = context.deadlineAt;
            return new Promise((resolve) => {
              context.signal.addEventListener(
                "abort",
                () => {
                  void seedDeployment(connection, attempt.requestAttemptId).then(() => {
                    resolve({
                      outcome: "committed",
                      deploymentId: DEPLOYMENT_ID,
                      costCents: 1,
                      activeProviderResources: 1,
                    });
                    lateCommitFinished?.();
                  });
                },
                { once: true },
              );
            });
          },
          cleanup,
        },
      ),
    ).resolves.toMatchObject({ state: "paused", nextSlotNumber: 1 });
    await lateCommit;
    expect(cleanup).not.toHaveBeenCalled();

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-002", generation: 2 } },
        {
          async executeSlot() {
            throw new Error("A timed-out request must be reconciled, not replayed blindly.");
          },
          async reconcileRequest(attempt, context) {
            expect(context.idempotencyKey).toBe(`provider-trial:${attempt.requestAttemptId}`);
            expect(context.deadlineAt).toBe(originalSlotDeadlineAt);
            return {
              outcome: "committed",
              deploymentId: DEPLOYMENT_ID,
              costCents: 1,
              activeProviderResources: 1,
            };
          },
          async observeCommittedSlot() {
            return "timed_out";
          },
          cleanup,
        },
      ),
    ).resolves.toMatchObject({ state: "running", nextSlotNumber: 2, spentCents: 1 });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reserves an independent cleanup budget when observation cannot yet prove a timeout", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-cleanup-budget");
    await seedOwner(connection);
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration({ perSlotTimeoutMs: 1_000, cleanupTimeoutMs: 30_000 }),
    });
    const cleanup = vi.fn(async (context: { timeoutMs: number }) => {
      expect(context.timeoutMs).toBeGreaterThan(1_000);
      return { ok: true, authoritative: true, remainingResourceIds: [] as string[] };
    });

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot(attempt) {
            await seedDeployment(
              connection,
              attempt.requestAttemptId,
              DEPLOYMENT_CHOICES,
              new Date(),
            );
            return {
              outcome: "committed",
              deploymentId: DEPLOYMENT_ID,
              costCents: 1,
              activeProviderResources: 1,
            };
          },
          async observeCommittedSlot() {
            return "timed_out";
          },
          cleanup,
        },
      ),
    ).resolves.toMatchObject({ state: "paused", nextSlotNumber: 1, spentCents: 0 });
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot() {
            throw new Error("Stale authorization must not replay incomplete observation.");
          },
          cleanup,
        },
      ),
    ).rejects.toThrow("renewed authorization");
  });

  it("passes the reserved spend, quota, and benchmark identity scope to the provider boundary", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-008");
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration({ maxSpendCents: 60, maxSlotCostCents: 2 }),
    });

    await resumeProviderTrialDriver(
      connection,
      { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
      {
        async executeSlot(_attempt, context) {
          expect(context).toMatchObject({
            maxCostCents: 2,
            maxProviderResources: 1,
            authorizationScope: {
              cohortId: cohort.id,
              region: "sfo3",
              runnerSizeSlug: "s-1vcpu-2gb",
              deploymentChoicesDigest: providerTrialDeploymentChoicesDigest(DEPLOYMENT_CHOICES),
              benchmarkOwnerIdentityHash: providerTrialBenchmarkOwnerIdentityHash(USER_ID),
              benchmarkTelegramIdentityHash: providerTrialBenchmarkTelegramIdentityHash(
                TELEGRAM_UNIQUENESS_FINGERPRINT,
              ),
            },
          });
          return {
            outcome: "pre_commit_failure",
            safeCode: "request_rejected",
            costCents: 2,
            activeProviderResources: 0,
          };
        },
        async cleanup() {
          return { ok: true, authoritative: true, remainingResourceIds: [] };
        },
      },
    );
  });

  it("drives and authoritatively cleans the local DigitalOcean-compatible provider", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-local-provider");
    const docker = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const provider = new LocalDockerDigitalOceanProvider({ docker });
    const providerTag = "bruno-provider-trial-local";
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration(),
    });

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot(_attempt, context) {
            const created = await provider.createRunner(
              {
                name: "bruno-provider-trial-local-01",
                region: context.authorizationScope.region,
                sizeSlug: context.authorizationScope.runnerSizeSlug,
                image: "ubuntu-24-04-x64",
                tags: [providerTag],
              },
              { signal: context.signal },
            );
            if (!created.ok) {
              return {
                outcome: "safety_pause",
                safeCode: "safety_failure",
                costCents: 0,
                activeProviderResources: 0,
              };
            }
            return {
              outcome: "pre_commit_failure",
              safeCode: "request_failed",
              costCents: 0,
              activeProviderResources: 1,
            };
          },
          async cleanup(context) {
            const cleaned = await provider.cleanupResource(
              { providerResourceId: LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID },
              { signal: context.signal },
            );
            const discovery = await provider.discoverResourcesByTag(
              { tag: providerTag },
              { signal: context.signal },
            );
            if (!cleaned.ok || !discovery.ok) {
              return { ok: false, authoritative: false, remainingResourceIds: [] };
            }
            return {
              ok: true,
              authoritative: discovery.value.authoritative,
              remainingResourceIds: discovery.value.resources.map(
                (resource) => resource.providerResourceId,
              ),
            };
          },
        },
      ),
    ).resolves.toMatchObject({ state: "running", nextSlotNumber: 2, spentCents: 0 });

    const discovery = await provider.discoverResourcesByTag({ tag: providerTag });
    expect(discovery).toEqual({
      ok: true,
      value: { authoritative: true, resources: [] },
    });
    expect(docker).toHaveBeenCalledWith(
      ["rm", "--force", LOCAL_DOCKER_DROPLET_CONTAINER_NAME],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("fails closed when provider resource-count evidence is omitted", async () => {
    const cohort = await createCohort(connection, "provider-trial-driver-resource-evidence");
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: { id: "auth-local-001", generation: 1 },
      configuration: configuration(),
    });
    const cleanup = vi.fn();

    await expect(
      resumeProviderTrialDriver(
        connection,
        { cohortId: cohort.id, authorization: { id: "auth-local-001", generation: 1 } },
        {
          async executeSlot() {
            return {
              outcome: "pre_commit_failure",
              safeCode: "request_rejected",
              costCents: 1,
            } as never;
          },
          cleanup,
        },
      ),
    ).resolves.toMatchObject({ state: "paused", nextSlotNumber: 1, spentCents: 0 });
    expect(cleanup).not.toHaveBeenCalled();
  });
});

async function createCohort(connection: DatabaseConnection, cohortKey: string) {
  return await createProviderTrialCohort(connection, {
    cohortKey,
    region: "sfo3",
    runnerSizeSlug: "s-1vcpu-2gb",
    rolloutConfigurationGeneration: 1,
  });
}

async function seedOwner(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values({ id: USER_ID });
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    name: "Provider trial driver fixture",
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
  });
  await connection.db.insert(agentSecrets).values({
    agentId: AGENT_ID,
    kind: "telegram_bot_token",
    ciphertext: "fixture-ciphertext",
    iv: "fixture-iv",
    authTag: "fixture-auth-tag",
    keyVersion: "fixture-v1",
    fingerprint: "a".repeat(16),
    uniquenessFingerprint: TELEGRAM_UNIQUENESS_FINGERPRINT,
    providerSubjectId: "123456789",
  });
}

async function seedDeployment(
  connection: DatabaseConnection,
  requestAttemptId: string,
  deploymentChoices: AgentDeploymentChoices = DEPLOYMENT_CHOICES,
  acceptedAt: Date = new Date("2026-08-08T10:00:00.000Z"),
): Promise<void> {
  await connection.db.insert(agentDeployments).values({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    configRevision: "cfg-provider-driver",
    idempotencyKey: `provider-trial:${requestAttemptId}`,
    origin: "operator_trial",
    initialCohort: "cold_deployment",
    deploymentEnvironment: "non_production",
    rolloutConfigurationGeneration: 1,
    deploymentChoices,
    stage: "pending",
    createdAt: acceptedAt,
    acceptedAt,
  });
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`
    truncate table provider_trial_runs, provider_trial_slots, provider_trial_cohorts,
      agent_deployments, agents, users restart identity cascade
  `;
}

function configuration(
  overrides: Partial<Parameters<typeof initializeProviderTrialDriver>[1]["configuration"]> = {},
) {
  return {
    providerMode: "local_docker" as const,
    perSlotTimeoutMs: 60_000,
    cleanupTimeoutMs: 30_000,
    maxSpendCents: 300,
    maxSlotCostCents: 10,
    maxProviderResources: 1,
    deploymentChoicesDigest: providerTrialDeploymentChoicesDigest(DEPLOYMENT_CHOICES),
    authorizedRegion: "sfo3",
    authorizedRunnerSizeSlug: "s-1vcpu-2gb",
    benchmarkOwnerIdentityHash: providerTrialBenchmarkOwnerIdentityHash(USER_ID),
    benchmarkTelegramIdentityHash: providerTrialBenchmarkTelegramIdentityHash(
      TELEGRAM_UNIQUENESS_FINGERPRINT,
    ),
    evidenceRetentionDays: 90,
    ...overrides,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
