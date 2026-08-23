import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import type { FounderProductContractClock } from "@/src/testing/founder-product-contract";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_365;

export type FounderProductContractFixture = {
  userId: string;
  operatorId: string;
  runnerId: string;
  checkoutCorrelation: string;
  externalBetaOwnerUserId: string;
  externalBetaOwnerOperatorId: string;
  externalBetaParticipantUserId: string;
  externalBetaParticipantOperatorId: string;
  externalBetaParticipantRunnerId: string;
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
  const externalBetaOwnerUserId = randomUUID();
  const externalBetaOwnerOperatorId = randomUUID();
  const externalBetaParticipantUserId = randomUUID();
  const externalBetaParticipantOperatorId = randomUUID();
  const externalBetaParticipantRunnerId = randomUUID();
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

  return {
    userId,
    operatorId,
    runnerId,
    checkoutCorrelation,
    externalBetaOwnerUserId,
    externalBetaOwnerOperatorId,
    externalBetaParticipantUserId,
    externalBetaParticipantOperatorId,
    externalBetaParticipantRunnerId,
  };
}

export async function prepareFounderExternalBetaContractFixture(
  fixture: FounderProductContractFixture,
  input: { runId: string; applicationRevision: string; now: Date },
): Promise<void> {
  const cohort = `external-beta-contract:${input.runId}`;
  const expiresAt = new Date(input.now.valueOf() + 8 * 24 * 60 * 60 * 1_000).toISOString();
  const ownerPreparationId = randomUUID();
  const ownerRuntimeId = randomUUID();
  const participantPreparationId = randomUUID();
  const participantRuntimeId = randomUUID();
  const participantCredentialId = randomUUID();
  const createdAt = input.now.toISOString();
  const capabilities = [
    "openai",
    "anthropic",
    "calendar_reading",
    "gmail_reading",
    "gmail_sending",
  ];

  await withFounderProductContractDatabase(async (sql) => {
    await sql`update users set clerk_user_id = ${`clerk:${fixture.userId}`}, updated_at = ${createdAt} where id = ${fixture.userId}`;
    await sql`insert into users (id, clerk_user_id, created_at, updated_at) values (${fixture.externalBetaOwnerUserId}, ${`clerk:${fixture.externalBetaOwnerUserId}`}, ${createdAt}, ${createdAt})`;
    await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${fixture.externalBetaOwnerOperatorId}, ${fixture.externalBetaOwnerUserId}, 'active', ${createdAt}, ${createdAt})`;
    await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${ownerPreparationId}, ${fixture.externalBetaOwnerOperatorId}, 'ready', 'Asia/Manila', ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${ownerRuntimeId}, ${fixture.externalBetaOwnerOperatorId}, 'ready', 'connected', 'verified', 'founder-contract-v1', ${`external-beta-owner:${input.runId}`}, 1, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;

    await sql`insert into users (id, clerk_user_id, created_at, updated_at) values (${fixture.externalBetaParticipantUserId}, ${`clerk:${fixture.externalBetaParticipantUserId}`}, ${createdAt}, ${createdAt})`;
    await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${fixture.externalBetaParticipantOperatorId}, ${fixture.externalBetaParticipantUserId}, 'active', ${createdAt}, ${createdAt})`;
    await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${participantPreparationId}, ${fixture.externalBetaParticipantOperatorId}, 'ready', 'Asia/Manila', ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${participantRuntimeId}, ${fixture.externalBetaParticipantOperatorId}, 'ready', 'connected', 'verified', 'founder-contract-v1', ${`external-beta-participant:${input.runId}`}, 1, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;
    await sql`insert into runners (id, user_id, name, kind, status, provider, provider_resource_id, provider_firewall_id, region, size_slug, image, provisioning_status, provisioning_operation_key, provisioning_started_at, provisioning_completed_at, created_at, updated_at) values (${fixture.externalBetaParticipantRunnerId}, ${fixture.externalBetaParticipantUserId}, ${`external-beta-${fixture.externalBetaParticipantRunnerId}`}, 'digitalocean', 'online', 'digitalocean', ${`droplet-${fixture.externalBetaParticipantRunnerId}`}, ${`firewall-${fixture.externalBetaParticipantRunnerId}`}, 'sfo3', 's-1vcpu-1gb', 'ubuntu-24-04-x64', 'ready', ${`bruno-deploy-${fixture.externalBetaParticipantRunnerId.replaceAll("-", "")}`}, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;
    await sql`insert into runner_credentials (id, runner_id, credential_hash, credential_prefix, status, created_at, updated_at) values (${participantCredentialId}, ${fixture.externalBetaParticipantRunnerId}, ${`sha256:${fixture.externalBetaParticipantRunnerId.replaceAll("-", "")}`}, 'fpct', 'active', ${createdAt}, ${createdAt})`;

    await sql`insert into app_metadata (key, value) values ('founder_owner_preview_owner_user_id:v1', ${fixture.externalBetaOwnerUserId}) on conflict (key) do update set value = excluded.value, updated_at = ${createdAt}`;
    await sql`delete from founder_preview_qualifications where cohort = ${cohort}`;
    for (const [index, capability] of capabilities.entries()) {
      await sql`insert into founder_preview_qualifications (stage, cohort, capability, application_revision, runtime_revision, evidence_digest, observed_at, expires_at, created_at) values ('external_beta', ${cohort}, ${capability}, ${input.applicationRevision}, 'founder-contract-v1', ${`sha256:${(500 + index).toString(16).padStart(64, "0")}`}, ${createdAt}, ${expiresAt}, ${createdAt})`;
    }
    await sql`insert into founder_release_decisions (user_id, operator_id, stage, outcome, application_revision, runtime_revision, capability_manifest, external_beta_cohort, evidence_digests, decided_at, created_at) values (${fixture.externalBetaOwnerUserId}, ${fixture.externalBetaOwnerOperatorId}, 'external_beta', 'enter', ${input.applicationRevision}, 'founder-contract-v1', ${sql.json(capabilities)}, ${cohort}, ${sql.json([`sha256:${"f".repeat(64)}`])}, ${createdAt}, ${createdAt})`;
  });
}

export async function prepareFounderExternalBetaBrowserFixture(
  fixture: FounderProductContractFixture,
  input: { runId: string; applicationRevision: string; now: Date },
): Promise<{ accessExpiresAt: string; retirementDueAt: string }> {
  await prepareFounderExternalBetaContractFixture(fixture, input);
  const cohort = `external-beta-contract:${input.runId}`;
  const admittedAt = input.now.toISOString();
  const invitationExpiresAt = new Date(
    input.now.valueOf() + 7 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const accessExpiresAt = new Date(input.now.valueOf() + 14 * 24 * 60 * 60 * 1_000).toISOString();
  const retirementDueAt = new Date(
    new Date(accessExpiresAt).valueOf() + 60 * 60 * 1_000,
  ).toISOString();
  const capabilities = [
    "openai",
    "anthropic",
    "calendar_reading",
    "gmail_reading",
    "gmail_sending",
  ];

  await withFounderProductContractDatabase(async (sql) => {
    const [stageDecision] = await sql<
      { id: string }[]
    >`select id from founder_release_decisions where user_id = ${fixture.externalBetaOwnerUserId} and stage = 'external_beta' order by decided_at desc limit 1`;
    if (!stageDecision) throw new Error("External Beta browser stage decision is unavailable.");
    const [admissionDecision] = await sql<
      { id: string }[]
    >`insert into founder_release_decisions (user_id, operator_id, stage, outcome, application_revision, runtime_revision, capability_manifest, external_beta_cohort, evidence_digests, decided_at, created_at) values (${fixture.userId}, ${fixture.operatorId}, 'external_beta', 'enter', ${input.applicationRevision}, 'founder-contract-v1', ${sql.json(capabilities)}, ${cohort}, ${sql.json([`sha256:${"e".repeat(64)}`])}, ${admittedAt}, ${admittedAt}) returning id`;
    if (!admissionDecision) {
      throw new Error("External Beta browser admission decision was not persisted.");
    }
    await sql`insert into founder_external_beta_invitations (cohort_owner_user_id, stage_decision_id, cohort, cohort_slot, invitation_digest, invited_clerk_subject_digest, named_founder_digest, workspace_digest, independence_evidence_digest, status, participant_user_id, participant_operator_id, admission_decision_id, beta_compact_digest, invited_at, invitation_expires_at, admitted_at, access_expires_at, retirement_due_at, payment_method_collected, automatic_paid_conversion, created_at, updated_at) values (${fixture.externalBetaOwnerUserId}, ${stageDecision.id}, ${cohort}, 1, ${`sha256:${createHash("sha256").update(`browser-token:${input.runId}`).digest("hex")}`}, ${`sha256:${createHash("sha256").update(`clerk:clerk:${fixture.userId}`).digest("hex")}`}, ${`sha256:${createHash("sha256").update(`browser-founder:${input.runId}`).digest("hex")}`}, ${`sha256:${createHash("sha256").update(`browser-workspace:${input.runId}`).digest("hex")}`}, ${`sha256:${createHash("sha256").update(`browser-independence:${input.runId}`).digest("hex")}`}, 'admitted', ${fixture.userId}, ${fixture.operatorId}, ${admissionDecision.id}, ${`sha256:${createHash("sha256").update(`browser-compact:${input.runId}`).digest("hex")}`}, ${admittedAt}, ${invitationExpiresAt}, ${admittedAt}, ${accessExpiresAt}, ${retirementDueAt}, false, false, ${admittedAt}, ${admittedAt})`;
  });
  return { accessExpiresAt, retirementDueAt };
}

export function founderContractIdentityHeaders(subject: string): Record<string, string> {
  const runId = requiredContractEnvironment("BRUNO_FOUNDER_CONTRACT_RUN_ID");
  const sourceRevision = requiredContractEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION");
  const signingSecret = requiredContractEnvironment(
    "BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET",
  );
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.valueOf() + 5 * 60 * 1_000);
  const payload = `${runId}\n${sourceRevision}\n${subject}\n${issuedAt.toISOString()}\n${expiresAt.toISOString()}`;
  return {
    "x-bruno-founder-contract-clerk-subject": subject,
    "x-bruno-founder-contract-issued-at": issuedAt.toISOString(),
    "x-bruno-founder-contract-expires-at": expiresAt.toISOString(),
    "x-bruno-founder-contract-clerk-signature": createHmac("sha256", signingSecret)
      .update(payload)
      .digest("hex"),
  };
}

export async function sendFounderIdentityLossWebhook(
  request: APIRequestContext,
  input: { subject: string; eventId: string },
): Promise<void> {
  const signingSecret = requiredContractEnvironment("CLERK_WEBHOOK_SIGNING_SECRET");
  if (!signingSecret.startsWith("whsec_")) throw new Error("Clerk webhook secret is invalid.");
  const key = Buffer.from(signingSecret.slice("whsec_".length), "base64");
  const body = JSON.stringify({ type: "user.deleted", data: { id: input.subject } });
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = `v1,${createHmac("sha256", key)
    .update(`${input.eventId}.${timestamp}.${body}`)
    .digest("base64")}`;
  const response = await request.post("/api/webhooks/clerk", {
    data: body,
    headers: {
      "content-type": "application/json",
      "svix-id": input.eventId,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
  });
  expect(response.status()).toBe(202);
}

export async function prepareFounderIdentityRecoveryBrowserPreconditions(
  fixture: FounderProductContractFixture,
  input: { runId: string; now: Date },
): Promise<void> {
  const occurredAt = input.now.toISOString();
  const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

  await withFounderProductContractDatabase(async (sql) => {
    const [correlation] = await sql<
      { id: string }[]
    >`select id from founder_checkout_correlations where user_id = ${fixture.userId} order by created_at desc limit 1`;
    if (!correlation) throw new Error("Browser commerce correlation is unavailable.");
    const [event] = await sql<
      { id: string }[]
    >`insert into founder_commerce_events (provider_event_id, user_id, checkout_correlation_id, provider_subscription_id, provider_order_id, event_type, payload_digest, signature_verified, occurred_at, recorded_at, application_status, last_attempt_at, applied_at) values (${`browser:${input.runId}:subscription-active`}, ${fixture.userId}, ${correlation.id}, ${`${input.runId}:subscription`}, ${`order:${input.runId}`}, 'subscription_active', ${digest(`browser-commerce:${input.runId}`)}, true, ${occurredAt}, ${occurredAt}, 'applied', ${occurredAt}, ${occurredAt}) returning id`;
    if (!event) throw new Error("Browser commerce event was not persisted.");
    await sql`insert into founder_product_entitlements (user_id, source_event_id, provider_subscription_id, status, reconciled_provider_status, provider_state_updated_at, reconciled_at, updated_at) values (${fixture.userId}, ${event.id}, ${`${input.runId}:subscription`}, 'verified', 'active', ${occurredAt}, ${occurredAt}, ${occurredAt})`;
  });
  await prepareFounderRevocableCalendarConnection(fixture, input);
}

export async function prepareFounderRevocableCalendarConnection(
  fixture: FounderProductContractFixture,
  input: { runId: string; now: Date },
): Promise<void> {
  const access = encryptFounderContractConnectionSecret(
    `founder-contract-google:${input.runId}:${fixture.userId}:calendar:access`,
    "google-calendar-access",
  );
  const refresh = encryptFounderContractConnectionSecret(
    `founder-contract-google:${input.runId}:${fixture.userId}:calendar:refresh`,
    "google-calendar-refresh",
  );
  const connectionId = randomUUID();
  const at = input.now.toISOString();
  await withFounderProductContractDatabase(async (sql) => {
    await sql`insert into operator_calendar_connections (id, operator_id, provider, provider_subject_id, account_label, status, authorization_state, access_token_ciphertext, access_token_iv, access_token_auth_tag, refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag, secret_key_version, authorized_at, last_verified_at, last_evidence_at, last_evidence_count, evidence_state, created_at, updated_at) values (${connectionId}, ${fixture.operatorId}, 'google_calendar', ${`founder-contract-calendar:${input.runId}`}, 'founder-contract@example.invalid', 'ready', 'authorized', ${access.ciphertext}, ${access.iv}, ${access.authTag}, ${refresh.ciphertext}, ${refresh.iv}, ${refresh.authTag}, ${access.keyVersion}, ${at}, ${at}, ${at}, 0, 'current', ${at}, ${at}) on conflict (operator_id, provider) do nothing`;
  });
}

function encryptFounderContractConnectionSecret(value: string, scope: string) {
  const keyVersion = requiredContractEnvironment("BRUNO_CONNECTION_SECRET_ACTIVE_KEY_VERSION");
  const serializedKeys = requiredContractEnvironment("BRUNO_CONNECTION_SECRET_KEYS_JSON");
  const keys = JSON.parse(serializedKeys) as Record<string, unknown>;
  const encodedKey = keys[keyVersion];
  if (typeof encodedKey !== "string") {
    throw new Error("Founder Product Contract connection key is unavailable.");
  }
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32) throw new Error("Founder Product Contract connection key is invalid.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`bruno.operator.connection.${scope}.${keyVersion}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    keyVersion,
  };
}

function requiredContractEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Founder Product Contract browser proof.`);
  return value;
}

export async function deleteFounderProductContractFixture(
  fixture: FounderProductContractFixture,
  options: { retainScenarioExecutions?: boolean } = {},
): Promise<void> {
  assertFounderProductContractCleanupBoundary();
  await withFounderProductContractDatabase(async (database) => {
    await database.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      const allUserIds = [
        fixture.userId,
        fixture.externalBetaOwnerUserId,
        fixture.externalBetaParticipantUserId,
      ];
      const contractRunId = process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID;
      if (contractRunId) {
        await sql`delete from founder_preview_qualifications where cohort = ${`external-beta-contract:${contractRunId}`}`;
      }
      if (!options.retainScenarioExecutions) {
        await sql`delete from founder_product_contract_scenario_executions where user_id = ${fixture.userId}`;
      }
      await sql`delete from founder_identity_recovery_receipts where user_id = ${fixture.userId}`;
      await sql`delete from founder_identity_recoveries where user_id = ${fixture.userId}`;
      await sql`delete from founder_identity_recovery_credentials where user_id = ${fixture.userId}`;
      await sql`delete from operator_deletion_receipts where request_id in (select id from operator_deletion_requests where operator_id = ${fixture.operatorId})`;
      await sql`delete from operator_deletion_commerce_cancellations where request_id in (select id from operator_deletion_requests where operator_id = ${fixture.operatorId})`;
      await sql`delete from operator_deletion_revocations where request_id in (select id from operator_deletion_requests where operator_id = ${fixture.operatorId})`;
      await sql`delete from operator_deletion_backup_expiries where request_id in (select id from operator_deletion_requests where operator_id = ${fixture.operatorId})`;
      await sql`delete from operator_deletion_tombstones where request_id in (select id from operator_deletion_requests where operator_id = ${fixture.operatorId})`;
      await sql`delete from operator_deletion_requests where operator_id = ${fixture.operatorId}`;
      await sql`delete from founder_infrastructure_retirements where user_id = any(${allUserIds})`;
      await sql`delete from founder_external_beta_invitations where cohort_owner_user_id = ${fixture.externalBetaOwnerUserId} or participant_user_id = any(${[fixture.userId, fixture.externalBetaParticipantUserId]})`;
      await sql`delete from founder_product_entitlements where user_id = ${fixture.userId}`;
      await sql`delete from founder_commerce_events where user_id = ${fixture.userId}`;
      await sql`delete from founder_checkout_correlations where user_id = ${fixture.userId}`;
      await sql`delete from founder_recovery_archive_deletion_receipts where user_id = ${fixture.userId}`;
      await sql`delete from founder_recovery_archives where user_id = any(${allUserIds})`;
      await sql`delete from founder_release_decisions where user_id = any(${allUserIds})`;
      await sql`delete from runner_credentials where runner_id in (select id from runners where user_id = any(${allUserIds}))`;
      await sql`delete from runners where user_id = any(${allUserIds})`;
      await sql`delete from operator_conversations where operator_id = ${fixture.operatorId}`;
      await sql`delete from operator_calendar_connection_receipts where connection_id in (select id from operator_calendar_connections where operator_id = ${fixture.operatorId})`;
      await sql`delete from operator_calendar_resources where connection_id in (select id from operator_calendar_connections where operator_id = ${fixture.operatorId})`;
      await sql`delete from operator_calendar_connections where operator_id = ${fixture.operatorId}`;
      await sql`delete from operator_runtimes where operator_id = ${fixture.operatorId}`;
      await sql`delete from operator_preparations where operator_id = ${fixture.operatorId}`;
      await sql`delete from operators where id = ${fixture.operatorId}`;
      await sql`delete from users where id = ${fixture.userId}`;
      await sql`delete from operator_runtimes where operator_id in (${fixture.externalBetaOwnerOperatorId}, ${fixture.externalBetaParticipantOperatorId})`;
      await sql`delete from operator_preparations where operator_id in (${fixture.externalBetaOwnerOperatorId}, ${fixture.externalBetaParticipantOperatorId})`;
      await sql`delete from operators where id in (${fixture.externalBetaOwnerOperatorId}, ${fixture.externalBetaParticipantOperatorId})`;
      await sql`delete from users where id in (${fixture.externalBetaOwnerUserId}, ${fixture.externalBetaParticipantUserId})`;
      await sql`delete from app_metadata where key = 'founder_owner_preview_owner_user_id:v1' and value = any(${allUserIds})`;
      const [remaining] = await sql<
        {
          revocations: number;
          backup_expiries: number;
          requests: number;
          calendar_connections: number;
          users: number;
        }[]
      >`select
        (select count(*)::int from operator_deletion_revocations where operator_id = ${fixture.operatorId}) as revocations,
        (select count(*)::int from operator_deletion_backup_expiries where operator_id = ${fixture.operatorId}) as backup_expiries,
        (select count(*)::int from operator_deletion_requests where operator_id = ${fixture.operatorId}) as requests,
        (select count(*)::int from operator_calendar_connections where operator_id = ${fixture.operatorId}) as calendar_connections,
        (select count(*)::int from users where id = any(${allUserIds})) as users`;
      if (!remaining || Object.values(remaining).some((count) => count !== 0)) {
        throw new Error("Founder Product Contract fixture cleanup left scoped database rows.");
      }
    });
  });
}

function assertFounderProductContractCleanupBoundary(): void {
  const databaseUrl = process.env.DATABASE_URL;
  const parsed = databaseUrl ? new URL(databaseUrl) : null;
  if (
    process.env.BRUNO_AUTH_MODE !== "development" ||
    process.env.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE !== "deterministic" ||
    !process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ||
    !parsed ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("Founder Product Contract cleanup is restricted to a loopback test database.");
  }
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
        recovered_identities: number;
        identity_receipts: number;
        used_identity_credentials: number;
        account_closures: number;
        account_closure_receipts: number;
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
      (select external_action_pause from operators where id = ${fixture.operatorId}) as paused,
      (select count(*)::int from founder_identity_recoveries where user_id = ${fixture.userId} and status = 'recovered' and recovered_at is not null) as recovered_identities,
      (select count(*)::int from founder_identity_recovery_receipts where user_id = ${fixture.userId}) as identity_receipts,
      (select count(*)::int from founder_identity_recovery_credentials where user_id = ${fixture.userId} and used_at is not null) as used_identity_credentials,
      (select count(*)::int from operator_deletion_requests where operator_id = ${fixture.operatorId} and kind = 'account_closure') as account_closures,
      (select count(*)::int from operator_deletion_receipts where operator_id = ${fixture.operatorId} and stage in ('requested', 'access_stopped')) as account_closure_receipts`;
    expect(authority).toMatchObject({
      release_decisions: 3,
      release_decision_outcomes: ["enter", "hold", "resume"],
      scenario_executions: 7,
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
      recovered_identities: 1,
      identity_receipts: 3,
      used_identity_credentials: 1,
      account_closures: 1,
      account_closure_receipts: 2,
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
