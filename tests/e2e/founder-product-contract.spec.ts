import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import {
  createFounderProductContractClock,
  createFounderProductContractHarness,
  runFounderProductContractPublicScenario,
  runFounderProductContractScenario,
  type FounderProductContractClock,
} from "@/src/testing/founder-product-contract";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_365;

test("four persisted lifecycle scenarios drive API, browser, keyboard, and accessibility evidence", async ({
  page,
  request,
}, testInfo) => {
  const clock = createFounderProductContractClock(
    process.env.BRUNO_FOUNDER_CONTRACT_OBSERVED_AT ?? new Date().toISOString(),
  );
  const fixture = await createFixture(clock);
  const contractSourceRevision =
    process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? "a".repeat(40);
  const runId = process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ?? "local-founder-contract";
  const harness = createFounderProductContractHarness({
    clock,
    sourceRevision: contractSourceRevision,
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
  const pageErrors: string[] = [];
  let admittedCommerceEvent: ReturnType<typeof signedCommerceEvent> | undefined;
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await runFounderProductContractPublicScenario(harness, async ({ application }) => {
      await withPinnedDevelopmentUser(fixture.userId, async () => {
        const apiResponse = await application.request({ method: "GET", path: "/api/operator" });
        expect(apiResponse.status).toBe(200);
        expect(apiResponse.headers["cache-control"]).toBe("no-store");
        const apiBody = (await apiResponse.json()) as { operator: { id: string } };
        expect(apiBody.operator.id).toBe(fixture.operatorId);

        for (const id of [
          "release_stage_admission",
          "product_entitlement_lifecycle",
          "recovery_archive_lifecycle",
          "infrastructure_retirement",
        ] as const) {
          await runFounderProductContractScenario(harness, id, async ({ application, clock }) => {
            if (id === "product_entitlement_lifecycle") {
              admittedCommerceEvent ??= signedCommerceEvent(
                runId,
                fixture.checkoutCorrelation,
                clock.now(),
              );
            }
            const requestBody = {
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
                    commerceEvent: signedCommerceEvent(
                      runId,
                      fixture.checkoutCorrelation,
                      clock.now(),
                      "cancelled",
                    ),
                    providerSubscriptionStatus: "cancelled",
                    providerFailure: "archive.create",
                  }
                : {}),
            };
            if (id === "release_stage_admission") {
              const archiveDeletionFailed = await application.request({
                method: "POST",
                path: "/api/operator/founder-product-contract/lifecycle",
                body: { ...requestBody, providerFailure: "archive.delete" },
              });
              expect(archiveDeletionFailed.status).toBe(409);
              await assertArchiveDeletionRemainsPending(fixture);
              const failed = await application.request({
                method: "POST",
                path: "/api/operator/founder-product-contract/lifecycle",
                body: { ...requestBody, providerFailure: "openAI.verify_connection" },
              });
              expect(failed.status).toBe(409);
            }
            if (id === "product_entitlement_lifecycle") {
              const failed = await application.request({
                method: "POST",
                path: "/api/operator/founder-product-contract/lifecycle",
                body: {
                  ...requestBody,
                  commerceEvent: signedCommerceEvent(runId, "wrong-owner-correlation", clock.now()),
                  providerFailure: "lemonSqueezy.read_subscription",
                },
              });
              expect(failed.status).toBe(409);
            }
            if (id === "recovery_archive_lifecycle") {
              const failed = await application.request({
                method: "POST",
                path: "/api/operator/founder-product-contract/lifecycle",
                body: { ...requestBody, providerFailure: "archive.create" },
              });
              expect(failed.status).toBe(409);
            }
            if (id === "infrastructure_retirement") {
              const ambiguousRunnerId = await createAdditionalLiveRunner(fixture, clock);
              const ambiguousIdentity = await application.request({
                method: "POST",
                path: "/api/operator/founder-product-contract/lifecycle",
                body: { ...requestBody, providerFailure: "digitalOcean.observe_owned_resources" },
              });
              expect(ambiguousIdentity.status).toBe(409);
              expect(await ambiguousIdentity.json()).toMatchObject({
                error: { message: "Infrastructure Retirement runner identity is ambiguous." },
              });
              await deleteAdditionalRunner(ambiguousRunnerId);
              const observationFailed = await application.request({
                method: "POST",
                path: "/api/operator/founder-product-contract/lifecycle",
                body: { ...requestBody, providerFailure: "digitalOcean.observe_owned_resources" },
              });
              expect(observationFailed.status).toBe(409);
              await assertTerminalEntitlementAuthority(fixture);
              const reordered = await application.request({
                method: "POST",
                path: "/api/operator/founder-product-contract/lifecycle",
                body: {
                  ...requestBody,
                  commerceEvent: admittedCommerceEvent,
                  providerSubscriptionStatus: "active",
                  providerFailure: "lemonSqueezy.read_subscription",
                },
              });
              expect(reordered.status).toBe(409);
              const deletionFailed = await application.request({
                method: "POST",
                path: "/api/operator/founder-product-contract/lifecycle",
                body: {
                  ...requestBody,
                  providerFailures: ["archive.create", "digitalOcean.delete_firewall"],
                },
              });
              expect(deletionFailed.status).toBe(409);
              expect(await deletionFailed.json()).toMatchObject({
                error: { message: "DigitalOcean deletion failed deterministically." },
              });
              await assertRetirementRemainsInProgress(fixture);
            }
            const responses = await Promise.all(
              Array.from({ length: 1 }, () =>
                application.request({
                  method: "POST",
                  path: "/api/operator/founder-product-contract/lifecycle",
                  body: requestBody,
                }),
              ),
            );
            const responseStatuses = responses.map((response) => response.status);
            if (!responseStatuses.includes(200)) {
              throw new Error(
                `Founder lifecycle ${id} failed: ${JSON.stringify(await responses[0]?.json())}`,
              );
            }
            expect(responseStatuses.every((status) => status === 200)).toBe(true);
            const successfulResponse = responses.find((response) => response.status === 200);
            if (!successfulResponse) throw new Error("Founder lifecycle response was missing.");
            const body = (await successfulResponse.json()) as {
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
            const cleanup = body.outcome.cleanup;
            if (id === "infrastructure_retirement") {
              expect(cleanup).toMatchObject({
                resourcesBefore: 2,
                resourcesAfter: 0,
                verified: true,
              });
            }
            clock.advance(1);
            return {
              status: "passed",
              ...cleanup,
            };
          });
        }

        await assertPersistedLifecycleAuthority(fixture);

        await page.goto("/operator");
        await expect(page.getByRole("heading", { name: "Bruno.Ai Operator" })).toBeVisible();
        await expect(page.getByText("Your Operator is ready.")).toBeVisible();
        await expect(page.getByText("Next step: Connect your Ready AI Connection")).toBeVisible();

        const forbiddenTechnicalControl =
          /agent template|manage api keys?|connect telegram|numeric allowlist|cron expression|runner management|deployment configuration|view raw logs?|open terminal/i;
        await expect(
          page
            .getByRole("button", { name: forbiddenTechnicalControl })
            .or(page.getByRole("link", { name: forbiddenTechnicalControl })),
        ).toHaveCount(0);
        await expect(page.getByRole("heading", { name: forbiddenTechnicalControl })).toHaveCount(0);

        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).not.toBe(
          "body",
        );

        const accessibility = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(accessibility.violations).toEqual([]);

        await page.reload();
        const resumedResponse = await application.request({ method: "GET", path: "/api/operator" });
        const resumedBody = (await resumedResponse.json()) as { operator: { id: string } };
        expect(resumedBody.operator.id).toBe(fixture.operatorId);
        await expect(page.getByText("Your Operator is ready.")).toBeVisible();
        await page.waitForLoadState("networkidle");
        expect(pageErrors).toEqual([]);
        await page.close();

        if (testInfo.project.name === "desktop-chrome") {
          const ledgerPath = process.env.BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH;
          if (ledgerPath) {
            const ledgerResponse = await application.request({
              method: "GET",
              path: "/api/operator/founder-product-contract/lifecycle",
            });
            expect(ledgerResponse.status).toBe(200);
            const { ledger } = (await ledgerResponse.json()) as { ledger: unknown };
            await mkdir(dirname(ledgerPath), { recursive: true });
            await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
          }
        }
      });
    });
  } finally {
    await deleteFixture(fixture);
  }
});

function signedCommerceEvent(
  runId: string,
  checkoutCorrelation: string,
  now: Date,
  status: "active" | "past_due" | "unpaid" | "cancelled" | "expired" | "refunded" = "active",
) {
  const event = {
    eventId: `${runId}:entitlement:${status}`,
    checkoutCorrelation,
    subscriptionId: `${runId}:subscription`,
    status,
    endsAt: status === "cancelled" ? now.toISOString() : null,
    occurredAt: now.toISOString(),
  };
  const secret =
    process.env.BRUNO_FOUNDER_CONTRACT_COMMERCE_WEBHOOK_SECRET ??
    "founder-contract-lemon-test-secret-v1";
  return {
    ...event,
    signature: `hmac-sha256:${createHmac("sha256", secret)
      .update(JSON.stringify(event))
      .digest("hex")}`,
  };
}

async function createFixture(clock: FounderProductContractClock): Promise<{
  userId: string;
  operatorId: string;
  runnerId: string;
  checkoutCorrelation: string;
}> {
  const userId = randomUUID();
  const operatorId = randomUUID();
  const preparationId = randomUUID();
  const runtimeId = randomUUID();
  const runnerId = randomUUID();
  const credentialId = randomUUID();
  const expiredArchiveId = randomUUID();
  const checkoutCorrelation = `${randomUUID()}.${randomUUID()}`;
  const createdAt = clock.now().toISOString();
  const readyAt = clock.advance(1_000).toISOString();
  const expiredArchiveObservedAt = new Date(clock.now().valueOf() - 31 * 24 * 60 * 60 * 1_000);
  const expiredArchiveExpiresAt = new Date(clock.now().valueOf() - 24 * 60 * 60 * 1_000);

  await withDatabase(async (sql) => {
    await sql`insert into users (id, created_at, updated_at) values (${userId}, ${createdAt}, ${readyAt})`;
    await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${operatorId}, ${userId}, 'active', ${createdAt}, ${readyAt})`;
    await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${preparationId}, ${operatorId}, 'ready', 'Asia/Manila', ${createdAt}, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${runtimeId}, ${operatorId}, 'ready', 'connected', 'verified', 'founder-contract-v1', 'founder-contract-runtime', 1, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into runners (id, user_id, name, kind, status, provider, provider_resource_id, provider_firewall_id, region, size_slug, image, provisioning_status, provisioning_operation_key, provisioning_started_at, provisioning_completed_at, created_at, updated_at) values (${runnerId}, ${userId}, ${`founder-${runnerId}`}, 'digitalocean', 'online', 'digitalocean', ${`droplet-${runnerId}`}, ${`firewall-${runnerId}`}, 'sfo3', 's-1vcpu-1gb', 'ubuntu-24-04-x64', 'ready', ${`bruno-deploy-${runnerId.replaceAll("-", "")}`}, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into runner_credentials (id, runner_id, credential_hash, credential_prefix, status, created_at, updated_at) values (${credentialId}, ${runnerId}, ${`sha256:${runnerId.replaceAll("-", "")}`}, 'fpct', 'active', ${createdAt}, ${readyAt})`;
    await sql`insert into founder_checkout_correlations (user_id, correlation_digest, status, created_at, expires_at) values (${userId}, ${`sha256:${createHash("sha256").update(checkoutCorrelation).digest("hex")}`}, 'pending', ${createdAt}, ${new Date(clock.now().valueOf() + 60 * 60 * 1_000).toISOString()})`;
    await sql`insert into founder_recovery_archives (id, user_id, operator_id, status, storage_object_key, ciphertext_digest, restorable_verified, failure_code, observed_at, expires_at, created_at, deleted_at) values (${expiredArchiveId}, ${userId}, ${operatorId}, 'verified', ${`founder-recovery/expired/${expiredArchiveId}.age`}, ${`sha256:${createHash("sha256").update(`expired:${userId}`).digest("hex")}`}, true, null, ${expiredArchiveObservedAt.toISOString()}, ${expiredArchiveExpiresAt.toISOString()}, ${expiredArchiveObservedAt.toISOString()}, null)`;
  });

  return { userId, operatorId, runnerId, checkoutCorrelation };
}

async function createAdditionalLiveRunner(
  fixture: { userId: string },
  clock: FounderProductContractClock,
): Promise<string> {
  const runnerId = randomUUID();
  const credentialId = randomUUID();
  const observedAt = clock.now().toISOString();
  await withDatabase(async (sql) => {
    await sql`insert into runners (id, user_id, name, kind, status, provider, provider_resource_id, provider_firewall_id, region, size_slug, image, provisioning_status, provisioning_operation_key, provisioning_started_at, provisioning_completed_at, created_at, updated_at) values (${runnerId}, ${fixture.userId}, ${`ambiguous-${runnerId}`}, 'digitalocean', 'online', 'digitalocean', ${`droplet-${runnerId}`}, ${`firewall-${runnerId}`}, 'sfo3', 's-1vcpu-1gb', 'ubuntu-24-04-x64', 'ready', ${`bruno-deploy-${runnerId.replaceAll("-", "")}`}, ${observedAt}, ${observedAt}, ${observedAt}, ${observedAt})`;
    await sql`insert into runner_credentials (id, runner_id, credential_hash, credential_prefix, status, created_at, updated_at) values (${credentialId}, ${runnerId}, ${`sha256:${runnerId.replaceAll("-", "")}`}, 'fpct', 'active', ${observedAt}, ${observedAt})`;
  });
  return runnerId;
}

async function deleteAdditionalRunner(runnerId: string): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from runner_credentials where runner_id = ${runnerId}`;
    await sql`delete from runners where id = ${runnerId}`;
  });
}

async function deleteFixture(fixture: {
  userId: string;
  operatorId: string;
  runnerId: string;
  checkoutCorrelation: string;
}): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from founder_product_contract_scenario_executions where user_id = ${fixture.userId}`;
    await sql`delete from founder_infrastructure_retirements where user_id = ${fixture.userId}`;
    await sql`delete from founder_product_entitlements where user_id = ${fixture.userId}`;
    await sql`delete from founder_commerce_events where user_id = ${fixture.userId}`;
    await sql`delete from founder_checkout_correlations where user_id = ${fixture.userId}`;
    await sql`delete from founder_recovery_archive_deletion_receipts where user_id = ${fixture.userId}`;
    await sql`delete from founder_recovery_archives where user_id = ${fixture.userId}`;
    await sql`delete from founder_release_decisions where user_id = ${fixture.userId}`;
    await sql`delete from runner_credentials where runner_id in (select id from runners where user_id = ${fixture.userId})`;
    await sql`delete from runners where user_id = ${fixture.userId}`;
    await sql`delete from operator_conversations where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_runtimes where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_preparations where operator_id = ${fixture.operatorId}`;
    await sql`delete from operators where id = ${fixture.operatorId}`;
    await sql`delete from users where id = ${fixture.userId}`;
  });
}

async function assertPersistedLifecycleAuthority(fixture: {
  userId: string;
  operatorId: string;
  runnerId: string;
  checkoutCorrelation: string;
}): Promise<void> {
  await withDatabase(async (sql) => {
    const [authority] = await sql<
      {
        release_decisions: number;
        scenario_executions: number;
        commerce_events: number;
        terminal_entitlements: number;
        consumed_correlations: number;
        safe_release_decisions: number;
        archives: number;
        failed_archives: number;
        deleted_archives: number;
        archive_deletions: number;
        retirements: number;
        runner_status: string;
        active_credentials: number;
        active_runners: number;
        paused: boolean;
      }[]
    >`select
      (select count(*)::int from founder_release_decisions where user_id = ${fixture.userId}) as release_decisions,
      (select count(*)::int from founder_product_contract_scenario_executions where user_id = ${fixture.userId}) as scenario_executions,
      (select count(*)::int from founder_commerce_events where user_id = ${fixture.userId}) as commerce_events,
      (select count(*)::int from founder_product_entitlements where user_id = ${fixture.userId} and status = 'cancelled' and retirement_due_at is not null) as terminal_entitlements,
      (select count(*)::int from founder_checkout_correlations where user_id = ${fixture.userId} and status = 'consumed') as consumed_correlations,
      (select count(*)::int from founder_release_decisions where user_id = ${fixture.userId} and application_revision = ${process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? "a".repeat(40)} and runtime_revision = 'founder-contract-v1' and capability_manifest = '["openai", "calendar_reading"]'::jsonb) as safe_release_decisions,
      (select count(*)::int from founder_recovery_archives where user_id = ${fixture.userId} and status = 'verified') as archives,
      (select count(*)::int from founder_recovery_archives where user_id = ${fixture.userId} and status = 'failed') as failed_archives,
      (select count(*)::int from founder_recovery_archives where user_id = ${fixture.userId} and status = 'deleted' and deleted_at is not null) as deleted_archives,
      (select count(*)::int from founder_recovery_archive_deletion_receipts where user_id = ${fixture.userId} and status = 'completed' and provider_confirmed = true) as archive_deletions,
      (select count(*)::int from founder_infrastructure_retirements where user_id = ${fixture.userId} and status = 'completed') as retirements,
      (select status from runners where id = ${fixture.runnerId}) as runner_status,
      (select count(*)::int from runner_credentials where runner_id in (select id from runners where user_id = ${fixture.userId}) and status = 'active') as active_credentials,
      (select count(*)::int from runners where user_id = ${fixture.userId} and deleted_at is null) as active_runners,
      (select external_action_pause from operators where id = ${fixture.operatorId}) as paused`;
    expect(authority).toMatchObject({
      release_decisions: 1,
      scenario_executions: 4,
      commerce_events: 2,
      terminal_entitlements: 1,
      consumed_correlations: 1,
      safe_release_decisions: 1,
      archives: 3,
      failed_archives: 2,
      deleted_archives: 1,
      archive_deletions: 1,
      retirements: 1,
      runner_status: "deleted",
      active_credentials: 0,
      active_runners: 0,
      paused: true,
    });
  });
}

async function assertRetirementRemainsInProgress(fixture: {
  userId: string;
  operatorId: string;
  runnerId: string;
  checkoutCorrelation: string;
}): Promise<void> {
  await withDatabase(async (sql) => {
    const [state] = await sql<
      { status: string; failure_code: string; credential_status: string; paused: boolean }[]
    >`select
      (select status from founder_infrastructure_retirements where user_id = ${fixture.userId}) as status,
      (select failure_code from founder_infrastructure_retirements where user_id = ${fixture.userId}) as failure_code,
      (select status from runner_credentials where runner_id = ${fixture.runnerId}) as credential_status,
      (select external_action_pause from operators where id = ${fixture.operatorId}) as paused`;
    expect(state).toEqual({
      status: "in_progress",
      failure_code: "provider_effect_failed",
      credential_status: "revoked",
      paused: true,
    });
  });
}

async function assertTerminalEntitlementAuthority(fixture: { userId: string }): Promise<void> {
  await withDatabase(async (sql) => {
    const [state] = await sql<
      { status: string; event_type: string; terminal_events: number }[]
    >`select entitlement.status, event.event_type,
      (select count(*)::int from founder_commerce_events where user_id = ${fixture.userId} and event_type = 'subscription_cancelled') as terminal_events
      from founder_product_entitlements entitlement
      join founder_commerce_events event on event.id = entitlement.source_event_id
      where entitlement.user_id = ${fixture.userId}`;
    expect(state).toEqual({
      status: "cancelled",
      event_type: "subscription_cancelled",
      terminal_events: 1,
    });
  });
}

async function assertArchiveDeletionRemainsPending(fixture: { userId: string }): Promise<void> {
  await withDatabase(async (sql) => {
    const [state] = await sql<
      { status: string; provider_confirmed: boolean; failure_code: string }[]
    >`select status, provider_confirmed, failure_code from founder_recovery_archive_deletion_receipts where user_id = ${fixture.userId}`;
    expect(state).toEqual({
      status: "pending",
      provider_confirmed: false,
      failure_code: "archive_delete_failed",
    });
  });
}

async function withPinnedDevelopmentUser<T>(userId: string, run: () => Promise<T>): Promise<T> {
  return withDatabase(async (sql) => {
    await sql`select pg_advisory_lock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;
    const [previous] = await sql<
      { value: string }[]
    >`select value from app_metadata where key = 'local_development_user_id'`;
    await sql`insert into app_metadata (key, value) values ('local_development_user_id', ${userId}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    try {
      return await run();
    } finally {
      if (previous) {
        await sql`update app_metadata set value = ${previous.value}, updated_at = now() where key = 'local_development_user_id'`;
      } else {
        await sql`delete from app_metadata where key = 'local_development_user_id'`;
      }
      await sql`select pg_advisory_unlock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;
    }
  });
}

async function withDatabase<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno", {
    connect_timeout: 5,
    idle_timeout: 60,
    max: 1,
  });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
