import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderProductContractScenarioExecutions,
  operatorRuntimes,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  claimFounderProductContractScenarioExecution,
  completeFounderProductContractScenarioExecution,
  failFounderProductContractScenarioExecution,
  issueFounderProductContractScenarioLedger,
} from "@/src/server/founder-product-contract/evidence";
import { eq } from "drizzle-orm";
import { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";

const USER_ID = "00000000-0000-4000-8000-000000003720";
const FAILED_USER_ID = "00000000-0000-4000-8000-000000003721";
const REVISION = "a".repeat(40);
const RUNTIME_REVISION = "runtime-release-v1";
const OPERATOR_ID = "00000000-0000-4000-8000-000000003722";
const RUN_ID = "application-evidence-run";
const OBSERVED_AT = "2026-08-21T08:00:00.000Z";

describe("persisted Founder Product Contract evidence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset();
    await connection.db.insert(users).values({ id: USER_ID });
    await connection.db.insert(operators).values({ id: OPERATOR_ID, userId: USER_ID });
    await connection.db.insert(operatorRuntimes).values({
      operatorId: OPERATOR_ID,
      status: "ready",
      transportState: "connected",
      safetyState: "verified",
      configRevision: RUNTIME_REVISION,
    });
  });

  afterEach(async () => {
    await reset();
    await connection.close();
  });

  it("claims before effects and rejects a retried canonical scenario", async () => {
    for (const action of FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS) {
      const identity = {
        runId: RUN_ID,
        userId: USER_ID,
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        scenarioId: action,
        observedAt: new Date(OBSERVED_AT),
        createConnection: () => connection,
      };
      await claimFounderProductContractScenarioExecution(identity);
      await completeFounderProductContractScenarioExecution({
        identity,
        outcome: {
          action,
          status: "passed",
          observedAt: OBSERVED_AT,
          providerCalls: ["application.authoritative_transition"],
          cleanup: {
            resourcesBefore: action === "infrastructure_retirement" ? 2 : 0,
            resourcesAfter: 0,
            verified: true,
            observedAt: OBSERVED_AT,
          },
        },
      });
    }

    await connection.db
      .update(operatorRuntimes)
      .set({ configRevision: "runtime-release-v2" })
      .where(eq(operatorRuntimes.operatorId, OPERATOR_ID));

    await expect(
      issueFounderProductContractScenarioLedger({
        runId: RUN_ID,
        userId: USER_ID,
        sourceRevision: REVISION,
        runtimeRevision: "runtime-release-v2",
        observedAt: OBSERVED_AT,
        signingSecret: "application-only-secret",
        createConnection: () => connection,
      }),
    ).rejects.toThrow("exact candidate contains a failed lifecycle scenario");

    await connection.db
      .update(operatorRuntimes)
      .set({ configRevision: RUNTIME_REVISION })
      .where(eq(operatorRuntimes.operatorId, OPERATOR_ID));

    await expect(
      issueFounderProductContractScenarioLedger({
        runId: RUN_ID,
        userId: USER_ID,
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        observedAt: OBSERVED_AT,
        signingSecret: "application-only-secret",
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      producer: "bruno.persisted-founder-application",
      results: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.map((id) => ({ id, attempts: 1 })),
    });

    await expect(
      claimFounderProductContractScenarioExecution({
        runId: RUN_ID,
        userId: USER_ID,
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        scenarioId: "release_stage_admission",
        observedAt: new Date(OBSERVED_AT),
        createConnection: () => connection,
      }),
    ).rejects.toThrow("was retried");

    await expect(
      issueFounderProductContractScenarioLedger({
        runId: RUN_ID,
        userId: USER_ID,
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        observedAt: OBSERVED_AT,
        signingSecret: "application-only-secret",
        createConnection: () => connection,
      }),
    ).rejects.toThrow("exact candidate contains a failed lifecycle scenario");
  });

  it("binds claim completion and retries to the runtime originally exercised", async () => {
    const identity = {
      runId: `${RUN_ID}-runtime-fence`,
      userId: USER_ID,
      sourceRevision: REVISION,
      runtimeRevision: RUNTIME_REVISION,
      scenarioId: "release_stage_admission" as const,
      observedAt: new Date(OBSERVED_AT),
      createConnection: () => connection,
    };
    await claimFounderProductContractScenarioExecution(identity);
    const outcome = {
      action: identity.scenarioId,
      status: "passed" as const,
      observedAt: OBSERVED_AT,
      providerCalls: ["application.authoritative_transition"],
      cleanup: {
        resourcesBefore: 0,
        resourcesAfter: 0,
        verified: true,
        observedAt: OBSERVED_AT,
      },
    };

    await expect(
      completeFounderProductContractScenarioExecution({
        identity: { ...identity, runtimeRevision: "runtime-release-v2" },
        outcome,
      }),
    ).rejects.toThrow("claim was not finalizable");
    expect(
      await connection.db
        .select({
          runtimeRevision: founderProductContractScenarioExecutions.runtimeRevision,
          status: founderProductContractScenarioExecutions.status,
          attempts: founderProductContractScenarioExecutions.attempts,
        })
        .from(founderProductContractScenarioExecutions)
        .where(eq(founderProductContractScenarioExecutions.runId, identity.runId)),
    ).toEqual([{ runtimeRevision: RUNTIME_REVISION, status: "in_progress", attempts: 1 }]);

    await expect(claimFounderProductContractScenarioExecution(identity)).rejects.toThrow(
      "was retried",
    );
    expect(
      await connection.db
        .select({
          runtimeRevision: founderProductContractScenarioExecutions.runtimeRevision,
          status: founderProductContractScenarioExecutions.status,
          attempts: founderProductContractScenarioExecutions.attempts,
        })
        .from(founderProductContractScenarioExecutions)
        .where(eq(founderProductContractScenarioExecutions.runId, identity.runId)),
    ).toEqual([{ runtimeRevision: RUNTIME_REVISION, status: "failed", attempts: 2 }]);
  });

  it("denies legacy scenario evidence whose runtime provenance is unknown", async () => {
    await connection.db.insert(founderProductContractScenarioExecutions).values({
      runId: `${RUN_ID}-legacy-runtime`,
      userId: USER_ID,
      scenarioId: "release_stage_admission",
      sourceRevision: REVISION,
      runtimeRevision: null,
      status: "passed",
      attempts: 1,
      resourcesBefore: 0,
      resourcesAfter: 0,
      cleanupVerified: true,
      observedAt: new Date(OBSERVED_AT),
      createdAt: new Date(OBSERVED_AT),
      updatedAt: new Date(OBSERVED_AT),
    });

    await expect(
      issueFounderProductContractScenarioLedger({
        runId: `${RUN_ID}-legacy-runtime`,
        userId: USER_ID,
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        observedAt: OBSERVED_AT,
        signingSecret: "application-only-secret",
        createConnection: () => connection,
      }),
    ).rejects.toThrow("exact candidate contains a failed lifecycle scenario");
  });

  it("retains a failed scenario as a candidate-wide denial after its user is deleted", async () => {
    await connection.db.insert(users).values({ id: FAILED_USER_ID });
    const failedIdentity = {
      runId: RUN_ID,
      userId: FAILED_USER_ID,
      sourceRevision: REVISION,
      runtimeRevision: RUNTIME_REVISION,
      scenarioId: "release_stage_admission" as const,
      observedAt: new Date(OBSERVED_AT),
      createConnection: () => connection,
    };
    await claimFounderProductContractScenarioExecution(failedIdentity);
    await failFounderProductContractScenarioExecution(failedIdentity);
    await connection.db.delete(users).where(eq(users.id, FAILED_USER_ID));

    expect(
      await connection.db
        .select({ userId: founderProductContractScenarioExecutions.userId })
        .from(founderProductContractScenarioExecutions)
        .where(eq(founderProductContractScenarioExecutions.userId, FAILED_USER_ID)),
    ).toEqual([{ userId: FAILED_USER_ID }]);

    for (const action of FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS) {
      const identity = {
        runId: RUN_ID,
        userId: USER_ID,
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        scenarioId: action,
        observedAt: new Date(OBSERVED_AT),
        createConnection: () => connection,
      };
      await claimFounderProductContractScenarioExecution(identity);
      await completeFounderProductContractScenarioExecution({
        identity,
        outcome: {
          action,
          status: "passed",
          observedAt: OBSERVED_AT,
          providerCalls: ["application.authoritative_transition"],
          cleanup: {
            resourcesBefore: action === "infrastructure_retirement" ? 2 : 0,
            resourcesAfter: 0,
            verified: true,
            observedAt: OBSERVED_AT,
          },
        },
      });
    }

    await expect(
      issueFounderProductContractScenarioLedger({
        runId: RUN_ID,
        userId: USER_ID,
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        observedAt: OBSERVED_AT,
        signingSecret: "application-only-secret",
        createConnection: () => connection,
      }),
    ).rejects.toThrow("exact candidate contains a failed lifecycle scenario");
  });

  async function reset(): Promise<void> {
    await connection.client.unsafe(
      "truncate table founder_product_contract_scenario_executions, users restart identity cascade",
    );
  }
});
