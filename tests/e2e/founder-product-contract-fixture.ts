import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import { FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS } from "@/src/shared/founder-product-contract";
import type { FounderProductContractClock } from "@/src/testing/founder-product-contract";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_365;

export function founderProductContractQualificationCohorts(runId: string): string[] {
  const baseCohort = `external-beta-contract:${runId}`;
  return [
    baseCohort,
    ...FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS.map((project) => `${baseCohort}:${project}`),
  ];
}

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
  restorationSuccessUserId: string;
  restorationSuccessOperatorId: string;
  restorationSuccessSourceEventId: string;
  restorationPartialFailureUserId: string;
  restorationPartialFailureSourceEventId: string;
  restorationDeletedArchiveUserId: string;
  restorationDeletedArchiveSourceEventId: string;
  restorationExpiredArchiveUserId: string;
  restorationExpiredArchiveSourceEventId: string;
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
  const runtimeRevision = founderProductContractRuntimeRevision();
  const sourceRevision = requiredContractEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION");
  const releaseDecisionId = randomUUID();
  const userId = randomUUID();
  const operatorId = randomUUID();
  const preparationId = randomUUID();
  const runtimeId = randomUUID();
  const runnerId = randomUUID();
  const credentialId = randomUUID();
  const aiConnectionId = randomUUID();
  const calendarConnectionId = randomUUID();
  const mailConnectionId = randomUUID();
  const expiredArchiveId = randomUUID();
  const checkoutCorrelation = `${randomUUID()}.${randomUUID()}`;
  const externalBetaOwnerUserId = randomUUID();
  const externalBetaOwnerOperatorId = randomUUID();
  const externalBetaParticipantUserId = randomUUID();
  const externalBetaParticipantOperatorId = randomUUID();
  const externalBetaParticipantRunnerId = randomUUID();
  const restorationBranches = ["success", "partial", "deleted", "expired"].map((kind) => ({
    kind,
    userId: randomUUID(),
    operatorId: randomUUID(),
    preparationId: randomUUID(),
    runtimeId: randomUUID(),
    runnerId: randomUUID(),
    credentialId: randomUUID(),
    oldCorrelationId: randomUUID(),
    oldEventId: randomUUID(),
    freshCorrelationId: randomUUID(),
    freshEventId: randomUUID(),
  }));
  const createdAt = clock.now().toISOString();
  const readyAt = clock.advance(1_000).toISOString();
  const expiredArchiveObservedAt = new Date(clock.now().valueOf() - 31 * 24 * 60 * 60 * 1_000);
  const expiredArchiveExpiresAt = new Date(clock.now().valueOf() - 24 * 60 * 60 * 1_000);

  await withFounderProductContractDatabase(async (sql) => {
    await sql`delete from founder_release_decisions where stage = 'initial_general_release'`;
    await sql`insert into founder_release_decisions (id, stage, outcome, application_revision, runtime_revision, capability_manifest, affected_capabilities, evidence_digests, authority_expires_at, decided_at, created_at) values (${releaseDecisionId}, 'initial_general_release', 'enter', ${sourceRevision}, ${runtimeRevision}, ${sql.json(["openai", "anthropic", "calendar_reading", "gmail_reading", "gmail_sending"])}, ${sql.json([])}, ${sql.json(Array.from({ length: 12 }, (_, index) => `sha256:${index.toString(16).repeat(64)}`))}, ${new Date(clock.now().valueOf() + 8 * 24 * 60 * 60 * 1_000).toISOString()}, ${createdAt}, ${createdAt})`;
    await sql`insert into users (id, created_at, updated_at) values (${userId}, ${createdAt}, ${readyAt})`;
    await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${operatorId}, ${userId}, 'active', ${createdAt}, ${readyAt})`;
    await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${preparationId}, ${operatorId}, 'ready', 'Asia/Manila', ${createdAt}, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${runtimeId}, ${operatorId}, 'ready', 'connected', 'verified', ${runtimeRevision}, 'founder-contract-runtime', 1, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into runners (id, user_id, name, kind, endpoint_url, status, provider, provider_resource_id, provider_firewall_id, region, size_slug, image, provisioning_status, provisioning_operation_key, provisioning_started_at, provisioning_completed_at, created_at, updated_at) values (${runnerId}, ${userId}, ${`founder-${runnerId}`}, 'digitalocean', 'https://203.0.113.10', 'online', 'digitalocean', ${`droplet-${runnerId}`}, ${`firewall-${runnerId}`}, 'sfo3', 's-1vcpu-1gb', 'ubuntu-24-04-x64', 'ready', ${`bruno-deploy-${runnerId.replaceAll("-", "")}`}, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into runner_credentials (id, runner_id, credential_hash, credential_prefix, status, created_at, updated_at) values (${credentialId}, ${runnerId}, ${`sha256:${runnerId.replaceAll("-", "")}`}, 'fpct', 'active', ${createdAt}, ${readyAt})`;
    await sql`insert into runner_provisioning_events (runner_id, phase, status, message, metadata, created_at) values (${runnerId}, 'creating', 'completed', 'Provider creation confirmed.', ${sql.json({ providerCreatedAt: readyAt })}, ${readyAt})`;
    await sql`insert into operator_ai_connections (id, operator_id, provider, provider_subject_id, account_label, status, authorization_state, capacity_state, inference_state, eligible_account, authorization_persisted, approved_model_assignment, authorized_at, last_verified_at, created_at, updated_at) values (${aiConnectionId}, ${operatorId}, 'openai', ${`openai-${userId}`}, 'Founder OpenAI', 'ready', 'authorized', 'available', 'passed', true, true, 'openai-codex', ${readyAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into operator_calendar_connections (id, operator_id, provider, provider_subject_id, account_label, status, authorization_state, access_token_ciphertext, access_token_iv, access_token_auth_tag, refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag, secret_key_version, granted_scopes, authorized_at, last_verified_at, last_evidence_at, last_evidence_count, evidence_state, created_at, updated_at) values (${calendarConnectionId}, ${operatorId}, 'google_calendar', ${`google-${userId}`}, 'founder@example.com', 'ready', 'authorized', 'a', 'b', 'c', 'd', 'e', 'f', 'test-v1', ${sql.json(["calendar.readonly"])}, ${readyAt}, ${readyAt}, ${readyAt}, 1, 'current', ${createdAt}, ${readyAt})`;
    await sql`insert into operator_mail_connections (id, operator_id, provider, provider_subject_id, account_label, status, authorization_state, access_token_ciphertext, access_token_iv, access_token_auth_tag, refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag, secret_key_version, granted_scopes, authorized_at, last_verified_at, last_evidence_at, last_evidence_count, evidence_state, suite_status, created_at, updated_at) values (${mailConnectionId}, ${operatorId}, 'google_gmail', ${`google-${userId}`}, 'founder@example.com', 'ready', 'authorized', 'a', 'b', 'c', 'd', 'e', 'f', 'test-v1', ${sql.json(["gmail.readonly"])}, ${readyAt}, ${readyAt}, ${readyAt}, 1, 'current', 'matched', ${createdAt}, ${readyAt})`;
    await sql`insert into operator_primary_communications_suites (operator_id, calendar_connection_id, mail_connection_id, provider_subject_id, status, created_at, updated_at) values (${operatorId}, ${calendarConnectionId}, ${mailConnectionId}, ${`google-${userId}`}, 'active', ${createdAt}, ${readyAt})`;
    await sql`insert into founder_checkout_correlations (user_id, correlation_digest, status, created_at, expires_at) values (${userId}, ${`sha256:${createHash("sha256").update(checkoutCorrelation).digest("hex")}`}, 'pending', ${createdAt}, ${new Date(clock.now().valueOf() + 60 * 60 * 1_000).toISOString()})`;
    await sql`insert into founder_recovery_archives (id, user_id, operator_id, status, format_version, storage_object_key, recovery_credential_object_key, ciphertext_digest, recovery_credential_digest, state_digest, restorable_verified, restore_verified_at, failure_code, observed_at, expires_at, created_at, deleted_at) values (${expiredArchiveId}, ${userId}, ${operatorId}, 'verified', 1, ${`founder-recovery/expired/${expiredArchiveId}.age`}, ${`founder-recovery/expired/${expiredArchiveId}.key`}, ${`sha256:${createHash("sha256").update(`expired:${userId}`).digest("hex")}`}, ${`sha256:${createHash("sha256").update(`expired-credential:${userId}`).digest("hex")}`}, ${`sha256:${createHash("sha256").update(`expired-state:${userId}`).digest("hex")}`}, true, ${expiredArchiveObservedAt.toISOString()}, null, ${expiredArchiveObservedAt.toISOString()}, ${expiredArchiveExpiresAt.toISOString()}, ${expiredArchiveObservedAt.toISOString()}, null)`;
    for (const branch of restorationBranches) {
      const oldSubscriptionId = `restoration-${branch.kind}-old-subscription`;
      const oldOrderId = `restoration-${branch.kind}-old-order`;
      const freshSubscriptionId = `restoration-${branch.kind}-fresh-subscription`;
      const freshOrderId = `restoration-${branch.kind}-fresh-order`;
      const dueAt = new Date(clock.now().valueOf() - 1).toISOString();
      const checkoutExpiry = new Date(clock.now().valueOf() + 60 * 60 * 1_000).toISOString();
      await sql`insert into users (id, created_at, updated_at) values (${branch.userId}, ${createdAt}, ${readyAt})`;
      await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${branch.operatorId}, ${branch.userId}, 'active', ${createdAt}, ${readyAt})`;
      await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${branch.preparationId}, ${branch.operatorId}, 'ready', 'Asia/Manila', ${createdAt}, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
      await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${branch.runtimeId}, ${branch.operatorId}, 'ready', 'connected', 'verified', ${runtimeRevision}, ${`restoration-old-runtime-${branch.kind}`}, 1, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
      await sql`insert into runners (id, user_id, name, kind, endpoint_url, status, provider, provider_resource_id, provider_firewall_id, region, size_slug, image, provisioning_status, provisioning_operation_key, provisioning_started_at, provisioning_completed_at, created_at, updated_at) values (${branch.runnerId}, ${branch.userId}, ${`restoration-${branch.kind}-${branch.runnerId}`}, 'digitalocean', ${`https://203.0.113.${30 + restorationBranches.indexOf(branch)}`}, 'online', 'digitalocean', ${`restoration-old-droplet-${branch.kind}`}, ${`restoration-old-firewall-${branch.kind}`}, 'sfo3', 's-1vcpu-1gb', 'ubuntu-24-04-x64', 'ready', ${`bruno-deploy-${branch.runnerId.replaceAll("-", "")}`}, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
      await sql`insert into runner_credentials (id, runner_id, credential_hash, credential_prefix, status, created_at, updated_at) values (${branch.credentialId}, ${branch.runnerId}, ${`sha256:${branch.runnerId.replaceAll("-", "")}`}, 'fpct', 'active', ${createdAt}, ${readyAt})`;
      await sql`insert into founder_checkout_correlations (id, user_id, correlation_digest, generation, status, provider_subscription_id, provider_order_id, payment_detected_at, reconciliation_due_at, consumed_at, created_at, expires_at) values (${branch.oldCorrelationId}, ${branch.userId}, ${`sha256:${createHash("sha256").update(`old:${branch.userId}`).digest("hex")}`}, 1, 'consumed', ${oldSubscriptionId}, ${oldOrderId}, ${createdAt}, ${new Date(new Date(createdAt).valueOf() + 60 * 60 * 1_000).toISOString()}, ${createdAt}, ${createdAt}, ${checkoutExpiry})`;
      await sql`insert into founder_commerce_events (id, provider_event_id, user_id, checkout_correlation_id, provider_subscription_id, provider_order_id, event_type, payload_digest, signature_verified, occurred_at, recorded_at, application_status, last_attempt_at, applied_at) values (${branch.oldEventId}, ${`restoration-${branch.kind}-old-event`}, ${branch.userId}, ${branch.oldCorrelationId}, ${oldSubscriptionId}, ${oldOrderId}, 'subscription_cancelled', ${`sha256:${createHash("sha256").update(`old-event:${branch.userId}`).digest("hex")}`}, true, ${createdAt}, ${createdAt}, 'applied', ${createdAt}, ${createdAt})`;
      await sql`insert into founder_product_entitlements (user_id, source_event_id, provider_subscription_id, status, reconciled_provider_status, provider_state_updated_at, reconciled_at, retirement_due_at, updated_at) values (${branch.userId}, ${branch.oldEventId}, ${oldSubscriptionId}, 'cancelled', 'cancelled', ${createdAt}, ${createdAt}, ${dueAt}, ${createdAt})`;
      await sql`insert into founder_checkout_correlations (id, user_id, correlation_digest, generation, status, provider_subscription_id, provider_order_id, payment_detected_at, reconciliation_due_at, consumed_at, created_at, expires_at) values (${branch.freshCorrelationId}, ${branch.userId}, ${`sha256:${createHash("sha256").update(`fresh:${branch.userId}`).digest("hex")}`}, 2, 'consumed', ${freshSubscriptionId}, ${freshOrderId}, ${readyAt}, ${new Date(new Date(readyAt).valueOf() + 60 * 60 * 1_000).toISOString()}, ${readyAt}, ${readyAt}, ${checkoutExpiry})`;
      await sql`insert into founder_commerce_events (id, provider_event_id, user_id, checkout_correlation_id, provider_subscription_id, provider_order_id, event_type, payload_digest, signature_verified, occurred_at, recorded_at, application_status) values (${branch.freshEventId}, ${`restoration-${branch.kind}-fresh-event`}, ${branch.userId}, ${branch.freshCorrelationId}, ${freshSubscriptionId}, ${freshOrderId}, 'subscription_active', ${`sha256:${createHash("sha256").update(`fresh-event:${branch.userId}`).digest("hex")}`}, true, ${readyAt}, ${readyAt}, 'pending')`;
    }
  });

  const [success, partial, deleted, expired] = restorationBranches;
  if (!success || !partial || !deleted || !expired) {
    throw new Error("Restoration fixtures were not created.");
  }

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
    restorationSuccessUserId: success.userId,
    restorationSuccessOperatorId: success.operatorId,
    restorationSuccessSourceEventId: success.freshEventId,
    restorationPartialFailureUserId: partial.userId,
    restorationPartialFailureSourceEventId: partial.freshEventId,
    restorationDeletedArchiveUserId: deleted.userId,
    restorationDeletedArchiveSourceEventId: deleted.freshEventId,
    restorationExpiredArchiveUserId: expired.userId,
    restorationExpiredArchiveSourceEventId: expired.freshEventId,
  };
}

export async function prepareFounderExternalBetaContractFixture(
  fixture: FounderProductContractFixture,
  input: { runId: string; applicationRevision: string; now: Date },
): Promise<void> {
  const runtimeRevision = founderProductContractRuntimeRevision();
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
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${ownerRuntimeId}, ${fixture.externalBetaOwnerOperatorId}, 'ready', 'connected', 'verified', ${runtimeRevision}, ${`external-beta-owner:${input.runId}`}, 1, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;

    await sql`insert into users (id, clerk_user_id, created_at, updated_at) values (${fixture.externalBetaParticipantUserId}, ${`clerk:${fixture.externalBetaParticipantUserId}`}, ${createdAt}, ${createdAt})`;
    await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${fixture.externalBetaParticipantOperatorId}, ${fixture.externalBetaParticipantUserId}, 'active', ${createdAt}, ${createdAt})`;
    await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${participantPreparationId}, ${fixture.externalBetaParticipantOperatorId}, 'ready', 'Asia/Manila', ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${participantRuntimeId}, ${fixture.externalBetaParticipantOperatorId}, 'ready', 'connected', 'verified', ${runtimeRevision}, ${`external-beta-participant:${input.runId}`}, 1, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;
    await sql`insert into runners (id, user_id, name, kind, status, provider, provider_resource_id, provider_firewall_id, region, size_slug, image, provisioning_status, provisioning_operation_key, provisioning_started_at, provisioning_completed_at, created_at, updated_at) values (${fixture.externalBetaParticipantRunnerId}, ${fixture.externalBetaParticipantUserId}, ${`external-beta-${fixture.externalBetaParticipantRunnerId}`}, 'digitalocean', 'online', 'digitalocean', ${`droplet-${fixture.externalBetaParticipantRunnerId}`}, ${`firewall-${fixture.externalBetaParticipantRunnerId}`}, 'sfo3', 's-1vcpu-1gb', 'ubuntu-24-04-x64', 'ready', ${`bruno-deploy-${fixture.externalBetaParticipantRunnerId.replaceAll("-", "")}`}, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;
    await sql`insert into runner_credentials (id, runner_id, credential_hash, credential_prefix, status, created_at, updated_at) values (${participantCredentialId}, ${fixture.externalBetaParticipantRunnerId}, ${`sha256:${fixture.externalBetaParticipantRunnerId.replaceAll("-", "")}`}, 'fpct', 'active', ${createdAt}, ${createdAt})`;

    await sql`insert into app_metadata (key, value) values ('founder_owner_preview_owner_user_id:v1', ${fixture.externalBetaOwnerUserId}) on conflict (key) do update set value = excluded.value, updated_at = ${createdAt}`;
    await sql`delete from founder_preview_qualifications where cohort = ${cohort}`;
    for (const [index, capability] of capabilities.entries()) {
      await sql`insert into founder_preview_qualifications (stage, cohort, capability, application_revision, runtime_revision, evidence_digest, observed_at, expires_at, created_at) values ('external_beta', ${cohort}, ${capability}, ${input.applicationRevision}, ${runtimeRevision}, ${`sha256:${(500 + index).toString(16).padStart(64, "0")}`}, ${createdAt}, ${expiresAt}, ${createdAt})`;
    }
    await sql`insert into founder_release_decisions (user_id, operator_id, stage, outcome, application_revision, runtime_revision, capability_manifest, external_beta_cohort, evidence_digests, decided_at, created_at) values (${fixture.externalBetaOwnerUserId}, ${fixture.externalBetaOwnerOperatorId}, 'external_beta', 'enter', ${input.applicationRevision}, ${runtimeRevision}, ${sql.json(capabilities)}, ${cohort}, ${sql.json([`sha256:${"f".repeat(64)}`])}, ${createdAt}, ${createdAt})`;
  });
}

export async function prepareFounderExternalBetaBrowserFixture(
  fixture: FounderProductContractFixture,
  input: { runId: string; applicationRevision: string; now: Date },
): Promise<{ accessExpiresAt: string; retirementDueAt: string }> {
  const runtimeRevision = founderProductContractRuntimeRevision();
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
    >`insert into founder_release_decisions (user_id, operator_id, stage, outcome, application_revision, runtime_revision, capability_manifest, external_beta_cohort, evidence_digests, decided_at, created_at) values (${fixture.userId}, ${fixture.operatorId}, 'external_beta', 'enter', ${input.applicationRevision}, ${runtimeRevision}, ${sql.json(capabilities)}, ${cohort}, ${sql.json([`sha256:${"e".repeat(64)}`])}, ${admittedAt}, ${admittedAt}) returning id`;
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
  input: { runId: string; providerRunId: string; now: Date },
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
    >`insert into founder_commerce_events (provider_event_id, user_id, checkout_correlation_id, provider_subscription_id, provider_order_id, event_type, payload_digest, signature_verified, occurred_at, recorded_at, application_status, last_attempt_at, applied_at) values (${`browser:${input.runId}:subscription-active`}, ${fixture.userId}, ${correlation.id}, ${`${input.providerRunId}:subscription`}, ${`order-${input.providerRunId}:subscription`}, 'subscription_active', ${digest(`browser-commerce:${input.runId}`)}, true, ${occurredAt}, ${occurredAt}, 'applied', ${occurredAt}, ${occurredAt}) returning id`;
    if (!event) throw new Error("Browser commerce event was not persisted.");
    await sql`update founder_checkout_correlations set status = 'consumed', provider_subscription_id = ${`${input.providerRunId}:subscription`}, provider_order_id = ${`order-${input.providerRunId}:subscription`}, consumed_at = ${occurredAt}, payment_detected_at = ${occurredAt}, reconciliation_due_at = ${new Date(input.now.valueOf() + 60 * 60 * 1_000).toISOString()} where id = ${correlation.id} and status = 'pending'`;
    await sql`insert into founder_product_entitlements (user_id, source_event_id, provider_subscription_id, status, reconciled_provider_status, provider_state_updated_at, reconciled_at, updated_at) values (${fixture.userId}, ${event.id}, ${`${input.providerRunId}:subscription`}, 'verified', 'active', ${occurredAt}, ${occurredAt}, ${occurredAt})`;
  });
  await prepareFounderRevocableConnections(fixture, {
    runId: input.providerRunId,
    now: input.now,
  });
}

export async function prepareFounderRevocableConnections(
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
  const mailAccess = encryptFounderContractConnectionSecret(
    `founder-contract-google:${input.runId}:${fixture.userId}:mail:access`,
    "google-mail-access",
  );
  const mailRefresh = encryptFounderContractConnectionSecret(
    `founder-contract-google:${input.runId}:${fixture.userId}:mail:refresh`,
    "google-mail-refresh",
  );
  const connectionId = randomUUID();
  const at = input.now.toISOString();
  await withFounderProductContractDatabase(async (sql) => {
    await sql`insert into operator_calendar_connections (id, operator_id, provider, provider_subject_id, account_label, status, authorization_state, access_token_ciphertext, access_token_iv, access_token_auth_tag, refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag, secret_key_version, authorized_at, last_verified_at, last_evidence_at, last_evidence_count, evidence_state, created_at, updated_at) values (${connectionId}, ${fixture.operatorId}, 'google_calendar', ${`google-${fixture.userId}`}, 'founder@example.com', 'ready', 'authorized', ${access.ciphertext}, ${access.iv}, ${access.authTag}, ${refresh.ciphertext}, ${refresh.iv}, ${refresh.authTag}, ${access.keyVersion}, ${at}, ${at}, ${at}, 0, 'current', ${at}, ${at}) on conflict (operator_id, provider) do update set status = excluded.status, authorization_state = excluded.authorization_state, access_token_ciphertext = excluded.access_token_ciphertext, access_token_iv = excluded.access_token_iv, access_token_auth_tag = excluded.access_token_auth_tag, refresh_token_ciphertext = excluded.refresh_token_ciphertext, refresh_token_iv = excluded.refresh_token_iv, refresh_token_auth_tag = excluded.refresh_token_auth_tag, secret_key_version = excluded.secret_key_version, authorized_at = excluded.authorized_at, last_verified_at = excluded.last_verified_at, last_evidence_at = excluded.last_evidence_at, last_evidence_count = excluded.last_evidence_count, evidence_state = excluded.evidence_state, disconnected_at = null, failure_code = null, recovery_message = null, updated_at = excluded.updated_at`;
    await sql`update operator_mail_connections set status = 'ready', authorization_state = 'authorized', access_token_ciphertext = ${mailAccess.ciphertext}, access_token_iv = ${mailAccess.iv}, access_token_auth_tag = ${mailAccess.authTag}, refresh_token_ciphertext = ${mailRefresh.ciphertext}, refresh_token_iv = ${mailRefresh.iv}, refresh_token_auth_tag = ${mailRefresh.authTag}, secret_key_version = ${mailAccess.keyVersion}, authorized_at = ${at}, last_verified_at = ${at}, last_evidence_at = ${at}, last_evidence_count = 0, evidence_state = 'current', disconnected_at = null, failure_code = null, recovery_message = null, updated_at = ${at} where operator_id = ${fixture.operatorId} and provider = 'google_gmail'`;
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
  await withFounderProductContractDatabase(async (sql) => {
    const allUserIds = [
      fixture.userId,
      fixture.externalBetaOwnerUserId,
      fixture.externalBetaParticipantUserId,
      fixture.restorationSuccessUserId,
      fixture.restorationPartialFailureUserId,
      fixture.restorationDeletedArchiveUserId,
      fixture.restorationExpiredArchiveUserId,
    ];
    const operatorRows = await sql<
      { id: string }[]
    >`select id from operators where user_id = any(${allUserIds})`;
    const allOperatorIds = operatorRows.map(({ id }) => id);
    const aiConnectionRows = await sql<
      { id: string }[]
    >`select id from operator_ai_connections where operator_id = any(${allOperatorIds})`;
    const aiConnectionIds = aiConnectionRows.map(({ id }) => id);
    const calendarConnectionRows = await sql<
      { id: string }[]
    >`select id from operator_calendar_connections where operator_id = any(${allOperatorIds})`;
    const calendarConnectionIds = calendarConnectionRows.map(({ id }) => id);
    const mailConnectionRows = await sql<
      { id: string }[]
    >`select id from operator_mail_connections where operator_id = any(${allOperatorIds})`;
    const mailConnectionIds = mailConnectionRows.map(({ id }) => id);
    const mailSendingConnectionRows = await sql<
      { id: string }[]
    >`select id from operator_mail_sending_connections where operator_id = any(${allOperatorIds})`;
    const mailSendingConnectionIds = mailSendingConnectionRows.map(({ id }) => id);
    const runnerRows = await sql<
      { id: string }[]
    >`select id from runners where user_id = any(${allUserIds})`;
    const runnerIds = runnerRows.map(({ id }) => id);
    const contractRunId = requiredContractEnvironment("BRUNO_FOUNDER_CONTRACT_RUN_ID");
    const contractCohorts = founderProductContractQualificationCohorts(contractRunId);
    await sql`delete from founder_preview_qualifications where cohort = any(${contractCohorts})`;
    if (!options.retainScenarioExecutions) {
      await sql`delete from founder_product_contract_scenario_executions where user_id = ${fixture.userId}`;
    }
    await sql`delete from founder_identity_recovery_receipts where user_id = any(${allUserIds})`;
    await sql`delete from founder_identity_recoveries where user_id = any(${allUserIds})`;
    await sql`delete from founder_identity_recovery_credentials where user_id = any(${allUserIds})`;
    await sql`delete from operator_deletion_receipts where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_deletion_commerce_cancellations where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_deletion_revocations where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_deletion_backup_expiries where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_deletion_tombstones where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_deletion_requests where operator_id = any(${allOperatorIds})`;
    await sql`delete from founder_operator_restorations where user_id = any(${allUserIds})`;
    await sql`delete from founder_external_beta_recordings where participant_user_id = any(${allUserIds})`;
    await sql`delete from founder_external_beta_measurements where participant_user_id = any(${allUserIds})`;
    await sql`delete from founder_external_beta_consent_receipts where participant_user_id = any(${allUserIds})`;
    await sql`delete from founder_external_beta_invitations where cohort_owner_user_id = ${fixture.externalBetaOwnerUserId} or participant_user_id = any(${[fixture.userId, fixture.externalBetaParticipantUserId]})`;
    await sql`delete from founder_general_release_activations where user_id = any(${allUserIds})`;
    await sql`delete from founder_product_entitlements where user_id = any(${allUserIds})`;
    await sql.begin(async (transaction) => {
      await transaction`alter table founder_commerce_lifecycle_receipts disable trigger founder_commerce_lifecycle_receipts_immutable_delete`;
      await transaction`delete from founder_commerce_lifecycle_receipts where user_id = any(${allUserIds})`;
      await transaction`alter table founder_commerce_lifecycle_receipts enable trigger founder_commerce_lifecycle_receipts_immutable_delete`;
    });
    await sql`delete from founder_infrastructure_retirements where user_id = any(${allUserIds})`;
    await sql`delete from founder_commerce_events where user_id = any(${allUserIds})`;
    await sql`delete from founder_checkout_correlations where user_id = any(${allUserIds})`;
    await sql`delete from founder_recovery_archive_deletion_receipts where user_id = any(${allUserIds})`;
    await sql`delete from founder_recovery_archives where user_id = any(${allUserIds})`;
    await sql`delete from founder_release_decisions where user_id = any(${allUserIds})`;
    await sql`delete from runner_credentials where runner_id in (select id from runners where user_id = any(${allUserIds}))`;
    await sql`delete from runner_provisioning_events where runner_id in (select id from runners where user_id = any(${allUserIds}))`;
    await sql`delete from runners where user_id = any(${allUserIds})`;
    await sql`delete from operator_conversation_messages where conversation_id in (select id from operator_conversations where operator_id in (select id from operators where user_id = any(${allUserIds})))`;
    await sql`delete from operator_conversations where operator_id in (select id from operators where user_id = any(${allUserIds}))`;
    await sql.begin(async (transaction) => {
      await transaction`alter table operator_founder_activations disable trigger operator_founder_activations_immutable_delete`;
      await transaction`alter table operator_governance_receipts disable trigger operator_governance_receipts_immutable_delete`;
      await transaction`alter table operator_ai_connection_receipts disable trigger operator_ai_connection_receipts_immutable_delete`;
      await transaction`alter table operator_calendar_connection_receipts disable trigger operator_calendar_connection_receipts_immutable_delete`;
      await transaction`alter table operator_mail_connection_receipts disable trigger operator_mail_connection_receipts_immutable_delete`;
      await transaction`delete from operator_founder_activations where operator_id = any(${allOperatorIds})`;
      await transaction`delete from operator_governance_receipts where operator_id = any(${allOperatorIds})`;
      await transaction`delete from operator_ai_connection_receipts where connection_id = any(${aiConnectionIds})`;
      await transaction`delete from operator_calendar_connection_receipts where connection_id = any(${calendarConnectionIds})`;
      await transaction`delete from operator_mail_connection_receipts where connection_id = any(${mailConnectionIds})`;
      await transaction`alter table operator_founder_activations enable trigger operator_founder_activations_immutable_delete`;
      await transaction`alter table operator_governance_receipts enable trigger operator_governance_receipts_immutable_delete`;
      await transaction`alter table operator_ai_connection_receipts enable trigger operator_ai_connection_receipts_immutable_delete`;
      await transaction`alter table operator_calendar_connection_receipts enable trigger operator_calendar_connection_receipts_immutable_delete`;
      await transaction`alter table operator_mail_connection_receipts enable trigger operator_mail_connection_receipts_immutable_delete`;
    });
    await sql`delete from operator_action_receipts where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_mail_sending_connection_receipts where connection_id = any(${mailSendingConnectionIds})`;
    await sql`delete from operator_mail_sending_connections where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_morning_brief_items where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_morning_briefs where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_limited_operations where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_processing_consents where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_authority_policies where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_primary_communications_suites where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_relationship_evidence where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_relationship_corrections where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_relationship_candidates where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_relationship_records where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_founder_data_exports where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_mail_resources where connection_id = any(${mailConnectionIds})`;
    await sql`delete from operator_calendar_resources where connection_id = any(${calendarConnectionIds})`;
    await sql`delete from operator_mail_connections where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_calendar_connections where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_ai_connections where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_runtimes where operator_id = any(${allOperatorIds})`;
    await sql`delete from operator_preparations where operator_id = any(${allOperatorIds})`;
    await sql`delete from operators where user_id = any(${allUserIds})`;
    await sql`delete from users where id = any(${allUserIds})`;
    await sql`delete from app_metadata where key = 'founder_owner_preview_owner_user_id:v1' and value = any(${allUserIds})`;

    const remainingRows = await sql<
      { relation: string; remaining: number }[]
    >`select relation, remaining from (
      select 'operator_ai_connection_receipts' as relation, count(*)::integer as remaining from operator_ai_connection_receipts where connection_id = any(${aiConnectionIds})
      union all select 'operator_calendar_connection_receipts', count(*)::integer from operator_calendar_connection_receipts where connection_id = any(${calendarConnectionIds})
      union all select 'operator_mail_connection_receipts', count(*)::integer from operator_mail_connection_receipts where connection_id = any(${mailConnectionIds})
      union all select 'operator_mail_sending_connection_receipts', count(*)::integer from operator_mail_sending_connection_receipts where connection_id = any(${mailSendingConnectionIds})
      union all select 'operator_action_receipts', count(*)::integer from operator_action_receipts where operator_id = any(${allOperatorIds})
      union all select 'operator_founder_activations', count(*)::integer from operator_founder_activations where operator_id = any(${allOperatorIds})
      union all select 'operator_governance_receipts', count(*)::integer from operator_governance_receipts where operator_id = any(${allOperatorIds})
      union all select 'operator_limited_operations', count(*)::integer from operator_limited_operations where operator_id = any(${allOperatorIds})
      union all select 'operator_processing_consents', count(*)::integer from operator_processing_consents where operator_id = any(${allOperatorIds})
      union all select 'operator_authority_policies', count(*)::integer from operator_authority_policies where operator_id = any(${allOperatorIds})
      union all select 'operator_primary_communications_suites', count(*)::integer from operator_primary_communications_suites where operator_id = any(${allOperatorIds})
      union all select 'operator_morning_briefs', count(*)::integer from operator_morning_briefs where operator_id = any(${allOperatorIds})
      union all select 'operator_morning_brief_items', count(*)::integer from operator_morning_brief_items where operator_id = any(${allOperatorIds})
      union all select 'operator_relationship_evidence', count(*)::integer from operator_relationship_evidence where operator_id = any(${allOperatorIds})
      union all select 'operator_relationship_corrections', count(*)::integer from operator_relationship_corrections where operator_id = any(${allOperatorIds})
      union all select 'operator_relationship_candidates', count(*)::integer from operator_relationship_candidates where operator_id = any(${allOperatorIds})
      union all select 'operator_relationship_records', count(*)::integer from operator_relationship_records where operator_id = any(${allOperatorIds})
      union all select 'operator_founder_data_exports', count(*)::integer from operator_founder_data_exports where operator_id = any(${allOperatorIds})
      union all select 'operator_calendar_resources', count(*)::integer from operator_calendar_resources where connection_id = any(${calendarConnectionIds})
      union all select 'operator_mail_resources', count(*)::integer from operator_mail_resources where connection_id = any(${mailConnectionIds})
      union all select 'operator_ai_connections', count(*)::integer from operator_ai_connections where id = any(${aiConnectionIds})
      union all select 'operator_calendar_connections', count(*)::integer from operator_calendar_connections where id = any(${calendarConnectionIds})
      union all select 'operator_mail_connections', count(*)::integer from operator_mail_connections where id = any(${mailConnectionIds})
      union all select 'operator_mail_sending_connections', count(*)::integer from operator_mail_sending_connections where id = any(${mailSendingConnectionIds})
      union all select 'operator_runtimes', count(*)::integer from operator_runtimes where operator_id = any(${allOperatorIds})
      union all select 'operator_preparations', count(*)::integer from operator_preparations where operator_id = any(${allOperatorIds})
      union all select 'runner_credentials', count(*)::integer from runner_credentials where runner_id = any(${runnerIds})
      union all select 'runner_provisioning_events', count(*)::integer from runner_provisioning_events where runner_id = any(${runnerIds})
      union all select 'runners', count(*)::integer from runners where id = any(${runnerIds})
      union all select 'founder_operator_restorations', count(*)::integer from founder_operator_restorations where user_id = any(${allUserIds})
      union all select 'founder_identity_recovery_receipts', count(*)::integer from founder_identity_recovery_receipts where user_id = any(${allUserIds})
      union all select 'founder_identity_recoveries', count(*)::integer from founder_identity_recoveries where user_id = any(${allUserIds})
      union all select 'founder_identity_recovery_credentials', count(*)::integer from founder_identity_recovery_credentials where user_id = any(${allUserIds})
      union all select 'operator_deletion_receipts', count(*)::integer from operator_deletion_receipts where operator_id = any(${allOperatorIds})
      union all select 'operator_deletion_commerce_cancellations', count(*)::integer from operator_deletion_commerce_cancellations where operator_id = any(${allOperatorIds})
      union all select 'operator_deletion_revocations', count(*)::integer from operator_deletion_revocations where operator_id = any(${allOperatorIds})
      union all select 'operator_deletion_backup_expiries', count(*)::integer from operator_deletion_backup_expiries where operator_id = any(${allOperatorIds})
      union all select 'operator_deletion_tombstones', count(*)::integer from operator_deletion_tombstones where operator_id = any(${allOperatorIds})
      union all select 'operator_deletion_requests', count(*)::integer from operator_deletion_requests where operator_id = any(${allOperatorIds})
      union all select 'founder_external_beta_recordings', count(*)::integer from founder_external_beta_recordings where participant_user_id = any(${allUserIds})
      union all select 'founder_external_beta_measurements', count(*)::integer from founder_external_beta_measurements where participant_user_id = any(${allUserIds})
      union all select 'founder_external_beta_consent_receipts', count(*)::integer from founder_external_beta_consent_receipts where participant_user_id = any(${allUserIds})
      union all select 'founder_external_beta_invitations', count(*)::integer from founder_external_beta_invitations where cohort_owner_user_id = any(${allUserIds}) or participant_user_id = any(${allUserIds})
      union all select 'founder_preview_qualifications', count(*)::integer from founder_preview_qualifications where cohort = any(${contractCohorts})
      union all select 'founder_general_release_activations', count(*)::integer from founder_general_release_activations where user_id = any(${allUserIds})
      union all select 'founder_product_entitlements', count(*)::integer from founder_product_entitlements where user_id = any(${allUserIds})
      union all select 'founder_commerce_lifecycle_receipts', count(*)::integer from founder_commerce_lifecycle_receipts where user_id = any(${allUserIds})
      union all select 'founder_infrastructure_retirements', count(*)::integer from founder_infrastructure_retirements where user_id = any(${allUserIds})
      union all select 'founder_commerce_events', count(*)::integer from founder_commerce_events where user_id = any(${allUserIds})
      union all select 'founder_checkout_correlations', count(*)::integer from founder_checkout_correlations where user_id = any(${allUserIds})
      union all select 'founder_recovery_archive_deletion_receipts', count(*)::integer from founder_recovery_archive_deletion_receipts where user_id = any(${allUserIds})
      union all select 'founder_recovery_archives', count(*)::integer from founder_recovery_archives where user_id = any(${allUserIds})
      union all select 'founder_release_decisions', count(*)::integer from founder_release_decisions where user_id = any(${allUserIds})
      union all select 'operators', count(*)::integer from operators where id = any(${allOperatorIds})
      union all select 'users', count(*)::integer from users where id = any(${allUserIds})
      union all select 'app_metadata', count(*)::integer from app_metadata where key = 'founder_owner_preview_owner_user_id:v1' and value = any(${allUserIds})
    ) cleanup where remaining <> 0`;
    expect(remainingRows, "Founder Product Contract teardown left fixture-owned rows.").toEqual([]);
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
        completed_restorations: number;
        restored_operator_id: string | null;
        source_operator_id: string | null;
        new_identity_distinct: boolean | null;
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
      (select count(*)::int from founder_release_decisions where user_id = ${fixture.userId} and application_revision = ${process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? "a".repeat(40)} and runtime_revision = ${founderProductContractRuntimeRevision()} and capability_manifest = '["openai", "calendar_reading"]'::jsonb) as safe_release_decisions,
      (select count(*)::int from founder_preview_qualifications where cohort = ${`external-beta-contract:${process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ?? "missing"}`} and application_revision = ${process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? "a".repeat(40)} and runtime_revision = ${founderProductContractRuntimeRevision()}) as external_beta_qualifications,
      (select count(*)::int from founder_recovery_archives where user_id = ${fixture.userId} and status = 'verified' and format_version = 1 and restorable_verified = true and restore_verified_at is not null and state_digest is not null) as archives,
      (select count(*)::int from founder_recovery_archives where user_id = ${fixture.userId} and status = 'failed') as failed_archives,
      (select count(*)::int from founder_recovery_archives where user_id = ${fixture.userId} and status = 'deleted' and deleted_at is not null) as deleted_archives,
      (select count(*)::int from founder_recovery_archive_deletion_receipts where user_id = ${fixture.userId} and status = 'completed' and archive_provider_confirmed = true and recovery_credentials_confirmed = true) as archive_deletions,
      (select count(*)::int from founder_infrastructure_retirements where user_id = ${fixture.userId} and status = 'completed') as retirements,
      (select status from runners where id = ${fixture.runnerId}) as runner_status,
      (select count(*)::int from runner_credentials where runner_id in (select id from runners where user_id = ${fixture.userId}) and status = 'active') as active_credentials,
      (select count(*)::int from runners where user_id = ${fixture.userId} and deleted_at is null) as active_runners,
      (select external_action_pause from operators where id = ${fixture.operatorId}) as paused,
      (select count(*)::int from founder_operator_restorations where user_id = ${fixture.restorationSuccessUserId} and status = 'completed') as completed_restorations,
      (select restored_operator_id from founder_operator_restorations where user_id = ${fixture.restorationSuccessUserId} order by created_at desc limit 1) as restored_operator_id,
      (select source_operator_id from founder_operator_restorations where user_id = ${fixture.restorationSuccessUserId} order by created_at desc limit 1) as source_operator_id,
      (select new_provider_resource_id <> old_provider_resource_id and new_provider_firewall_id <> old_provider_firewall_id and new_runtime_identity <> old_runtime_identity from founder_operator_restorations where user_id = ${fixture.restorationSuccessUserId} order by created_at desc limit 1) as new_identity_distinct,
      (select count(*)::int from founder_identity_recoveries where user_id = ${fixture.userId} and status = 'recovered' and recovered_at is not null) as recovered_identities,
      (select count(*)::int from founder_identity_recovery_receipts where user_id = ${fixture.userId}) as identity_receipts,
      (select count(*)::int from founder_identity_recovery_credentials where user_id = ${fixture.userId} and used_at is not null) as used_identity_credentials,
      (select count(*)::int from operator_deletion_requests where operator_id = ${fixture.operatorId} and kind = 'account_closure') as account_closures,
      (select count(*)::int from operator_deletion_receipts where operator_id = ${fixture.operatorId} and stage in ('requested', 'access_stopped')) as account_closure_receipts`;
    expect(authority).toMatchObject({
      release_decisions: 3,
      release_decision_outcomes: ["enter", "hold", "resume"],
      scenario_executions: 8,
      commerce_events: 3,
      terminal_entitlements: 1,
      consumed_correlations: 1,
      safe_release_decisions: 3,
      external_beta_qualifications: 5,
      archives: 1,
      failed_archives: 1,
      deleted_archives: 1,
      archive_deletions: 1,
      retirements: 1,
      runner_status: "deleted",
      active_credentials: 0,
      active_runners: 0,
      paused: true,
      completed_restorations: 1,
      restored_operator_id: fixture.restorationSuccessOperatorId,
      source_operator_id: fixture.restorationSuccessOperatorId,
      new_identity_distinct: true,
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

function founderProductContractRuntimeRevision(): string {
  const value = process.env.BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION?.trim();
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/.test(value)) {
    throw new Error("BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION is required.");
  }
  return value;
}
