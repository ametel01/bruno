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
  prepareFounderExternalBetaContractFixture,
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
          "external_beta_cohort_lifecycle",
          "product_entitlement_lifecycle",
          "subscription_lifecycle",
          "recovery_archive_lifecycle",
          "infrastructure_retirement",
          "identity_recovery_lifecycle",
        ] as const) {
          await runFounderProductContractScenario(harness, id, async ({ application, clock }) => {
            if (id === "external_beta_cohort_lifecycle") {
              await prepareFounderExternalBetaContractFixture(fixture, {
                runId,
                applicationRevision: sourceRevision,
                now: clock.now(),
              });
            }
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
                ...(id === "external_beta_cohort_lifecycle"
                  ? {
                      externalBetaContract: {
                        cohortOwnerUserId: fixture.externalBetaOwnerUserId,
                        participantUserId: fixture.externalBetaParticipantUserId,
                        invitedClerkSubject: `clerk:${fixture.externalBetaParticipantUserId}`,
                      },
                    }
                  : {}),
              },
            });
            const responseBody = await response.json();
            expect(response.status, JSON.stringify(responseBody)).toBe(200);
            const body = responseBody as {
              outcome: {
                providerCalls: string[];
                externalBetaManifest?: {
                  state: string;
                  availableCapabilities: string[];
                  providerChoice: string;
                  capacityBoundary: string;
                  safeWorkCheckpointsPreserved: boolean;
                };
                externalBetaCohort?: {
                  invitationExpiresAt: string;
                  accessExpiresAt: string;
                  retirementDueAt: string;
                  copiedAccountDenied: boolean;
                  wrongWorkspaceDenied: boolean;
                  payment: string;
                  exactCapabilities: string[];
                  promotionEligible: boolean;
                  founderAcceptanceEligible: boolean;
                  newCohortRequired: boolean;
                  retirementCompleted: boolean;
                };
                cleanup: {
                  resourcesBefore: number;
                  resourcesAfter: number;
                  verified: boolean;
                  observedAt: string;
                };
                commerceLifecycle?: {
                  portal: string;
                  paymentRecoveryHours: number;
                  unpaidRetirementHours: number;
                  expiredRetirementHours: number;
                  refundRetirementHours: number;
                  reorderedActiveCanRestartTerminalClock: boolean;
                };
                identityRecovery?: {
                  lostIdentityDenied: boolean;
                  takeoverDenied: boolean;
                  recoveredSameOwner: boolean;
                  accountClosureCoordinated: boolean;
                  commerceChangedByIdentityLoss: boolean;
                  productEntitlementChangedByIdentityLoss: boolean;
                  refundStartedByIdentityLoss: boolean;
                  retirementStartedByIdentityLoss: boolean;
                  archiveDeletionStartedByIdentityLoss: boolean;
                  accountClosureStartedByIdentityLoss: boolean;
                  receiptKinds: string[];
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
                  expect.arrayContaining([
                    "openAI.verify_connection",
                    "anthropic.verify_connection",
                    "google.verify_calendar_reading",
                    "google.verify_gmail_reading",
                    "google.verify_gmail_sending",
                    "archive.delete",
                    "archive.delete_credentials",
                  ]),
                );
                expect(body.outcome.externalBetaManifest).toEqual({
                  state: "ready",
                  availableCapabilities: [
                    "openai",
                    "anthropic",
                    "calendar_reading",
                    "gmail_reading",
                    "gmail_sending",
                  ],
                  providerChoice: "Connect OpenAI, Anthropic, or both",
                  capacityBoundary: "Uses only your connected provider accounts",
                  safeWorkCheckpointsPreserved: true,
                });
                expect(JSON.stringify(body.outcome.externalBetaManifest)).not.toMatch(
                  /model|credential|token|runner|hermes|digest|revision/i,
                );
              }
            }
            if (id === "infrastructure_retirement") {
              expect(body.outcome.cleanup).toMatchObject({
                resourcesBefore: 2,
                resourcesAfter: 0,
                verified: true,
              });
              const statusResponse = await application.request({
                method: "GET",
                path: "/api/operator",
              });
              expect(statusResponse.status).toBe(200);
              await expect(statusResponse.json()).resolves.toMatchObject({
                infrastructureRetirement: {
                  state: "completed",
                  attemptCount: 1,
                  archive: { outcome: "failed", criticalFailure: true },
                  provider: {
                    droplet: "absent",
                    firewall: "absent",
                    absenceVerifiedAt: clock.now().toISOString(),
                  },
                  billableRuntime: {
                    startedAt: clock.now().toISOString(),
                    endedAt: clock.now().toISOString(),
                    seconds: 0,
                  },
                  needsAttention: false,
                },
              });
            }
            if (id === "external_beta_cohort_lifecycle") {
              expect(body.outcome.providerCalls).toEqual(
                expect.arrayContaining([
                  "archive.create",
                  "archive.restore",
                  "digitalOcean.observe_owned_resources",
                  "digitalOcean.delete_firewall",
                  "digitalOcean.delete_droplet",
                  "digitalOcean.observe_owned_resources_absent",
                ]),
              );
              expect(body.outcome.externalBetaCohort).toEqual({
                invitationExpiresAt: new Date(
                  clock.now().valueOf() + 7 * 24 * 60 * 60 * 1_000,
                ).toISOString(),
                accessExpiresAt: new Date(
                  clock.now().valueOf() + 14 * 24 * 60 * 60 * 1_000,
                ).toISOString(),
                retirementDueAt: new Date(
                  clock.now().valueOf() + 14 * 24 * 60 * 60 * 1_000 + 60 * 60 * 1_000,
                ).toISOString(),
                copiedAccountDenied: true,
                wrongWorkspaceDenied: true,
                payment: "Free, no card, no renewal, and no automatic paid conversion",
                exactCapabilities: [
                  "openai",
                  "anthropic",
                  "calendar_reading",
                  "gmail_reading",
                  "gmail_sending",
                ],
                promotionEligible: false,
                founderAcceptanceEligible: false,
                newCohortRequired: true,
                retirementCompleted: true,
              });
            }
            if (id === "subscription_lifecycle") {
              expect(body.outcome.providerCalls).toContain("lemonSqueezy.create_customer_portal");
              expect(body.outcome.commerceLifecycle).toEqual({
                portal: "signed_hosted",
                paymentRecoveryHours: 168,
                unpaidRetirementHours: 24,
                expiredRetirementHours: 1,
                refundRetirementHours: 24,
                reorderedActiveCanRestartTerminalClock: false,
              });
            }
            if (id === "identity_recovery_lifecycle") {
              expect(body.outcome.providerCalls).toContain("clerk.authenticate");
              expect(body.outcome.identityRecovery).toEqual({
                lostIdentityDenied: true,
                takeoverDenied: true,
                recoveredSameOwner: true,
                accountClosureCoordinated: true,
                commerceChangedByIdentityLoss: false,
                productEntitlementChangedByIdentityLoss: false,
                refundStartedByIdentityLoss: false,
                retirementStartedByIdentityLoss: false,
                archiveDeletionStartedByIdentityLoss: false,
                accountClosureStartedByIdentityLoss: false,
                receiptKinds: [
                  "identity_loss_recorded",
                  "recovery_denied",
                  "identity_rebound",
                  "account_closure_requested",
                ],
              });
            }
            clock.advance(id === "release_stage_admission" ? 3 : 1);
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
