import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderProductContractScenarioExecutions, users } from "@/src/server/db/schema";
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
const RUN_ID = "application-evidence-run";
const OBSERVED_AT = "2026-08-21T08:00:00.000Z";

describe("persisted Founder Product Contract evidence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset();
    await connection.db.insert(users).values({ id: USER_ID });
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
