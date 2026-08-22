import { createHash, createHmac, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import postgres from "postgres";
import type { FounderProductContractClock } from "@/src/testing/founder-product-contract";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_365;

export type FounderProductContractFixture = {
  userId: string;
  operatorId: string;
  runnerId: string;
  checkoutCorrelation: string;
};

export function signedFounderCommerceEvent(
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

export async function createFounderProductContractFixture(
  clock: FounderProductContractClock,
): Promise<FounderProductContractFixture> {
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

  await withFounderProductContractDatabase(async (sql) => {
    await sql`insert into users (id, created_at, updated_at) values (${userId}, ${createdAt}, ${readyAt})`;
    await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${operatorId}, ${userId}, 'active', ${createdAt}, ${readyAt})`;
    await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${preparationId}, ${operatorId}, 'ready', 'Asia/Manila', ${createdAt}, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${runtimeId}, ${operatorId}, 'ready', 'connected', 'verified', 'founder-contract-v1', 'founder-contract-runtime', 1, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into runners (id, user_id, name, kind, status, provider, provider_resource_id, provider_firewall_id, region, size_slug, image, provisioning_status, provisioning_operation_key, provisioning_started_at, provisioning_completed_at, created_at, updated_at) values (${runnerId}, ${userId}, ${`founder-${runnerId}`}, 'digitalocean', 'online', 'digitalocean', ${`droplet-${runnerId}`}, ${`firewall-${runnerId}`}, 'sfo3', 's-1vcpu-1gb', 'ubuntu-24-04-x64', 'ready', ${`bruno-deploy-${runnerId.replaceAll("-", "")}`}, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into runner_credentials (id, runner_id, credential_hash, credential_prefix, status, created_at, updated_at) values (${credentialId}, ${runnerId}, ${`sha256:${runnerId.replaceAll("-", "")}`}, 'fpct', 'active', ${createdAt}, ${readyAt})`;
    await sql`insert into founder_checkout_correlations (user_id, correlation_digest, status, created_at, expires_at) values (${userId}, ${`sha256:${createHash("sha256").update(checkoutCorrelation).digest("hex")}`}, 'pending', ${createdAt}, ${new Date(clock.now().valueOf() + 60 * 60 * 1_000).toISOString()})`;
    await sql`insert into founder_recovery_archives (id, user_id, operator_id, status, format_version, storage_object_key, recovery_credential_object_key, ciphertext_digest, recovery_credential_digest, state_digest, restorable_verified, restore_verified_at, failure_code, observed_at, expires_at, created_at, deleted_at) values (${expiredArchiveId}, ${userId}, ${operatorId}, 'verified', 1, ${`founder-recovery/expired/${expiredArchiveId}.age`}, ${`founder-recovery/expired/${expiredArchiveId}.key`}, ${`sha256:${createHash("sha256").update(`expired:${userId}`).digest("hex")}`}, ${`sha256:${createHash("sha256").update(`expired-credential:${userId}`).digest("hex")}`}, ${`sha256:${createHash("sha256").update(`expired-state:${userId}`).digest("hex")}`}, true, ${expiredArchiveObservedAt.toISOString()}, null, ${expiredArchiveObservedAt.toISOString()}, ${expiredArchiveExpiresAt.toISOString()}, ${expiredArchiveObservedAt.toISOString()}, null)`;
  });

  return { userId, operatorId, runnerId, checkoutCorrelation };
}

export async function deleteFounderProductContractFixture(
  fixture: FounderProductContractFixture,
  options: { retainScenarioExecutions?: boolean } = {},
): Promise<void> {
  await withFounderProductContractDatabase(async (sql) => {
    const contractRunId = process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID;
    if (contractRunId) {
      await sql`delete from founder_preview_qualifications where cohort = ${`external-beta-contract:${contractRunId}`}`;
    }
    if (!options.retainScenarioExecutions) {
      await sql`delete from founder_product_contract_scenario_executions where user_id = ${fixture.userId}`;
    }
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
    await sql`delete from app_metadata where key = 'founder_owner_preview_owner_user_id:v1' and value = ${fixture.userId}`;
  });
}

export async function assertPersistedFounderLifecycleAuthority(
  fixture: FounderProductContractFixture,
): Promise<void> {
  await withFounderProductContractDatabase(async (sql) => {
    const [authority] = await sql<
      {
        release_decisions: number;
        release_decision_outcomes: string[];
        scenario_executions: number;
        commerce_events: number;
        terminal_entitlements: number;
        consumed_correlations: number;
        safe_release_decisions: number;
        external_beta_qualifications: number;
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
      (select array_agg(outcome order by decided_at) from founder_release_decisions where user_id = ${fixture.userId}) as release_decision_outcomes,
      (select count(*)::int from founder_product_contract_scenario_executions where user_id = ${fixture.userId}) as scenario_executions,
      (select count(*)::int from founder_commerce_events where user_id = ${fixture.userId}) as commerce_events,
      (select count(*)::int from founder_product_entitlements where user_id = ${fixture.userId} and status = 'cancelled' and retirement_due_at is not null) as terminal_entitlements,
      (select count(*)::int from founder_checkout_correlations where user_id = ${fixture.userId} and status = 'consumed') as consumed_correlations,
      (select count(*)::int from founder_release_decisions where user_id = ${fixture.userId} and application_revision = ${process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? "a".repeat(40)} and runtime_revision = 'founder-contract-v1' and capability_manifest = '["openai", "calendar_reading"]'::jsonb) as safe_release_decisions,
      (select count(*)::int from founder_preview_qualifications where cohort = ${`external-beta-contract:${process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ?? "missing"}`} and application_revision = ${process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? "a".repeat(40)} and runtime_revision = 'founder-contract-v1') as external_beta_qualifications,
      (select count(*)::int from founder_recovery_archives where user_id = ${fixture.userId} and status = 'verified' and format_version = 1 and restorable_verified = true and restore_verified_at is not null and state_digest is not null) as archives,
      (select count(*)::int from founder_recovery_archives where user_id = ${fixture.userId} and status = 'failed') as failed_archives,
      (select count(*)::int from founder_recovery_archives where user_id = ${fixture.userId} and status = 'deleted' and deleted_at is not null) as deleted_archives,
      (select count(*)::int from founder_recovery_archive_deletion_receipts where user_id = ${fixture.userId} and status = 'completed' and archive_provider_confirmed = true and recovery_credentials_confirmed = true) as archive_deletions,
      (select count(*)::int from founder_infrastructure_retirements where user_id = ${fixture.userId} and status = 'completed') as retirements,
      (select status from runners where id = ${fixture.runnerId}) as runner_status,
      (select count(*)::int from runner_credentials where runner_id in (select id from runners where user_id = ${fixture.userId}) and status = 'active') as active_credentials,
      (select count(*)::int from runners where user_id = ${fixture.userId} and deleted_at is null) as active_runners,
      (select external_action_pause from operators where id = ${fixture.operatorId}) as paused`;
    expect(authority).toMatchObject({
      release_decisions: 3,
      release_decision_outcomes: ["enter", "hold", "resume"],
      scenario_executions: 4,
      commerce_events: 2,
      terminal_entitlements: 1,
      consumed_correlations: 1,
      safe_release_decisions: 3,
      external_beta_qualifications: 5,
      archives: 2,
      failed_archives: 1,
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

export async function readFounderScenarioExecutions(runId: string, userId: string) {
  return withFounderProductContractDatabase(
    (sql) =>
      sql<
        {
          scenario_id: string;
          status: string;
          attempts: number;
          cleanup_verified: boolean;
        }[]
      >`select scenario_id, status, attempts, cleanup_verified from founder_product_contract_scenario_executions where run_id = ${runId} and user_id = ${userId} order by scenario_id`,
  );
}

export async function readFounderReleaseDecisions(userId: string) {
  return withFounderProductContractDatabase(
    (sql) =>
      sql<
        { outcome: string; application_revision: string; runtime_revision: string }[]
      >`select outcome, application_revision, runtime_revision from founder_release_decisions where user_id = ${userId} order by decided_at`,
  );
}

export async function readFounderExternalBetaQualifications(runId: string) {
  return withFounderProductContractDatabase(
    (sql) =>
      sql<
        { capability: string }[]
      >`select capability from founder_preview_qualifications where cohort = ${`external-beta-contract:${runId}`} order by capability`,
  );
}

export async function withPinnedFounderDevelopmentUser<T>(
  userId: string,
  run: () => Promise<T>,
): Promise<T> {
  return withFounderProductContractDatabase(async (sql) => {
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

export async function withFounderProductContractDatabase<T>(
  run: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
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
