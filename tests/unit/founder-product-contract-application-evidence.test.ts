import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { users } from "@/src/server/db/schema";
import {
  claimFounderProductContractScenarioExecution,
  completeFounderProductContractScenarioExecution,
  issueFounderProductContractScenarioLedger,
} from "@/src/server/founder-product-contract/evidence";
import { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";

const USER_ID = "00000000-0000-4000-8000-000000003720";
const REVISION = "a".repeat(40);
const RUN_ID = "application-evidence-run";
const OBSERVED_AT = "2026-08-21T08:00:00.000Z";

describe("persisted Founder Product Contract evidence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.db.insert(users).values({ id: USER_ID });
  });

  afterEach(async () => {
    await connection.client.unsafe("truncate table users restart identity cascade");
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
    ).rejects.toThrow("exactly once");
  });
});
