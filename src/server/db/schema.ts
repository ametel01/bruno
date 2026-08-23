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
import type { AgentDeploymentChoices } from "@/src/server/agents/agent-deployment-choices";
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

export const operatorStatusEnum = pgEnum("operator_status", ["active", "archived"]);
export const founderReleaseStageEnum = pgEnum("founder_release_stage", [
  "owner_preview",
  "trusted_preview",
  "external_beta",
  "initial_general_release",
]);
export const founderReleaseDecisionOutcomeEnum = pgEnum("founder_release_decision_outcome", [
  "enter",
  "deny",
  "hold",
  "resume",
]);
export const founderProductEntitlementStatusEnum = pgEnum("founder_product_entitlement_status", [
  "verified",
  "past_due",
  "unpaid",
  "cancelled",
  "expired",
  "refunded",
]);
export const founderIdentityRecoveryStatusEnum = pgEnum("founder_identity_recovery_status", [
  "pending",
  "recovered",
]);
export const founderIdentityRecoveryReasonEnum = pgEnum("founder_identity_recovery_reason", [
  "clerk_user_deleted",
  "clerk_identity_lost",
]);
export const founderIdentityRecoveryReceiptKindEnum = pgEnum(
  "founder_identity_recovery_receipt_kind",
  ["identity_loss_recorded", "recovery_denied", "identity_rebound"],
);
export const founderCommerceLifecycleReceiptKindEnum = pgEnum(
  "founder_commerce_lifecycle_receipt_kind",
  ["portal_issued", "cancellation", "refund"],
);
export const founderRecoveryArchiveStatusEnum = pgEnum("founder_recovery_archive_status", [
  "pending",
  "verified",
  "failed",
  "deleted",
]);
export const founderProductContractScenarioEnum = pgEnum("founder_product_contract_scenario", [
  "release_stage_admission",
  "external_beta_cohort_lifecycle",
  "product_entitlement_lifecycle",
  "subscription_lifecycle",
  "identity_recovery_lifecycle",
  "recovery_archive_lifecycle",
  "infrastructure_retirement",
]);
export const founderInfrastructureRetirementStatusEnum = pgEnum(
  "founder_infrastructure_retirement_status",
  ["in_progress", "completed", "failed"],
);
export const operatorDeletionRequestKindEnum = pgEnum("operator_deletion_request_kind", [
  "retained_data",
  "account_closure",
]);
export const operatorDeletionRequestStatusEnum = pgEnum("operator_deletion_request_status", [
  "requested",
  "access_stopped",
  "purge_pending",
  "active_purge_complete",
  "backup_expiry_pending",
  "completed",
  "failed",
]);
export const operatorDeletionStageEnum = pgEnum("operator_deletion_stage", [
  "requested",
  "access_stopped",
  "commerce_cancellation",
  "active_purge_complete",
  "backup_expiry",
  "revocation",
]);
export const operatorDeletionRevocationStatusEnum = pgEnum("operator_deletion_revocation_status", [
  "pending",
  "succeeded",
  "failed",
]);
export const operatorDeletionCommerceCancellationStatusEnum = pgEnum(
  "operator_deletion_commerce_cancellation_status",
  ["pending", "succeeded", "failed"],
);
export const operatorDeletionBackupStatusEnum = pgEnum("operator_deletion_backup_status", [
  "pending",
  "expired",
  "failed",
]);
export const operatorRetentionRunStatusEnum = pgEnum("operator_retention_run_status", [
  "running",
  "completed",
  "failed",
]);
export const operatorRetentionTombstoneKindEnum = pgEnum("operator_retention_tombstone_kind", [
  "working_context",
  "relationship_record",
  "governance",
  "connection",
  "action",
  "deletion",
  "support",
]);
export const operatorMailOfferDispositionEnum = pgEnum("operator_mail_offer_disposition", [
  "enabled",
  "dismissed",
]);

export const operatorPreparationStatusEnum = pgEnum("operator_preparation_status", [
  "awaiting_timezone",
  "preparing",
  "ready",
  "needs_attention",
]);

export const operatorRuntimeStatusEnum = pgEnum("operator_runtime_status", [
  "awaiting_timezone",
  "preparing",
  "ready",
  "needs_attention",
]);

export const operatorRuntimeTransportStateEnum = pgEnum("operator_runtime_transport_state", [
  "unknown",
  "starting",
  "connected",
  "failed",
]);

export const operatorRuntimeSafetyStateEnum = pgEnum("operator_runtime_safety_state", [
  "unknown",
  "verified",
  "failed",
]);

export const operatorAiConnectionStatusEnum = pgEnum("operator_ai_connection_status", [
  "authorizing",
  "verifying",
  "ready",
  "needs_attention",
  "paused",
  "disconnected",
]);

export const operatorAiAuthorizationStateEnum = pgEnum("operator_ai_authorization_state", [
  "pending",
  "authorized",
  "denied",
  "expired",
  "revoked",
  "revocation_unconfirmed",
]);

export const operatorAiCapacityStateEnum = pgEnum("operator_ai_capacity_state", [
  "unknown",
  "available",
  "exhausted",
  "unavailable",
]);

export const operatorAiInferenceStateEnum = pgEnum("operator_ai_inference_state", [
  "unknown",
  "passed",
  "failed",
]);

export const operatorAiConnectionReceiptKindEnum = pgEnum("operator_ai_connection_receipt_kind", [
  "authorized",
  "reauthorized",
  "verification_failed",
  "revoked",
  "disconnected",
]);

export const operatorCalendarConnectionStatusEnum = pgEnum("operator_calendar_connection_status", [
  "authorizing",
  "selecting",
  "verifying",
  "ready",
  "needs_attention",
  "disconnected",
]);

export const operatorCalendarAuthorizationStateEnum = pgEnum(
  "operator_calendar_authorization_state",
  ["pending", "authorized", "expired", "revoked", "revocation_unconfirmed"],
);

export const operatorCalendarResourceStatusEnum = pgEnum("operator_calendar_resource_status", [
  "available",
  "removed",
]);

export const operatorCalendarConnectionReceiptKindEnum = pgEnum(
  "operator_calendar_connection_receipt_kind",
  ["authorized", "reauthorized", "verified", "verification_failed", "revoked", "disconnected"],
);

export const operatorCalendarEvidenceStateEnum = pgEnum("operator_calendar_evidence_state", [
  "unknown",
  "current",
  "unavailable",
]);

export const operatorMailConnectionStatusEnum = pgEnum("operator_mail_connection_status", [
  "authorizing",
  "selecting",
  "verifying",
  "ready",
  "needs_attention",
  "disconnected",
]);

export const operatorMailAuthorizationStateEnum = pgEnum("operator_mail_authorization_state", [
  "pending",
  "authorized",
  "denied",
  "expired",
  "revoked",
  "revocation_unconfirmed",
]);

export const operatorMailResourceStatusEnum = pgEnum("operator_mail_resource_status", [
  "available",
  "removed",
]);

export const operatorMailConnectionReceiptKindEnum = pgEnum(
  "operator_mail_connection_receipt_kind",
  ["authorized", "reauthorized", "verified", "verification_failed", "revoked", "disconnected"],
);

export const operatorMailEvidenceStateEnum = pgEnum("operator_mail_evidence_state", [
  "unknown",
  "current",
  "unavailable",
]);

export const operatorMailSuiteStatusEnum = pgEnum("operator_mail_suite_status", [
  "calendar_unavailable",
  "matched",
  "mismatch",
]);

export const operatorMailSendingConnectionStatusEnum = pgEnum(
  "operator_mail_sending_connection_status",
  ["authorizing", "verifying", "ready", "needs_attention", "disconnected"],
);

export const operatorMailSendingAuthorizationStateEnum = pgEnum(
  "operator_mail_sending_authorization_state",
  ["pending", "authorized", "denied", "expired", "revoked", "revocation_unconfirmed"],
);

export const operatorMailSendingConnectionReceiptKindEnum = pgEnum(
  "operator_mail_sending_connection_receipt_kind",
  [
    "authorized",
    "reauthorized",
    "verified",
    "verification_failed",
    "denied",
    "revoked",
    "disconnected",
  ],
);

export const operatorPrimaryCommunicationsSuiteStatusEnum = pgEnum(
  "operator_primary_communications_suite_status",
  ["active", "needs_attention"],
);

export const operatorLimitedOperationStatusEnum = pgEnum("operator_limited_operation_status", [
  "awaiting_consent",
  "limited",
  "core",
  "needs_attention",
]);

export const operatorProcessingConsentStatusEnum = pgEnum("operator_processing_consent_status", [
  "active",
  "revoked",
]);

export const operatorAuthorityModeEnum = pgEnum("operator_authority_mode", [
  "always",
  "approval_required",
  "never",
]);

export const operatorGovernanceReceiptKindEnum = pgEnum("operator_governance_receipt_kind", [
  "processing_consent",
  "authority_policy",
]);

export const operatorActionFamilyEnum = pgEnum("operator_action_family", [
  "observe_evidence",
  "relationship_maintenance",
  "prepare_work",
  "external_communication",
  "meeting_management",
  "commercial_commitment",
  "data_control",
]);

export const operatorProposedActionStateEnum = pgEnum("operator_proposed_action_state", [
  "proposed",
  "awaiting_approval",
  "authorized",
  "executing",
  "succeeded",
  "failed",
  "outcome_uncertain",
  "declined",
  "expired",
  "superseded",
  "cancelled",
  "blocked",
]);

export const operatorActionDecisionKindEnum = pgEnum("operator_action_decision_kind", [
  "approve",
  "request_changes",
  "decline",
]);

export const operatorActionExecutionAttemptPhaseEnum = pgEnum(
  "operator_action_execution_attempt_phase",
  ["started", "acknowledged", "rejected", "ambiguous"],
);

export const operatorActionReceiptOutcomeEnum = pgEnum("operator_action_receipt_outcome", [
  "succeeded",
  "failed",
  "outcome_uncertain",
]);

export const operatorMorningBriefStatusEnum = pgEnum("operator_morning_brief_status", [
  "prepared",
  "opened",
]);

export const operatorMorningBriefAttentionKindEnum = pgEnum(
  "operator_morning_brief_attention_kind",
  ["unanswered_inbound", "external_meeting", "overdue_relationship_work", "proposed_action"],
);

export const operatorConversationStatusEnum = pgEnum("operator_conversation_status", [
  "active",
  "paused",
]);

export const operatorConversationMessageRoleEnum = pgEnum("operator_conversation_message_role", [
  "founder",
  "operator",
]);

export const operatorConversationMessageStatusEnum = pgEnum(
  "operator_conversation_message_status",
  ["complete", "paused"],
);

export const operatorConversationWorkStateEnum = pgEnum("operator_conversation_work_state", [
  "running",
  "completed",
  "paused",
  "failed",
]);

export const operatorTroubleshootingIncidentStatusEnum = pgEnum(
  "operator_troubleshooting_incident_status",
  ["open", "closed"],
);

export const operatorTroubleshootingEvidenceKindEnum = pgEnum(
  "operator_troubleshooting_evidence_kind",
  ["recovery_summary", "capability_impact", "safe_action"],
);

export const operatorSupportAccessGrantStatusEnum = pgEnum("operator_support_access_grant_status", [
  "active",
  "revoked",
  "expired",
]);

export const operatorSupportAccessScopeEnum = pgEnum("operator_support_access_scope", [
  "troubleshooting_evidence",
  "capability_status",
  "recovery_checkpoint",
]);

export const operatorSupportReceiptKindEnum = pgEnum("operator_support_receipt_kind", [
  "grant_created",
  "grant_revoked",
  "tool_invoked",
  "proposal_created",
  "decision_recorded",
  "repair_executed",
]);

export const operatorSupportRepairKindEnum = pgEnum("operator_support_repair_kind", [
  "rerun_verification",
  "restart_from_checkpoint",
  "replace_runtime_from_verified_release",
  "rotate_bruno_transport_credential",
]);

export const operatorSupportRepairStateEnum = pgEnum("operator_support_repair_state", [
  "proposed",
  "approved",
  "declined",
  "executing",
  "succeeded",
  "failed",
  "outcome_uncertain",
  "closed_without_recovery",
]);

export const operatorSupportRepairDecisionKindEnum = pgEnum(
  "operator_support_repair_decision_kind",
  ["approve", "decline"],
);

export const operatorActionPreviewStateEnum = pgEnum("operator_action_preview_state", ["draft"]);

export const operatorRelationshipStateEnum = pgEnum("operator_relationship_state", [
  "lead",
  "client",
  "partner",
  "ignored",
]);

export const operatorRelationshipStatusEnum = pgEnum("operator_relationship_status", [
  "active",
  "closed",
  "ignored",
]);

export const operatorRelationshipCandidateMatchKindEnum = pgEnum(
  "operator_relationship_candidate_match_kind",
  ["exact_provider_identity", "exact_email", "fuzzy_name", "fuzzy_company", "fuzzy_domain"],
);

export const operatorRelationshipCandidateStatusEnum = pgEnum(
  "operator_relationship_candidate_status",
  ["pending", "confirmed", "rejected"],
);

export const operatorRelationshipEvidenceSourceKindEnum = pgEnum(
  "operator_relationship_evidence_source_kind",
  ["calendar", "mail"],
);

export const operatorRelationshipEvidenceStateEnum = pgEnum(
  "operator_relationship_evidence_state",
  ["current", "stale", "disconnected", "unavailable"],
);

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
  "exhausted",
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

export const founderIdentityRecoveries = pgTable(
  "founder_identity_recoveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    status: founderIdentityRecoveryStatusEnum("status").notNull().default("pending"),
    reason: founderIdentityRecoveryReasonEnum("reason").notNull(),
    priorClerkSubjectDigest: text("prior_clerk_subject_digest").notNull(),
    replacementClerkSubjectDigest: text("replacement_clerk_subject_digest"),
    providerEventId: text("provider_event_id").notNull(),
    providerEventDigest: text("provider_event_digest").notNull(),
    lossObservedAt: timestamp("loss_observed_at", { withTimezone: true }).notNull(),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("founder_identity_recoveries_provider_event_idx").on(table.providerEventId),
    uniqueIndex("founder_identity_recoveries_pending_user_idx")
      .on(table.userId)
      .where(sql`${table.status} = 'pending'`),
    check(
      "founder_identity_recoveries_prior_subject_digest_check",
      sql`${table.priorClerkSubjectDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_identity_recoveries_replacement_subject_digest_check",
      sql`${table.replacementClerkSubjectDigest} IS NULL OR ${table.replacementClerkSubjectDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_identity_recoveries_provider_event_digest_check",
      sql`${table.providerEventDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_identity_recoveries_status_check",
      sql`(${table.status} = 'pending' AND ${table.replacementClerkSubjectDigest} IS NULL AND ${table.recoveredAt} IS NULL) OR (${table.status} = 'recovered' AND ${table.replacementClerkSubjectDigest} IS NOT NULL AND ${table.recoveredAt} IS NOT NULL)`,
    ),
    index("founder_identity_recoveries_user_status_idx").on(
      table.userId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const founderIdentityRecoveryCredentials = pgTable(
  "founder_identity_recovery_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    credentialDigest: text("credential_digest").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("founder_identity_recovery_credentials_user_idx").on(table.userId),
    uniqueIndex("founder_identity_recovery_credentials_digest_idx").on(table.credentialDigest),
    check(
      "founder_identity_recovery_credentials_digest_check",
      sql`${table.credentialDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_identity_recovery_credentials_window_check",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
  ],
);

export const founderIdentityRecoveryReceipts = pgTable(
  "founder_identity_recovery_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recoveryId: uuid("recovery_id")
      .notNull()
      .references(() => founderIdentityRecoveries.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: founderIdentityRecoveryReceiptKindEnum("kind").notNull(),
    subjectDigest: text("subject_digest"),
    evidenceDigest: text("evidence_digest").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("founder_identity_recovery_receipts_evidence_idx").on(table.evidenceDigest),
    check(
      "founder_identity_recovery_receipts_subject_digest_check",
      sql`${table.subjectDigest} IS NULL OR ${table.subjectDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_identity_recovery_receipts_evidence_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    index("founder_identity_recovery_receipts_user_occurred_idx").on(
      table.userId,
      table.occurredAt,
    ),
  ],
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

export const operators = pgTable(
  "operators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    status: operatorStatusEnum("status").notNull().default("active"),
    mailOfferDisposition: operatorMailOfferDispositionEnum("mail_offer_disposition"),
    externalActionPause: boolean("external_action_pause").notNull().default(false),
    externalActionPauseReason: text("external_action_pause_reason"),
    externalActionPausedAt: timestamp("external_action_paused_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "operators_archived_status_check",
      sql`(${table.status} = 'archived' AND ${table.archivedAt} IS NOT NULL) OR (${table.status} = 'active' AND ${table.archivedAt} IS NULL)`,
    ),
    check(
      "operators_external_action_pause_pair_check",
      sql`(${table.externalActionPause} = false AND ${table.externalActionPauseReason} IS NULL AND ${table.externalActionPausedAt} IS NULL) OR (${table.externalActionPause} = true AND ${table.externalActionPauseReason} IS NOT NULL AND ${table.externalActionPausedAt} IS NOT NULL)`,
    ),
    uniqueIndex("operators_user_id_idx").on(table.userId),
    index("operators_status_idx").on(table.status),
  ],
);

export const founderReleaseDecisions = pgTable(
  "founder_release_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    stage: founderReleaseStageEnum("stage").notNull(),
    outcome: founderReleaseDecisionOutcomeEnum("outcome").notNull(),
    applicationRevision: text("application_revision").notNull(),
    runtimeRevision: text("runtime_revision").notNull(),
    capabilityManifest: jsonb("capability_manifest").$type<readonly string[]>().notNull(),
    openAiQualificationExpiresAt: timestamp("openai_qualification_expires_at", {
      withTimezone: true,
    }),
    calendarQualificationExpiresAt: timestamp("calendar_qualification_expires_at", {
      withTimezone: true,
    }),
    externalBetaCohort: text("external_beta_cohort"),
    affectedCapabilities: jsonb("affected_capabilities")
      .$type<readonly string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    evidenceDigests: jsonb("evidence_digests").$type<readonly string[]>().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "founder_release_decisions_application_revision_check",
      sql`${table.applicationRevision} ~ '^[a-f0-9]{40}$'`,
    ),
    check(
      "founder_release_decisions_runtime_revision_check",
      sql`length(trim(${table.runtimeRevision})) > 0`,
    ),
    check(
      "founder_release_decisions_affected_capabilities_check",
      sql`(${table.outcome} = 'hold' AND jsonb_array_length(${table.affectedCapabilities}) > 0) OR (${table.outcome} <> 'hold' AND jsonb_array_length(${table.affectedCapabilities}) = 0)`,
    ),
    check(
      "founder_release_decisions_affected_capabilities_manifest_check",
      sql`${table.affectedCapabilities} <@ ${table.capabilityManifest}`,
    ),
    check(
      "founder_release_decisions_owner_preview_manifest_check",
      sql`${table.stage} <> 'owner_preview' OR (jsonb_array_length(${table.capabilityManifest}) = 2 AND ${table.capabilityManifest} @> '["openai", "calendar_reading"]'::jsonb)`,
    ),
    check(
      "founder_release_decisions_owner_preview_qualification_expiry_check",
      sql`${table.stage} <> 'owner_preview' OR ${table.outcome} = 'deny' OR (${table.openAiQualificationExpiresAt} IS NOT NULL AND ${table.calendarQualificationExpiresAt} IS NOT NULL)`,
    ),
    check(
      "founder_release_decisions_trusted_preview_manifest_check",
      sql`${table.stage} <> 'trusted_preview' OR (jsonb_array_length(${table.capabilityManifest}) = 2 AND ${table.capabilityManifest} @> '["openai", "calendar_reading"]'::jsonb)`,
    ),
    check(
      "founder_release_decisions_trusted_preview_qualification_expiry_check",
      sql`${table.stage} <> 'trusted_preview' OR ${table.outcome} NOT IN ('enter', 'resume') OR (${table.openAiQualificationExpiresAt} IS NOT NULL AND ${table.calendarQualificationExpiresAt} IS NOT NULL)`,
    ),
    check(
      "founder_release_decisions_external_beta_cohort_check",
      sql`(${table.stage} = 'external_beta' AND ${table.externalBetaCohort} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') OR (${table.stage} <> 'external_beta' AND ${table.externalBetaCohort} IS NULL)`,
    ),
    check(
      "founder_release_decisions_external_beta_manifest_check",
      sql`${table.stage} <> 'external_beta' OR (jsonb_array_length(${table.capabilityManifest}) = 5 AND ${table.capabilityManifest} @> '["openai", "anthropic", "calendar_reading", "gmail_reading", "gmail_sending"]'::jsonb)`,
    ),
    index("founder_release_decisions_user_stage_idx").on(
      table.userId,
      table.stage,
      table.decidedAt,
    ),
  ],
);

export const founderPreviewQualifications = pgTable(
  "founder_preview_qualifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stage: founderReleaseStageEnum("stage").notNull(),
    cohort: text("cohort").notNull(),
    capability: text("capability").notNull(),
    applicationRevision: text("application_revision").notNull(),
    runtimeRevision: text("runtime_revision").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "founder_preview_qualifications_external_beta_stage_check",
      sql`${table.stage} = 'external_beta'`,
    ),
    check(
      "founder_preview_qualifications_cohort_check",
      sql`${table.cohort} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      "founder_preview_qualifications_capability_check",
      sql`${table.capability} IN ('openai', 'anthropic', 'calendar_reading', 'gmail_reading', 'gmail_sending')`,
    ),
    check(
      "founder_preview_qualifications_application_revision_check",
      sql`${table.applicationRevision} ~ '^[a-f0-9]{40}$'`,
    ),
    check(
      "founder_preview_qualifications_runtime_revision_check",
      sql`length(trim(${table.runtimeRevision})) > 0`,
    ),
    check(
      "founder_preview_qualifications_evidence_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_preview_qualifications_time_check",
      sql`${table.observedAt} < ${table.expiresAt}`,
    ),
    uniqueIndex("founder_preview_qualifications_evidence_idx").on(
      table.stage,
      table.cohort,
      table.applicationRevision,
      table.runtimeRevision,
      table.capability,
      table.evidenceDigest,
    ),
    index("founder_preview_qualifications_candidate_idx").on(
      table.stage,
      table.cohort,
      table.applicationRevision,
      table.runtimeRevision,
      table.capability,
      table.observedAt,
    ),
  ],
);

export const founderTrustedPreviewInvitations = pgTable(
  "founder_trusted_preview_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cohortOwnerUserId: uuid("cohort_owner_user_id")
      .notNull()
      .references(() => users.id),
    stageDecisionId: uuid("stage_decision_id")
      .notNull()
      .references(() => founderReleaseDecisions.id),
    cohortSlot: integer("cohort_slot").notNull(),
    invitationDigest: text("invitation_digest").notNull(),
    invitedClerkSubjectDigest: text("invited_clerk_subject_digest").notNull(),
    serviceBusinessEvidenceDigest: text("service_business_evidence_digest").notNull(),
    status: text("status").notNull().default("invited"),
    participantUserId: uuid("participant_user_id").references(() => users.id),
    participantOperatorId: uuid("participant_operator_id").references(() => operators.id),
    admissionDecisionId: uuid("admission_decision_id").references(() => founderReleaseDecisions.id),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "founder_trusted_preview_invitations_slot_check",
      sql`${table.cohortSlot} BETWEEN 1 AND 3`,
    ),
    check(
      "founder_trusted_preview_invitations_digest_check",
      sql`${table.invitationDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${table.invitedClerkSubjectDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${table.serviceBusinessEvidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_trusted_preview_invitations_state_check",
      sql`(${table.status} = 'invited' AND ${table.participantUserId} IS NULL AND ${table.participantOperatorId} IS NULL AND ${table.admissionDecisionId} IS NULL AND ${table.admittedAt} IS NULL AND ${table.revokedAt} IS NULL) OR (${table.status} = 'admitted' AND ${table.participantUserId} IS NOT NULL AND ${table.participantOperatorId} IS NOT NULL AND ${table.admissionDecisionId} IS NOT NULL AND ${table.admittedAt} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.participantUserId} IS NULL AND ${table.participantOperatorId} IS NULL AND ${table.admissionDecisionId} IS NULL AND ${table.admittedAt} IS NULL AND ${table.revokedAt} IS NOT NULL)`,
    ),
    check(
      "founder_trusted_preview_invitations_owner_participant_check",
      sql`${table.participantUserId} IS NULL OR ${table.participantUserId} <> ${table.cohortOwnerUserId}`,
    ),
    uniqueIndex("founder_trusted_preview_invitations_slot_idx")
      .on(table.cohortSlot)
      .where(sql`${table.status} <> 'revoked'`),
    uniqueIndex("founder_trusted_preview_invitations_digest_idx").on(table.invitationDigest),
    uniqueIndex("founder_trusted_preview_invitations_clerk_subject_idx")
      .on(table.invitedClerkSubjectDigest)
      .where(sql`${table.status} <> 'revoked'`),
    uniqueIndex("founder_trusted_preview_invitations_participant_idx").on(table.participantUserId),
    uniqueIndex("founder_trusted_preview_invitations_operator_idx").on(table.participantOperatorId),
    index("founder_trusted_preview_invitations_owner_status_idx").on(
      table.cohortOwnerUserId,
      table.status,
      table.cohortSlot,
    ),
  ],
);

export const founderExternalBetaInvitations = pgTable(
  "founder_external_beta_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cohortOwnerUserId: uuid("cohort_owner_user_id")
      .notNull()
      .references(() => users.id),
    stageDecisionId: uuid("stage_decision_id")
      .notNull()
      .references(() => founderReleaseDecisions.id),
    cohort: text("cohort").notNull(),
    cohortSlot: integer("cohort_slot").notNull(),
    invitationDigest: text("invitation_digest").notNull(),
    invitedClerkSubjectDigest: text("invited_clerk_subject_digest").notNull(),
    namedFounderDigest: text("named_founder_digest").notNull(),
    workspaceDigest: text("workspace_digest").notNull(),
    independenceEvidenceDigest: text("independence_evidence_digest").notNull(),
    status: text("status").notNull().default("invited"),
    participantUserId: uuid("participant_user_id").references(() => users.id),
    participantOperatorId: uuid("participant_operator_id").references(() => operators.id),
    admissionDecisionId: uuid("admission_decision_id").references(() => founderReleaseDecisions.id),
    betaCompactDigest: text("beta_compact_digest"),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull(),
    invitationExpiresAt: timestamp("invitation_expires_at", { withTimezone: true }).notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    retirementDueAt: timestamp("retirement_due_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    paymentMethodCollected: boolean("payment_method_collected").notNull().default(false),
    automaticPaidConversion: boolean("automatic_paid_conversion").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "founder_external_beta_invitations_cohort_check",
      sql`${table.cohort} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND ${table.cohortSlot} BETWEEN 1 AND 10`,
    ),
    check(
      "founder_external_beta_invitations_digest_check",
      sql`${table.invitationDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${table.invitedClerkSubjectDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${table.namedFounderDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${table.workspaceDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${table.independenceEvidenceDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${table.betaCompactDigest} IS NULL OR ${table.betaCompactDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "founder_external_beta_invitations_exact_windows_check",
      sql`${table.invitationExpiresAt} = ${table.invitedAt} + interval '7 days' AND (${table.admittedAt} IS NULL OR (${table.accessExpiresAt} = ${table.admittedAt} + interval '14 days' AND ${table.retirementDueAt} = ${table.accessExpiresAt} + interval '1 hour'))`,
    ),
    check(
      "founder_external_beta_invitations_free_nonconverting_check",
      sql`${table.paymentMethodCollected} = false AND ${table.automaticPaidConversion} = false`,
    ),
    check(
      "founder_external_beta_invitations_state_check",
      sql`(${table.status} = 'invited' AND ${table.participantUserId} IS NULL AND ${table.participantOperatorId} IS NULL AND ${table.admissionDecisionId} IS NULL AND ${table.betaCompactDigest} IS NULL AND ${table.admittedAt} IS NULL AND ${table.accessExpiresAt} IS NULL AND ${table.retirementDueAt} IS NULL AND ${table.expiredAt} IS NULL AND ${table.withdrawnAt} IS NULL) OR (${table.status} = 'admitted' AND ${table.participantUserId} IS NOT NULL AND ${table.participantOperatorId} IS NOT NULL AND ${table.admissionDecisionId} IS NOT NULL AND ${table.betaCompactDigest} IS NOT NULL AND ${table.admittedAt} IS NOT NULL AND ${table.accessExpiresAt} IS NOT NULL AND ${table.retirementDueAt} IS NOT NULL AND ${table.expiredAt} IS NULL AND ${table.withdrawnAt} IS NULL) OR (${table.status} = 'expired' AND ${table.participantUserId} IS NOT NULL AND ${table.participantOperatorId} IS NOT NULL AND ${table.admissionDecisionId} IS NOT NULL AND ${table.betaCompactDigest} IS NOT NULL AND ${table.admittedAt} IS NOT NULL AND ${table.accessExpiresAt} IS NOT NULL AND ${table.retirementDueAt} IS NOT NULL AND ${table.expiredAt} = ${table.accessExpiresAt} AND ${table.withdrawnAt} IS NULL) OR (${table.status} = 'withdrawn' AND ${table.participantUserId} IS NOT NULL AND ${table.participantOperatorId} IS NOT NULL AND ${table.admissionDecisionId} IS NOT NULL AND ${table.betaCompactDigest} IS NOT NULL AND ${table.admittedAt} IS NOT NULL AND ${table.accessExpiresAt} IS NOT NULL AND ${table.retirementDueAt} IS NOT NULL AND ${table.expiredAt} IS NULL AND ${table.withdrawnAt} IS NOT NULL)`,
    ),
    uniqueIndex("founder_external_beta_invitations_slot_idx").on(
      table.stageDecisionId,
      table.cohortSlot,
    ),
    uniqueIndex("founder_external_beta_invitations_digest_idx").on(table.invitationDigest),
    uniqueIndex("founder_external_beta_invitations_clerk_subject_idx").on(
      table.invitedClerkSubjectDigest,
    ),
    uniqueIndex("founder_external_beta_invitations_workspace_idx").on(table.workspaceDigest),
    uniqueIndex("founder_external_beta_invitations_participant_idx").on(table.participantUserId),
    uniqueIndex("founder_external_beta_invitations_operator_idx").on(table.participantOperatorId),
    index("founder_external_beta_invitations_cohort_status_idx").on(
      table.cohort,
      table.status,
      table.cohortSlot,
    ),
    index("founder_external_beta_invitations_expiry_idx").on(
      table.status,
      table.accessExpiresAt,
      table.retirementDueAt,
    ),
  ],
);

export const founderCheckoutCorrelations = pgTable(
  "founder_checkout_correlations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    correlationDigest: text("correlation_digest").notNull(),
    generation: integer("generation").notNull().default(1),
    status: text("status").notNull().default("pending"),
    providerCheckoutId: text("provider_checkout_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    providerOrderId: text("provider_order_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    paymentDetectedAt: timestamp("payment_detected_at", { withTimezone: true }),
    reconciliationDueAt: timestamp("reconciliation_due_at", { withTimezone: true }),
    refundRequestedAt: timestamp("refund_requested_at", { withTimezone: true }),
    refundLeaseToken: uuid("refund_lease_token"),
    refundLeaseExpiresAt: timestamp("refund_lease_expires_at", { withTimezone: true }),
    refundAttemptCount: integer("refund_attempt_count").notNull().default(0),
    refundLastErrorCode: text("refund_last_error_code"),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closureReason: text("closure_reason"),
  },
  (table) => [
    uniqueIndex("founder_checkout_correlations_digest_idx").on(table.correlationDigest),
    uniqueIndex("founder_checkout_correlations_user_generation_idx").on(
      table.userId,
      table.generation,
    ),
    uniqueIndex("founder_checkout_correlations_subscription_idx").on(table.providerSubscriptionId),
    uniqueIndex("founder_checkout_correlations_order_idx").on(table.providerOrderId),
    check(
      "founder_checkout_correlations_digest_check",
      sql`${table.correlationDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check("founder_checkout_correlations_generation_check", sql`${table.generation} >= 1`),
    check(
      "founder_checkout_correlations_status_check",
      sql`${table.status} IN ('pending', 'consumed', 'refund_pending', 'closed')`,
    ),
    check(
      "founder_checkout_correlations_consumed_check",
      sql`(${table.status} = 'pending' AND ${table.consumedAt} IS NULL AND ${table.closedAt} IS NULL AND ${table.closureReason} IS NULL) OR (${table.status} IN ('consumed', 'refund_pending') AND ${table.consumedAt} IS NOT NULL AND ${table.closedAt} IS NULL AND ${table.closureReason} IS NULL) OR (${table.status} = 'closed' AND ${table.consumedAt} IS NOT NULL AND ${table.closedAt} IS NOT NULL AND ${table.closureReason} IS NOT NULL)`,
    ),
    check(
      "founder_checkout_correlations_payment_check",
      sql`(${table.paymentDetectedAt} IS NULL AND ${table.reconciliationDueAt} IS NULL AND ${table.providerSubscriptionId} IS NULL AND ${table.providerOrderId} IS NULL) OR (${table.paymentDetectedAt} IS NOT NULL AND ${table.reconciliationDueAt} = ${table.paymentDetectedAt} + interval '1 hour' AND ${table.providerSubscriptionId} IS NOT NULL AND ${table.providerOrderId} IS NOT NULL)`,
    ),
    check(
      "founder_checkout_correlations_refund_check",
      sql`(${table.refundRequestedAt} IS NULL AND ${table.refundLeaseToken} IS NULL AND ${table.refundLeaseExpiresAt} IS NULL AND ${table.refundedAt} IS NULL AND ${table.refundAttemptCount} = 0) OR (${table.refundRequestedAt} IS NOT NULL AND ${table.refundAttemptCount} > 0 AND (${table.refundedAt} IS NULL OR ${table.refundedAt} >= ${table.refundRequestedAt}))`,
    ),
    check(
      "founder_checkout_correlations_refund_lease_check",
      sql`(${table.refundLeaseToken} IS NULL AND ${table.refundLeaseExpiresAt} IS NULL) OR (${table.status} = 'refund_pending' AND ${table.refundLeaseToken} IS NOT NULL AND ${table.refundLeaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "founder_checkout_correlations_closed_check",
      sql`${table.status} <> 'closed' OR (${table.closureReason} IN ('payment_without_access_refunded', 'payment_without_access_refunded_superseded') AND ${table.refundedAt} IS NOT NULL)`,
    ),
    check(
      "founder_checkout_correlations_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    index("founder_checkout_correlations_user_status_idx").on(table.userId, table.status),
    index("founder_checkout_correlations_reconciliation_due_idx").on(
      table.status,
      table.reconciliationDueAt,
    ),
  ],
);

export const founderCommerceEvents = pgTable(
  "founder_commerce_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerEventId: text("provider_event_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    checkoutCorrelationId: uuid("checkout_correlation_id")
      .notNull()
      .references(() => founderCheckoutCorrelations.id),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    providerOrderId: text("provider_order_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    applicationStatus: text("application_status").notNull().default("pending"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    uniqueIndex("founder_commerce_events_provider_event_id_idx").on(table.providerEventId),
    check(
      "founder_commerce_events_payload_digest_check",
      sql`${table.payloadDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_commerce_events_signature_verified_check",
      sql`${table.signatureVerified} = true`,
    ),
    check(
      "founder_commerce_events_application_check",
      sql`(${table.applicationStatus} = 'pending' AND ${table.appliedAt} IS NULL) OR (${table.applicationStatus} IN ('applied', 'ignored') AND ${table.appliedAt} IS NOT NULL AND ${table.lastErrorCode} IS NULL)`,
    ),
    index("founder_commerce_events_user_occurred_idx").on(table.userId, table.occurredAt),
  ],
);

export const founderCommerceLifecycleReceipts = pgTable(
  "founder_commerce_lifecycle_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sourceEventId: uuid("source_event_id").references(() => founderCommerceEvents.id),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    kind: founderCommerceLifecycleReceiptKindEnum("kind").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    portalExpiresAt: timestamp("portal_expires_at", { withTimezone: true }),
    evidenceDigest: text("evidence_digest").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("founder_commerce_lifecycle_receipts_event_kind_idx").on(
      table.sourceEventId,
      table.kind,
    ),
    check(
      "founder_commerce_lifecycle_receipts_shape_check",
      sql`(${table.kind} = 'portal_issued' AND ${table.sourceEventId} IS NULL AND ${table.effectiveAt} IS NULL AND ${table.portalExpiresAt} IS NOT NULL) OR (${table.kind} = 'cancellation' AND ${table.sourceEventId} IS NOT NULL AND ${table.effectiveAt} IS NOT NULL AND ${table.portalExpiresAt} IS NULL) OR (${table.kind} = 'refund' AND ${table.sourceEventId} IS NOT NULL AND ${table.effectiveAt} IS NOT NULL AND ${table.portalExpiresAt} IS NULL)`,
    ),
    check(
      "founder_commerce_lifecycle_receipts_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_commerce_lifecycle_receipts_portal_expiry_check",
      sql`${table.portalExpiresAt} IS NULL OR ${table.portalExpiresAt} > ${table.occurredAt}`,
    ),
    index("founder_commerce_lifecycle_receipts_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const founderProductEntitlements = pgTable(
  "founder_product_entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sourceEventId: uuid("source_event_id")
      .notNull()
      .references(() => founderCommerceEvents.id),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    status: founderProductEntitlementStatusEnum("status").notNull(),
    reconciledProviderStatus: text("reconciled_provider_status").notNull(),
    providerStateUpdatedAt: timestamp("provider_state_updated_at", {
      withTimezone: true,
    }).notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull(),
    retirementDueAt: timestamp("retirement_due_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("founder_product_entitlements_user_idx").on(table.userId),
    check(
      "founder_product_entitlements_provider_status_check",
      sql`${table.reconciledProviderStatus} IN ('active', 'past_due', 'unpaid', 'cancelled', 'expired', 'refunded')`,
    ),
    check(
      "founder_product_entitlements_retirement_due_check",
      sql`(${table.status} = 'verified' AND ${table.retirementDueAt} IS NULL) OR (${table.status} IN ('past_due', 'unpaid', 'cancelled', 'expired', 'refunded') AND ${table.retirementDueAt} IS NOT NULL)`,
    ),
  ],
);

export const founderRecoveryArchives = pgTable(
  "founder_recovery_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    applicationRevision: text("application_revision"),
    runtimeRevision: text("runtime_revision"),
    status: founderRecoveryArchiveStatusEnum("status").notNull(),
    formatVersion: integer("format_version"),
    storageObjectKey: text("storage_object_key"),
    recoveryCredentialObjectKey: text("recovery_credential_object_key"),
    ciphertextDigest: text("ciphertext_digest"),
    recoveryCredentialDigest: text("recovery_credential_digest"),
    stateDigest: text("state_digest"),
    restorableVerified: boolean("restorable_verified").notNull(),
    restoreVerifiedAt: timestamp("restore_verified_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "founder_recovery_archives_outcome_check",
      sql`(${table.status} = 'pending' AND ${table.ciphertextDigest} IS NULL AND ${table.recoveryCredentialDigest} IS NULL AND ${table.restorableVerified} = false AND ${table.failureCode} IS NULL AND ${table.deletedAt} IS NULL AND ((${table.storageObjectKey} IS NULL AND ${table.recoveryCredentialObjectKey} IS NULL) OR (${table.storageObjectKey} IS NOT NULL AND ${table.recoveryCredentialObjectKey} IS NOT NULL))) OR (${table.status} = 'verified' AND ${table.storageObjectKey} IS NOT NULL AND ${table.ciphertextDigest} IS NOT NULL AND ${table.recoveryCredentialDigest} IS NOT NULL AND ${table.restorableVerified} = true AND ${table.failureCode} IS NULL AND ${table.deletedAt} IS NULL) OR (${table.status} = 'failed' AND ${table.recoveryCredentialDigest} IS NULL AND ${table.restorableVerified} = false AND ${table.failureCode} IS NOT NULL AND ${table.deletedAt} IS NULL) OR (${table.status} = 'deleted' AND ${table.storageObjectKey} IS NULL AND ${table.recoveryCredentialDigest} IS NULL AND ${table.restorableVerified} = false AND ${table.failureCode} IS NULL AND ${table.deletedAt} IS NOT NULL)`,
    ),
    check(
      "founder_recovery_archives_ciphertext_digest_check",
      sql`${table.ciphertextDigest} IS NULL OR ${table.ciphertextDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_recovery_archives_credential_digest_check",
      sql`${table.recoveryCredentialDigest} IS NULL OR ${table.recoveryCredentialDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_recovery_archives_state_digest_check",
      sql`${table.stateDigest} IS NULL OR ${table.stateDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "founder_recovery_archives_application_revision_check",
      sql`${table.applicationRevision} IS NULL OR ${table.applicationRevision} ~ '^[a-f0-9]{40}$'`,
    ),
    check(
      "founder_recovery_archives_runtime_revision_check",
      sql`${table.runtimeRevision} IS NULL OR length(trim(${table.runtimeRevision})) > 0`,
    ),
    check(
      "founder_recovery_archives_v1_verification_check",
      sql`${table.formatVersion} IS NULL OR (${table.formatVersion} = 1 AND ${table.stateDigest} IS NOT NULL AND ${table.restoreVerifiedAt} IS NOT NULL AND ((${table.status} = 'verified' AND ${table.recoveryCredentialObjectKey} IS NOT NULL AND ${table.restorableVerified} = true) OR (${table.status} = 'deleted' AND ${table.recoveryCredentialObjectKey} IS NULL AND ${table.restorableVerified} = false)))`,
    ),
    check("founder_recovery_archives_expiry_check", sql`${table.expiresAt} > ${table.observedAt}`),
    index("founder_recovery_archives_user_observed_idx").on(table.userId, table.observedAt),
  ],
);

export const founderRecoveryArchiveDeletionReceipts = pgTable(
  "founder_recovery_archive_deletion_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => founderRecoveryArchives.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    archiveProviderConfirmed: boolean("archive_provider_confirmed").notNull().default(false),
    recoveryCredentialsConfirmed: boolean("recovery_credentials_confirmed")
      .notNull()
      .default(false),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureCode: text("failure_code"),
  },
  (table) => [
    uniqueIndex("founder_recovery_archive_deletions_archive_idx").on(table.archiveId),
    uniqueIndex("founder_recovery_archive_deletions_key_idx").on(table.idempotencyKey),
    check(
      "founder_recovery_archive_deletions_status_check",
      sql`${table.status} IN ('pending', 'completed')`,
    ),
    check(
      "founder_recovery_archive_deletions_outcome_check",
      sql`(${table.status} = 'pending' AND ${table.archiveProviderConfirmed} = false AND ${table.recoveryCredentialsConfirmed} = false AND ${table.completedAt} IS NULL) OR (${table.status} = 'completed' AND ${table.archiveProviderConfirmed} = true AND ${table.recoveryCredentialsConfirmed} = true AND ${table.completedAt} IS NOT NULL AND ${table.failureCode} IS NULL)`,
    ),
  ],
);

export const founderProductContractScenarioExecutions = pgTable(
  "founder_product_contract_scenario_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: text("run_id").notNull(),
    // Contract execution history is candidate evidence. It intentionally outlives
    // disposable lifecycle users so a failed attempt cannot be erased by cleanup.
    userId: uuid("user_id").notNull(),
    scenarioId: founderProductContractScenarioEnum("scenario_id").notNull(),
    sourceRevision: text("source_revision").notNull(),
    status: text("status").notNull().default("in_progress"),
    attempts: integer("attempts").notNull().default(1),
    resourcesBefore: integer("resources_before").notNull(),
    resourcesAfter: integer("resources_after").notNull(),
    cleanupVerified: boolean("cleanup_verified").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("founder_product_contract_executions_run_scenario_idx").on(
      table.runId,
      table.userId,
      table.scenarioId,
    ),
    check(
      "founder_product_contract_executions_revision_check",
      sql`${table.sourceRevision} ~ '^[a-f0-9]{40}$'`,
    ),
    check(
      "founder_product_contract_executions_outcome_check",
      sql`(${table.status} = 'in_progress' AND ${table.attempts} = 1 AND ${table.cleanupVerified} = false AND ${table.resourcesBefore} = 0 AND ${table.resourcesAfter} = 0) OR (${table.status} = 'failed' AND ${table.attempts} >= 1 AND ${table.cleanupVerified} = false AND ${table.resourcesBefore} >= 0 AND ${table.resourcesAfter} = 0) OR (${table.status} = 'passed' AND ${table.attempts} = 1 AND ${table.cleanupVerified} = true AND ${table.resourcesBefore} >= 0 AND ${table.resourcesAfter} = 0)`,
    ),
  ],
);

export const founderInfrastructureRetirements = pgTable(
  "founder_infrastructure_retirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id),
    recoveryArchiveId: uuid("recovery_archive_id").references(() => founderRecoveryArchives.id),
    idempotencyKey: text("idempotency_key").notNull(),
    providerResourceId: text("provider_resource_id").notNull(),
    providerFirewallId: text("provider_firewall_id").notNull(),
    providerOperationTag: text("provider_operation_tag"),
    providerResourceName: text("provider_resource_name"),
    providerRegion: text("provider_region"),
    providerSizeSlug: text("provider_size_slug"),
    providerFirewallName: text("provider_firewall_name"),
    providerResourceCreatedAt: timestamp("provider_resource_created_at", { withTimezone: true }),
    hardDestructionDueAt: timestamp("hard_destruction_due_at", { withTimezone: true }),
    status: founderInfrastructureRetirementStatusEnum("status").notNull(),
    resourcesBefore: integer("resources_before").notNull(),
    resourcesAfter: integer("resources_after"),
    providerDropletState: text("provider_droplet_state").notNull().default("unknown"),
    providerFirewallState: text("provider_firewall_state").notNull().default("unknown"),
    providerObservedAt: timestamp("provider_observed_at", { withTimezone: true }),
    workStoppedAt: timestamp("work_stopped_at", { withTimezone: true }),
    credentialsDisabledAt: timestamp("credentials_disabled_at", { withTimezone: true }),
    archiveOutcome: text("archive_outcome").notNull().default("pending"),
    archiveFailureCode: text("archive_failure_code"),
    firewallDeletedAt: timestamp("firewall_deleted_at", { withTimezone: true }),
    dropletDeletedAt: timestamp("droplet_deleted_at", { withTimezone: true }),
    absenceVerifiedAt: timestamp("absence_verified_at", { withTimezone: true }),
    billableRuntimeSeconds: integer("billable_runtime_seconds"),
    failureCode: text("failure_code"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseToken: text("lease_token").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("founder_infrastructure_retirements_idempotency_idx").on(table.idempotencyKey),
    uniqueIndex("founder_infrastructure_retirements_runner_idx").on(table.runnerId),
    check(
      "founder_infrastructure_retirements_resources_check",
      sql`${table.resourcesBefore} >= 0 AND (${table.resourcesAfter} IS NULL OR ${table.resourcesAfter} >= 0)`,
    ),
    check(
      "founder_infrastructure_retirements_provider_state_check",
      sql`${table.providerDropletState} IN ('unknown', 'present', 'absent') AND ${table.providerFirewallState} IN ('unknown', 'present', 'absent')`,
    ),
    check(
      "founder_infrastructure_retirements_archive_outcome_check",
      sql`(${table.archiveOutcome} = 'pending' AND ${table.archiveFailureCode} IS NULL) OR (${table.archiveOutcome} = 'verified' AND ${table.archiveFailureCode} IS NULL) OR (${table.archiveOutcome} = 'failed' AND ${table.archiveFailureCode} IS NOT NULL)`,
    ),
    check(
      "founder_infrastructure_retirements_billable_runtime_check",
      sql`${table.billableRuntimeSeconds} IS NULL OR ${table.billableRuntimeSeconds} >= 0`,
    ),
    check(
      "founder_infrastructure_retirements_lease_token_check",
      sql`length(trim(${table.leaseToken})) > 0`,
    ),
    check(
      "founder_infrastructure_retirements_completed_check",
      sql`${table.status} <> 'completed' OR (${table.providerOperationTag} IS NOT NULL AND ${table.providerResourceName} IS NOT NULL AND ${table.providerRegion} IS NOT NULL AND ${table.providerSizeSlug} IS NOT NULL AND ${table.providerFirewallName} IS NOT NULL AND ${table.providerResourceCreatedAt} IS NOT NULL AND ${table.hardDestructionDueAt} IS NOT NULL AND ${table.resourcesAfter} = 0 AND ${table.providerDropletState} = 'absent' AND ${table.providerFirewallState} = 'absent' AND ${table.providerObservedAt} IS NOT NULL AND ${table.workStoppedAt} IS NOT NULL AND ${table.credentialsDisabledAt} IS NOT NULL AND ${table.archiveOutcome} <> 'pending' AND ${table.firewallDeletedAt} IS NOT NULL AND ${table.dropletDeletedAt} IS NOT NULL AND ${table.absenceVerifiedAt} IS NOT NULL AND ${table.billableRuntimeSeconds} IS NOT NULL AND ${table.failureCode} IS NULL)`,
    ),
    index("founder_infrastructure_retirements_user_status_idx").on(table.userId, table.status),
  ],
);

export const operatorPreparations = pgTable(
  "operator_preparations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    status: operatorPreparationStatusEnum("status").notNull().default("awaiting_timezone"),
    timezone: text("timezone"),
    timezoneConfirmedAt: timestamp("timezone_confirmed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    recoveryMessage: text("recovery_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_preparations_timezone_confirmation_check",
      sql`(${table.timezone} IS NULL AND ${table.timezoneConfirmedAt} IS NULL) OR (${table.timezone} IS NOT NULL AND ${table.timezoneConfirmedAt} IS NOT NULL)`,
    ),
    check(
      "operator_preparations_started_after_created_check",
      sql`${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt}`,
    ),
    check(
      "operator_preparations_completed_after_started_check",
      sql`${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
    check(
      "operator_preparations_recovery_message_check",
      sql`${table.status} = 'needs_attention' OR ${table.recoveryMessage} IS NULL`,
    ),
    uniqueIndex("operator_preparations_operator_id_idx").on(table.operatorId),
    index("operator_preparations_status_idx").on(table.status),
  ],
);

export const operatorRuntimes = pgTable(
  "operator_runtimes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    status: operatorRuntimeStatusEnum("status").notNull().default("awaiting_timezone"),
    transportState: operatorRuntimeTransportStateEnum("transport_state")
      .notNull()
      .default("unknown"),
    safetyState: operatorRuntimeSafetyStateEnum("safety_state").notNull().default("unknown"),
    configRevision: text("config_revision"),
    runtimeIdentity: text("runtime_identity"),
    operationId: uuid("operation_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    recoveryMessage: text("recovery_message"),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_runtimes_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "operator_runtimes_lease_pair_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "operator_runtimes_recovery_message_check",
      sql`${table.status} = 'needs_attention' OR ${table.recoveryMessage} IS NULL`,
    ),
    check(
      "operator_runtimes_failure_code_check",
      sql`${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[a-z0-9_.:-]{1,64}$'`,
    ),
    uniqueIndex("operator_runtimes_operator_id_idx").on(table.operatorId),
    index("operator_runtimes_status_idx").on(table.status),
  ],
);

export const operatorAiConnections = pgTable(
  "operator_ai_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    provider: text("provider").notNull().default("openai"),
    providerSubjectId: text("provider_subject_id"),
    accountLabel: text("account_label"),
    status: operatorAiConnectionStatusEnum("status").notNull().default("authorizing"),
    authorizationState: operatorAiAuthorizationStateEnum("authorization_state")
      .notNull()
      .default("pending"),
    capacityState: operatorAiCapacityStateEnum("capacity_state").notNull().default("unknown"),
    inferenceState: operatorAiInferenceStateEnum("inference_state").notNull().default("unknown"),
    eligibleAccount: boolean("eligible_account").notNull().default(false),
    billingVerified: boolean("billing_verified").notNull().default(false),
    privacyAccepted: boolean("privacy_accepted").notNull().default(false),
    retentionBounded: boolean("retention_bounded").notNull().default(false),
    thirdPartyPermissionGranted: boolean("third_party_permission_granted").notNull().default(false),
    credentialHealthy: boolean("credential_healthy").notNull().default(false),
    reconnectSupported: boolean("reconnect_supported").notNull().default(false),
    productionUseApproved: boolean("production_use_approved").notNull().default(false),
    processingConsentActive: boolean("processing_consent_active").notNull().default(false),
    authorizationPersisted: boolean("authorization_persisted").notNull().default(false),
    authorizationSessionHash: text("authorization_session_hash"),
    authorizationExpiresAt: timestamp("authorization_expires_at", { withTimezone: true }),
    approvedModelAssignment: text("approved_model_assignment"),
    authorizationGeneration: integer("authorization_generation").notNull().default(1),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    recoveryMessage: text("recovery_message"),
    workPausedReason: text("work_paused_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_ai_connections_provider_check",
      sql`${table.provider} IN ('openai', 'anthropic')`,
    ),
    check(
      "operator_ai_connections_subject_check",
      sql`${table.providerSubjectId} IS NULL OR length(trim(${table.providerSubjectId})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_ai_connections_account_label_check",
      sql`${table.accountLabel} IS NULL OR length(trim(${table.accountLabel})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_ai_connections_session_hash_check",
      sql`${table.authorizationSessionHash} IS NULL OR ${table.authorizationSessionHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check("operator_ai_connections_generation_check", sql`${table.authorizationGeneration} >= 1`),
    check(
      "operator_ai_connections_failure_pair_check",
      sql`(${table.failureCode} IS NULL AND ${table.recoveryMessage} IS NULL) OR (${table.failureCode} IS NOT NULL AND ${table.recoveryMessage} IS NOT NULL)`,
    ),
    check(
      "operator_ai_connections_ready_shape_check",
      sql`${table.status} <> 'ready' OR (${table.providerSubjectId} IS NOT NULL AND ${table.accountLabel} IS NOT NULL AND ${table.authorizationState} = 'authorized' AND ${table.eligibleAccount} = true AND ${table.authorizationPersisted} = true AND ${table.approvedModelAssignment} IS NOT NULL AND ${table.capacityState} = 'available' AND ${table.inferenceState} = 'passed' AND ${table.lastVerifiedAt} IS NOT NULL AND (${table.provider} <> 'anthropic' OR (${table.billingVerified} = true AND ${table.privacyAccepted} = true AND ${table.retentionBounded} = true AND ${table.thirdPartyPermissionGranted} = true AND ${table.credentialHealthy} = true AND ${table.reconnectSupported} = true AND ${table.productionUseApproved} = true AND ${table.processingConsentActive} = true)))`,
    ),
    uniqueIndex("operator_ai_connections_operator_provider_idx").on(
      table.operatorId,
      table.provider,
    ),
    index("operator_ai_connections_status_idx").on(table.status),
  ],
);

export const operatorAiConnectionReceipts = pgTable(
  "operator_ai_connection_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => operatorAiConnections.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    kind: operatorAiConnectionReceiptKindEnum("kind").notNull(),
    provider: text("provider").notNull().default("openai"),
    providerSubjectId: text("provider_subject_id"),
    accountLabel: text("account_label"),
    status: text("status").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_ai_connection_receipts_provider_check",
      sql`${table.provider} IN ('openai', 'anthropic')`,
    ),
    check(
      "operator_ai_connection_receipts_subject_check",
      sql`${table.providerSubjectId} IS NULL OR length(trim(${table.providerSubjectId})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_ai_connection_receipts_account_label_check",
      sql`${table.accountLabel} IS NULL OR length(trim(${table.accountLabel})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_ai_connection_receipts_status_check",
      sql`${table.status} IN ('ready', 'needs_attention', 'paused', 'disconnected')`,
    ),
    check("operator_ai_connection_receipts_generation_check", sql`${table.generation} >= 1`),
    check(
      "operator_ai_connection_receipts_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_ai_connection_receipts_generation_idx").on(
      table.connectionId,
      table.generation,
      table.kind,
    ),
    index("operator_ai_connection_receipts_created_idx").on(table.connectionId, table.createdAt),
  ],
);

export const operatorCalendarConnections = pgTable(
  "operator_calendar_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    provider: text("provider").notNull().default("google_calendar"),
    providerSubjectId: text("provider_subject_id"),
    accountLabel: text("account_label"),
    status: operatorCalendarConnectionStatusEnum("status").notNull().default("authorizing"),
    authorizationState: operatorCalendarAuthorizationStateEnum("authorization_state")
      .notNull()
      .default("pending"),
    authorizationSessionHash: text("authorization_session_hash"),
    authorizationExpiresAt: timestamp("authorization_expires_at", { withTimezone: true }),
    authorizationGeneration: integer("authorization_generation").notNull().default(1),
    accessTokenCiphertext: text("access_token_ciphertext"),
    accessTokenIv: text("access_token_iv"),
    accessTokenAuthTag: text("access_token_auth_tag"),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    refreshTokenIv: text("refresh_token_iv"),
    refreshTokenAuthTag: text("refresh_token_auth_tag"),
    secretKeyVersion: text("secret_key_version"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastEvidenceAt: timestamp("last_evidence_at", { withTimezone: true }),
    lastEvidenceCount: integer("last_evidence_count").notNull().default(0),
    evidenceState: operatorCalendarEvidenceStateEnum("evidence_state").notNull().default("unknown"),
    failureCode: text("failure_code"),
    recoveryMessage: text("recovery_message"),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_calendar_connections_provider_check",
      sql`${table.provider} = 'google_calendar'`,
    ),
    check(
      "operator_calendar_connections_subject_check",
      sql`${table.providerSubjectId} IS NULL OR length(trim(${table.providerSubjectId})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_calendar_connections_account_label_check",
      sql`${table.accountLabel} IS NULL OR length(trim(${table.accountLabel})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_calendar_connections_session_hash_check",
      sql`${table.authorizationSessionHash} IS NULL OR ${table.authorizationSessionHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "operator_calendar_connections_generation_check",
      sql`${table.authorizationGeneration} >= 1`,
    ),
    check(
      "operator_calendar_connections_token_pair_check",
      sql`(
        ${table.accessTokenCiphertext} IS NULL AND ${table.accessTokenIv} IS NULL AND ${table.accessTokenAuthTag} IS NULL
        AND ${table.refreshTokenCiphertext} IS NULL AND ${table.refreshTokenIv} IS NULL AND ${table.refreshTokenAuthTag} IS NULL
        AND ${table.secretKeyVersion} IS NULL
      ) OR (
        ${table.accessTokenCiphertext} IS NOT NULL AND ${table.accessTokenIv} IS NOT NULL AND ${table.accessTokenAuthTag} IS NOT NULL
        AND ${table.refreshTokenCiphertext} IS NOT NULL AND ${table.refreshTokenIv} IS NOT NULL AND ${table.refreshTokenAuthTag} IS NOT NULL
        AND ${table.secretKeyVersion} IS NOT NULL
      )`,
    ),
    check(
      "operator_calendar_connections_failure_pair_check",
      sql`(${table.failureCode} IS NULL AND ${table.recoveryMessage} IS NULL) OR (${table.failureCode} IS NOT NULL AND ${table.recoveryMessage} IS NOT NULL)`,
    ),
    check(
      "operator_calendar_connections_ready_shape_check",
      sql`${table.status} <> 'ready' OR (${table.providerSubjectId} IS NOT NULL AND ${table.accountLabel} IS NOT NULL AND ${table.authorizationState} = 'authorized' AND ${table.authorizationSessionHash} IS NULL AND ${table.accessTokenCiphertext} IS NOT NULL AND ${table.refreshTokenCiphertext} IS NOT NULL AND ${table.lastVerifiedAt} IS NOT NULL AND ${table.lastEvidenceAt} IS NOT NULL)`,
    ),
    uniqueIndex("operator_calendar_connections_operator_provider_idx").on(
      table.operatorId,
      table.provider,
    ),
    index("operator_calendar_connections_status_idx").on(table.status),
  ],
);

export const operatorCalendarResources = pgTable(
  "operator_calendar_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => operatorCalendarConnections.id, { onDelete: "cascade" }),
    providerResourceId: text("provider_resource_id").notNull(),
    summary: text("summary").notNull(),
    timeZone: text("time_zone"),
    accessRole: text("access_role"),
    primaryCalendar: boolean("primary_calendar").notNull().default(false),
    selected: boolean("selected").notNull().default(false),
    status: operatorCalendarResourceStatusEnum("status").notNull().default("available"),
    selectionReviewedAt: timestamp("selection_reviewed_at", { withTimezone: true }),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_calendar_resources_provider_id_check",
      sql`length(trim(${table.providerResourceId})) BETWEEN 1 AND 500`,
    ),
    check(
      "operator_calendar_resources_summary_check",
      sql`length(trim(${table.summary})) BETWEEN 1 AND 500`,
    ),
    check(
      "operator_calendar_resources_selection_check",
      sql`${table.selected} = false OR (${table.status} = 'available' AND ${table.selectionReviewedAt} IS NOT NULL)`,
    ),
    uniqueIndex("operator_calendar_resources_connection_provider_id_idx").on(
      table.connectionId,
      table.providerResourceId,
    ),
    index("operator_calendar_resources_connection_selected_idx").on(
      table.connectionId,
      table.selected,
    ),
  ],
);

export const operatorCalendarConnectionReceipts = pgTable(
  "operator_calendar_connection_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => operatorCalendarConnections.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    kind: operatorCalendarConnectionReceiptKindEnum("kind").notNull(),
    provider: text("provider").notNull().default("google_calendar"),
    providerSubjectId: text("provider_subject_id"),
    accountLabel: text("account_label"),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    selectedResourceCount: integer("selected_resource_count").notNull().default(0),
    selectedResourceDigest: text("selected_resource_digest").notNull(),
    evidenceState: operatorCalendarEvidenceStateEnum("evidence_state").notNull().default("unknown"),
    status: text("status").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_calendar_connection_receipts_provider_check",
      sql`${table.provider} = 'google_calendar'`,
    ),
    check(
      "operator_calendar_connection_receipts_subject_check",
      sql`${table.providerSubjectId} IS NULL OR length(trim(${table.providerSubjectId})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_calendar_connection_receipts_account_label_check",
      sql`${table.accountLabel} IS NULL OR length(trim(${table.accountLabel})) BETWEEN 1 AND 200`,
    ),
    check("operator_calendar_connection_receipts_generation_check", sql`${table.generation} >= 1`),
    check(
      "operator_calendar_connection_receipts_count_check",
      sql`${table.selectedResourceCount} >= 0`,
    ),
    check(
      "operator_calendar_connection_receipts_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${table.selectedResourceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    index("operator_calendar_connection_receipts_generation_idx").on(
      table.connectionId,
      table.generation,
      table.kind,
    ),
    index("operator_calendar_connection_receipts_created_idx").on(
      table.connectionId,
      table.createdAt,
    ),
  ],
);

export const operatorMailConnections = pgTable(
  "operator_mail_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    provider: text("provider").notNull().default("google_gmail"),
    providerSubjectId: text("provider_subject_id"),
    accountLabel: text("account_label"),
    status: operatorMailConnectionStatusEnum("status").notNull().default("authorizing"),
    authorizationState: operatorMailAuthorizationStateEnum("authorization_state")
      .notNull()
      .default("pending"),
    authorizationSessionHash: text("authorization_session_hash"),
    authorizationExpiresAt: timestamp("authorization_expires_at", { withTimezone: true }),
    authorizationGeneration: integer("authorization_generation").notNull().default(1),
    accessTokenCiphertext: text("access_token_ciphertext"),
    accessTokenIv: text("access_token_iv"),
    accessTokenAuthTag: text("access_token_auth_tag"),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    refreshTokenIv: text("refresh_token_iv"),
    refreshTokenAuthTag: text("refresh_token_auth_tag"),
    secretKeyVersion: text("secret_key_version"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastEvidenceAt: timestamp("last_evidence_at", { withTimezone: true }),
    lastEvidenceCount: integer("last_evidence_count").notNull().default(0),
    evidenceState: operatorMailEvidenceStateEnum("evidence_state").notNull().default("unknown"),
    suiteStatus: operatorMailSuiteStatusEnum("suite_status")
      .notNull()
      .default("calendar_unavailable"),
    failureCode: text("failure_code"),
    recoveryMessage: text("recovery_message"),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_mail_connections_provider_check", sql`${table.provider} = 'google_gmail'`),
    check(
      "operator_mail_connections_subject_check",
      sql`${table.providerSubjectId} IS NULL OR length(trim(${table.providerSubjectId})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_mail_connections_account_label_check",
      sql`${table.accountLabel} IS NULL OR length(trim(${table.accountLabel})) BETWEEN 1 AND 320`,
    ),
    check(
      "operator_mail_connections_session_hash_check",
      sql`${table.authorizationSessionHash} IS NULL OR ${table.authorizationSessionHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check("operator_mail_connections_generation_check", sql`${table.authorizationGeneration} >= 1`),
    check("operator_mail_connections_evidence_count_check", sql`${table.lastEvidenceCount} >= 0`),
    check(
      "operator_mail_connections_token_pair_check",
      sql`(
        ${table.accessTokenCiphertext} IS NULL AND ${table.accessTokenIv} IS NULL AND ${table.accessTokenAuthTag} IS NULL
        AND ${table.refreshTokenCiphertext} IS NULL AND ${table.refreshTokenIv} IS NULL AND ${table.refreshTokenAuthTag} IS NULL
        AND ${table.secretKeyVersion} IS NULL
      ) OR (
        ${table.accessTokenCiphertext} IS NOT NULL AND ${table.accessTokenIv} IS NOT NULL AND ${table.accessTokenAuthTag} IS NOT NULL
        AND ${table.refreshTokenCiphertext} IS NOT NULL AND ${table.refreshTokenIv} IS NOT NULL AND ${table.refreshTokenAuthTag} IS NOT NULL
        AND ${table.secretKeyVersion} IS NOT NULL
      )`,
    ),
    check(
      "operator_mail_connections_failure_pair_check",
      sql`(${table.failureCode} IS NULL AND ${table.recoveryMessage} IS NULL) OR (${table.failureCode} IS NOT NULL AND ${table.recoveryMessage} IS NOT NULL)`,
    ),
    check(
      "operator_mail_connections_ready_shape_check",
      sql`${table.status} <> 'ready' OR (${table.providerSubjectId} IS NOT NULL AND ${table.accountLabel} IS NOT NULL AND ${table.authorizationState} = 'authorized' AND ${table.authorizationSessionHash} IS NULL AND ${table.accessTokenCiphertext} IS NOT NULL AND ${table.refreshTokenCiphertext} IS NOT NULL AND ${table.lastVerifiedAt} IS NOT NULL AND ${table.lastEvidenceAt} IS NOT NULL)`,
    ),
    uniqueIndex("operator_mail_connections_operator_provider_idx").on(
      table.operatorId,
      table.provider,
    ),
    index("operator_mail_connections_status_idx").on(table.status),
  ],
);

export const operatorMailResources = pgTable(
  "operator_mail_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => operatorMailConnections.id, { onDelete: "cascade" }),
    providerResourceId: text("provider_resource_id").notNull(),
    name: text("name").notNull(),
    labelType: text("label_type").notNull(),
    messageListVisibility: text("message_list_visibility"),
    labelListVisibility: text("label_list_visibility"),
    selected: boolean("selected").notNull().default(false),
    status: operatorMailResourceStatusEnum("status").notNull().default("available"),
    selectionReviewedAt: timestamp("selection_reviewed_at", { withTimezone: true }),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_mail_resources_provider_id_check",
      sql`length(trim(${table.providerResourceId})) BETWEEN 1 AND 200`,
    ),
    check("operator_mail_resources_name_check", sql`length(trim(${table.name})) BETWEEN 1 AND 200`),
    check(
      "operator_mail_resources_label_type_check",
      sql`${table.labelType} IN ('system', 'user')`,
    ),
    check(
      "operator_mail_resources_selection_check",
      sql`${table.selected} = false OR (${table.status} = 'available' AND ${table.selectionReviewedAt} IS NOT NULL)`,
    ),
    uniqueIndex("operator_mail_resources_connection_provider_id_idx").on(
      table.connectionId,
      table.providerResourceId,
    ),
    index("operator_mail_resources_connection_selected_idx").on(table.connectionId, table.selected),
  ],
);

export const operatorMailConnectionReceipts = pgTable(
  "operator_mail_connection_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => operatorMailConnections.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    kind: operatorMailConnectionReceiptKindEnum("kind").notNull(),
    provider: text("provider").notNull().default("google_gmail"),
    providerSubjectId: text("provider_subject_id"),
    accountLabel: text("account_label"),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    selectedResourceCount: integer("selected_resource_count").notNull().default(0),
    selectedResourceDigest: text("selected_resource_digest").notNull(),
    evidenceState: operatorMailEvidenceStateEnum("evidence_state").notNull().default("unknown"),
    suiteStatus: operatorMailSuiteStatusEnum("suite_status")
      .notNull()
      .default("calendar_unavailable"),
    status: text("status").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_mail_connection_receipts_provider_check",
      sql`${table.provider} = 'google_gmail'`,
    ),
    check(
      "operator_mail_connection_receipts_subject_check",
      sql`${table.providerSubjectId} IS NULL OR length(trim(${table.providerSubjectId})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_mail_connection_receipts_account_label_check",
      sql`${table.accountLabel} IS NULL OR length(trim(${table.accountLabel})) BETWEEN 1 AND 320`,
    ),
    check("operator_mail_connection_receipts_generation_check", sql`${table.generation} >= 1`),
    check(
      "operator_mail_connection_receipts_count_check",
      sql`${table.selectedResourceCount} >= 0`,
    ),
    check(
      "operator_mail_connection_receipts_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${table.selectedResourceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    index("operator_mail_connection_receipts_generation_idx").on(
      table.connectionId,
      table.generation,
      table.kind,
    ),
    index("operator_mail_connection_receipts_created_idx").on(table.connectionId, table.createdAt),
  ],
);

export const operatorMailSendingConnections = pgTable(
  "operator_mail_sending_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    mailConnectionId: uuid("mail_connection_id").references(() => operatorMailConnections.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull().default("google_gmail_sending"),
    providerSubjectId: text("provider_subject_id"),
    accountLabel: text("account_label"),
    status: operatorMailSendingConnectionStatusEnum("status").notNull().default("authorizing"),
    authorizationState: operatorMailSendingAuthorizationStateEnum("authorization_state")
      .notNull()
      .default("pending"),
    authorizationSessionHash: text("authorization_session_hash"),
    authorizationExpiresAt: timestamp("authorization_expires_at", { withTimezone: true }),
    authorizationGeneration: integer("authorization_generation").notNull().default(1),
    accessTokenCiphertext: text("access_token_ciphertext"),
    accessTokenIv: text("access_token_iv"),
    accessTokenAuthTag: text("access_token_auth_tag"),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    refreshTokenIv: text("refresh_token_iv"),
    refreshTokenAuthTag: text("refresh_token_auth_tag"),
    secretKeyVersion: text("secret_key_version"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    recoveryMessage: text("recovery_message"),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_mail_sending_connections_provider_check",
      sql`${table.provider} = 'google_gmail_sending'`,
    ),
    check(
      "operator_mail_sending_connections_subject_check",
      sql`${table.providerSubjectId} IS NULL OR length(trim(${table.providerSubjectId})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_mail_sending_connections_session_hash_check",
      sql`${table.authorizationSessionHash} IS NULL OR ${table.authorizationSessionHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "operator_mail_sending_connections_generation_check",
      sql`${table.authorizationGeneration} >= 1`,
    ),
    check(
      "operator_mail_sending_connections_token_pair_check",
      sql`(
        ${table.accessTokenCiphertext} IS NULL AND ${table.accessTokenIv} IS NULL AND ${table.accessTokenAuthTag} IS NULL
        AND ${table.refreshTokenCiphertext} IS NULL AND ${table.refreshTokenIv} IS NULL AND ${table.refreshTokenAuthTag} IS NULL
        AND ${table.secretKeyVersion} IS NULL
      ) OR (
        ${table.accessTokenCiphertext} IS NOT NULL AND ${table.accessTokenIv} IS NOT NULL AND ${table.accessTokenAuthTag} IS NOT NULL
        AND ${table.refreshTokenCiphertext} IS NOT NULL AND ${table.refreshTokenIv} IS NOT NULL AND ${table.refreshTokenAuthTag} IS NOT NULL
        AND ${table.secretKeyVersion} IS NOT NULL
      )`,
    ),
    check(
      "operator_mail_sending_connections_failure_pair_check",
      sql`(${table.failureCode} IS NULL AND ${table.recoveryMessage} IS NULL) OR (${table.failureCode} IS NOT NULL AND ${table.recoveryMessage} IS NOT NULL)`,
    ),
    check(
      "operator_mail_sending_connections_ready_shape_check",
      sql`${table.status} <> 'ready' OR (${table.providerSubjectId} IS NOT NULL AND ${table.accountLabel} IS NOT NULL AND ${table.authorizationState} = 'authorized' AND ${table.authorizationSessionHash} IS NULL AND ${table.accessTokenCiphertext} IS NOT NULL AND ${table.refreshTokenCiphertext} IS NOT NULL AND ${table.lastVerifiedAt} IS NOT NULL)`,
    ),
    uniqueIndex("operator_mail_sending_connections_operator_idx").on(table.operatorId),
    index("operator_mail_sending_connections_status_idx").on(table.status),
  ],
);

export const operatorMailSendingConnectionReceipts = pgTable(
  "operator_mail_sending_connection_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => operatorMailSendingConnections.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    kind: operatorMailSendingConnectionReceiptKindEnum("kind").notNull(),
    provider: text("provider").notNull().default("google_gmail_sending"),
    providerSubjectId: text("provider_subject_id"),
    accountLabel: text("account_label"),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_mail_sending_connection_receipts_provider_check",
      sql`${table.provider} = 'google_gmail_sending'`,
    ),
    check(
      "operator_mail_sending_connection_receipts_generation_check",
      sql`${table.generation} >= 1`,
    ),
    check(
      "operator_mail_sending_connection_receipts_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_mail_sending_connection_receipts_generation_idx").on(
      table.connectionId,
      table.generation,
      table.kind,
    ),
    index("operator_mail_sending_connection_receipts_created_idx").on(
      table.connectionId,
      table.createdAt,
    ),
  ],
);

export const operatorPrimaryCommunicationsSuites = pgTable(
  "operator_primary_communications_suites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    calendarConnectionId: uuid("calendar_connection_id")
      .notNull()
      .references(() => operatorCalendarConnections.id, { onDelete: "restrict" }),
    mailConnectionId: uuid("mail_connection_id")
      .notNull()
      .references(() => operatorMailConnections.id, { onDelete: "restrict" }),
    providerSubjectId: text("provider_subject_id").notNull(),
    status: operatorPrimaryCommunicationsSuiteStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_primary_communications_suites_subject_check",
      sql`length(trim(${table.providerSubjectId})) BETWEEN 1 AND 200`,
    ),
    uniqueIndex("operator_primary_communications_suites_operator_idx").on(table.operatorId),
    uniqueIndex("operator_primary_communications_suites_pair_idx").on(
      table.calendarConnectionId,
      table.mailConnectionId,
    ),
  ],
);

export const operatorProcessingConsents = pgTable(
  "operator_processing_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    aiConnectionId: uuid("ai_connection_id")
      .notNull()
      .references(() => operatorAiConnections.id),
    calendarConnectionId: uuid("calendar_connection_id")
      .notNull()
      .references(() => operatorCalendarConnections.id),
    mailConnectionId: uuid("mail_connection_id").references(() => operatorMailConnections.id),
    version: integer("version").notNull().default(1),
    status: operatorProcessingConsentStatusEnum("status").notNull().default("active"),
    purpose: text("purpose").notNull().default("calendar_morning_brief"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_processing_consents_version_check", sql`${table.version} >= 1`),
    check(
      "operator_processing_consents_purpose_check",
      sql`${table.purpose} IN ('calendar_morning_brief', 'core_operation')`,
    ),
    check(
      "operator_processing_consents_revocation_check",
      sql`(${table.status} = 'active' AND ${table.revokedAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`,
    ),
    uniqueIndex("operator_processing_consents_connection_version_idx").on(
      table.operatorId,
      table.aiConnectionId,
      table.calendarConnectionId,
      table.mailConnectionId,
      table.purpose,
      table.version,
    ),
    index("operator_processing_consents_status_idx").on(table.operatorId, table.status),
  ],
);

export const operatorAuthorityPolicies = pgTable(
  "operator_authority_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    version: integer("version").notNull(),
    actionFamilies: jsonb("action_families")
      .$type<
        Record<
          | "observe_evidence"
          | "relationship_maintenance"
          | "prepare_work"
          | "external_communication"
          | "meeting_management"
          | "commercial_commitment"
          | "data_control",
          "always" | "approval_required" | "never"
        >
      >()
      .notNull()
      .default(
        sql`'{"observe_evidence":"always","relationship_maintenance":"always","prepare_work":"always","external_communication":"approval_required","meeting_management":"approval_required","commercial_commitment":"approval_required","data_control":"approval_required"}'::jsonb`,
      ),
    observation: operatorAuthorityModeEnum("observation").notNull().default("always"),
    preparation: operatorAuthorityModeEnum("preparation").notNull().default("always"),
    externalEffects: operatorAuthorityModeEnum("external_effects")
      .notNull()
      .default("approval_required"),
    mailIncluded: boolean("mail_included").notNull().default(false),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_authority_policies_version_check", sql`${table.version} >= 1`),
    check(
      "operator_authority_policies_safe_default_check",
      sql`${table.observation} = 'always' AND ${table.preparation} = 'always' AND ${table.externalEffects} = 'approval_required' AND ${table.mailIncluded} = false`,
    ),
    uniqueIndex("operator_authority_policies_operator_version_idx").on(
      table.operatorId,
      table.version,
    ),
    index("operator_authority_policies_operator_idx").on(table.operatorId, table.createdAt),
  ],
);

export const operatorGovernanceReceipts = pgTable(
  "operator_governance_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    kind: operatorGovernanceReceiptKindEnum("kind").notNull(),
    processingConsentId: uuid("processing_consent_id").references(
      () => operatorProcessingConsents.id,
    ),
    authorityPolicyId: uuid("authority_policy_id").references(() => operatorAuthorityPolicies.id),
    evidenceDigest: text("evidence_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_governance_receipts_source_check",
      sql`(${table.kind} = 'processing_consent' AND ${table.processingConsentId} IS NOT NULL AND ${table.authorityPolicyId} IS NULL) OR (${table.kind} = 'authority_policy' AND ${table.processingConsentId} IS NULL AND ${table.authorityPolicyId} IS NOT NULL)`,
    ),
    check(
      "operator_governance_receipts_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_governance_receipts_consent_idx").on(
      table.processingConsentId,
      table.kind,
    ),
    uniqueIndex("operator_governance_receipts_policy_idx").on(table.authorityPolicyId, table.kind),
    index("operator_governance_receipts_operator_created_idx").on(
      table.operatorId,
      table.createdAt,
    ),
  ],
);

export const operatorLimitedOperations = pgTable(
  "operator_limited_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    aiConnectionId: uuid("ai_connection_id")
      .notNull()
      .references(() => operatorAiConnections.id),
    calendarConnectionId: uuid("calendar_connection_id")
      .notNull()
      .references(() => operatorCalendarConnections.id),
    mailConnectionId: uuid("mail_connection_id").references(() => operatorMailConnections.id),
    processingConsentId: uuid("processing_consent_id").references(
      () => operatorProcessingConsents.id,
    ),
    authorityPolicyId: uuid("authority_policy_id").references(() => operatorAuthorityPolicies.id),
    status: operatorLimitedOperationStatusEnum("status").notNull().default("awaiting_consent"),
    firstBriefId: uuid("first_brief_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_limited_operations_consent_shape_check",
      sql`${table.status} = 'awaiting_consent' OR (${table.processingConsentId} IS NOT NULL AND ${table.authorityPolicyId} IS NOT NULL)`,
    ),
    check(
      "operator_limited_operations_activation_shape_check",
      sql`${table.activatedAt} IS NULL OR ${table.firstBriefId} IS NOT NULL`,
    ),
    uniqueIndex("operator_limited_operations_operator_idx").on(table.operatorId),
    index("operator_limited_operations_status_idx").on(table.status),
  ],
);

export const operatorMorningBriefs = pgTable(
  "operator_morning_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => operatorLimitedOperations.id),
    generation: integer("generation").notNull(),
    status: operatorMorningBriefStatusEnum("status").notNull().default("prepared"),
    evidenceState: operatorCalendarEvidenceStateEnum("evidence_state").notNull(),
    quiet: boolean("quiet").notNull(),
    attentionCount: integer("attention_count").notNull().default(0),
    content: text("content").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    evidenceWatermark: text("evidence_watermark").notNull().default(""),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    windowEndedAt: timestamp("window_ended_at", { withTimezone: true }).notNull(),
    calendarWindowStartedAt: timestamp("calendar_window_started_at", { withTimezone: true }),
    calendarWindowEndedAt: timestamp("calendar_window_ended_at", { withTimezone: true }),
    mailWindowStartedAt: timestamp("mail_window_started_at", { withTimezone: true }),
    mailWindowEndedAt: timestamp("mail_window_ended_at", { withTimezone: true }),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_morning_briefs_generation_check", sql`${table.generation} >= 1`),
    check("operator_morning_briefs_attention_count_check", sql`${table.attentionCount} >= 0`),
    check(
      "operator_morning_briefs_quiet_truth_check",
      sql`${table.quiet} = false OR (${table.evidenceState} = 'current' AND ${table.attentionCount} = 0)`,
    ),
    check(
      "operator_morning_briefs_content_check",
      sql`length(trim(${table.content})) BETWEEN 1 AND 12000`,
    ),
    check(
      "operator_morning_briefs_window_check",
      sql`${table.windowEndedAt} > ${table.windowStartedAt}`,
    ),
    check(
      "operator_morning_briefs_opened_status_check",
      sql`(${table.status} = 'prepared' AND ${table.openedAt} IS NULL) OR (${table.status} = 'opened' AND ${table.openedAt} IS NOT NULL)`,
    ),
    check(
      "operator_morning_briefs_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_morning_briefs_operation_generation_idx").on(
      table.operationId,
      table.generation,
    ),
    index("operator_morning_briefs_operator_status_idx").on(table.operatorId, table.status),
  ],
);

export const operatorMorningBriefPreferences = pgTable(
  "operator_morning_brief_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    deliveryLocalTime: text("delivery_local_time").notNull().default("07:00"),
    nextDeliveryAt: timestamp("next_delivery_at", { withTimezone: true }),
    lastDeliveredLocalDate: text("last_delivered_local_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_morning_brief_preferences_delivery_time_check",
      sql`${table.deliveryLocalTime} ~ '^[0-2][0-9]:[0-5][0-9]$' AND substring(${table.deliveryLocalTime} from 1 for 2)::integer BETWEEN 0 AND 23`,
    ),
    uniqueIndex("operator_morning_brief_preferences_operator_idx").on(table.operatorId),
  ],
);

export const operatorMorningBriefItems = pgTable(
  "operator_morning_brief_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => operatorMorningBriefs.id, { onDelete: "cascade" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    kind: operatorMorningBriefAttentionKindEnum("kind").notNull(),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    priority: integer("priority").notNull().default(50),
    sourceWatermark: text("source_watermark").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_morning_brief_items_priority_check", sql`${table.priority} BETWEEN 0 AND 100`),
    check(
      "operator_morning_brief_items_title_check",
      sql`length(trim(${table.title})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_morning_brief_items_detail_check",
      sql`length(trim(${table.detail})) BETWEEN 1 AND 2000`,
    ),
    uniqueIndex("operator_morning_brief_items_identity_idx").on(
      table.briefId,
      table.kind,
      table.sourceId,
    ),
    index("operator_morning_brief_items_brief_priority_idx").on(table.briefId, table.priority),
  ],
);

export const operatorFounderActivations = pgTable(
  "operator_founder_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    firstBriefId: uuid("first_brief_id")
      .notNull()
      .references(() => operatorMorningBriefs.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    evidenceDigest: text("evidence_digest").notNull(),
  },
  (table) => [
    check(
      "operator_founder_activations_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_founder_activations_operator_idx").on(table.operatorId),
    uniqueIndex("operator_founder_activations_brief_idx").on(table.firstBriefId),
  ],
);

export const operatorFounderDataExports = pgTable(
  "operator_founder_data_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    tokenHash: text("token_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "operator_founder_data_exports_token_hash_check",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_founder_data_exports_token_hash_idx").on(table.tokenHash),
    index("operator_founder_data_exports_operator_expires_idx").on(
      table.operatorId,
      table.expiresAt,
    ),
  ],
);

export const operatorFounderDataExportAccesses = pgTable(
  "operator_founder_data_export_accesses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exportId: uuid("export_id")
      .notNull()
      .references(() => operatorFounderDataExports.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    format: text("format").notNull(),
    outcome: text("outcome").notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_founder_data_export_accesses_format_check",
      sql`${table.format} IN ('json', 'html')`,
    ),
    check(
      "operator_founder_data_export_accesses_outcome_check",
      sql`${table.outcome} IN ('downloaded', 'expired', 'owner_mismatch', 'deletion_stopped')`,
    ),
    index("operator_founder_data_export_accesses_export_accessed_idx").on(
      table.exportId,
      table.accessedAt,
    ),
  ],
);

/**
 * Founder-readable support incidents are opened only from a durable exhausted
 * recovery projection. They intentionally retain impact and a deduplication
 * fingerprint, never raw provider or runtime evidence.
 */
export const operatorTroubleshootingIncidents = pgTable(
  "operator_troubleshooting_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    recoveryCapability: text("recovery_capability").notNull(),
    recoveryState: text("recovery_state").notNull().default("recovery_exhausted"),
    attemptCount: integer("attempt_count").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    elapsedMs: integer("elapsed_ms").notNull(),
    maxElapsedMs: integer("max_elapsed_ms").notNull(),
    impactSummary: text("impact_summary").notNull(),
    affectedCapabilities: jsonb("affected_capabilities")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    unaffectedCapabilities: jsonb("unaffected_capabilities")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    deduplicationKey: text("deduplication_key").notNull(),
    status: operatorTroubleshootingIncidentStatusEnum("status").notNull().default("open"),
    supportCaseApprovedAt: timestamp("support_case_approved_at", { withTimezone: true }),
    supportCaseClosedAt: timestamp("support_case_closed_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_troubleshooting_incidents_capability_check",
      sql`${table.recoveryCapability} IN ('ai', 'calendar', 'mail', 'mail_sending', 'brief', 'conversation', 'external_effect')`,
    ),
    check(
      "operator_troubleshooting_incidents_state_check",
      sql`${table.recoveryState} = 'recovery_exhausted'`,
    ),
    check(
      "operator_troubleshooting_incidents_budget_check",
      sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} >= 1 AND ${table.elapsedMs} >= 0 AND ${table.maxElapsedMs} >= 1`,
    ),
    check(
      "operator_troubleshooting_incidents_status_pair_check",
      sql`(${table.status} = 'open' AND ${table.closedAt} IS NULL) OR (${table.status} = 'closed' AND ${table.closedAt} IS NOT NULL)`,
    ),
    check(
      "operator_troubleshooting_incidents_case_pair_check",
      sql`${table.supportCaseClosedAt} IS NULL OR (${table.supportCaseApprovedAt} IS NOT NULL AND ${table.supportCaseClosedAt} >= ${table.supportCaseApprovedAt})`,
    ),
    uniqueIndex("operator_troubleshooting_incidents_dedup_idx").on(
      table.operatorId,
      table.deduplicationKey,
    ),
    index("operator_troubleshooting_incidents_operator_status_idx").on(
      table.operatorId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const operatorTroubleshootingEvidence = pgTable(
  "operator_troubleshooting_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => operatorTroubleshootingIncidents.id, { onDelete: "cascade" }),
    kind: operatorTroubleshootingEvidenceKindEnum("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_troubleshooting_evidence_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_troubleshooting_evidence_incident_kind_idx").on(
      table.incidentId,
      table.kind,
    ),
    index("operator_troubleshooting_evidence_expiry_idx").on(table.incidentId, table.expiresAt),
  ],
);

/**
 * Founder-granted, read-only support access. A grant is deliberately separate
 * from a Troubleshooting Incident: opening a case never creates one.
 */
export const operatorSupportAccessGrants = pgTable(
  "operator_support_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => operatorTroubleshootingIncidents.id, { onDelete: "cascade" }),
    supportActorName: text("support_actor_name").notNull(),
    supportActorIdentity: text("support_actor_identity").notNull(),
    supportActorMfaVerifiedAt: timestamp("support_actor_mfa_verified_at", {
      withTimezone: true,
    }).notNull(),
    accessTokenHash: text("access_token_hash").notNull(),
    accessTokenPrefix: text("access_token_prefix").notNull(),
    scope: operatorSupportAccessScopeEnum("scope").notNull(),
    status: operatorSupportAccessGrantStatusEnum("status").notNull().default("active"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_support_access_grants_actor_name_check",
      sql`length(trim(${table.supportActorName})) BETWEEN 1 AND 160`,
    ),
    check(
      "operator_support_access_grants_actor_identity_check",
      sql`length(trim(${table.supportActorIdentity})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_support_access_grants_token_check",
      sql`${table.accessTokenHash} ~ '^sha256:[a-f0-9]{64}$' AND length(trim(${table.accessTokenPrefix})) BETWEEN 8 AND 24`,
    ),
    check(
      "operator_support_access_grants_ttl_check",
      sql`${table.expiresAt} > ${table.grantedAt} AND ${table.expiresAt} <= ${table.grantedAt} + interval '60 minutes'`,
    ),
    check(
      "operator_support_access_grants_revocation_pair_check",
      sql`(${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL) OR (${table.status} <> 'revoked' AND ${table.revokedAt} IS NULL)`,
    ),
    uniqueIndex("operator_support_access_grants_active_incident_idx")
      .on(table.incidentId)
      .where(sql`${table.status} = 'active'`),
    index("operator_support_access_grants_operator_status_idx").on(
      table.operatorId,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const operatorSupportReceipts = pgTable(
  "operator_support_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id").references(() => operatorSupportAccessGrants.id, {
      onDelete: "set null",
    }),
    repairProposalId: uuid("repair_proposal_id"),
    kind: operatorSupportReceiptKindEnum("kind").notNull(),
    digest: text("digest").notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("operator_support_receipts_digest_check", sql`${table.digest} ~ '^sha256:[a-f0-9]{64}$'`),
    index("operator_support_receipts_operator_created_idx").on(table.operatorId, table.createdAt),
  ],
);

export const operatorSupportToolInvocations = pgTable(
  "operator_support_tool_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => operatorSupportAccessGrants.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    argumentDigest: text("argument_digest").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "operator_support_tool_invocations_digest_check",
      sql`${table.argumentDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "operator_support_tool_invocations_tool_check",
      sql`${table.tool} IN ('read_troubleshooting_evidence', 'read_capability_status', 'read_recovery_checkpoint')`,
    ),
    index("operator_support_tool_invocations_grant_created_idx").on(table.grantId, table.createdAt),
  ],
);

export const operatorSupportRepairProposals = pgTable(
  "operator_support_repair_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => operatorTroubleshootingIncidents.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => operatorSupportAccessGrants.id, { onDelete: "cascade" }),
    supportActorName: text("support_actor_name").notNull(),
    kind: operatorSupportRepairKindEnum("kind").notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    proposalDigest: text("proposal_digest").notNull(),
    state: operatorSupportRepairStateEnum("state").notNull().default("proposed"),
    decisionKind: operatorSupportRepairDecisionKindEnum("decision_kind"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    verification: jsonb("verification").$type<Record<string, unknown> | null>(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "operator_support_repair_proposals_digest_check",
      sql`${table.proposalDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "operator_support_repair_proposals_decision_pair_check",
      sql`(${table.state} = 'proposed' AND ${table.decisionKind} IS NULL AND ${table.decidedAt} IS NULL) OR (${table.state} <> 'proposed' AND ${table.decisionKind} IS NOT NULL AND ${table.decidedAt} IS NOT NULL)`,
    ),
    uniqueIndex("operator_support_repair_proposals_grant_digest_idx").on(
      table.grantId,
      table.proposalDigest,
    ),
    index("operator_support_repair_proposals_operator_state_idx").on(
      table.operatorId,
      table.state,
      table.createdAt,
    ),
  ],
);

export const operatorSupportRepairDecisions = pgTable(
  "operator_support_repair_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => operatorSupportRepairProposals.id, { onDelete: "cascade" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    kind: operatorSupportRepairDecisionKindEnum("kind").notNull(),
    proposalDigest: text("proposal_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "operator_support_repair_decisions_digest_check",
      sql`${table.proposalDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_support_repair_decisions_proposal_idx").on(table.proposalId),
  ],
);

export const operatorDeletionRequests = pgTable(
  "operator_deletion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    kind: operatorDeletionRequestKindEnum("kind").notNull(),
    status: operatorDeletionRequestStatusEnum("status").notNull().default("requested"),
    scope: jsonb("scope").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    activePurgeDueAt: timestamp("active_purge_due_at", { withTimezone: true }).notNull(),
    backupExpiryDueAt: timestamp("backup_expiry_due_at", { withTimezone: true }).notNull(),
    accessStoppedAt: timestamp("access_stopped_at", { withTimezone: true }),
    activePurgeCompletedAt: timestamp("active_purge_completed_at", { withTimezone: true }),
    backupExpiredAt: timestamp("backup_expired_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_deletion_requests_due_order_check",
      sql`${table.backupExpiryDueAt} >= ${table.activePurgeDueAt} AND ${table.activePurgeDueAt} >= ${table.requestedAt}`,
    ),
    check(
      "operator_deletion_requests_access_stage_check",
      sql`${table.status} = 'requested' OR ${table.accessStoppedAt} IS NOT NULL`,
    ),
    check(
      "operator_deletion_requests_purge_stage_check",
      sql`${table.status} IN ('requested', 'access_stopped', 'purge_pending', 'failed') OR ${table.activePurgeCompletedAt} IS NOT NULL`,
    ),
    check(
      "operator_deletion_requests_backup_stage_check",
      sql`${table.status} NOT IN ('completed') OR (${table.backupExpiredAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
    uniqueIndex("operator_deletion_requests_active_idx")
      .on(table.operatorId)
      .where(sql`${table.status} NOT IN ('completed', 'failed')`),
    index("operator_deletion_requests_operator_status_idx").on(
      table.operatorId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const operatorDeletionReceipts = pgTable(
  "operator_deletion_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => operatorDeletionRequests.id, { onDelete: "restrict" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    stage: operatorDeletionStageEnum("stage").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operator_deletion_receipts_request_stage_idx").on(table.requestId, table.stage),
    index("operator_deletion_receipts_operator_occurred_idx").on(
      table.operatorId,
      table.occurredAt,
    ),
  ],
);

export const operatorDeletionRevocations = pgTable(
  "operator_deletion_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => operatorDeletionRequests.id, { onDelete: "cascade" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    connectionKind: text("connection_kind").notNull(),
    connectionId: uuid("connection_id").notNull(),
    provider: text("provider").notNull(),
    providerIdentity: text("provider_identity"),
    status: operatorDeletionRevocationStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_deletion_revocations_attempt_count_check", sql`${table.attemptCount} >= 0`),
    uniqueIndex("operator_deletion_revocations_identity_idx").on(
      table.requestId,
      table.connectionKind,
      table.connectionId,
    ),
    index("operator_deletion_revocations_retry_idx").on(
      table.operatorId,
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

export const operatorDeletionCommerceCancellations = pgTable(
  "operator_deletion_commerce_cancellations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => operatorDeletionRequests.id, { onDelete: "restrict" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    status: operatorDeletionCommerceCancellationStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("operator_deletion_commerce_cancellations_request_idx").on(table.requestId),
    check(
      "operator_deletion_commerce_cancellations_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "operator_deletion_commerce_cancellations_status_check",
      sql`(${table.status} = 'pending' AND ${table.confirmedAt} IS NULL AND ${table.errorCode} IS NULL) OR (${table.status} = 'succeeded' AND ${table.confirmedAt} IS NOT NULL AND ${table.errorCode} IS NULL) OR (${table.status} = 'failed' AND ${table.confirmedAt} IS NULL AND ${table.errorCode} IS NOT NULL)`,
    ),
    index("operator_deletion_commerce_cancellations_status_idx").on(table.status, table.updatedAt),
  ],
);

export const operatorDeletionTombstones = pgTable(
  "operator_deletion_tombstones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => operatorDeletionRequests.id, { onDelete: "restrict" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    erasedAt: timestamp("erased_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operator_deletion_tombstones_identity_idx").on(
      table.operatorId,
      table.entityType,
      table.entityId,
    ),
    index("operator_deletion_tombstones_request_idx").on(table.requestId, table.erasedAt),
  ],
);

export const operatorDeletionBackupExpiries = pgTable(
  "operator_deletion_backup_expiries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => operatorDeletionRequests.id, { onDelete: "cascade" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    backupKind: text("backup_kind").notNull(),
    backupId: text("backup_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: operatorDeletionBackupStatusEnum("status").notNull().default("pending"),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operator_deletion_backup_expiries_identity_idx").on(
      table.requestId,
      table.backupKind,
      table.backupId,
    ),
    index("operator_deletion_backup_expiries_due_idx").on(
      table.operatorId,
      table.status,
      table.expiresAt,
    ),
  ],
);

/**
 * A retention tombstone contains only the stable identity and non-sensitive
 * accounting needed to explain why an expired row is no longer exportable.
 * It intentionally has no foreign key to the erased entity because the
 * source row is removed by the retention job.
 */
export const operatorRetentionTombstones = pgTable(
  "operator_retention_tombstones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    kind: operatorRetentionTombstoneKindEnum("kind").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    identityDigest: text("identity_digest").notNull(),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull().default("retention_expired"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_retention_tombstones_digest_check",
      sql`${table.identityDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_retention_tombstones_identity_idx").on(
      table.operatorId,
      table.kind,
      table.entityType,
      table.entityId,
    ),
    index("operator_retention_tombstones_operator_expired_idx").on(
      table.operatorId,
      table.expiredAt,
    ),
  ],
);

/** One durable per-owner run record makes retries observable and idempotent. */
export const operatorRetentionRuns = pgTable(
  "operator_retention_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    runKey: text("run_key").notNull(),
    status: operatorRetentionRunStatusEnum("status").notNull().default("running"),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    failureCode: text("failure_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_retention_runs_completion_shape_check",
      sql`(${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL AND ${table.failureCode} IS NULL) OR (${table.status} = 'failed' AND ${table.completedAt} IS NOT NULL AND ${table.failureCode} IS NOT NULL) OR (${table.status} = 'running' AND ${table.completedAt} IS NULL)`,
    ),
    uniqueIndex("operator_retention_runs_operator_key_idx").on(table.operatorId, table.runKey),
    index("operator_retention_runs_operator_status_idx").on(
      table.operatorId,
      table.status,
      table.startedAt,
    ),
  ],
);

export const operatorRelationshipRecords = pgTable(
  "operator_relationship_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    displayName: text("display_name").notNull(),
    company: text("company"),
    primaryEmail: text("primary_email"),
    provider: text("provider"),
    providerIdentity: text("provider_identity"),
    relationshipState: operatorRelationshipStateEnum("relationship_state")
      .notNull()
      .default("lead"),
    status: operatorRelationshipStatusEnum("status").notNull().default("active"),
    nextAction: text("next_action"),
    nextActionDueAt: timestamp("next_action_due_at", { withTimezone: true }),
    commitments: jsonb("commitments").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    revision: integer("revision").notNull().default(1),
    founderConfirmedAt: timestamp("founder_confirmed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_relationship_records_display_name_check",
      sql`length(trim(${table.displayName})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_relationship_records_company_check",
      sql`${table.company} IS NULL OR length(trim(${table.company})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_relationship_records_email_check",
      sql`${table.primaryEmail} IS NULL OR length(trim(${table.primaryEmail})) BETWEEN 3 AND 320`,
    ),
    check(
      "operator_relationship_records_provider_check",
      sql`(${table.provider} IS NULL AND ${table.providerIdentity} IS NULL) OR (${table.provider} IS NOT NULL AND ${table.providerIdentity} IS NOT NULL)`,
    ),
    check("operator_relationship_records_revision_check", sql`${table.revision} >= 1`),
    check(
      "operator_relationship_records_closed_shape_check",
      sql`(${table.status} = 'active' AND ${table.closedAt} IS NULL) OR (${table.status} <> 'active' AND ${table.closedAt} IS NOT NULL)`,
    ),
    uniqueIndex("operator_relationship_records_provider_identity_idx")
      .on(table.operatorId, table.provider, table.providerIdentity)
      .where(sql`${table.providerIdentity} IS NOT NULL`),
    uniqueIndex("operator_relationship_records_primary_email_idx")
      .on(table.operatorId, table.primaryEmail)
      .where(sql`${table.primaryEmail} IS NOT NULL`),
    index("operator_relationship_records_operator_status_idx").on(
      table.operatorId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const operatorRelationshipCandidates = pgTable(
  "operator_relationship_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    matchKind: operatorRelationshipCandidateMatchKindEnum("match_kind").notNull(),
    status: operatorRelationshipCandidateStatusEnum("status").notNull().default("pending"),
    displayName: text("display_name").notNull(),
    company: text("company"),
    primaryEmail: text("primary_email"),
    provider: text("provider"),
    providerIdentity: text("provider_identity"),
    domain: text("domain"),
    candidateKey: text("candidate_key").notNull(),
    proposedRecordId: uuid("proposed_record_id").references(() => operatorRelationshipRecords.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_relationship_candidates_display_name_check",
      sql`length(trim(${table.displayName})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_relationship_candidates_status_shape_check",
      sql`(${table.status} = 'pending' AND ${table.resolvedAt} IS NULL) OR (${table.status} <> 'pending' AND ${table.resolvedAt} IS NOT NULL)`,
    ),
    check(
      "operator_relationship_candidates_provider_check",
      sql`(${table.provider} IS NULL AND ${table.providerIdentity} IS NULL) OR (${table.provider} IS NOT NULL AND ${table.providerIdentity} IS NOT NULL)`,
    ),
    uniqueIndex("operator_relationship_candidates_key_idx").on(
      table.operatorId,
      table.candidateKey,
    ),
    index("operator_relationship_candidates_operator_status_idx").on(
      table.operatorId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const operatorRelationshipEvidence = pgTable(
  "operator_relationship_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    recordId: uuid("record_id").references(() => operatorRelationshipRecords.id, {
      onDelete: "set null",
    }),
    candidateId: uuid("candidate_id").references(() => operatorRelationshipCandidates.id, {
      onDelete: "set null",
    }),
    sourceKind: operatorRelationshipEvidenceSourceKindEnum("source_kind").notNull(),
    calendarConnectionId: uuid("calendar_connection_id").references(
      () => operatorCalendarConnections.id,
      { onDelete: "set null" },
    ),
    mailConnectionId: uuid("mail_connection_id").references(() => operatorMailConnections.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    providerItemId: text("provider_item_id").notNull(),
    providerIdentity: text("provider_identity"),
    email: text("email"),
    displayName: text("display_name"),
    company: text("company"),
    domain: text("domain"),
    excerpt: text("excerpt"),
    sourceMetadata: jsonb("source_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    evidenceState: operatorRelationshipEvidenceStateEnum("evidence_state")
      .notNull()
      .default("current"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_relationship_evidence_source_connection_check",
      sql`(${table.sourceKind} = 'calendar' AND ${table.mailConnectionId} IS NULL) OR (${table.sourceKind} = 'mail' AND ${table.calendarConnectionId} IS NULL)`,
    ),
    check(
      "operator_relationship_evidence_provider_item_check",
      sql`length(trim(${table.providerItemId})) BETWEEN 1 AND 500`,
    ),
    check(
      "operator_relationship_evidence_display_name_check",
      sql`${table.displayName} IS NULL OR length(trim(${table.displayName})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_relationship_evidence_excerpt_check",
      sql`${table.excerpt} IS NULL OR length(trim(${table.excerpt})) BETWEEN 1 AND 2000`,
    ),
    uniqueIndex("operator_relationship_evidence_source_fingerprint_idx").on(
      table.operatorId,
      table.sourceFingerprint,
    ),
    index("operator_relationship_evidence_record_idx").on(table.operatorId, table.recordId),
    index("operator_relationship_evidence_candidate_idx").on(table.operatorId, table.candidateId),
  ],
);

export const operatorRelationshipCorrections = pgTable(
  "operator_relationship_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    recordId: uuid("record_id")
      .notNull()
      .references(() => operatorRelationshipRecords.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    field: text("field").notNull(),
    previousValue: jsonb("previous_value"),
    nextValue: jsonb("next_value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_relationship_corrections_field_check",
      sql`${table.field} IN ('relationship_state', 'status', 'next_action', 'next_action_due_at', 'commitments')`,
    ),
    check("operator_relationship_corrections_revision_check", sql`${table.revision} >= 1`),
    index("operator_relationship_corrections_record_idx").on(
      table.operatorId,
      table.recordId,
      table.revision,
    ),
  ],
);

export const operatorConversations = pgTable(
  "operator_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    status: operatorConversationStatusEnum("status").notNull().default("active"),
    nextSequence: integer("next_sequence").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_conversations_next_sequence_check", sql`${table.nextSequence} >= 1`),
    uniqueIndex("operator_conversations_operator_id_idx").on(table.operatorId),
    index("operator_conversations_status_idx").on(table.status),
  ],
);

export const operatorConversationWorks = pgTable(
  "operator_conversation_works",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => operatorConversations.id),
    requestId: text("request_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    provider: text("provider").notNull().default("openai"),
    policyVersion: integer("policy_version").notNull().default(1),
    completionIdentity: text("completion_identity").notNull().default("legacy"),
    responseSequence: integer("response_sequence").notNull(),
    state: operatorConversationWorkStateEnum("state").notNull().default("running"),
    founderMessageId: uuid("founder_message_id"),
    operatorMessageId: uuid("operator_message_id"),
    providerConnectionId: uuid("provider_connection_id"),
    providerSubjectId: text("provider_subject_id"),
    providerAccountLabel: text("provider_account_label"),
    approvedModelAssignment: text("approved_model_assignment"),
    providerAttempts: jsonb("provider_attempts")
      .$type<
        Array<{
          provider: string;
          policyVersion: number;
          connectionId: string | null;
          providerSubjectId: string | null;
          accountLabel: string | null;
          approvedModelAssignment: string;
          state: "running" | "paused" | "completed";
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    externalEffectStarted: boolean("external_effect_started").notNull().default(false),
    recoveryChoices: jsonb("recovery_choices")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    recoveryMessage: text("recovery_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_conversation_works_request_id_check",
      sql`length(trim(${table.requestId})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_conversation_works_checkpoint_id_check",
      sql`length(trim(${table.checkpointId})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_conversation_works_provider_check",
      sql`${table.provider} IN ('openai', 'anthropic')`,
    ),
    check(
      "operator_conversation_works_provider_subject_check",
      sql`${table.providerSubjectId} IS NULL OR length(trim(${table.providerSubjectId})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_conversation_works_provider_account_label_check",
      sql`${table.providerAccountLabel} IS NULL OR length(trim(${table.providerAccountLabel})) BETWEEN 1 AND 200`,
    ),
    check(
      "operator_conversation_works_approved_model_assignment_check",
      sql`${table.approvedModelAssignment} IS NULL OR length(trim(${table.approvedModelAssignment})) BETWEEN 1 AND 200`,
    ),
    check("operator_conversation_works_policy_version_check", sql`${table.policyVersion} >= 1`),
    check(
      "operator_conversation_works_completion_identity_check",
      sql`length(trim(${table.completionIdentity})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_conversation_works_response_sequence_check",
      sql`${table.responseSequence} >= 1`,
    ),
    check(
      "operator_conversation_works_recovery_message_check",
      sql`${table.state} IN ('paused', 'failed') OR ${table.recoveryMessage} IS NULL`,
    ),
    check(
      "operator_conversation_works_pause_pair_check",
      sql`(${table.state} = 'paused' AND ${table.pausedAt} IS NOT NULL) OR (${table.state} <> 'paused' AND ${table.pausedAt} IS NULL)`,
    ),
    check(
      "operator_conversation_works_completed_pair_check",
      sql`(${table.state} = 'completed' AND ${table.completedAt} IS NOT NULL) OR (${table.state} <> 'completed' AND ${table.completedAt} IS NULL)`,
    ),
    uniqueIndex("operator_conversation_works_request_id_idx").on(
      table.conversationId,
      table.requestId,
    ),
    index("operator_conversation_works_checkpoint_idx").on(
      table.conversationId,
      table.checkpointId,
    ),
    index("operator_conversation_works_state_idx").on(table.conversationId, table.state),
    uniqueIndex("operator_conversation_works_completion_identity_idx")
      .on(table.completionIdentity)
      .where(sql`${table.completionIdentity} <> 'legacy'`),
  ],
);

export const operatorConversationMessages = pgTable(
  "operator_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => operatorConversations.id),
    workId: uuid("work_id").references(() => operatorConversationWorks.id),
    sequence: integer("sequence").notNull(),
    role: operatorConversationMessageRoleEnum("role").notNull(),
    status: operatorConversationMessageStatusEnum("status").notNull().default("complete"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "operator_conversation_messages_body_check",
      sql`length(trim(${table.body})) BETWEEN 1 AND 12000`,
    ),
    check("operator_conversation_messages_sequence_check", sql`${table.sequence} >= 1`),
    uniqueIndex("operator_conversation_messages_sequence_idx").on(
      table.conversationId,
      table.sequence,
    ),
    index("operator_conversation_messages_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

/**
 * A preview has one stable identity and append-only revisions. The table never
 * carries an executable provider operation; it is deliberately only a
 * founder-controlled description of a possible future effect.
 */
export const operatorActionPreviews = pgTable(
  "operator_action_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    mailSendingOfferDismissedAt: timestamp("mail_sending_offer_dismissed_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operator_action_previews_operator_idx").on(table.operatorId),
    index("operator_action_previews_updated_idx").on(table.operatorId, table.updatedAt),
  ],
);

export const operatorActionPreviewRevisions = pgTable(
  "operator_action_preview_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    previewId: uuid("preview_id")
      .notNull()
      .references(() => operatorActionPreviews.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    state: operatorActionPreviewStateEnum("state").notNull().default("draft"),
    recipientName: text("recipient_name").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    content: text("content").notNull(),
    supportingEvidence: jsonb("supporting_evidence")
      .$type<Array<{ label: string; detail: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    expectedExternalEffect: text("expected_external_effect").notNull(),
    supersedesRevisionId: uuid("supersedes_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_action_preview_revisions_revision_check", sql`${table.revision} >= 1`),
    check(
      "operator_action_preview_revisions_recipient_name_check",
      sql`length(trim(${table.recipientName})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_action_preview_revisions_recipient_address_check",
      sql`length(trim(${table.recipientAddress})) BETWEEN 1 AND 320`,
    ),
    check(
      "operator_action_preview_revisions_content_check",
      sql`length(trim(${table.content})) BETWEEN 1 AND 12000`,
    ),
    check(
      "operator_action_preview_revisions_effect_check",
      sql`length(trim(${table.expectedExternalEffect})) BETWEEN 1 AND 2000`,
    ),
    uniqueIndex("operator_action_preview_revisions_identity_idx").on(
      table.previewId,
      table.revision,
    ),
    index("operator_action_preview_revisions_current_idx").on(table.previewId, table.createdAt),
  ],
);

export const operatorProductGuardrails = pgTable(
  "operator_product_guardrails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    blockedActionFamilies: jsonb("blocked_action_families")
      .$type<Array<(typeof operatorActionFamilyEnum.enumValues)[number]>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    blockedSubtypes: jsonb("blocked_subtypes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_product_guardrails_version_check", sql`${table.version} >= 1`),
    uniqueIndex("operator_product_guardrails_operator_version_idx").on(
      table.operatorId,
      table.version,
    ),
    index("operator_product_guardrails_operator_idx").on(table.operatorId, table.createdAt),
  ],
);

export const operatorProposedActions = pgTable(
  "operator_proposed_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    supersedesActionId: uuid("supersedes_action_id"),
    actionFamily: operatorActionFamilyEnum("action_family").notNull(),
    actionSubtype: text("action_subtype"),
    businessOutcome: text("business_outcome").notNull(),
    companyConnectionId: uuid("company_connection_id"),
    connectionResourceId: uuid("connection_resource_id"),
    connectionAccessVersion: integer("connection_access_version"),
    destination: jsonb("destination").$type<Record<string, unknown>>().notNull(),
    materialContent: jsonb("material_content").$type<Record<string, unknown>>().notNull(),
    sideEffects: jsonb("side_effects").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    processingConsentId: uuid("processing_consent_id"),
    processingConsentVersion: integer("processing_consent_version"),
    authorityPolicyId: uuid("authority_policy_id"),
    authorityPolicyVersion: integer("authority_policy_version").notNull(),
    authorityMode: operatorAuthorityModeEnum("authority_mode").notNull(),
    productGuardrailsVersion: integer("product_guardrails_version").notNull().default(1),
    preconditions: jsonb("preconditions")
      .$type<Array<{ key: string; description: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    executionWindowStart: timestamp("execution_window_start", { withTimezone: true }),
    executionWindowEnd: timestamp("execution_window_end", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    state: operatorProposedActionStateEnum("state").notNull().default("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_proposed_actions_version_check", sql`${table.version} >= 1`),
    check(
      "operator_proposed_actions_connection_access_version_check",
      sql`${table.connectionAccessVersion} IS NULL OR ${table.connectionAccessVersion} >= 1`,
    ),
    check(
      "operator_proposed_actions_processing_consent_version_check",
      sql`${table.processingConsentVersion} IS NULL OR ${table.processingConsentVersion} >= 1`,
    ),
    check(
      "operator_proposed_actions_business_outcome_check",
      sql`length(trim(${table.businessOutcome})) BETWEEN 1 AND 2000`,
    ),
    check(
      "operator_proposed_actions_validity_check",
      sql`${table.executionWindowStart} IS NULL OR ${table.executionWindowEnd} IS NULL OR ${table.executionWindowStart} < ${table.executionWindowEnd}`,
    ),
    uniqueIndex("operator_proposed_actions_operator_version_idx").on(
      table.operatorId,
      table.id,
      table.version,
    ),
    uniqueIndex("operator_proposed_actions_idempotency_idx").on(
      table.operatorId,
      table.idempotencyKey,
    ),
    index("operator_proposed_actions_operator_state_idx").on(
      table.operatorId,
      table.state,
      table.updatedAt,
    ),
  ],
);

export const operatorActionDecisions = pgTable(
  "operator_action_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    proposedActionId: uuid("proposed_action_id")
      .notNull()
      .references(() => operatorProposedActions.id, { onDelete: "cascade" }),
    proposedActionVersion: integer("proposed_action_version").notNull(),
    kind: operatorActionDecisionKindEnum("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operator_action_decisions_proposed_action_idx").on(table.proposedActionId),
    index("operator_action_decisions_operator_created_idx").on(table.operatorId, table.createdAt),
  ],
);

export const operatorActionAuthorizations = pgTable(
  "operator_action_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    proposedActionId: uuid("proposed_action_id")
      .notNull()
      .references(() => operatorProposedActions.id, { onDelete: "cascade" }),
    decisionId: uuid("decision_id").references(() => operatorActionDecisions.id, {
      onDelete: "cascade",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operator_action_authorizations_proposed_action_idx").on(table.proposedActionId),
    index("operator_action_authorizations_operator_idx").on(table.operatorId, table.createdAt),
  ],
);

export const operatorActionExecutionAttempts = pgTable(
  "operator_action_execution_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    proposedActionId: uuid("proposed_action_id")
      .notNull()
      .references(() => operatorProposedActions.id, { onDelete: "cascade" }),
    authorizationId: uuid("authorization_id")
      .notNull()
      .references(() => operatorActionAuthorizations.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    phase: operatorActionExecutionAttemptPhaseEnum("phase").notNull(),
    provider: text("provider").notNull().default("google_gmail_sending"),
    messageIdentity: text("message_identity").notNull(),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    requestDigest: text("request_digest"),
    responseDigest: text("response_digest"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_action_execution_attempts_attempt_check", sql`${table.attemptNumber} >= 1`),
    check(
      "operator_action_execution_attempts_provider_check",
      sql`${table.provider} = 'google_gmail_sending'`,
    ),
    check(
      "operator_action_execution_attempts_identity_check",
      sql`length(trim(${table.messageIdentity})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_action_execution_attempts_request_digest_check",
      sql`${table.requestDigest} IS NULL OR ${table.requestDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "operator_action_execution_attempts_response_digest_check",
      sql`${table.responseDigest} IS NULL OR ${table.responseDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    uniqueIndex("operator_action_execution_attempts_phase_idx").on(
      table.proposedActionId,
      table.attemptNumber,
      table.phase,
    ),
    index("operator_action_execution_attempts_action_idx").on(
      table.proposedActionId,
      table.createdAt,
    ),
  ],
);

export const operatorActionReceipts = pgTable(
  "operator_action_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    proposedActionId: uuid("proposed_action_id")
      .notNull()
      .references(() => operatorProposedActions.id, { onDelete: "cascade" }),
    proposedActionVersion: integer("proposed_action_version").notNull(),
    authorityPolicyId: uuid("authority_policy_id").references(() => operatorAuthorityPolicies.id),
    authorityPolicyVersion: integer("authority_policy_version").notNull(),
    decisionId: uuid("decision_id").references(() => operatorActionDecisions.id),
    authorizationId: uuid("authorization_id")
      .notNull()
      .references(() => operatorActionAuthorizations.id, { onDelete: "restrict" }),
    provider: text("provider").notNull().default("google_gmail_sending"),
    providerConnectionId: uuid("provider_connection_id")
      .notNull()
      .references(() => operatorMailSendingConnections.id, { onDelete: "restrict" }),
    providerConnectionGeneration: integer("provider_connection_generation").notNull(),
    connectionAccessVersion: integer("connection_access_version"),
    connectionResourceId: uuid("connection_resource_id"),
    processingConsentId: uuid("processing_consent_id"),
    processingConsentVersion: integer("processing_consent_version"),
    messageIdentity: text("message_identity").notNull(),
    contentDigest: text("content_digest").notNull(),
    destinationDigest: text("destination_digest").notNull(),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    attemptCount: integer("attempt_count").notNull(),
    outcome: operatorActionReceiptOutcomeEnum("outcome").notNull(),
    outcomeReason: text("outcome_reason"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    evidenceDigest: text("evidence_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("operator_action_receipts_version_check", sql`${table.proposedActionVersion} >= 1`),
    check(
      "operator_action_receipts_policy_version_check",
      sql`${table.authorityPolicyVersion} >= 1`,
    ),
    check(
      "operator_action_receipts_generation_check",
      sql`${table.providerConnectionGeneration} >= 1`,
    ),
    check(
      "operator_action_receipts_processing_consent_version_check",
      sql`${table.processingConsentVersion} IS NULL OR ${table.processingConsentVersion} >= 1`,
    ),
    check("operator_action_receipts_attempt_count_check", sql`${table.attemptCount} >= 1`),
    check(
      "operator_action_receipts_provider_check",
      sql`${table.provider} = 'google_gmail_sending'`,
    ),
    check(
      "operator_action_receipts_identity_check",
      sql`length(trim(${table.messageIdentity})) BETWEEN 1 AND 240`,
    ),
    check(
      "operator_action_receipts_content_digest_check",
      sql`${table.contentDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "operator_action_receipts_destination_digest_check",
      sql`${table.destinationDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "operator_action_receipts_evidence_digest_check",
      sql`${table.evidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "operator_action_receipts_ack_pair_check",
      sql`(${table.outcome} = 'succeeded' AND ${table.providerMessageId} IS NOT NULL AND ${table.acknowledgedAt} IS NOT NULL) OR (${table.outcome} <> 'succeeded' AND ${table.acknowledgedAt} IS NULL)`,
    ),
    uniqueIndex("operator_action_receipts_action_idx").on(table.proposedActionId),
    uniqueIndex("operator_action_receipts_message_identity_idx").on(table.messageIdentity),
    index("operator_action_receipts_operator_created_idx").on(table.operatorId, table.createdAt),
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
    origin: text("origin").default("operator_trial"),
    initialCohort: text("initial_cohort").default("unknown"),
    deploymentEnvironment: text("deployment_environment").default("non_production"),
    ownerCancelledAt: timestamp("owner_cancelled_at", { withTimezone: true }),
    rolloutConfigurationGeneration: integer("rollout_configuration_generation").default(1),
    deploymentChoices: jsonb("deployment_choices")
      .$type<AgentDeploymentChoices>()
      .notNull()
      .default(
        sql`'{"schemaVersion":"bruno.agent-deployment.choices.v1","dispatchMode":"cron","rolloutConfigurationGeneration":1,"provider":{"mode":"unavailable","region":"unknown","sizeSlug":"unknown","image":"unknown","tags":[],"runnerImage":"unknown","hermesWorkloadImage":null,"hermesStateRoot":null,"hermesPrivateNetwork":null,"hermesReadinessTimeoutMs":null,"hermesDockerCpus":null,"hermesDockerMemory":null,"hermesDockerPidsLimit":null,"runnerMaxAgents":null,"snapshotMode":{"mode":"stock"}},"validation":{"mode":"full","releaseBundleDigest":null,"snapshotBundleDigest":null}}'::jsonb`,
      ),
    safetyQuarantinedAt: timestamp("safety_quarantined_at", { withTimezone: true }),
    safetyQuarantineReason: text("safety_quarantine_reason"),
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
      "agent_deployments_origin_check",
      sql`${table.origin} IS NULL OR ${table.origin} IN ('owner_request', 'operator_trial', 'runner_replacement')`,
    ),
    check(
      "agent_deployments_initial_cohort_check",
      sql`${table.initialCohort} IS NULL OR ${table.initialCohort} IN ('cold_deployment', 'same_owner_reuse', 'unknown')`,
    ),
    check(
      "agent_deployments_environment_check",
      sql`${table.deploymentEnvironment} IS NULL OR ${table.deploymentEnvironment} IN ('production', 'non_production')`,
    ),
    check(
      "agent_deployments_owner_cancelled_after_acceptance_check",
      sql`${table.ownerCancelledAt} IS NULL OR ${table.acceptedAt} IS NULL OR ${table.ownerCancelledAt} >= ${table.acceptedAt}`,
    ),
    check(
      "agent_deployments_rollout_configuration_generation_check",
      sql`${table.rolloutConfigurationGeneration} IS NULL OR ${table.rolloutConfigurationGeneration} >= 1`,
    ),
    check(
      "agent_deployments_choices_schema_check",
      sql`${table.deploymentChoices} ->> 'schemaVersion' = 'bruno.agent-deployment.choices.v1'`,
    ),
    check(
      "agent_deployments_safety_quarantine_pair_check",
      sql`(${table.safetyQuarantinedAt} IS NULL AND ${table.safetyQuarantineReason} IS NULL) OR (${table.safetyQuarantinedAt} IS NOT NULL AND length(trim(${table.safetyQuarantineReason})) BETWEEN 1 AND 200)`,
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
    index("agent_deployments_slo_selection_idx")
      .on(table.acceptedAt, table.id)
      .where(
        sql`${table.origin} = 'owner_request' AND ${table.initialCohort} = 'cold_deployment' AND ${table.deploymentEnvironment} = 'production'`,
      ),
  ],
);

export const providerTrialCohorts = pgTable(
  "provider_trial_cohorts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cohortKey: text("cohort_key").notNull(),
    region: text("region").notNull(),
    runnerSizeSlug: text("runner_size_slug").notNull(),
    rolloutConfigurationGeneration: integer("rollout_configuration_generation").notNull(),
    readinessObjectiveSeconds: integer("readiness_objective_seconds").notNull().default(300),
    startedAt: timestamp("started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_trial_cohorts_key_idx").on(table.cohortKey),
    check(
      "provider_trial_cohorts_key_check",
      sql`${table.cohortKey} ~ '^[a-z0-9][a-z0-9._:-]{7,127}$'`,
    ),
    check(
      "provider_trial_cohorts_region_check",
      sql`${table.region} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`,
    ),
    check(
      "provider_trial_cohorts_runner_size_slug_check",
      sql`${table.runnerSizeSlug} ~ '^[a-z0-9][a-z0-9-]{0,127}$'`,
    ),
    check(
      "provider_trial_cohorts_rollout_generation_check",
      sql`${table.rolloutConfigurationGeneration} >= 1`,
    ),
    check(
      "provider_trial_cohorts_readiness_objective_check",
      sql`${table.readinessObjectiveSeconds} IN (60, 300)`,
    ),
  ],
);

export const providerTrialSlots = pgTable(
  "provider_trial_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cohortId: uuid("cohort_id")
      .notNull()
      .references(() => providerTrialCohorts.id, { onDelete: "restrict" }),
    slotNumber: integer("slot_number").notNull(),
    requestAttemptId: uuid("request_attempt_id"),
    requestStartedAt: timestamp("request_started_at", { withTimezone: true }),
    requestOutcome: text("request_outcome"),
    requestSafeCode: text("request_safe_code"),
    requestOutcomeRecordedAt: timestamp("request_outcome_recorded_at", { withTimezone: true }),
    deploymentId: uuid("deployment_id").references(() => agentDeployments.id, {
      onDelete: "restrict",
    }),
    terminalOutcome: text("terminal_outcome"),
    terminalSafeCode: text("terminal_safe_code"),
    terminalRecordedAt: timestamp("terminal_recorded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_trial_slots_cohort_number_idx").on(table.cohortId, table.slotNumber),
    uniqueIndex("provider_trial_slots_request_attempt_idx").on(table.requestAttemptId),
    uniqueIndex("provider_trial_slots_deployment_idx").on(table.deploymentId),
    check("provider_trial_slots_number_check", sql`${table.slotNumber} BETWEEN 1 AND 30`),
    check(
      "provider_trial_slots_request_started_pair_check",
      sql`(${table.requestAttemptId} IS NULL AND ${table.requestStartedAt} IS NULL) OR (${table.requestAttemptId} IS NOT NULL AND ${table.requestStartedAt} IS NOT NULL)`,
    ),
    check(
      "provider_trial_slots_request_outcome_check",
      sql`${table.requestOutcome} IS NULL OR ${table.requestOutcome} IN ('committed', 'pre_commit_failure')`,
    ),
    check(
      "provider_trial_slots_request_safe_code_check",
      sql`${table.requestSafeCode} IS NULL OR ${table.requestSafeCode} IN ('deployment_failed', 'ready_timeout', 'request_failed', 'request_outcome_unknown', 'request_rejected', 'request_validation_failed', 'safety_failure')`,
    ),
    check(
      "provider_trial_slots_request_outcome_shape_check",
      sql`(${table.requestOutcome} IS NULL AND ${table.requestOutcomeRecordedAt} IS NULL AND ${table.requestSafeCode} IS NULL AND ${table.deploymentId} IS NULL) OR (${table.requestOutcome} = 'committed' AND ${table.requestOutcomeRecordedAt} IS NOT NULL AND ${table.requestSafeCode} IS NULL AND ${table.deploymentId} IS NOT NULL) OR (${table.requestOutcome} = 'pre_commit_failure' AND ${table.requestOutcomeRecordedAt} IS NOT NULL AND ${table.requestSafeCode} IS NOT NULL AND ${table.deploymentId} IS NULL)`,
    ),
    check(
      "provider_trial_slots_request_outcome_after_start_check",
      sql`${table.requestOutcome} IS NULL OR (${table.requestAttemptId} IS NOT NULL AND ${table.requestStartedAt} IS NOT NULL AND ${table.requestOutcomeRecordedAt} >= ${table.requestStartedAt})`,
    ),
    check(
      "provider_trial_slots_request_start_boundary_check",
      sql`${table.requestStartedAt} IS NULL OR ${table.requestStartedAt} >= ${table.createdAt}`,
    ),
    check(
      "provider_trial_slots_terminal_outcome_check",
      sql`${table.terminalOutcome} IS NULL OR ${table.terminalOutcome} IN ('pre_commit_failure', 'ready_within_60', 'ready_after_60', 'ready_within_objective', 'ready_after_objective', 'deployment_failed', 'timed_out', 'safety_failure')`,
    ),
    check(
      "provider_trial_slots_terminal_safe_code_check",
      sql`${table.terminalSafeCode} IS NULL OR ${table.terminalSafeCode} IN ('deployment_failed', 'ready_timeout', 'request_failed', 'request_outcome_unknown', 'request_rejected', 'request_validation_failed', 'safety_failure')`,
    ),
    check(
      "provider_trial_slots_terminal_outcome_shape_check",
      sql`(${table.terminalOutcome} IS NULL AND ${table.terminalRecordedAt} IS NULL AND ${table.terminalSafeCode} IS NULL) OR (${table.terminalOutcome} = 'pre_commit_failure' AND ${table.terminalRecordedAt} IS NOT NULL AND ${table.terminalSafeCode} IS NOT NULL AND ${table.requestOutcome} = 'pre_commit_failure') OR (${table.terminalOutcome} IN ('ready_within_60', 'ready_after_60', 'ready_within_objective', 'ready_after_objective') AND ${table.terminalRecordedAt} IS NOT NULL AND ${table.terminalSafeCode} IS NULL AND ${table.requestOutcome} = 'committed') OR (${table.terminalOutcome} IN ('deployment_failed', 'timed_out', 'safety_failure') AND ${table.terminalRecordedAt} IS NOT NULL AND ${table.terminalSafeCode} IS NOT NULL AND ${table.requestOutcome} = 'committed')`,
    ),
    check(
      "provider_trial_slots_terminal_after_request_check",
      sql`${table.terminalOutcome} IS NULL OR ${table.terminalRecordedAt} >= ${table.requestOutcomeRecordedAt}`,
    ),
    check(
      "provider_trial_slots_precommit_code_match_check",
      sql`${table.terminalOutcome} <> 'pre_commit_failure' OR ${table.terminalSafeCode} = ${table.requestSafeCode}`,
    ),
  ],
);

export const providerTrialSlotCleanupEvents = pgTable(
  "provider_trial_slot_cleanup_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => providerTrialSlots.id, { onDelete: "restrict" }),
    cleanupAttemptNumber: integer("cleanup_attempt_number").notNull(),
    costCents: integer("cost_cents").notNull(),
    activeProviderResources: integer("active_provider_resources").notNull(),
    ok: boolean("ok").notNull(),
    authoritative: boolean("authoritative").notNull(),
    remainingResourceCount: integer("remaining_resource_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_trial_slot_cleanup_events_attempt_idx").on(
      table.slotId,
      table.cleanupAttemptNumber,
    ),
    index("provider_trial_slot_cleanup_events_created_idx").on(table.createdAt, table.slotId),
    check(
      "provider_trial_slot_cleanup_events_attempt_check",
      sql`${table.cleanupAttemptNumber} >= 1`,
    ),
    check("provider_trial_slot_cleanup_events_cost_check", sql`${table.costCents} >= 0`),
    check(
      "provider_trial_slot_cleanup_events_resource_count_check",
      sql`${table.activeProviderResources} >= 0 AND ${table.remainingResourceCount} >= 0`,
    ),
  ],
);

export const providerTrialRuns = pgTable(
  "provider_trial_runs",
  {
    cohortId: uuid("cohort_id")
      .primaryKey()
      .references(() => providerTrialCohorts.id, { onDelete: "restrict" }),
    state: text("state").notNull().default("running"),
    configuration: jsonb("configuration").notNull(),
    nextSlotNumber: integer("next_slot_number").notNull().default(1),
    spentCents: integer("spent_cents").notNull().default(0),
    authorizationGeneration: integer("authorization_generation").notNull(),
    authorizationIdHash: text("authorization_id_hash").notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull().defaultNow(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pauseReason: text("pause_reason"),
    activeSlotCheckpoint: jsonb("active_slot_checkpoint"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    cleanupEvidence: jsonb("cleanup_evidence"),
    signedReportBytes: text("signed_report_bytes"),
    signedReportDigest: text("signed_report_digest"),
    signedReportKeyId: text("signed_report_key_id"),
    signedReportSignature: text("signed_report_signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "provider_trial_runs_state_check",
      sql`${table.state} IN ('running', 'paused', 'ready_to_finalize', 'complete')`,
    ),
    check("provider_trial_runs_next_slot_check", sql`${table.nextSlotNumber} BETWEEN 1 AND 31`),
    check("provider_trial_runs_spend_check", sql`${table.spentCents} >= 0`),
    check(
      "provider_trial_runs_authorization_generation_check",
      sql`${table.authorizationGeneration} >= 1`,
    ),
    check(
      "provider_trial_runs_pause_pair_check",
      sql`(${table.state} = 'paused' AND ${table.pausedAt} IS NOT NULL AND ${table.pauseReason} IS NOT NULL) OR (${table.state} <> 'paused' AND ${table.pausedAt} IS NULL AND ${table.pauseReason} IS NULL)`,
    ),
    check(
      "provider_trial_runs_lease_pair_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "provider_trial_runs_signed_report_shape_check",
      sql`(${table.state} = 'complete' AND ${table.signedReportBytes} IS NOT NULL AND ${table.signedReportDigest} IS NOT NULL AND ${table.signedReportKeyId} IS NOT NULL AND ${table.signedReportSignature} IS NOT NULL AND ${table.cleanupEvidence} IS NOT NULL) OR (${table.state} <> 'complete' AND ${table.signedReportBytes} IS NULL AND ${table.signedReportDigest} IS NULL AND ${table.signedReportKeyId} IS NULL AND ${table.signedReportSignature} IS NULL)`,
    ),
  ],
);

export const providerTrialAuthorizationEvents = pgTable(
  "provider_trial_authorization_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cohortId: uuid("cohort_id")
      .notNull()
      .references(() => providerTrialRuns.cohortId, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    authorizationIdHash: text("authorization_id_hash").notNull(),
    prerequisiteGateEvidenceDigest: text("prerequisite_gate_evidence_digest").notNull(),
    deploymentChoicesDigest: text("deployment_choices_digest").notNull(),
    renewedFromPausedAt: timestamp("renewed_from_paused_at", { withTimezone: true }),
    renewedFromPauseReason: text("renewed_from_pause_reason"),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_trial_authorization_events_generation_idx").on(
      table.cohortId,
      table.generation,
    ),
    check("provider_trial_authorization_events_generation_check", sql`${table.generation} >= 1`),
    check(
      "provider_trial_authorization_events_id_hash_check",
      sql`${table.authorizationIdHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "provider_trial_authorization_events_gate_digest_check",
      sql`${table.prerequisiteGateEvidenceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "provider_trial_authorization_events_choices_digest_check",
      sql`${table.deploymentChoicesDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "provider_trial_authorization_events_pause_pair_check",
      sql`(${table.renewedFromPausedAt} IS NULL AND ${table.renewedFromPauseReason} IS NULL) OR (${table.renewedFromPausedAt} IS NOT NULL AND ${table.renewedFromPauseReason} IS NOT NULL)`,
    ),
  ],
);

export const coldDeploymentSloEvaluations = pgTable(
  "cold_deployment_slo_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    reportBytes: text("report_bytes").notNull(),
    reportDigest: text("report_digest").notNull(),
    signingKeyId: text("signing_key_id").notNull(),
    signature: text("signature").notNull(),
    objectiveSeconds: integer("objective_seconds").notNull(),
    eligibleCount: integer("eligible_count").notNull(),
    readyWithinObjective: integer("ready_within_objective").notNull(),
    pendingCount: integer("pending_count").notNull(),
    proven: boolean("proven").notNull(),
    incidentOpened: boolean("incident_opened").notNull().default(false),
    rolloutConfigurationGenerations: jsonb("rollout_configuration_generations")
      .$type<number[]>()
      .notNull(),
    previousReportDigest: text("previous_report_digest"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("cold_deployment_slo_evaluations_digest_idx").on(table.reportDigest),
    check(
      "cold_deployment_slo_evaluations_digest_check",
      sql`${table.reportDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "cold_deployment_slo_evaluations_previous_digest_check",
      sql`${table.previousReportDigest} IS NULL OR ${table.previousReportDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "cold_deployment_slo_evaluations_count_check",
      sql`${table.objectiveSeconds} IN (60, 300) AND ${table.eligibleCount} BETWEEN 0 AND 100 AND ${table.readyWithinObjective} BETWEEN 0 AND ${table.eligibleCount} AND ${table.pendingCount} BETWEEN 0 AND ${table.eligibleCount}`,
    ),
    check(
      "cold_deployment_slo_evaluations_proven_check",
      sql`${table.proven} = (${table.eligibleCount} = 100 AND ${table.pendingCount} = 0 AND ${table.readyWithinObjective} >= 95)`,
    ),
    check(
      "cold_deployment_slo_evaluations_incident_check",
      sql`NOT ${table.incidentOpened} OR NOT ${table.proven}`,
    ),
  ],
);

export const agentDeploymentApiAttemptEvents = pgTable(
  "agent_deployment_api_attempt_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id").notNull(),
    requestKind: text("request_kind").notNull(),
    phase: text("phase").notNull(),
    safeCode: text("safe_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_deployment_api_attempt_events_attempt_phase_idx").on(
      table.attemptId,
      table.phase,
    ),
    uniqueIndex("agent_deployment_api_attempt_events_one_terminal_idx")
      .on(table.attemptId)
      .where(sql`${table.phase} <> 'started'`),
    index("agent_deployment_api_attempt_events_created_idx").on(table.createdAt, table.attemptId),
    check(
      "agent_deployment_api_attempt_events_kind_check",
      sql`${table.requestKind} IN ('create_ready', 'start')`,
    ),
    check(
      "agent_deployment_api_attempt_events_phase_check",
      sql`${table.phase} IN ('started', 'accepted', 'rejected', 'outcome_unknown')`,
    ),
    check(
      "agent_deployment_api_attempt_events_shape_check",
      sql`(${table.phase} IN ('started', 'accepted') AND ${table.safeCode} IS NULL) OR (${table.phase} IN ('rejected', 'outcome_unknown') AND ${table.safeCode} ~ '^[a-z0-9_.:-]{1,64}$')`,
    ),
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
    exhaustedAt: timestamp("exhausted_at", { withTimezone: true }),
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
    check(
      "agent_deployment_wakeups_exhausted_evidence_check",
      sql`${table.exhaustedAt} IS NULL OR ${table.safeErrorCode} IS NOT NULL`,
    ),
    check(
      "agent_deployment_wakeups_exhausted_state_check",
      sql`${table.state}::text <> 'exhausted' OR (${table.exhaustedAt} IS NOT NULL AND ${table.publishLeaseOwner} IS NULL AND ${table.publishLeaseExpiresAt} IS NULL)`,
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
    index("agent_deployment_wakeups_exhausted_idx")
      .on(table.exhaustedAt, table.deploymentId, table.generation)
      .where(sql`${table.exhaustedAt} IS NOT NULL`),
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
