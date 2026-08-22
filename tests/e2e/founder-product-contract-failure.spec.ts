import { expect, test } from "@playwright/test";
import { createFounderProductContractClock } from "@/src/testing/founder-product-contract";
import {
  createFounderProductContractFixture,
  deleteFounderProductContractFixture,
  readFounderReleaseDecisions,
  readFounderScenarioExecutions,
  withPinnedFounderDevelopmentUser,
} from "./founder-product-contract-fixture";

test("unavailable Recovery Archive storage remains a durable failed run after user cleanup", async ({
  request,
}) => {
  const clock = createFounderProductContractClock(
    requiredEnvironment("BRUNO_FOUNDER_CONTRACT_OBSERVED_AT"),
  );
  const runId = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUN_ID");
  const fixture = await createFounderProductContractFixture(clock);

  try {
    await withPinnedFounderDevelopmentUser(fixture.userId, async () => {
      const failed = await request.post("/api/operator/founder-product-contract/lifecycle", {
        data: {
          action: "release_stage_admission",
          runId,
          now: clock.now().toISOString(),
          providerFailure: "archive.create",
        },
      });
      expect(failed.status()).toBe(409);
      await expect(failed.json()).resolves.toMatchObject({
        error: {
          code: "lifecycle_transition_failed",
          message: "archive.create failed deterministically.",
        },
      });

      const ledger = await request.get("/api/operator/founder-product-contract/lifecycle");
      expect(ledger.status()).toBe(409);
      await expect(ledger.json()).resolves.toMatchObject({
        error: {
          code: "ledger_incomplete",
          message: expect.stringContaining("exact candidate contains a failed lifecycle scenario"),
        },
      });
      expect(await readFounderReleaseDecisions(fixture.userId)).toEqual([
        {
          outcome: "deny",
          application_revision: requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION"),
          runtime_revision: "founder-contract-v1",
        },
      ]);
    });
  } finally {
    await deleteFounderProductContractFixture(fixture, { retainScenarioExecutions: true });
  }

  expect(await readFounderScenarioExecutions(runId, fixture.userId)).toEqual([
    {
      scenario_id: "release_stage_admission",
      status: "failed",
      attempts: 1,
      cleanup_verified: false,
    },
  ]);
});

test("a corrupt Recovery Archive fails admission before it can be certified", async ({
  request,
}) => {
  const clock = createFounderProductContractClock(
    requiredEnvironment("BRUNO_FOUNDER_CONTRACT_OBSERVED_AT"),
  );
  const runId = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUN_ID");
  const fixture = await createFounderProductContractFixture(clock);

  try {
    await withPinnedFounderDevelopmentUser(fixture.userId, async () => {
      const failed = await request.post("/api/operator/founder-product-contract/lifecycle", {
        data: {
          action: "release_stage_admission",
          runId,
          now: clock.now().toISOString(),
          providerFailure: "archive.corrupt",
        },
      });
      expect(failed.status()).toBe(409);
      await expect(failed.json()).resolves.toMatchObject({
        error: {
          code: "lifecycle_transition_failed",
          message: "Recovery Archive ciphertext digest did not match.",
        },
      });
    });
  } finally {
    await deleteFounderProductContractFixture(fixture);
  }
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
