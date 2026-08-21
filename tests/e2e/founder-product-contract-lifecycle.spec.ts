import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createFounderProductContractClock,
  createFounderProductContractHarness,
  runFounderProductContractPublicScenario,
  runFounderProductContractScenario,
} from "@/src/testing/founder-product-contract";
import {
  assertPersistedFounderLifecycleAuthority,
  createFounderProductContractFixture,
  deleteFounderProductContractFixture,
  readFounderScenarioExecutions,
  signedFounderCommerceEvent,
  withPinnedFounderDevelopmentUser,
} from "./founder-product-contract-fixture";

test("one persisted lifecycle producer emits the exact-run ledger", async ({ request }) => {
  const clock = createFounderProductContractClock(
    requiredEnvironment("BRUNO_FOUNDER_CONTRACT_OBSERVED_AT"),
  );
  const fixture = await createFounderProductContractFixture(clock);
  const sourceRevision = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION");
  const runId = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUN_ID");
  const ledgerPath = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH");
  const harness = createFounderProductContractHarness({
    clock,
    sourceRevision,
    application: {
      request: async ({ method, path, body }) => {
        const response = await request.fetch(path, {
          method,
          ...(body === undefined ? {} : { data: body as object }),
        });
        return {
          status: response.status(),
          headers: response.headers(),
          json: () => response.json(),
        };
      },
    },
  });
  let admittedCommerceEvent: ReturnType<typeof signedFounderCommerceEvent> | undefined;

  try {
    await runFounderProductContractPublicScenario(harness, async ({ application }) => {
      await withPinnedFounderDevelopmentUser(fixture.userId, async () => {
        const apiResponse = await application.request({ method: "GET", path: "/api/operator" });
        expect(apiResponse.status).toBe(200);
        expect(apiResponse.headers["cache-control"]).toBe("no-store");

        for (const id of [
          "release_stage_admission",
          "product_entitlement_lifecycle",
          "recovery_archive_lifecycle",
          "infrastructure_retirement",
        ] as const) {
          await runFounderProductContractScenario(harness, id, async ({ application, clock }) => {
            if (id === "product_entitlement_lifecycle") {
              admittedCommerceEvent ??= signedFounderCommerceEvent(
                runId,
                fixture.checkoutCorrelation,
                clock.now(),
              );
            }
            const response = await application.request({
              method: "POST",
              path: "/api/operator/founder-product-contract/lifecycle",
              body: {
                action: id,
                runId,
                now: clock.now().toISOString(),
                ...(id === "product_entitlement_lifecycle"
                  ? {
                      commerceEvent: admittedCommerceEvent,
                      providerSubscriptionStatus: "active",
                    }
                  : {}),
                ...(id === "infrastructure_retirement"
                  ? {
                      commerceEvent: signedFounderCommerceEvent(
                        runId,
                        fixture.checkoutCorrelation,
                        clock.now(),
                        "cancelled",
                      ),
                      providerSubscriptionStatus: "cancelled",
                      providerFailure: "archive.create",
                    }
                  : {}),
              },
            });
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
              outcome: {
                providerCalls: string[];
                cleanup: {
                  resourcesBefore: number;
                  resourcesAfter: number;
                  verified: boolean;
                  observedAt: string;
                };
              };
            };
            expect(body.outcome.providerCalls.length).toBeGreaterThan(0);
            if (id === "release_stage_admission" || id === "recovery_archive_lifecycle") {
              expect(body.outcome.providerCalls).toEqual(
                expect.arrayContaining(["archive.encrypt", "archive.store", "archive.restore"]),
              );
              const statusResponse = await application.request({
                method: "GET",
                path: "/api/operator",
              });
              const statusBody = (await statusResponse.json()) as { recoveryArchive: unknown };
              expect(statusResponse.status).toBe(200);
              expect(statusBody.recoveryArchive).toMatchObject({
                state: "current",
                restoreVerifiedAt: clock.now().toISOString(),
              });
              expect(JSON.stringify(statusBody.recoveryArchive)).not.toMatch(
                /objectKey|digest|credential|ciphertext/i,
              );
              if (id === "release_stage_admission") {
                expect(body.outcome.providerCalls).toEqual(
                  expect.arrayContaining(["archive.delete", "archive.delete_credentials"]),
                );
              }
            }
            if (id === "infrastructure_retirement") {
              expect(body.outcome.cleanup).toMatchObject({
                resourcesBefore: 2,
                resourcesAfter: 0,
                verified: true,
              });
            }
            clock.advance(1);
            return { status: "passed", ...body.outcome.cleanup };
          });
        }

        await assertPersistedFounderLifecycleAuthority(fixture);
        const ledgerResponse = await application.request({
          method: "GET",
          path: "/api/operator/founder-product-contract/lifecycle",
        });
        expect(ledgerResponse.status).toBe(200);
        const { ledger } = (await ledgerResponse.json()) as { ledger: unknown };
        await mkdir(dirname(ledgerPath), { recursive: true });
        await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      });
    });
  } finally {
    await deleteFounderProductContractFixture(fixture, { retainScenarioExecutions: true });
  }

  expect(await readFounderScenarioExecutions(runId, fixture.userId)).toEqual([
    expect.objectContaining({ status: "passed", attempts: 1, cleanup_verified: true }),
    expect.objectContaining({ status: "passed", attempts: 1, cleanup_verified: true }),
    expect.objectContaining({ status: "passed", attempts: 1, cleanup_verified: true }),
    expect.objectContaining({ status: "passed", attempts: 1, cleanup_verified: true }),
  ]);
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
