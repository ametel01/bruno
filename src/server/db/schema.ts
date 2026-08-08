import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AgentTemplateSnapshot } from "@/src/server/agents/templates";
import type { BackupManifest, BackupStatus } from "@/src/server/backups/backup-manifest";

export const appMetadata = pgTable("app_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentStatusEnum = pgEnum("agent_status", [
  "idle",
  "starting",
  "running",
  "stopped",
  "restarting",
  "error",
  "deleting",
]);

export const agentDesiredStatusEnum = pgEnum("agent_desired_status", ["stopped", "running"]);

export const agentDeploymentStageEnum = pgEnum("agent_deployment_stage", [
  "pending",
  "provisioning_runner",
  "configuring_hermes",
  "starting_gateway",
  "verifying_model",
  "connecting_telegram",
  "ready",
  "failed",
]);

export const agentDeploymentWakeupStateEnum = pgEnum("agent_deployment_wakeup_state", [
  "pending",
  "publishing",
  "published",
  "claimed",
  "terminal",
  "failed",
]);

export const agentRuntimeReconciliationStateEnum = pgEnum("agent_runtime_reconciliation_state", [
  "observing",
  "recovering_stop",
  "recovering_start",
  "verifying",
  "stopping",
  "stopped",
  "circuit_open",
]);

export const runnerReplacementStateEnum = pgEnum("runner_replacement_state", [
  "pending",
  "provisioning_target",
  "validating_target",
  "fencing_source",
  "reassigning",
  "converging_agents",
  "cleaning_source",
  "complete",
  "failed",
]);

export const runnerReplacementReasonEnum = pgEnum("runner_replacement_reason", [
  "release_mismatch",
  "boot_failure",
  "provider_resource_missing",
  "stale_heartbeat",
  "endpoint_failure",
  "gateway_deadline",
]);

export const runnerReplacementTerminalCodeEnum = pgEnum("runner_replacement_terminal_code", [
  "replacement_budget_exhausted",
  "target_provisioning_failed",
  "target_validation_failed",
  "source_fence_failed",
  "reassignment_failed",
  "agent_convergence_failed",
  "source_cleanup_failed",
  "state_invalid",
]);

export const hermesStagingAcceptanceDesiredOutcomeEnum = pgEnum(
  "hermes_staging_acceptance_desired_outcome",
  ["acceptance", "cleanup"],
);

export const hermesStagingAcceptancePhaseEnum = pgEnum("hermes_staging_acceptance_phase", [
  "preflight",
  "attesting_image",
  "creating_ready_agent",
  "observing_deployment",
  "verifying_host_image",
  "awaiting_initial_human_proof",
  "restarting",
  "reverifying_runtime",
  "awaiting_post_restart_human_proof",
  "auditing_diagnostics",
  "stopping_agent",
  "observing_stop_stability",
  "checking_rollback",
  "cleaning_workload",
  "cleaning_secrets",
  "cleaning_firewall",
  "cleaning_droplet",
  "cleaning_runner",
  "complete",
]);

export const hermesStagingAcceptanceStateEnum = pgEnum("hermes_staging_acceptance_state", [
  "pending",
  "executing",
  "waiting",
  "blocked",
  "complete",
]);

export const hermesStagingAcceptanceTerminalOutcomeEnum = pgEnum(
  "hermes_staging_acceptance_terminal_outcome",
  ["succeeded", "failed", "cancelled"],
);

export const hermesStagingAcceptancePendingEffectEnum = pgEnum(
  "hermes_staging_acceptance_pending_effect",
  [
    "preflight",
    "attest_published_image",
    "create_ready_agent",
    "observe_agent_creation",
    "observe_next_deployment_stage",
    "verify_strict_host_image",
    "issue_initial_human_challenge",
    "observe_initial_human_challenge",
    "restart_agent",
    "observe_agent_restart",
    "verify_restarted_image_and_telegram",
    "issue_post_restart_human_challenge",
    "observe_post_restart_human_challenge",
    "audit_safe_diagnostics",
    "stop_agent_db_first",
    "observe_stop_intent",
    "observe_stop_stability",
    "verify_manual_rollback",
    "cleanup_workload",
    "observe_workload_absence",
    "cleanup_secrets",
    "observe_secrets_absence",
    "cleanup_firewall",
    "observe_firewall_absence",
    "cleanup_droplet",
    "observe_droplet_absence",
    "cleanup_runner",
    "observe_runner_absence",
  ],
);

export const hermesStagingAcceptanceErrorCodeEnum = pgEnum("hermes_staging_acceptance_error_code", [
  "invalid_begin",
  "preflight_failed",
  "image_attestation_failed",
  "agent_creation_failed",
  "deployment_failed",
  "deployment_stage_invalid",
  "host_image_unverified",
  "initial_human_proof_failed",
  "post_restart_human_proof_failed",
  "human_proof_expired",
  "restart_failed",
  "runtime_reverification_failed",
  "diagnostics_unsafe",
  "stop_failed",
  "rollback_failed",
  "acceptance_deadline_exceeded",
  "acceptance_cancelled",
  "cleanup_failed",
  "internal_state_invalid",
]);

export const hermesStagingAcceptanceChallengePurposeEnum = pgEnum(
  "hermes_staging_acceptance_challenge_purpose",
  ["initial", "post_restart"],
);

export const agentScheduleModeEnum = pgEnum("agent_schedule_mode", ["manual", "cron"]);

export const agentApprovalStatusEnum = pgEnum("agent_approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);

export const agentSecretKindEnum = pgEnum("agent_secret_kind", [
  "openrouter_api_key",
  "openai_api_key",
  "anthropic_api_key",
  "telegram_bot_token",
  "telegram_allowed_users",
  "api_server_key",
]);

export const agentSecretStatusEnum = pgEnum("agent_secret_status", ["active", "revoked"]);

export const localRunnerProcessStatusEnum = pgEnum("local_runner_process_status", [
  "starting",
  "running",
  "stopped",
  "exited",
  "failed",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_clerk_user_id_idx").on(table.clerkUserId)],
);

export const runners = pgTable(
  "runners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("manual_vps"),
    endpointUrl: text("endpoint_url"),
    status: text("status").notNull().default("active"),
    provider: text("provider"),
    providerResourceId: text("provider_resource_id"),
    providerFirewallId: text("provider_firewall_id"),
    region: text("region"),
    sizeSlug: text("size_slug"),
    image: text("image"),
    provisioningStatus: text("provisioning_status"),
    provisioningError: text("provisioning_error"),
    provisioningOperationKey: text("provisioning_operation_key"),
    provisioningStartedAt: timestamp("provisioning_started_at", { withTimezone: true }),
    provisioningCompletedAt: timestamp("provisioning_completed_at", { withTimezone: true }),
    requiredRunnerImageDigest: text("required_runner_image_digest"),
    observedRunnerImageDigest: text("observed_runner_image_digest"),
    observedRunnerReleaseVersion: text("observed_runner_release_version"),
    observedRunnerBootContractVersion: text("observed_runner_boot_contract_version"),
    compatibilityState: text("compatibility_state").notNull().default("unknown"),
    compatibilityVerifiedAt: timestamp("compatibility_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check("runners_name_not_empty_check", sql`length(trim(${table.name})) > 0`),
    check("runners_kind_check", sql`${table.kind} IN ('manual_vps', 'digitalocean')`),
    check(
      "runners_manual_endpoint_required_check",
      sql`${table.kind} <> 'manual_vps' OR ${table.endpointUrl} IS NOT NULL`,
    ),
    check(
      "runners_endpoint_url_not_empty_check",
      sql`${table.endpointUrl} IS NULL OR length(trim(${table.endpointUrl})) > 0`,
    ),
    check(
      "runners_status_check",
      sql`${table.status} IN ('active', 'inactive', 'registering', 'online', 'offline', 'degraded', 'provisioning', 'provision_failed', 'deleting', 'deleted')`,
    ),
    check(
      "runners_provider_check",
      sql`${table.provider} IS NULL OR ${table.provider} = 'digitalocean'`,
    ),
    check(
      "runners_provider_resource_id_not_empty_check",
      sql`${table.providerResourceId} IS NULL OR length(trim(${table.providerResourceId})) > 0`,
    ),
    check(
      "runners_provider_firewall_id_not_empty_check",
      sql`${table.providerFirewallId} IS NULL OR length(trim(${table.providerFirewallId})) > 0`,
    ),
    check(
      "runners_region_not_empty_check",
      sql`${table.region} IS NULL OR length(trim(${table.region})) > 0`,
    ),
    check(
      "runners_size_slug_not_empty_check",
      sql`${table.sizeSlug} IS NULL OR length(trim(${table.sizeSlug})) > 0`,
    ),
    check(
      "runners_image_not_empty_check",
      sql`${table.image} IS NULL OR length(trim(${table.image})) > 0`,
    ),
    check(
      "runners_provisioning_status_check",
      sql`${table.provisioningStatus} IS NULL OR ${table.provisioningStatus} IN ('pending', 'creating', 'tagging', 'firewall_configuring', 'bootstrapping', 'waiting_for_runner', 'ready', 'failed', 'cleaning_up', 'deleted')`,
    ),
    check(
      "runners_digitalocean_provider_fields_check",
      sql`(${table.kind} = 'manual_vps' AND ${table.provider} IS NULL AND ${table.providerResourceId} IS NULL AND ${table.providerFirewallId} IS NULL AND ${table.region} IS NULL AND ${table.sizeSlug} IS NULL AND ${table.image} IS NULL AND ${table.provisioningStatus} IS NULL AND ${table.provisioningError} IS NULL AND ${table.provisioningStartedAt} IS NULL AND ${table.provisioningCompletedAt} IS NULL) OR (${table.kind} = 'digitalocean' AND ${table.provider} = 'digitalocean' AND ${table.region} IS NOT NULL AND ${table.sizeSlug} IS NOT NULL AND ${table.image} IS NOT NULL AND ${table.provisioningStatus} IS NOT NULL)`,
    ),
    check(
      "runners_provisioning_completed_after_started_check",
      sql`${table.provisioningCompletedAt} IS NULL OR ${table.provisioningStartedAt} IS NULL OR ${table.provisioningCompletedAt} >= ${table.provisioningStartedAt}`,
    ),
    check(
      "runners_provisioning_operation_key_check",
      sql`${table.provisioningOperationKey} IS NULL OR (${table.kind} = 'digitalocean' AND ${table.provisioningOperationKey} ~ '^bruno-deploy-[0-9a-f]{32}$')`,
    ),
    check(
      "runners_required_runner_image_digest_check",
      sql`${table.requiredRunnerImageDigest} IS NULL OR ${table.requiredRunnerImageDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "runners_observed_runner_image_digest_check",
      sql`${table.observedRunnerImageDigest} IS NULL OR ${table.observedRunnerImageDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "runners_observed_runner_release_version_check",
      sql`${table.observedRunnerReleaseVersion} IS NULL OR ${table.observedRunnerReleaseVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'`,
    ),
    check(
      "runners_observed_runner_boot_contract_version_check",
      sql`${table.observedRunnerBootContractVersion} IS NULL OR ${table.observedRunnerBootContractVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'`,
    ),
    check(
      "runners_observed_runner_release_tuple_check",
      sql`(${table.observedRunnerImageDigest} IS NULL AND ${table.observedRunnerReleaseVersion} IS NULL AND ${table.observedRunnerBootContractVersion} IS NULL) OR (${table.observedRunnerImageDigest} IS NOT NULL AND ${table.observedRunnerReleaseVersion} IS NOT NULL AND ${table.observedRunnerBootContractVersion} IS NOT NULL)`,
    ),
    check(
      "runners_compatibility_state_check",
      sql`${table.compatibilityState} IN ('compatible', 'unknown', 'outdated', 'invalid')`,
    ),
    check(
      "runners_compatible_evidence_check",
      sql`${table.compatibilityState} <> 'compatible' OR (${table.requiredRunnerImageDigest} IS NOT NULL AND ${table.observedRunnerImageDigest} = ${table.requiredRunnerImageDigest} AND ${table.observedRunnerReleaseVersion} IS NOT NULL AND ${table.observedRunnerBootContractVersion} IS NOT NULL AND ${table.compatibilityVerifiedAt} IS NOT NULL)`,
    ),
    index("runners_user_status_idx").on(table.userId, table.status),
    index("runners_user_status_compatibility_idx").on(
      table.userId,
      table.status,
      table.compatibilityState,
    ),
    index("runners_managed_release_idx")
      .on(
        table.kind,
        table.provider,
        table.requiredRunnerImageDigest,
        table.observedRunnerImageDigest,
        table.compatibilityState,
      )
      .where(sql`${table.deletedAt} IS NULL AND ${table.kind} = 'digitalocean'`),
    index("runners_provider_resource_idx").on(table.provider, table.providerResourceId),
    uniqueIndex("runners_provider_firewall_idx")
      .on(table.providerFirewallId)
      .where(sql`${table.providerFirewallId} IS NOT NULL`),
    uniqueIndex("runners_provisioning_operation_key_idx")
      .on(table.provisioningOperationKey)
      .where(sql`${table.provisioningOperationKey} IS NOT NULL`),
    uniqueIndex("runners_active_user_endpoint_idx")
      .on(table.userId, table.endpointUrl)
      .where(sql`${table.deletedAt} IS NULL AND ${table.endpointUrl} IS NOT NULL`),
  ],
);

export const runnerProvisioningEvents = pgTable(
  "runner_provisioning_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "runner_provisioning_events_phase_check",
      sql`${table.phase} IN ('pending', 'creating', 'tagging', 'firewall_configuring', 'bootstrapping', 'waiting_for_runner', 'ready', 'failed', 'cleaning_up', 'deleted')`,
    ),
    check(
      "runner_provisioning_events_status_check",
      sql`${table.status} IN ('started', 'completed', 'failed')`,
    ),
    check(
      "runner_provisioning_events_message_not_empty_check",
      sql`length(trim(${table.message})) > 0`,
    ),
    index("runner_provisioning_events_runner_created_idx").on(table.runnerId, table.createdAt),
  ],
);

export const runnerRegistrationTokens = pgTable(
  "runner_registration_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    runnerId: uuid("runner_id").references(() => runners.id),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "runner_registration_tokens_hash_not_empty_check",
      sql`length(trim(${table.tokenHash})) > 0`,
    ),
    check(
      "runner_registration_tokens_prefix_not_empty_check",
      sql`length(trim(${table.tokenPrefix})) > 0`,
    ),
    check(
      "runner_registration_tokens_status_check",
      sql`${table.status} IN ('pending', 'used', 'revoked', 'expired')`,
    ),
    check(
      "runner_registration_tokens_used_status_check",
      sql`(${table.status} = 'used' AND ${table.usedAt} IS NOT NULL AND ${table.runnerId} IS NOT NULL) OR (${table.status} <> 'used' AND ${table.usedAt} IS NULL)`,
    ),
    check(
      "runner_registration_tokens_revoked_status_check",
      sql`(${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL) OR (${table.status} <> 'revoked' AND ${table.revokedAt} IS NULL)`,
    ),
    uniqueIndex("runner_registration_tokens_hash_idx").on(table.tokenHash),
    index("runner_registration_tokens_user_status_expires_idx").on(
      table.userId,
      table.status,
      table.expiresAt,
    ),
    index("runner_registration_tokens_runner_idx").on(table.runnerId),
  ],
);

export const runnerCredentials = pgTable(
  "runner_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id),
    credentialHash: text("credential_hash").notNull(),
    credentialPrefix: text("credential_prefix").notNull(),
    status: text("status").notNull().default("active"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "runner_credentials_hash_not_empty_check",
      sql`length(trim(${table.credentialHash})) > 0`,
    ),
    check(
      "runner_credentials_prefix_not_empty_check",
      sql`length(trim(${table.credentialPrefix})) > 0`,
    ),
    check("runner_credentials_status_check", sql`${table.status} IN ('active', 'revoked')`),
    check(
      "runner_credentials_revoked_status_check",
      sql`(${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL) OR (${table.status} <> 'revoked' AND ${table.revokedAt} IS NULL)`,
    ),
    uniqueIndex("runner_credentials_hash_idx").on(table.credentialHash),
    index("runner_credentials_runner_status_idx").on(table.runnerId, table.status),
  ],
);

export const runnerHeartbeats = pgTable(
  "runner_heartbeats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id),
    status: text("status").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "runner_heartbeats_status_check",
      sql`${table.status} IN ('online', 'offline', 'degraded')`,
    ),
    index("runner_heartbeats_runner_observed_idx").on(table.runnerId, table.observedAt),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    runnerId: uuid("runner_id").references(() => runners.id),
    name: text("name").notNull(),
    templateKey: text("template_key").notNull(),
    templateVersion: text("template_version").notNull().default("1.0.0"),
    templateSnapshotJson: jsonb("template_snapshot_json")
      .$type<AgentTemplateSnapshot>()
      .notNull()
      .default(
        sql`'{"key":"research_agent","version":"1.0.0","name":"Research Agent","description":"Tracks a research question, gathers source notes, and produces concise summaries for later review.","defaultTools":["Web search","Notes","Summaries"],"defaultSchedule":"Manual","defaultSystemPrompt":"You are a Research Agent. Gather relevant information, keep source notes, and produce concise summaries. Do not take external actions or contact third parties. Ask for approval before using any integration or publishing output.","requiredIntegrations":[]}'::jsonb`,
      ),
    status: agentStatusEnum("status").notNull().default("stopped"),
    desiredStatus: agentDesiredStatusEnum("desired_status").notNull().default("stopped"),
    statusReason: text("status_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("agents_id_user_id_unique").on(table.id, table.userId),
    index("agents_runner_id_idx").on(table.runnerId),
  ],
);

export const agentDeployments = pgTable(
  "agent_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    userId: uuid("user_id").notNull(),
    stage: agentDeploymentStageEnum("stage").notNull().default("pending"),
    configRevision: text("config_revision").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    runnerOperationId: uuid("runner_operation_id"),
    runnerAcceptedAt: timestamp("runner_accepted_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).default(sql`clock_timestamp()`),
    canaryState: text("canary_state").notNull().default("not_started"),
    canaryAttemptedAt: timestamp("canary_attempted_at", { withTimezone: true }),
    canaryCompletedAt: timestamp("canary_completed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_deployments_agent_owner_fk",
      columns: [table.agentId, table.userId],
      foreignColumns: [agents.id, agents.userId],
    }),
    check("agent_deployments_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "agent_deployments_config_revision_check",
      sql`trim(${table.configRevision}) = ${table.configRevision} AND ${table.configRevision} ~ '^[A-Za-z0-9_.:-]{1,80}$'`,
    ),
    check(
      "agent_deployments_idempotency_key_check",
      sql`trim(${table.idempotencyKey}) = ${table.idempotencyKey} AND length(${table.idempotencyKey}) BETWEEN 8 AND 128`,
    ),
    check(
      "agent_deployments_lease_owner_check",
      sql`${table.leaseOwner} IS NULL OR (length(trim(${table.leaseOwner})) > 0 AND length(${table.leaseOwner}) <= 128)`,
    ),
    check(
      "agent_deployments_error_code_check",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} ~ '^[a-z0-9_.:-]{1,64}$'`,
    ),
    check(
      "agent_deployments_error_detail_check",
      sql`${table.errorDetail} IS NULL OR (length(trim(${table.errorDetail})) > 0 AND length(${table.errorDetail}) <= 500)`,
    ),
    check(
      "agent_deployments_error_detail_code_check",
      sql`${table.errorDetail} IS NULL OR ${table.errorCode} IS NOT NULL`,
    ),
    check(
      "agent_deployments_lease_pair_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "agent_deployments_runner_operation_pair_check",
      sql`(${table.runnerOperationId} IS NULL AND ${table.runnerAcceptedAt} IS NULL) OR (${table.runnerOperationId} IS NOT NULL AND ${table.runnerAcceptedAt} IS NOT NULL)`,
    ),
    check(
      "agent_deployments_stage_runner_operation_check",
      sql`${table.stage} NOT IN ('starting_gateway', 'verifying_model', 'connecting_telegram', 'ready') OR (${table.runnerOperationId} IS NOT NULL AND ${table.runnerAcceptedAt} IS NOT NULL)`,
    ),
    check(
      "agent_deployments_canary_state_check",
      sql`${table.canaryState} IN ('not_started', 'started', 'passed', 'skipped', 'failed', 'outcome_unknown')`,
    ),
    check(
      "agent_deployments_canary_stage_check",
      sql`${table.canaryState} = 'not_started' OR ${table.stage} IN ('verifying_model', 'connecting_telegram', 'ready', 'failed')`,
    ),
    check(
      "agent_deployments_canary_started_check",
      sql`${table.canaryState} <> 'started' OR (${table.canaryAttemptedAt} IS NOT NULL AND ${table.canaryCompletedAt} IS NULL)`,
    ),
    check(
      "agent_deployments_canary_terminal_check",
      sql`${table.canaryState} NOT IN ('passed', 'failed') OR (${table.canaryAttemptedAt} IS NOT NULL AND ${table.canaryCompletedAt} IS NOT NULL AND ${table.canaryCompletedAt} >= ${table.canaryAttemptedAt})`,
    ),
    check(
      "agent_deployments_canary_unknown_check",
      sql`${table.canaryState} <> 'outcome_unknown' OR (${table.canaryAttemptedAt} IS NOT NULL AND ${table.canaryCompletedAt} IS NULL)`,
    ),
    check(
      "agent_deployments_telegram_ready_canary_check",
      sql`${table.stage} NOT IN ('connecting_telegram', 'ready') OR ${table.canaryState} IN ('passed', 'skipped')`,
    ),
    check(
      "agent_deployments_completed_stage_check",
      sql`(${table.stage} = 'ready' AND ${table.completedAt} IS NOT NULL) OR (${table.stage} <> 'ready' AND ${table.completedAt} IS NULL)`,
    ),
    check(
      "agent_deployments_failed_stage_check",
      sql`(${table.stage} = 'failed' AND ${table.failedAt} IS NOT NULL) OR (${table.stage} <> 'failed' AND ${table.failedAt} IS NULL)`,
    ),
    check(
      "agent_deployments_failed_error_check",
      sql`${table.stage} <> 'failed' OR ${table.errorCode} IS NOT NULL`,
    ),
    check(
      "agent_deployments_ready_error_check",
      sql`${table.stage} <> 'ready' OR (${table.errorCode} IS NULL AND ${table.errorDetail} IS NULL)`,
    ),
    check(
      "agent_deployments_terminal_clear_work_check",
      sql`${table.stage} NOT IN ('ready', 'failed') OR (${table.nextAttemptAt} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "agent_deployments_completed_after_started_check",
      sql`${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
    check(
      "agent_deployments_failed_after_started_check",
      sql`${table.failedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.failedAt} >= ${table.startedAt}`,
    ),
    uniqueIndex("agent_deployments_user_idempotency_idx").on(table.userId, table.idempotencyKey),
    uniqueIndex("agent_deployments_active_agent_idx")
      .on(table.agentId)
      .where(sql`${table.stage} NOT IN ('ready', 'failed')`),
    index("agent_deployments_user_agent_created_idx").on(
      table.userId,
      table.agentId,
      table.createdAt,
    ),
    index("agent_deployments_claim_idx")
      .on(table.nextAttemptAt, table.leaseExpiresAt, table.createdAt)
      .where(sql`${table.stage} NOT IN ('ready', 'failed')`),
  ],
);

export const agentDeploymentWakeups = pgTable(
  "agent_deployment_wakeups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => agentDeployments.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    state: agentDeploymentWakeupStateEnum("state").notNull().default("pending"),
    publishAttemptCount: integer("publish_attempt_count").notNull().default(0),
    providerMessageId: text("provider_message_id"),
    publishLeaseOwner: text("publish_lease_owner"),
    publishLeaseExpiresAt: timestamp("publish_lease_expires_at", { withTimezone: true }),
    safeErrorCode: text("safe_error_code"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_deployment_wakeups_generation_idx").on(table.deploymentId, table.generation),
    check("agent_deployment_wakeups_generation_check", sql`${table.generation} >= 1`),
    check(
      "agent_deployment_wakeups_publish_attempt_count_check",
      sql`${table.publishAttemptCount} >= 0`,
    ),
    check(
      "agent_deployment_wakeups_provider_message_id_check",
      sql`${table.providerMessageId} IS NULL OR (length(trim(${table.providerMessageId})) > 0 AND length(${table.providerMessageId}) <= 256)`,
    ),
    check(
      "agent_deployment_wakeups_publish_lease_owner_check",
      sql`${table.publishLeaseOwner} IS NULL OR (length(trim(${table.publishLeaseOwner})) > 0 AND length(${table.publishLeaseOwner}) <= 128)`,
    ),
    check(
      "agent_deployment_wakeups_publish_lease_pair_check",
      sql`(${table.publishLeaseOwner} IS NULL AND ${table.publishLeaseExpiresAt} IS NULL) OR (${table.publishLeaseOwner} IS NOT NULL AND ${table.publishLeaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "agent_deployment_wakeups_safe_error_code_check",
      sql`${table.safeErrorCode} IS NULL OR ${table.safeErrorCode} ~ '^[a-z0-9_.:-]{1,64}$'`,
    ),
    check(
      "agent_deployment_wakeups_published_state_check",
      sql`${table.state} <> 'published' OR (${table.providerMessageId} IS NOT NULL AND ${table.publishedAt} IS NOT NULL)`,
    ),
    check(
      "agent_deployment_wakeups_claimed_state_check",
      sql`${table.state} <> 'claimed' OR ${table.claimedAt} IS NOT NULL`,
    ),
    index("agent_deployment_wakeups_due_idx")
      .on(table.dueAt, table.updatedAt, table.deploymentId)
      .where(sql`${table.state} IN ('pending', 'failed')`),
    index("agent_deployment_wakeups_publish_lease_idx")
      .on(table.publishLeaseExpiresAt, table.updatedAt)
      .where(sql`${table.state} = 'publishing'`),
    index("agent_deployment_wakeups_delivery_idx")
      .on(table.deploymentId, table.generation, table.dueAt)
      .where(sql`${table.state} IN ('pending', 'published', 'failed')`),
  ],
);

export const runnerReplacements = pgTable(
  "runner_replacements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceRunnerId: uuid("source_runner_id")
      .notNull()
      .references(() => runners.id),
    targetRunnerId: uuid("target_runner_id").references(() => runners.id),
    triggerDeploymentId: uuid("trigger_deployment_id").references(() => agentDeployments.id),
    reason: runnerReplacementReasonEnum("reason").notNull(),
    state: runnerReplacementStateEnum("state").notNull().default("pending"),
    operationKey: text("operation_key").notNull(),
    generation: integer("generation").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    replacementCount: integer("replacement_count").notNull().default(0),
    replacementWindowStartedAt: timestamp("replacement_window_started_at", {
      withTimezone: true,
    }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    terminalCode: runnerReplacementTerminalCodeEnum("terminal_code"),
    terminalSummary: text("terminal_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "runner_replacements_source_target_check",
      sql`${table.targetRunnerId} IS NULL OR ${table.targetRunnerId} <> ${table.sourceRunnerId}`,
    ),
    check(
      "runner_replacements_operation_key_check",
      sql`${table.operationKey} ~ '^bruno-replace-[0-9a-f]{32}$'`,
    ),
    check("runner_replacements_generation_check", sql`${table.generation} >= 0`),
    check("runner_replacements_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "runner_replacements_replacement_count_check",
      sql`${table.replacementCount} BETWEEN 0 AND 2`,
    ),
    check(
      "runner_replacements_replacement_window_check",
      sql`(${table.replacementCount} = 0 AND ${table.replacementWindowStartedAt} IS NULL) OR (${table.replacementCount} BETWEEN 1 AND 2 AND ${table.replacementWindowStartedAt} IS NOT NULL)`,
    ),
    check(
      "runner_replacements_lease_owner_check",
      sql`${table.leaseOwner} IS NULL OR ${table.leaseOwner} ~ '^runner-replacement:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "runner_replacements_lease_pair_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "runner_replacements_terminal_summary_check",
      sql`${table.terminalSummary} IS NULL OR (length(trim(${table.terminalSummary})) BETWEEN 1 AND 240 AND ${table.terminalCode} IS NOT NULL)`,
    ),
    check(
      "runner_replacements_terminal_evidence_check",
      sql`(${table.terminalCode} IS NULL AND ${table.terminalSummary} IS NULL) OR (${table.terminalCode} = 'replacement_budget_exhausted' AND ${table.terminalSummary} = 'Automatic runner replacement budget was exhausted.') OR (${table.terminalCode} = 'target_provisioning_failed' AND ${table.terminalSummary} = 'Replacement runner provisioning did not complete.') OR (${table.terminalCode} = 'target_validation_failed' AND ${table.terminalSummary} = 'Replacement runner validation did not pass.') OR (${table.terminalCode} = 'source_fence_failed' AND ${table.terminalSummary} = 'The source runner could not be fenced safely.') OR (${table.terminalCode} = 'reassignment_failed' AND ${table.terminalSummary} = 'Agent reassignment did not complete safely.') OR (${table.terminalCode} = 'agent_convergence_failed' AND ${table.terminalSummary} = 'Agents did not converge on the replacement runner.') OR (${table.terminalCode} = 'source_cleanup_failed' AND ${table.terminalSummary} = 'The obsolete source runner could not be cleaned up safely.') OR (${table.terminalCode} = 'state_invalid' AND ${table.terminalSummary} = 'The replacement workflow reached an invalid state.')`,
    ),
    check(
      "runner_replacements_terminal_state_check",
      sql`(${table.state} = 'complete' AND ${table.completedAt} IS NOT NULL AND ${table.failedAt} IS NULL AND ${table.terminalCode} IS NULL AND ${table.terminalSummary} IS NULL) OR (${table.state} = 'failed' AND ${table.failedAt} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.terminalCode} IS NOT NULL AND ${table.terminalSummary} IS NOT NULL) OR (${table.state} NOT IN ('complete', 'failed') AND ${table.completedAt} IS NULL AND ${table.failedAt} IS NULL AND ${table.terminalCode} IS NULL AND ${table.terminalSummary} IS NULL)`,
    ),
    check(
      "runner_replacements_terminal_clear_work_check",
      sql`${table.state} NOT IN ('complete', 'failed') OR (${table.nextAttemptAt} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "runner_replacements_active_work_check",
      sql`${table.state} IN ('complete', 'failed') OR ${table.nextAttemptAt} IS NOT NULL OR ${table.leaseOwner} IS NOT NULL`,
    ),
    check(
      "runner_replacements_target_state_check",
      sql`${table.state} IN ('pending', 'provisioning_target', 'failed') OR ${table.targetRunnerId} IS NOT NULL`,
    ),
    check(
      "runner_replacements_completed_after_started_check",
      sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
    check(
      "runner_replacements_failed_after_started_check",
      sql`${table.failedAt} IS NULL OR ${table.failedAt} >= ${table.startedAt}`,
    ),
    uniqueIndex("runner_replacements_operation_key_idx").on(table.operationKey),
    uniqueIndex("runner_replacements_active_source_idx")
      .on(table.sourceRunnerId)
      .where(sql`${table.state} NOT IN ('complete', 'failed')`),
    uniqueIndex("runner_replacements_active_deployment_idx")
      .on(table.triggerDeploymentId)
      .where(
        sql`${table.triggerDeploymentId} IS NOT NULL AND ${table.state} NOT IN ('complete', 'failed')`,
      ),
    index("runner_replacements_claim_idx")
      .on(table.nextAttemptAt, table.leaseExpiresAt, table.createdAt)
      .where(sql`${table.state} NOT IN ('complete', 'failed')`),
    index("runner_replacements_deployment_budget_idx").on(
      table.triggerDeploymentId,
      table.replacementWindowStartedAt,
    ),
  ],
);

export const runnerInfrastructureReconciliations = pgTable(
  "runner_infrastructure_reconciliations",
  {
    scopeKey: text("scope_key").primaryKey().default("global"),
    generation: integer("generation").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("runner_infrastructure_reconciliations_scope_check", sql`${table.scopeKey} = 'global'`),
    check("runner_infrastructure_reconciliations_generation_check", sql`${table.generation} >= 0`),
    check(
      "runner_infrastructure_reconciliations_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "runner_infrastructure_reconciliations_lease_owner_check",
      sql`${table.leaseOwner} IS NULL OR ${table.leaseOwner} ~ '^runner-infrastructure:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "runner_infrastructure_reconciliations_lease_pair_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    index("runner_infrastructure_reconciliations_due_idx").on(
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const runnerInfrastructureOrphans = pgTable(
  "runner_infrastructure_orphans",
  {
    providerResourceId: text("provider_resource_id").primaryKey(),
    operationTag: text("operation_tag").notNull(),
    providerFirewallId: text("provider_firewall_id"),
    expectedName: text("expected_name").notNull(),
    expectedRegion: text("expected_region").notNull(),
    expectedSizeSlug: text("expected_size_slug").notNull(),
    observationCount: integer("observation_count").notNull().default(1),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "runner_infrastructure_orphans_resource_check",
      sql`length(trim(${table.providerResourceId})) > 0`,
    ),
    check(
      "runner_infrastructure_orphans_operation_check",
      sql`${table.operationTag} ~ '^bruno-deploy-[0-9a-f]{32}$'`,
    ),
    check(
      "runner_infrastructure_orphans_firewall_check",
      sql`${table.providerFirewallId} IS NULL OR length(trim(${table.providerFirewallId})) > 0`,
    ),
    check(
      "runner_infrastructure_orphans_expected_fields_check",
      sql`length(trim(${table.expectedName})) > 0 AND length(trim(${table.expectedRegion})) > 0 AND length(trim(${table.expectedSizeSlug})) > 0`,
    ),
    check(
      "runner_infrastructure_orphans_observation_count_check",
      sql`${table.observationCount} >= 1`,
    ),
    check(
      "runner_infrastructure_orphans_observation_order_check",
      sql`${table.lastObservedAt} >= ${table.firstObservedAt}`,
    ),
    check(
      "runner_infrastructure_orphans_deleted_order_check",
      sql`${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.firstObservedAt}`,
    ),
    index("runner_infrastructure_orphans_grace_idx").on(
      table.deletedAt,
      table.firstObservedAt,
      table.lastObservedAt,
    ),
    uniqueIndex("runner_infrastructure_orphans_active_operation_idx")
      .on(table.operationTag)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const agentDeploymentReplacementBudgets = pgTable(
  "agent_deployment_replacement_budgets",
  {
    deploymentId: uuid("deployment_id")
      .primaryKey()
      .references(() => agentDeployments.id),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    replacementCount: integer("replacement_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "agent_deployment_replacement_budgets_count_check",
      sql`${table.replacementCount} BETWEEN 1 AND 2`,
    ),
    check(
      "agent_deployment_replacement_budgets_updated_check",
      sql`${table.updatedAt} >= ${table.windowStartedAt}`,
    ),
  ],
);

export const agentRuntimeReconciliations = pgTable(
  "agent_runtime_reconciliations",
  {
    agentId: uuid("agent_id").primaryKey(),
    userId: uuid("user_id").notNull(),
    state: agentRuntimeReconciliationStateEnum("state").notNull(),
    generation: integer("generation").notNull().default(0),
    configRevision: text("config_revision").notNull(),
    operationId: uuid("operation_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    recoveryCount: integer("recovery_count").notNull().default(0),
    recoveryWindowStartedAt: timestamp("recovery_window_started_at", { withTimezone: true }),
    stableSince: timestamp("stable_since", { withTimezone: true }),
    telegramNonConnectedSince: timestamp("telegram_non_connected_since", {
      withTimezone: true,
    }),
    lastRestartCount: integer("last_restart_count"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    lastReadyAt: timestamp("last_ready_at", { withTimezone: true }),
    errorCode: text("error_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    circuitOpenedAt: timestamp("circuit_opened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_runtime_reconciliations_agent_owner_fk",
      columns: [table.agentId, table.userId],
      foreignColumns: [agents.id, agents.userId],
    }),
    check("agent_runtime_reconciliations_generation_check", sql`${table.generation} >= 0`),
    check("agent_runtime_reconciliations_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check("agent_runtime_reconciliations_recovery_count_check", sql`${table.recoveryCount} >= 0`),
    check(
      "agent_runtime_reconciliations_restart_count_check",
      sql`${table.lastRestartCount} IS NULL OR ${table.lastRestartCount} >= 0`,
    ),
    check(
      "agent_runtime_reconciliations_config_revision_check",
      sql`trim(${table.configRevision}) = ${table.configRevision} AND ${table.configRevision} ~ '^[A-Za-z0-9_.:-]{1,80}$'`,
    ),
    check(
      "agent_runtime_reconciliations_error_code_check",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN ('runtime_runner_unavailable', 'runtime_container_absent', 'runtime_container_terminal', 'runtime_revision_mismatch', 'runtime_restart_policy_mismatch', 'runtime_gateway_unhealthy', 'runtime_api_server_unhealthy', 'runtime_telegram_unhealthy', 'telegram_webhook_conflict', 'telegram_polling_conflict_or_unavailable', 'runtime_secret_unavailable', 'runtime_capacity_blocked', 'runtime_recovery_exhausted', 'runtime_stop_unconfirmed', 'runtime_internal_failure')`,
    ),
    check(
      "agent_runtime_reconciliations_lease_owner_check",
      sql`${table.leaseOwner} IS NULL OR ${table.leaseOwner} ~ '^reconcile:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "agent_runtime_reconciliations_lease_pair_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "agent_runtime_reconciliations_operation_state_check",
      sql`${table.operationId} IS NULL OR ${table.state} IN ('verifying', 'observing')`,
    ),
    check(
      "agent_runtime_reconciliations_terminal_work_check",
      sql`${table.state} NOT IN ('stopped', 'circuit_open') OR (${table.nextAttemptAt} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "agent_runtime_reconciliations_circuit_check",
      sql`${table.state} <> 'circuit_open' OR (${table.circuitOpenedAt} IS NOT NULL AND ${table.errorCode} IS NOT NULL)`,
    ),
    check(
      "agent_runtime_reconciliations_stopped_check",
      sql`${table.state} <> 'stopped' OR (${table.operationId} IS NULL AND ${table.errorCode} IS NULL AND ${table.circuitOpenedAt} IS NULL AND ${table.nextAttemptAt} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "agent_runtime_reconciliations_updated_after_created_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "agent_runtime_reconciliations_last_ready_observed_check",
      sql`${table.lastReadyAt} IS NULL OR (${table.lastObservedAt} IS NOT NULL AND ${table.lastReadyAt} <= ${table.lastObservedAt})`,
    ),
    check(
      "agent_runtime_reconciliations_recovery_window_updated_check",
      sql`${table.recoveryWindowStartedAt} IS NULL OR ${table.recoveryWindowStartedAt} <= ${table.updatedAt}`,
    ),
    check(
      "agent_runtime_reconciliations_stable_ready_check",
      sql`${table.stableSince} IS NULL OR (${table.lastReadyAt} IS NOT NULL AND ${table.stableSince} <= ${table.lastReadyAt})`,
    ),
    check(
      "agent_runtime_reconciliations_stable_updated_check",
      sql`${table.stableSince} IS NULL OR ${table.stableSince} <= ${table.updatedAt}`,
    ),
    check(
      "agent_runtime_reconciliations_telegram_observed_check",
      sql`${table.telegramNonConnectedSince} IS NULL OR (${table.lastObservedAt} IS NOT NULL AND ${table.telegramNonConnectedSince} <= ${table.lastObservedAt})`,
    ),
    check(
      "agent_runtime_reconciliations_observed_updated_check",
      sql`${table.lastObservedAt} IS NULL OR ${table.lastObservedAt} <= ${table.updatedAt}`,
    ),
    check(
      "agent_runtime_reconciliations_ready_updated_check",
      sql`${table.lastReadyAt} IS NULL OR ${table.lastReadyAt} <= ${table.updatedAt}`,
    ),
    check(
      "agent_runtime_reconciliations_circuit_updated_check",
      sql`${table.circuitOpenedAt} IS NULL OR ${table.circuitOpenedAt} <= ${table.updatedAt}`,
    ),
    index("agent_runtime_reconciliations_owner_agent_idx").on(table.userId, table.agentId),
    index("agent_runtime_reconciliations_claim_idx")
      .on(table.nextAttemptAt, table.leaseExpiresAt, table.updatedAt)
      .where(sql`${table.state} NOT IN ('stopped', 'circuit_open')`),
  ],
);

export const hermesStagingAcceptanceRuns = pgTable(
  "hermes_staging_acceptance_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeKey: text("scope_key").notNull().default("global"),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    desiredOutcome: hermesStagingAcceptanceDesiredOutcomeEnum("desired_outcome")
      .notNull()
      .default("acceptance"),
    phase: hermesStagingAcceptancePhaseEnum("phase").notNull().default("preflight"),
    state: hermesStagingAcceptanceStateEnum("state").notNull().default("pending"),
    terminalOutcome: hermesStagingAcceptanceTerminalOutcomeEnum("terminal_outcome"),
    generation: integer("generation").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseAttempt: integer("lease_attempt").notNull().default(0),
    pendingEffect: hermesStagingAcceptancePendingEffectEnum("pending_effect"),
    deploymentStageIndex: integer("deployment_stage_index").notNull().default(-1),
    errorCode: hermesStagingAcceptanceErrorCodeEnum("error_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    cleanupDeadlineAt: timestamp("cleanup_deadline_at", { withTimezone: true }).notNull(),
    expectedSourceRevision: text("expected_source_revision").notNull(),
    expectedPublishWorkflowRunId: text("expected_publish_workflow_run_id").notNull(),
    expectedImageDigest: text("expected_image_digest").notNull(),
    observedImageDigest: text("observed_image_digest"),
    agentId: uuid("agent_id"),
    deploymentId: uuid("deployment_id"),
    runnerId: uuid("runner_id"),
    providerResourceId: text("provider_resource_id"),
    providerFirewallId: text("provider_firewall_id"),
    challengePurpose: hermesStagingAcceptanceChallengePurposeEnum("challenge_purpose"),
    initialChallengeDigest: text("initial_challenge_digest"),
    initialChallengeExpiresAt: timestamp("initial_challenge_expires_at", { withTimezone: true }),
    initialAttestationDigest: text("initial_attestation_digest"),
    initialChallengeAttestedAt: timestamp("initial_challenge_attested_at", {
      withTimezone: true,
    }),
    postRestartChallengeDigest: text("post_restart_challenge_digest"),
    postRestartChallengeExpiresAt: timestamp("post_restart_challenge_expires_at", {
      withTimezone: true,
    }),
    postRestartAttestationDigest: text("post_restart_attestation_digest"),
    postRestartChallengeAttestedAt: timestamp("post_restart_challenge_attested_at", {
      withTimezone: true,
    }),
    stopStableSince: timestamp("stop_stable_since", { withTimezone: true }),
    publishedImageVerified: boolean("published_image_verified").notNull().default(false),
    publishedImageVerifiedAt: timestamp("published_image_verified_at", { withTimezone: true }),
    hostImageVerified: boolean("host_image_verified").notNull().default(false),
    hostImageVerifiedAt: timestamp("host_image_verified_at", { withTimezone: true }),
    agentReadyVerified: boolean("agent_ready_verified").notNull().default(false),
    agentReadyVerifiedAt: timestamp("agent_ready_verified_at", { withTimezone: true }),
    initialHumanProofVerified: boolean("initial_human_proof_verified").notNull().default(false),
    restartRequested: boolean("restart_requested").notNull().default(false),
    restartRequestedAt: timestamp("restart_requested_at", { withTimezone: true }),
    restartVerified: boolean("restart_verified").notNull().default(false),
    restartVerifiedAt: timestamp("restart_verified_at", { withTimezone: true }),
    restartedRuntimeVerified: boolean("restarted_runtime_verified").notNull().default(false),
    restartedRuntimeVerifiedAt: timestamp("restarted_runtime_verified_at", {
      withTimezone: true,
    }),
    postRestartHumanProofVerified: boolean("post_restart_human_proof_verified")
      .notNull()
      .default(false),
    diagnosticsRedactedConfirmed: boolean("diagnostics_redacted_confirmed")
      .notNull()
      .default(false),
    diagnosticsRedactedConfirmedAt: timestamp("diagnostics_redacted_confirmed_at", {
      withTimezone: true,
    }),
    stopVerified: boolean("stop_verified").notNull().default(false),
    stopVerifiedAt: timestamp("stop_verified_at", { withTimezone: true }),
    rollbackVerified: boolean("rollback_verified").notNull().default(false),
    rollbackVerifiedAt: timestamp("rollback_verified_at", { withTimezone: true }),
    workloadCleanupConfirmed: boolean("workload_cleanup_confirmed").notNull().default(false),
    workloadCleanupConfirmedAt: timestamp("workload_cleanup_confirmed_at", {
      withTimezone: true,
    }),
    secretsCleanupConfirmed: boolean("secrets_cleanup_confirmed").notNull().default(false),
    secretsCleanupConfirmedAt: timestamp("secrets_cleanup_confirmed_at", {
      withTimezone: true,
    }),
    firewallCleanupConfirmed: boolean("firewall_cleanup_confirmed").notNull().default(false),
    firewallCleanupConfirmedAt: timestamp("firewall_cleanup_confirmed_at", {
      withTimezone: true,
    }),
    dropletCleanupConfirmed: boolean("droplet_cleanup_confirmed").notNull().default(false),
    dropletCleanupConfirmedAt: timestamp("droplet_cleanup_confirmed_at", {
      withTimezone: true,
    }),
    runnerCleanupConfirmed: boolean("runner_cleanup_confirmed").notNull().default(false),
    runnerCleanupConfirmedAt: timestamp("runner_cleanup_confirmed_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check("hermes_staging_acceptance_runs_scope_check", sql`${table.scopeKey} = 'global'`),
    check(
      "hermes_staging_acceptance_runs_idempotency_key_check",
      sql`trim(${table.idempotencyKey}) = ${table.idempotencyKey} AND ${table.idempotencyKey} ~ '^[A-Za-z0-9_.:-]{8,128}$'`,
    ),
    check("hermes_staging_acceptance_runs_generation_check", sql`${table.generation} >= 0`),
    check("hermes_staging_acceptance_runs_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check("hermes_staging_acceptance_runs_lease_attempt_check", sql`${table.leaseAttempt} >= 0`),
    check(
      "hermes_staging_acceptance_runs_deployment_stage_index_check",
      sql`${table.deploymentStageIndex} BETWEEN -1 AND 6`,
    ),
    check(
      "hermes_staging_acceptance_runs_lease_owner_check",
      sql`${table.leaseOwner} IS NULL OR ${table.leaseOwner} ~ '^staging-acceptance:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "hermes_staging_acceptance_runs_lease_pair_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_execution_lease_check",
      sql`(${table.state} = 'executing' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.state} <> 'executing' AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_scheduled_work_check",
      sql`(${table.state} IN ('pending', 'executing', 'waiting') AND ${table.nextAttemptAt} IS NOT NULL) OR (${table.state} IN ('blocked', 'complete') AND ${table.nextAttemptAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_image_digest_check",
      sql`${table.expectedImageDigest} ~ '^sha256:[0-9a-f]{64}$' AND (${table.observedImageDigest} IS NULL OR ${table.observedImageDigest} ~ '^sha256:[0-9a-f]{64}$')`,
    ),
    check(
      "hermes_staging_acceptance_runs_source_revision_check",
      sql`${table.expectedSourceRevision} ~ '^[0-9a-f]{40}$'`,
    ),
    check(
      "hermes_staging_acceptance_runs_workflow_run_id_check",
      sql`${table.expectedPublishWorkflowRunId} ~ '^[1-9][0-9]{0,19}$'`,
    ),
    check(
      "hermes_staging_acceptance_runs_provider_resource_id_check",
      sql`${table.providerResourceId} IS NULL OR ${table.providerResourceId} ~ '^[A-Za-z0-9_.:-]{1,120}$'`,
    ),
    check(
      "hermes_staging_acceptance_runs_provider_firewall_id_check",
      sql`${table.providerFirewallId} IS NULL OR ${table.providerFirewallId} ~ '^[A-Za-z0-9_.:-]{1,120}$'`,
    ),
    check(
      "hermes_staging_acceptance_runs_challenge_digest_check",
      sql`(${table.initialChallengeDigest} IS NULL OR ${table.initialChallengeDigest} ~ '^sha256:[0-9a-f]{64}$') AND (${table.initialAttestationDigest} IS NULL OR ${table.initialAttestationDigest} ~ '^sha256:[0-9a-f]{64}$') AND (${table.postRestartChallengeDigest} IS NULL OR ${table.postRestartChallengeDigest} ~ '^sha256:[0-9a-f]{64}$') AND (${table.postRestartAttestationDigest} IS NULL OR ${table.postRestartAttestationDigest} ~ '^sha256:[0-9a-f]{64}$')`,
    ),
    check(
      "hermes_staging_acceptance_runs_initial_challenge_check",
      sql`(${table.initialChallengeDigest} IS NULL AND ${table.initialChallengeExpiresAt} IS NULL AND ${table.initialAttestationDigest} IS NULL AND ${table.initialChallengeAttestedAt} IS NULL AND NOT ${table.initialHumanProofVerified}) OR (${table.initialChallengeDigest} IS NOT NULL AND ${table.initialChallengeExpiresAt} IS NOT NULL AND ((${table.initialAttestationDigest} IS NULL AND ${table.initialChallengeAttestedAt} IS NULL AND NOT ${table.initialHumanProofVerified}) OR (${table.initialAttestationDigest} IS NOT NULL AND ${table.initialChallengeAttestedAt} IS NOT NULL AND ${table.initialHumanProofVerified} AND ${table.initialAttestationDigest} <> ${table.initialChallengeDigest})))`,
    ),
    check(
      "hermes_staging_acceptance_runs_post_restart_challenge_check",
      sql`(${table.postRestartChallengeDigest} IS NULL AND ${table.postRestartChallengeExpiresAt} IS NULL AND ${table.postRestartAttestationDigest} IS NULL AND ${table.postRestartChallengeAttestedAt} IS NULL AND NOT ${table.postRestartHumanProofVerified}) OR (${table.postRestartChallengeDigest} IS NOT NULL AND ${table.postRestartChallengeExpiresAt} IS NOT NULL AND ${table.initialChallengeDigest} IS NOT NULL AND ${table.postRestartChallengeDigest} <> ${table.initialChallengeDigest} AND ((${table.postRestartAttestationDigest} IS NULL AND ${table.postRestartChallengeAttestedAt} IS NULL AND NOT ${table.postRestartHumanProofVerified}) OR (${table.postRestartAttestationDigest} IS NOT NULL AND ${table.postRestartChallengeAttestedAt} IS NOT NULL AND ${table.postRestartHumanProofVerified} AND ${table.initialAttestationDigest} IS NOT NULL AND ${table.postRestartAttestationDigest} <> ${table.postRestartChallengeDigest} AND ${table.postRestartAttestationDigest} <> ${table.initialAttestationDigest})))`,
    ),
    check(
      "hermes_staging_acceptance_runs_challenge_purpose_check",
      sql`(${table.phase} = 'awaiting_initial_human_proof' AND ((${table.initialChallengeDigest} IS NULL AND ${table.initialChallengeExpiresAt} IS NULL AND ${table.challengePurpose} IS NULL AND ${table.pendingEffect} IN ('issue_initial_human_challenge', 'observe_initial_human_challenge')) OR (${table.initialChallengeDigest} IS NOT NULL AND ${table.initialChallengeExpiresAt} IS NOT NULL AND ${table.challengePurpose} = 'initial'))) OR (${table.phase} = 'awaiting_post_restart_human_proof' AND ((${table.postRestartChallengeDigest} IS NULL AND ${table.postRestartChallengeExpiresAt} IS NULL AND ${table.challengePurpose} IS NULL AND ${table.pendingEffect} IN ('issue_post_restart_human_challenge', 'observe_post_restart_human_challenge')) OR (${table.postRestartChallengeDigest} IS NOT NULL AND ${table.postRestartChallengeExpiresAt} IS NOT NULL AND ${table.challengePurpose} = 'post_restart'))) OR (${table.phase} NOT IN ('awaiting_initial_human_proof', 'awaiting_post_restart_human_proof') AND ${table.challengePurpose} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_challenge_time_check",
      sql`(${table.initialChallengeExpiresAt} IS NULL OR (${table.initialChallengeExpiresAt} > ${table.createdAt} AND ${table.initialChallengeExpiresAt} <= ${table.deadlineAt} AND (${table.initialChallengeAttestedAt} IS NULL OR (${table.initialChallengeAttestedAt} >= ${table.createdAt} AND ${table.initialChallengeAttestedAt} <= ${table.initialChallengeExpiresAt} AND ${table.initialChallengeAttestedAt} <= ${table.updatedAt})))) AND (${table.postRestartChallengeExpiresAt} IS NULL OR (${table.postRestartChallengeExpiresAt} > ${table.createdAt} AND ${table.postRestartChallengeExpiresAt} <= ${table.deadlineAt} AND (${table.postRestartChallengeAttestedAt} IS NULL OR (${table.postRestartChallengeAttestedAt} >= ${table.createdAt} AND ${table.postRestartChallengeAttestedAt} <= ${table.postRestartChallengeExpiresAt} AND ${table.postRestartChallengeAttestedAt} <= ${table.updatedAt}))))`,
    ),
    check(
      "hermes_staging_acceptance_runs_published_image_evidence_check",
      sql`(${table.publishedImageVerified} AND ${table.publishedImageVerifiedAt} IS NOT NULL) OR (NOT ${table.publishedImageVerified} AND ${table.publishedImageVerifiedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_host_image_evidence_check",
      sql`(${table.hostImageVerified} AND ${table.hostImageVerifiedAt} IS NOT NULL AND ${table.observedImageDigest} IS NOT NULL AND ${table.observedImageDigest} = ${table.expectedImageDigest}) OR (NOT ${table.hostImageVerified} AND ${table.hostImageVerifiedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_ready_evidence_check",
      sql`(${table.agentReadyVerified} AND ${table.agentReadyVerifiedAt} IS NOT NULL) OR (NOT ${table.agentReadyVerified} AND ${table.agentReadyVerifiedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_restart_requested_evidence_check",
      sql`(${table.restartRequested} AND ${table.restartRequestedAt} IS NOT NULL) OR (NOT ${table.restartRequested} AND ${table.restartRequestedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_restart_evidence_check",
      sql`(${table.restartVerified} AND ${table.restartVerifiedAt} IS NOT NULL) OR (NOT ${table.restartVerified} AND ${table.restartVerifiedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_restarted_runtime_evidence_check",
      sql`(${table.restartedRuntimeVerified} AND ${table.restartedRuntimeVerifiedAt} IS NOT NULL AND ${table.observedImageDigest} IS NOT NULL AND ${table.observedImageDigest} = ${table.expectedImageDigest}) OR (NOT ${table.restartedRuntimeVerified} AND ${table.restartedRuntimeVerifiedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_diagnostics_evidence_check",
      sql`(${table.diagnosticsRedactedConfirmed} AND ${table.diagnosticsRedactedConfirmedAt} IS NOT NULL) OR (NOT ${table.diagnosticsRedactedConfirmed} AND ${table.diagnosticsRedactedConfirmedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_stop_evidence_check",
      sql`(${table.stopVerified} AND ${table.stopVerifiedAt} IS NOT NULL) OR (NOT ${table.stopVerified} AND ${table.stopVerifiedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_rollback_evidence_check",
      sql`(${table.rollbackVerified} AND ${table.rollbackVerifiedAt} IS NOT NULL) OR (NOT ${table.rollbackVerified} AND ${table.rollbackVerifiedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_workload_cleanup_check",
      sql`(${table.workloadCleanupConfirmed} AND ${table.workloadCleanupConfirmedAt} IS NOT NULL) OR (NOT ${table.workloadCleanupConfirmed} AND ${table.workloadCleanupConfirmedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_secrets_cleanup_check",
      sql`(${table.secretsCleanupConfirmed} AND ${table.secretsCleanupConfirmedAt} IS NOT NULL) OR (NOT ${table.secretsCleanupConfirmed} AND ${table.secretsCleanupConfirmedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_firewall_cleanup_check",
      sql`(${table.firewallCleanupConfirmed} AND ${table.firewallCleanupConfirmedAt} IS NOT NULL) OR (NOT ${table.firewallCleanupConfirmed} AND ${table.firewallCleanupConfirmedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_droplet_cleanup_check",
      sql`(${table.dropletCleanupConfirmed} AND ${table.dropletCleanupConfirmedAt} IS NOT NULL) OR (NOT ${table.dropletCleanupConfirmed} AND ${table.dropletCleanupConfirmedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_runner_cleanup_check",
      sql`(${table.runnerCleanupConfirmed} AND ${table.runnerCleanupConfirmedAt} IS NOT NULL) OR (NOT ${table.runnerCleanupConfirmed} AND ${table.runnerCleanupConfirmedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_cleanup_intent_check",
      sql`${table.phase} NOT IN ('cleaning_workload', 'cleaning_secrets', 'cleaning_firewall', 'cleaning_droplet', 'cleaning_runner', 'complete') OR ${table.desiredOutcome} = 'cleanup'`,
    ),
    check(
      "hermes_staging_acceptance_runs_terminal_check",
      sql`(${table.state} = 'complete' AND ${table.phase} = 'complete' AND ${table.desiredOutcome} = 'cleanup' AND ${table.terminalOutcome} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.nextAttemptAt} IS NULL AND ${table.pendingEffect} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.workloadCleanupConfirmed} AND ${table.secretsCleanupConfirmed} AND ${table.firewallCleanupConfirmed} AND ${table.dropletCleanupConfirmed} AND ${table.runnerCleanupConfirmed}) OR (${table.state} <> 'complete' AND ${table.phase} <> 'complete' AND ${table.completedAt} IS NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_terminal_outcome_check",
      sql`(${table.terminalOutcome} IS NULL AND ${table.state} <> 'complete') OR (${table.terminalOutcome} = 'succeeded' AND ${table.errorCode} IS NULL) OR (${table.terminalOutcome} IN ('failed', 'cancelled') AND ${table.errorCode} IS NOT NULL)`,
    ),
    check(
      "hermes_staging_acceptance_runs_success_evidence_check",
      sql`${table.terminalOutcome} <> 'succeeded' OR (${table.publishedImageVerified} AND ${table.hostImageVerified} AND ${table.agentReadyVerified} AND ${table.initialHumanProofVerified} AND ${table.restartRequested} AND ${table.restartVerified} AND ${table.restartedRuntimeVerified} AND ${table.postRestartHumanProofVerified} AND ${table.diagnosticsRedactedConfirmed} AND ${table.stopVerified} AND ${table.rollbackVerified})`,
    ),
    check(
      "hermes_staging_acceptance_runs_cleanup_deadline_check",
      sql`${table.deadlineAt} > ${table.createdAt} AND ${table.deadlineAt} <= ${table.createdAt} + interval '2 hours' AND ${table.cleanupDeadlineAt} > ${table.deadlineAt} AND ${table.cleanupDeadlineAt} <= ${table.deadlineAt} + interval '2 hours'`,
    ),
    check(
      "hermes_staging_acceptance_runs_updated_after_created_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "hermes_staging_acceptance_runs_lease_after_updated_check",
      sql`${table.leaseExpiresAt} IS NULL OR ${table.leaseExpiresAt} > ${table.updatedAt}`,
    ),
    check(
      "hermes_staging_acceptance_runs_evidence_time_check",
      sql`(${table.publishedImageVerifiedAt} IS NULL OR (${table.publishedImageVerifiedAt} >= ${table.createdAt} AND ${table.publishedImageVerifiedAt} <= ${table.updatedAt})) AND (${table.hostImageVerifiedAt} IS NULL OR (${table.hostImageVerifiedAt} >= ${table.createdAt} AND ${table.hostImageVerifiedAt} <= ${table.updatedAt})) AND (${table.agentReadyVerifiedAt} IS NULL OR (${table.agentReadyVerifiedAt} >= ${table.createdAt} AND ${table.agentReadyVerifiedAt} <= ${table.updatedAt})) AND (${table.restartRequestedAt} IS NULL OR (${table.restartRequestedAt} >= ${table.createdAt} AND ${table.restartRequestedAt} <= ${table.updatedAt})) AND (${table.restartVerifiedAt} IS NULL OR (${table.restartVerifiedAt} >= ${table.createdAt} AND ${table.restartVerifiedAt} <= ${table.updatedAt})) AND (${table.restartedRuntimeVerifiedAt} IS NULL OR (${table.restartedRuntimeVerifiedAt} >= ${table.createdAt} AND ${table.restartedRuntimeVerifiedAt} <= ${table.updatedAt})) AND (${table.diagnosticsRedactedConfirmedAt} IS NULL OR (${table.diagnosticsRedactedConfirmedAt} >= ${table.createdAt} AND ${table.diagnosticsRedactedConfirmedAt} <= ${table.updatedAt})) AND (${table.stopVerifiedAt} IS NULL OR (${table.stopVerifiedAt} >= ${table.createdAt} AND ${table.stopVerifiedAt} <= ${table.updatedAt})) AND (${table.rollbackVerifiedAt} IS NULL OR (${table.rollbackVerifiedAt} >= ${table.createdAt} AND ${table.rollbackVerifiedAt} <= ${table.updatedAt})) AND (${table.stopStableSince} IS NULL OR (${table.stopStableSince} >= ${table.createdAt} AND ${table.stopStableSince} <= ${table.updatedAt}))`,
    ),
    check(
      "hermes_staging_acceptance_runs_cleanup_time_check",
      sql`(${table.workloadCleanupConfirmedAt} IS NULL OR (${table.workloadCleanupConfirmedAt} >= ${table.createdAt} AND ${table.workloadCleanupConfirmedAt} <= ${table.updatedAt})) AND (${table.secretsCleanupConfirmedAt} IS NULL OR (${table.secretsCleanupConfirmedAt} >= ${table.createdAt} AND ${table.secretsCleanupConfirmedAt} <= ${table.updatedAt})) AND (${table.firewallCleanupConfirmedAt} IS NULL OR (${table.firewallCleanupConfirmedAt} >= ${table.createdAt} AND ${table.firewallCleanupConfirmedAt} <= ${table.updatedAt})) AND (${table.dropletCleanupConfirmedAt} IS NULL OR (${table.dropletCleanupConfirmedAt} >= ${table.createdAt} AND ${table.dropletCleanupConfirmedAt} <= ${table.updatedAt})) AND (${table.runnerCleanupConfirmedAt} IS NULL OR (${table.runnerCleanupConfirmedAt} >= ${table.createdAt} AND ${table.runnerCleanupConfirmedAt} <= ${table.updatedAt}))`,
    ),
    check(
      "hermes_staging_acceptance_runs_completed_after_created_check",
      sql`${table.completedAt} IS NULL OR (${table.completedAt} >= ${table.createdAt} AND ${table.completedAt} <= ${table.updatedAt})`,
    ),
    uniqueIndex("hermes_staging_acceptance_runs_idempotency_idx").on(table.idempotencyKey),
    index("hermes_staging_acceptance_runs_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
    uniqueIndex("hermes_staging_acceptance_runs_one_active_idx")
      .on(table.scopeKey)
      .where(sql`${table.state} <> 'complete'`),
    index("hermes_staging_acceptance_runs_claim_idx")
      .on(table.nextAttemptAt, table.leaseExpiresAt, table.createdAt)
      .where(sql`${table.state} IN ('pending', 'executing', 'waiting')`),
  ],
);

export const agentUsagePeriods = pgTable(
  "agent_usage_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    runnerId: uuid("runner_id").references(() => runners.id),
    source: text("source").notNull().default("lifecycle"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("agent_usage_periods_source_check", sql`${table.source} IN ('lifecycle')`),
    check(
      "agent_usage_periods_stopped_after_started_check",
      sql`${table.stoppedAt} IS NULL OR ${table.stoppedAt} >= ${table.startedAt}`,
    ),
    uniqueIndex("agent_usage_periods_one_open_agent_idx")
      .on(table.agentId)
      .where(sql`${table.stoppedAt} IS NULL`),
    index("agent_usage_periods_agent_started_idx").on(table.agentId, table.startedAt),
    index("agent_usage_periods_runner_started_idx").on(table.runnerId, table.startedAt),
    index("agent_usage_periods_agent_stopped_idx").on(table.agentId, table.stoppedAt),
  ],
);

export const backups = pgTable(
  "backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    runnerId: uuid("runner_id").references(() => runners.id),
    status: text("status").$type<BackupStatus>().notNull().default("pending"),
    storageUri: text("storage_uri"),
    manifestJson: jsonb("manifest_json").$type<BackupManifest>().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "backups_status_check",
      sql`${table.status} IN ('pending', 'uploading', 'ready', 'failed', 'restoring', 'restored')`,
    ),
    check(
      "backups_storage_uri_not_empty_check",
      sql`${table.storageUri} IS NULL OR length(trim(${table.storageUri})) > 0`,
    ),
    check(
      "backups_restored_at_status_check",
      sql`(${table.status} = 'restored' AND ${table.restoredAt} IS NOT NULL) OR (${table.status} <> 'restored' AND ${table.restoredAt} IS NULL)`,
    ),
    index("backups_agent_created_idx").on(table.agentId, table.createdAt),
    index("backups_runner_idx").on(table.runnerId),
    index("backups_created_by_idx").on(table.createdBy),
    index("backups_status_idx").on(table.status),
  ],
);

export const agentConfigs = pgTable(
  "agent_configs",
  {
    agentId: uuid("agent_id")
      .primaryKey()
      .references(() => agents.id),
    systemPrompt: text("system_prompt").notNull(),
    modelProvider: text("model_provider").notNull().default("not_configured"),
    modelName: text("model_name").notNull().default("not_configured"),
    maxDailySpendCents: integer("max_daily_spend_cents").notNull().default(0),
    scheduleMode: agentScheduleModeEnum("schedule_mode").notNull().default("manual"),
    scheduleCron: text("schedule_cron"),
    timezone: text("timezone").notNull().default("UTC"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("agent_configs_max_daily_spend_nonnegative_check", sql`${table.maxDailySpendCents} >= 0`),
    check(
      "agent_configs_schedule_cron_mode_check",
      sql`(${table.scheduleMode} = 'manual' AND ${table.scheduleCron} IS NULL) OR (${table.scheduleMode} = 'cron' AND ${table.scheduleCron} IS NOT NULL)`,
    ),
  ],
);

export const agentSecrets = pgTable(
  "agent_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    kind: agentSecretKindEnum("kind").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: text("key_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    uniquenessFingerprint: text("uniqueness_fingerprint"),
    providerSubjectId: text("provider_subject_id"),
    providerUsername: text("provider_username"),
    status: agentSecretStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check("agent_secrets_ciphertext_not_empty_check", sql`length(trim(${table.ciphertext})) > 0`),
    check("agent_secrets_iv_not_empty_check", sql`length(trim(${table.iv})) > 0`),
    check("agent_secrets_auth_tag_not_empty_check", sql`length(trim(${table.authTag})) > 0`),
    check("agent_secrets_key_version_not_empty_check", sql`length(trim(${table.keyVersion})) > 0`),
    check("agent_secrets_fingerprint_check", sql`${table.fingerprint} ~ '^[0-9a-f]{16}$'`),
    check(
      "agent_secrets_uniqueness_fingerprint_check",
      sql`${table.uniquenessFingerprint} IS NULL OR ${table.uniquenessFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "agent_secrets_provider_subject_id_check",
      sql`${table.providerSubjectId} IS NULL OR ${table.providerSubjectId} ~ '^[1-9][0-9]{0,19}$'`,
    ),
    check(
      "agent_secrets_provider_username_check",
      sql`${table.providerUsername} IS NULL OR ${table.providerUsername} ~ '^[A-Za-z][A-Za-z0-9_]{4,31}$'`,
    ),
    check(
      "agent_secrets_telegram_metadata_kind_check",
      sql`${table.kind} = 'telegram_bot_token' OR (${table.uniquenessFingerprint} IS NULL AND ${table.providerSubjectId} IS NULL AND ${table.providerUsername} IS NULL)`,
    ),
    check(
      "agent_secrets_telegram_metadata_pair_check",
      sql`${table.kind} <> 'telegram_bot_token' OR (${table.uniquenessFingerprint} IS NULL AND ${table.providerSubjectId} IS NULL AND ${table.providerUsername} IS NULL) OR (${table.uniquenessFingerprint} IS NOT NULL AND ${table.providerSubjectId} IS NOT NULL)`,
    ),
    check(
      "agent_secrets_revoked_status_check",
      sql`(${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL) OR (${table.status} <> 'revoked' AND ${table.revokedAt} IS NULL)`,
    ),
    uniqueIndex("agent_secrets_active_agent_kind_idx")
      .on(table.agentId, table.kind)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("agent_secrets_active_telegram_uniqueness_idx")
      .on(table.uniquenessFingerprint)
      .where(
        sql`${table.kind} = 'telegram_bot_token' AND ${table.status} = 'active' AND ${table.uniquenessFingerprint} IS NOT NULL`,
      ),
    uniqueIndex("agent_secrets_active_telegram_subject_idx")
      .on(table.providerSubjectId)
      .where(
        sql`${table.kind} = 'telegram_bot_token' AND ${table.status} = 'active' AND ${table.providerSubjectId} IS NOT NULL`,
      ),
    index("agent_secrets_agent_status_idx").on(table.agentId, table.status),
  ],
);

export const agentEvents = pgTable("agent_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id),
  type: text("type").notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const localRunnerProcesses = pgTable(
  "local_runner_processes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    pid: integer("pid").notNull(),
    commandMetadata: jsonb("command_metadata").$type<Record<string, unknown>>().notNull(),
    status: localRunnerProcessStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("local_runner_processes_pid_positive_check", sql`${table.pid} > 0`),
    check(
      "local_runner_processes_exit_code_nonnegative_check",
      sql`${table.exitCode} IS NULL OR ${table.exitCode} >= 0`,
    ),
    check(
      "local_runner_processes_stopped_after_started_check",
      sql`${table.stoppedAt} IS NULL OR ${table.stoppedAt} >= ${table.startedAt}`,
    ),
    index("local_runner_processes_agent_started_idx").on(table.agentId, table.startedAt),
  ],
);

export const dockerRunnerContainers = pgTable(
  "docker_runner_containers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    containerId: text("container_id").notNull(),
    containerName: text("container_name").notNull(),
    image: text("image").notNull(),
    observedStatus: text("observed_status").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "docker_runner_containers_observed_status_not_empty_check",
      sql`length(trim(${table.observedStatus})) > 0`,
    ),
    check(
      "docker_runner_containers_started_finished_order_check",
      sql`${table.finishedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.finishedAt} >= ${table.startedAt}`,
    ),
    index("docker_runner_containers_agent_observed_idx").on(table.agentId, table.observedAt),
    uniqueIndex("docker_runner_containers_container_id_idx").on(table.containerId),
  ],
);

export const agentLogs = pgTable(
  "agent_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    runnerId: uuid("runner_id"),
    localRunnerProcessId: uuid("local_runner_process_id").references(() => localRunnerProcesses.id),
    dockerRunnerContainerId: uuid("docker_runner_container_id").references(
      () => dockerRunnerContainers.id,
    ),
    source: text("source").notNull().default("simulator"),
    stream: text("stream").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sequence: integer("sequence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("agent_logs_sequence_positive_check", sql`${table.sequence} > 0`),
    check("agent_logs_stream_check", sql`${table.stream} IN ('stdout', 'stderr')`),
    uniqueIndex("agent_logs_agent_sequence_idx").on(table.agentId, table.sequence),
  ],
);

export const agentApprovals = pgTable("agent_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: agentApprovalStatusEnum("status").notNull().default("pending"),
  payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
  requestedBy: text("requested_by").notNull(),
  resolvedBy: text("resolved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
