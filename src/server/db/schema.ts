import { sql } from "drizzle-orm";
import {
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

export const agentRuntimeReconciliationStateEnum = pgEnum("agent_runtime_reconciliation_state", [
  "observing",
  "recovering_stop",
  "recovering_start",
  "verifying",
  "stopping",
  "stopped",
  "circuit_open",
]);

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
    region: text("region"),
    sizeSlug: text("size_slug"),
    image: text("image"),
    provisioningStatus: text("provisioning_status"),
    provisioningError: text("provisioning_error"),
    provisioningOperationKey: text("provisioning_operation_key"),
    provisioningStartedAt: timestamp("provisioning_started_at", { withTimezone: true }),
    provisioningCompletedAt: timestamp("provisioning_completed_at", { withTimezone: true }),
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
      sql`(${table.kind} = 'manual_vps' AND ${table.provider} IS NULL AND ${table.providerResourceId} IS NULL AND ${table.region} IS NULL AND ${table.sizeSlug} IS NULL AND ${table.image} IS NULL AND ${table.provisioningStatus} IS NULL AND ${table.provisioningError} IS NULL AND ${table.provisioningStartedAt} IS NULL AND ${table.provisioningCompletedAt} IS NULL) OR (${table.kind} = 'digitalocean' AND ${table.provider} = 'digitalocean' AND ${table.region} IS NOT NULL AND ${table.sizeSlug} IS NOT NULL AND ${table.image} IS NOT NULL AND ${table.provisioningStatus} IS NOT NULL)`,
    ),
    check(
      "runners_provisioning_completed_after_started_check",
      sql`${table.provisioningCompletedAt} IS NULL OR ${table.provisioningStartedAt} IS NULL OR ${table.provisioningCompletedAt} >= ${table.provisioningStartedAt}`,
    ),
    check(
      "runners_provisioning_operation_key_check",
      sql`${table.provisioningOperationKey} IS NULL OR (${table.kind} = 'digitalocean' AND ${table.provisioningOperationKey} ~ '^agentbay-deploy-[0-9a-f]{32}$')`,
    ),
    index("runners_user_status_idx").on(table.userId, table.status),
    index("runners_provider_resource_idx").on(table.provider, table.providerResourceId),
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
      sql`${table.canaryState} IN ('not_started', 'started', 'passed', 'failed', 'outcome_unknown')`,
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
      sql`${table.stage} NOT IN ('connecting_telegram', 'ready') OR ${table.canaryState} = 'passed'`,
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
