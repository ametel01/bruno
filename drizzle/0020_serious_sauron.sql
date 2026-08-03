CREATE TYPE "public"."hermes_staging_acceptance_challenge_purpose" AS ENUM('initial', 'post_restart');--> statement-breakpoint
CREATE TYPE "public"."hermes_staging_acceptance_desired_outcome" AS ENUM('acceptance', 'cleanup');--> statement-breakpoint
CREATE TYPE "public"."hermes_staging_acceptance_error_code" AS ENUM('invalid_begin', 'preflight_failed', 'image_attestation_failed', 'agent_creation_failed', 'deployment_failed', 'deployment_stage_invalid', 'host_image_unverified', 'initial_human_proof_failed', 'post_restart_human_proof_failed', 'human_proof_expired', 'restart_failed', 'runtime_reverification_failed', 'diagnostics_unsafe', 'stop_failed', 'rollback_failed', 'acceptance_deadline_exceeded', 'acceptance_cancelled', 'cleanup_failed', 'internal_state_invalid');--> statement-breakpoint
CREATE TYPE "public"."hermes_staging_acceptance_pending_effect" AS ENUM('preflight', 'attest_published_image', 'create_ready_agent', 'observe_agent_creation', 'observe_next_deployment_stage', 'verify_strict_host_image', 'issue_initial_human_challenge', 'observe_initial_human_challenge', 'restart_agent', 'observe_agent_restart', 'verify_restarted_image_and_telegram', 'issue_post_restart_human_challenge', 'observe_post_restart_human_challenge', 'audit_safe_diagnostics', 'stop_agent_db_first', 'observe_stop_intent', 'observe_stop_stability', 'verify_manual_rollback', 'cleanup_workload', 'observe_workload_absence', 'cleanup_secrets', 'observe_secrets_absence', 'cleanup_firewall', 'observe_firewall_absence', 'cleanup_droplet', 'observe_droplet_absence', 'cleanup_runner', 'observe_runner_absence');--> statement-breakpoint
CREATE TYPE "public"."hermes_staging_acceptance_phase" AS ENUM('preflight', 'attesting_image', 'creating_ready_agent', 'observing_deployment', 'verifying_host_image', 'awaiting_initial_human_proof', 'restarting', 'reverifying_runtime', 'awaiting_post_restart_human_proof', 'auditing_diagnostics', 'stopping_agent', 'observing_stop_stability', 'checking_rollback', 'cleaning_workload', 'cleaning_secrets', 'cleaning_firewall', 'cleaning_droplet', 'cleaning_runner', 'complete');--> statement-breakpoint
CREATE TYPE "public"."hermes_staging_acceptance_state" AS ENUM('pending', 'executing', 'waiting', 'blocked', 'complete');--> statement-breakpoint
CREATE TYPE "public"."hermes_staging_acceptance_terminal_outcome" AS ENUM('succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "hermes_staging_acceptance_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_key" text DEFAULT 'global' NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"desired_outcome" "hermes_staging_acceptance_desired_outcome" DEFAULT 'acceptance' NOT NULL,
	"phase" "hermes_staging_acceptance_phase" DEFAULT 'preflight' NOT NULL,
	"state" "hermes_staging_acceptance_state" DEFAULT 'pending' NOT NULL,
	"terminal_outcome" "hermes_staging_acceptance_terminal_outcome",
	"generation" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_attempt" integer DEFAULT 0 NOT NULL,
	"pending_effect" "hermes_staging_acceptance_pending_effect",
	"deployment_stage_index" integer DEFAULT -1 NOT NULL,
	"error_code" "hermes_staging_acceptance_error_code",
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"cleanup_deadline_at" timestamp with time zone NOT NULL,
	"expected_source_revision" text NOT NULL,
	"expected_publish_workflow_run_id" text NOT NULL,
	"expected_image_digest" text NOT NULL,
	"observed_image_digest" text,
	"agent_id" uuid,
	"deployment_id" uuid,
	"runner_id" uuid,
	"provider_resource_id" text,
	"provider_firewall_id" text,
	"challenge_purpose" "hermes_staging_acceptance_challenge_purpose",
	"initial_challenge_digest" text,
	"initial_challenge_expires_at" timestamp with time zone,
	"initial_attestation_digest" text,
	"initial_challenge_attested_at" timestamp with time zone,
	"post_restart_challenge_digest" text,
	"post_restart_challenge_expires_at" timestamp with time zone,
	"post_restart_attestation_digest" text,
	"post_restart_challenge_attested_at" timestamp with time zone,
	"stop_stable_since" timestamp with time zone,
	"published_image_verified" boolean DEFAULT false NOT NULL,
	"published_image_verified_at" timestamp with time zone,
	"host_image_verified" boolean DEFAULT false NOT NULL,
	"host_image_verified_at" timestamp with time zone,
	"agent_ready_verified" boolean DEFAULT false NOT NULL,
	"agent_ready_verified_at" timestamp with time zone,
	"initial_human_proof_verified" boolean DEFAULT false NOT NULL,
	"restart_requested" boolean DEFAULT false NOT NULL,
	"restart_requested_at" timestamp with time zone,
	"restart_verified" boolean DEFAULT false NOT NULL,
	"restart_verified_at" timestamp with time zone,
	"restarted_runtime_verified" boolean DEFAULT false NOT NULL,
	"restarted_runtime_verified_at" timestamp with time zone,
	"post_restart_human_proof_verified" boolean DEFAULT false NOT NULL,
	"diagnostics_redacted_confirmed" boolean DEFAULT false NOT NULL,
	"diagnostics_redacted_confirmed_at" timestamp with time zone,
	"stop_verified" boolean DEFAULT false NOT NULL,
	"stop_verified_at" timestamp with time zone,
	"rollback_verified" boolean DEFAULT false NOT NULL,
	"rollback_verified_at" timestamp with time zone,
	"workload_cleanup_confirmed" boolean DEFAULT false NOT NULL,
	"workload_cleanup_confirmed_at" timestamp with time zone,
	"secrets_cleanup_confirmed" boolean DEFAULT false NOT NULL,
	"secrets_cleanup_confirmed_at" timestamp with time zone,
	"firewall_cleanup_confirmed" boolean DEFAULT false NOT NULL,
	"firewall_cleanup_confirmed_at" timestamp with time zone,
	"droplet_cleanup_confirmed" boolean DEFAULT false NOT NULL,
	"droplet_cleanup_confirmed_at" timestamp with time zone,
	"runner_cleanup_confirmed" boolean DEFAULT false NOT NULL,
	"runner_cleanup_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "hermes_staging_acceptance_runs_scope_check" CHECK ("hermes_staging_acceptance_runs"."scope_key" = 'global'),
	CONSTRAINT "hermes_staging_acceptance_runs_idempotency_key_check" CHECK (trim("hermes_staging_acceptance_runs"."idempotency_key") = "hermes_staging_acceptance_runs"."idempotency_key" AND "hermes_staging_acceptance_runs"."idempotency_key" ~ '^[A-Za-z0-9_.:-]{8,128}$'),
	CONSTRAINT "hermes_staging_acceptance_runs_generation_check" CHECK ("hermes_staging_acceptance_runs"."generation" >= 0),
	CONSTRAINT "hermes_staging_acceptance_runs_attempt_count_check" CHECK ("hermes_staging_acceptance_runs"."attempt_count" >= 0),
	CONSTRAINT "hermes_staging_acceptance_runs_lease_attempt_check" CHECK ("hermes_staging_acceptance_runs"."lease_attempt" >= 0),
	CONSTRAINT "hermes_staging_acceptance_runs_deployment_stage_index_check" CHECK ("hermes_staging_acceptance_runs"."deployment_stage_index" BETWEEN -1 AND 6),
	CONSTRAINT "hermes_staging_acceptance_runs_lease_owner_check" CHECK ("hermes_staging_acceptance_runs"."lease_owner" IS NULL OR "hermes_staging_acceptance_runs"."lease_owner" ~ '^staging-acceptance:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "hermes_staging_acceptance_runs_lease_pair_check" CHECK (("hermes_staging_acceptance_runs"."lease_owner" IS NULL AND "hermes_staging_acceptance_runs"."lease_expires_at" IS NULL) OR ("hermes_staging_acceptance_runs"."lease_owner" IS NOT NULL AND "hermes_staging_acceptance_runs"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_execution_lease_check" CHECK (("hermes_staging_acceptance_runs"."state" = 'executing' AND "hermes_staging_acceptance_runs"."lease_owner" IS NOT NULL AND "hermes_staging_acceptance_runs"."lease_expires_at" IS NOT NULL) OR ("hermes_staging_acceptance_runs"."state" <> 'executing' AND "hermes_staging_acceptance_runs"."lease_owner" IS NULL AND "hermes_staging_acceptance_runs"."lease_expires_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_scheduled_work_check" CHECK (("hermes_staging_acceptance_runs"."state" IN ('pending', 'executing', 'waiting') AND "hermes_staging_acceptance_runs"."next_attempt_at" IS NOT NULL) OR ("hermes_staging_acceptance_runs"."state" IN ('blocked', 'complete') AND "hermes_staging_acceptance_runs"."next_attempt_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_image_digest_check" CHECK ("hermes_staging_acceptance_runs"."expected_image_digest" ~ '^sha256:[0-9a-f]{64}$' AND ("hermes_staging_acceptance_runs"."observed_image_digest" IS NULL OR "hermes_staging_acceptance_runs"."observed_image_digest" ~ '^sha256:[0-9a-f]{64}$')),
	CONSTRAINT "hermes_staging_acceptance_runs_source_revision_check" CHECK ("hermes_staging_acceptance_runs"."expected_source_revision" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "hermes_staging_acceptance_runs_workflow_run_id_check" CHECK ("hermes_staging_acceptance_runs"."expected_publish_workflow_run_id" ~ '^[1-9][0-9]{0,19}$'),
	CONSTRAINT "hermes_staging_acceptance_runs_provider_resource_id_check" CHECK ("hermes_staging_acceptance_runs"."provider_resource_id" IS NULL OR "hermes_staging_acceptance_runs"."provider_resource_id" ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	CONSTRAINT "hermes_staging_acceptance_runs_provider_firewall_id_check" CHECK ("hermes_staging_acceptance_runs"."provider_firewall_id" IS NULL OR "hermes_staging_acceptance_runs"."provider_firewall_id" ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	CONSTRAINT "hermes_staging_acceptance_runs_challenge_digest_check" CHECK (("hermes_staging_acceptance_runs"."initial_challenge_digest" IS NULL OR "hermes_staging_acceptance_runs"."initial_challenge_digest" ~ '^sha256:[0-9a-f]{64}$') AND ("hermes_staging_acceptance_runs"."initial_attestation_digest" IS NULL OR "hermes_staging_acceptance_runs"."initial_attestation_digest" ~ '^sha256:[0-9a-f]{64}$') AND ("hermes_staging_acceptance_runs"."post_restart_challenge_digest" IS NULL OR "hermes_staging_acceptance_runs"."post_restart_challenge_digest" ~ '^sha256:[0-9a-f]{64}$') AND ("hermes_staging_acceptance_runs"."post_restart_attestation_digest" IS NULL OR "hermes_staging_acceptance_runs"."post_restart_attestation_digest" ~ '^sha256:[0-9a-f]{64}$')),
	CONSTRAINT "hermes_staging_acceptance_runs_initial_challenge_check" CHECK (("hermes_staging_acceptance_runs"."initial_challenge_digest" IS NULL AND "hermes_staging_acceptance_runs"."initial_challenge_expires_at" IS NULL AND "hermes_staging_acceptance_runs"."initial_attestation_digest" IS NULL AND "hermes_staging_acceptance_runs"."initial_challenge_attested_at" IS NULL AND NOT "hermes_staging_acceptance_runs"."initial_human_proof_verified") OR ("hermes_staging_acceptance_runs"."initial_challenge_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."initial_challenge_expires_at" IS NOT NULL AND (("hermes_staging_acceptance_runs"."initial_attestation_digest" IS NULL AND "hermes_staging_acceptance_runs"."initial_challenge_attested_at" IS NULL AND NOT "hermes_staging_acceptance_runs"."initial_human_proof_verified") OR ("hermes_staging_acceptance_runs"."initial_attestation_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."initial_challenge_attested_at" IS NOT NULL AND "hermes_staging_acceptance_runs"."initial_human_proof_verified" AND "hermes_staging_acceptance_runs"."initial_attestation_digest" <> "hermes_staging_acceptance_runs"."initial_challenge_digest")))),
	CONSTRAINT "hermes_staging_acceptance_runs_post_restart_challenge_check" CHECK (("hermes_staging_acceptance_runs"."post_restart_challenge_digest" IS NULL AND "hermes_staging_acceptance_runs"."post_restart_challenge_expires_at" IS NULL AND "hermes_staging_acceptance_runs"."post_restart_attestation_digest" IS NULL AND "hermes_staging_acceptance_runs"."post_restart_challenge_attested_at" IS NULL AND NOT "hermes_staging_acceptance_runs"."post_restart_human_proof_verified") OR ("hermes_staging_acceptance_runs"."post_restart_challenge_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."post_restart_challenge_expires_at" IS NOT NULL AND "hermes_staging_acceptance_runs"."initial_challenge_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."post_restart_challenge_digest" <> "hermes_staging_acceptance_runs"."initial_challenge_digest" AND (("hermes_staging_acceptance_runs"."post_restart_attestation_digest" IS NULL AND "hermes_staging_acceptance_runs"."post_restart_challenge_attested_at" IS NULL AND NOT "hermes_staging_acceptance_runs"."post_restart_human_proof_verified") OR ("hermes_staging_acceptance_runs"."post_restart_attestation_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."post_restart_challenge_attested_at" IS NOT NULL AND "hermes_staging_acceptance_runs"."post_restart_human_proof_verified" AND "hermes_staging_acceptance_runs"."initial_attestation_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."post_restart_attestation_digest" <> "hermes_staging_acceptance_runs"."post_restart_challenge_digest" AND "hermes_staging_acceptance_runs"."post_restart_attestation_digest" <> "hermes_staging_acceptance_runs"."initial_attestation_digest")))),
	CONSTRAINT "hermes_staging_acceptance_runs_challenge_purpose_check" CHECK (("hermes_staging_acceptance_runs"."phase" = 'awaiting_initial_human_proof' AND (("hermes_staging_acceptance_runs"."initial_challenge_digest" IS NULL AND "hermes_staging_acceptance_runs"."initial_challenge_expires_at" IS NULL AND "hermes_staging_acceptance_runs"."challenge_purpose" IS NULL AND "hermes_staging_acceptance_runs"."pending_effect" IN ('issue_initial_human_challenge', 'observe_initial_human_challenge')) OR ("hermes_staging_acceptance_runs"."initial_challenge_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."initial_challenge_expires_at" IS NOT NULL AND "hermes_staging_acceptance_runs"."challenge_purpose" = 'initial'))) OR ("hermes_staging_acceptance_runs"."phase" = 'awaiting_post_restart_human_proof' AND (("hermes_staging_acceptance_runs"."post_restart_challenge_digest" IS NULL AND "hermes_staging_acceptance_runs"."post_restart_challenge_expires_at" IS NULL AND "hermes_staging_acceptance_runs"."challenge_purpose" IS NULL AND "hermes_staging_acceptance_runs"."pending_effect" IN ('issue_post_restart_human_challenge', 'observe_post_restart_human_challenge')) OR ("hermes_staging_acceptance_runs"."post_restart_challenge_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."post_restart_challenge_expires_at" IS NOT NULL AND "hermes_staging_acceptance_runs"."challenge_purpose" = 'post_restart'))) OR ("hermes_staging_acceptance_runs"."phase" NOT IN ('awaiting_initial_human_proof', 'awaiting_post_restart_human_proof') AND "hermes_staging_acceptance_runs"."challenge_purpose" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_challenge_time_check" CHECK (("hermes_staging_acceptance_runs"."initial_challenge_expires_at" IS NULL OR ("hermes_staging_acceptance_runs"."initial_challenge_expires_at" > "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."initial_challenge_expires_at" <= "hermes_staging_acceptance_runs"."deadline_at" AND ("hermes_staging_acceptance_runs"."initial_challenge_attested_at" IS NULL OR ("hermes_staging_acceptance_runs"."initial_challenge_attested_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."initial_challenge_attested_at" <= "hermes_staging_acceptance_runs"."initial_challenge_expires_at" AND "hermes_staging_acceptance_runs"."initial_challenge_attested_at" <= "hermes_staging_acceptance_runs"."updated_at")))) AND ("hermes_staging_acceptance_runs"."post_restart_challenge_expires_at" IS NULL OR ("hermes_staging_acceptance_runs"."post_restart_challenge_expires_at" > "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."post_restart_challenge_expires_at" <= "hermes_staging_acceptance_runs"."deadline_at" AND ("hermes_staging_acceptance_runs"."post_restart_challenge_attested_at" IS NULL OR ("hermes_staging_acceptance_runs"."post_restart_challenge_attested_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."post_restart_challenge_attested_at" <= "hermes_staging_acceptance_runs"."post_restart_challenge_expires_at" AND "hermes_staging_acceptance_runs"."post_restart_challenge_attested_at" <= "hermes_staging_acceptance_runs"."updated_at"))))),
	CONSTRAINT "hermes_staging_acceptance_runs_published_image_evidence_check" CHECK (("hermes_staging_acceptance_runs"."published_image_verified" AND "hermes_staging_acceptance_runs"."published_image_verified_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."published_image_verified" AND "hermes_staging_acceptance_runs"."published_image_verified_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_host_image_evidence_check" CHECK (("hermes_staging_acceptance_runs"."host_image_verified" AND "hermes_staging_acceptance_runs"."host_image_verified_at" IS NOT NULL AND "hermes_staging_acceptance_runs"."observed_image_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."observed_image_digest" = "hermes_staging_acceptance_runs"."expected_image_digest") OR (NOT "hermes_staging_acceptance_runs"."host_image_verified" AND "hermes_staging_acceptance_runs"."host_image_verified_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_ready_evidence_check" CHECK (("hermes_staging_acceptance_runs"."agent_ready_verified" AND "hermes_staging_acceptance_runs"."agent_ready_verified_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."agent_ready_verified" AND "hermes_staging_acceptance_runs"."agent_ready_verified_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_restart_requested_evidence_check" CHECK (("hermes_staging_acceptance_runs"."restart_requested" AND "hermes_staging_acceptance_runs"."restart_requested_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."restart_requested" AND "hermes_staging_acceptance_runs"."restart_requested_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_restart_evidence_check" CHECK (("hermes_staging_acceptance_runs"."restart_verified" AND "hermes_staging_acceptance_runs"."restart_verified_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."restart_verified" AND "hermes_staging_acceptance_runs"."restart_verified_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_restarted_runtime_evidence_check" CHECK (("hermes_staging_acceptance_runs"."restarted_runtime_verified" AND "hermes_staging_acceptance_runs"."restarted_runtime_verified_at" IS NOT NULL AND "hermes_staging_acceptance_runs"."observed_image_digest" IS NOT NULL AND "hermes_staging_acceptance_runs"."observed_image_digest" = "hermes_staging_acceptance_runs"."expected_image_digest") OR (NOT "hermes_staging_acceptance_runs"."restarted_runtime_verified" AND "hermes_staging_acceptance_runs"."restarted_runtime_verified_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_diagnostics_evidence_check" CHECK (("hermes_staging_acceptance_runs"."diagnostics_redacted_confirmed" AND "hermes_staging_acceptance_runs"."diagnostics_redacted_confirmed_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."diagnostics_redacted_confirmed" AND "hermes_staging_acceptance_runs"."diagnostics_redacted_confirmed_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_stop_evidence_check" CHECK (("hermes_staging_acceptance_runs"."stop_verified" AND "hermes_staging_acceptance_runs"."stop_verified_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."stop_verified" AND "hermes_staging_acceptance_runs"."stop_verified_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_rollback_evidence_check" CHECK (("hermes_staging_acceptance_runs"."rollback_verified" AND "hermes_staging_acceptance_runs"."rollback_verified_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."rollback_verified" AND "hermes_staging_acceptance_runs"."rollback_verified_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_workload_cleanup_check" CHECK (("hermes_staging_acceptance_runs"."workload_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."workload_cleanup_confirmed_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."workload_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."workload_cleanup_confirmed_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_secrets_cleanup_check" CHECK (("hermes_staging_acceptance_runs"."secrets_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."secrets_cleanup_confirmed_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."secrets_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."secrets_cleanup_confirmed_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_firewall_cleanup_check" CHECK (("hermes_staging_acceptance_runs"."firewall_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."firewall_cleanup_confirmed_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."firewall_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."firewall_cleanup_confirmed_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_droplet_cleanup_check" CHECK (("hermes_staging_acceptance_runs"."droplet_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."droplet_cleanup_confirmed_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."droplet_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."droplet_cleanup_confirmed_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_runner_cleanup_check" CHECK (("hermes_staging_acceptance_runs"."runner_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."runner_cleanup_confirmed_at" IS NOT NULL) OR (NOT "hermes_staging_acceptance_runs"."runner_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."runner_cleanup_confirmed_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_cleanup_intent_check" CHECK ("hermes_staging_acceptance_runs"."phase" NOT IN ('cleaning_workload', 'cleaning_secrets', 'cleaning_firewall', 'cleaning_droplet', 'cleaning_runner', 'complete') OR "hermes_staging_acceptance_runs"."desired_outcome" = 'cleanup'),
	CONSTRAINT "hermes_staging_acceptance_runs_terminal_check" CHECK (("hermes_staging_acceptance_runs"."state" = 'complete' AND "hermes_staging_acceptance_runs"."phase" = 'complete' AND "hermes_staging_acceptance_runs"."desired_outcome" = 'cleanup' AND "hermes_staging_acceptance_runs"."terminal_outcome" IS NOT NULL AND "hermes_staging_acceptance_runs"."completed_at" IS NOT NULL AND "hermes_staging_acceptance_runs"."next_attempt_at" IS NULL AND "hermes_staging_acceptance_runs"."pending_effect" IS NULL AND "hermes_staging_acceptance_runs"."lease_owner" IS NULL AND "hermes_staging_acceptance_runs"."lease_expires_at" IS NULL AND "hermes_staging_acceptance_runs"."workload_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."secrets_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."firewall_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."droplet_cleanup_confirmed" AND "hermes_staging_acceptance_runs"."runner_cleanup_confirmed") OR ("hermes_staging_acceptance_runs"."state" <> 'complete' AND "hermes_staging_acceptance_runs"."phase" <> 'complete' AND "hermes_staging_acceptance_runs"."completed_at" IS NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_terminal_outcome_check" CHECK (("hermes_staging_acceptance_runs"."terminal_outcome" IS NULL AND "hermes_staging_acceptance_runs"."state" <> 'complete') OR ("hermes_staging_acceptance_runs"."terminal_outcome" = 'succeeded' AND "hermes_staging_acceptance_runs"."error_code" IS NULL) OR ("hermes_staging_acceptance_runs"."terminal_outcome" IN ('failed', 'cancelled') AND "hermes_staging_acceptance_runs"."error_code" IS NOT NULL)),
	CONSTRAINT "hermes_staging_acceptance_runs_success_evidence_check" CHECK ("hermes_staging_acceptance_runs"."terminal_outcome" <> 'succeeded' OR ("hermes_staging_acceptance_runs"."published_image_verified" AND "hermes_staging_acceptance_runs"."host_image_verified" AND "hermes_staging_acceptance_runs"."agent_ready_verified" AND "hermes_staging_acceptance_runs"."initial_human_proof_verified" AND "hermes_staging_acceptance_runs"."restart_requested" AND "hermes_staging_acceptance_runs"."restart_verified" AND "hermes_staging_acceptance_runs"."restarted_runtime_verified" AND "hermes_staging_acceptance_runs"."post_restart_human_proof_verified" AND "hermes_staging_acceptance_runs"."diagnostics_redacted_confirmed" AND "hermes_staging_acceptance_runs"."stop_verified" AND "hermes_staging_acceptance_runs"."rollback_verified")),
	CONSTRAINT "hermes_staging_acceptance_runs_cleanup_deadline_check" CHECK ("hermes_staging_acceptance_runs"."deadline_at" > "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."deadline_at" <= "hermes_staging_acceptance_runs"."created_at" + interval '2 hours' AND "hermes_staging_acceptance_runs"."cleanup_deadline_at" > "hermes_staging_acceptance_runs"."deadline_at" AND "hermes_staging_acceptance_runs"."cleanup_deadline_at" <= "hermes_staging_acceptance_runs"."deadline_at" + interval '2 hours'),
	CONSTRAINT "hermes_staging_acceptance_runs_updated_after_created_check" CHECK ("hermes_staging_acceptance_runs"."updated_at" >= "hermes_staging_acceptance_runs"."created_at"),
	CONSTRAINT "hermes_staging_acceptance_runs_lease_after_updated_check" CHECK ("hermes_staging_acceptance_runs"."lease_expires_at" IS NULL OR "hermes_staging_acceptance_runs"."lease_expires_at" > "hermes_staging_acceptance_runs"."updated_at"),
	CONSTRAINT "hermes_staging_acceptance_runs_evidence_time_check" CHECK (("hermes_staging_acceptance_runs"."published_image_verified_at" IS NULL OR ("hermes_staging_acceptance_runs"."published_image_verified_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."published_image_verified_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."host_image_verified_at" IS NULL OR ("hermes_staging_acceptance_runs"."host_image_verified_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."host_image_verified_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."agent_ready_verified_at" IS NULL OR ("hermes_staging_acceptance_runs"."agent_ready_verified_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."agent_ready_verified_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."restart_requested_at" IS NULL OR ("hermes_staging_acceptance_runs"."restart_requested_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."restart_requested_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."restart_verified_at" IS NULL OR ("hermes_staging_acceptance_runs"."restart_verified_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."restart_verified_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."restarted_runtime_verified_at" IS NULL OR ("hermes_staging_acceptance_runs"."restarted_runtime_verified_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."restarted_runtime_verified_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."diagnostics_redacted_confirmed_at" IS NULL OR ("hermes_staging_acceptance_runs"."diagnostics_redacted_confirmed_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."diagnostics_redacted_confirmed_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."stop_verified_at" IS NULL OR ("hermes_staging_acceptance_runs"."stop_verified_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."stop_verified_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."rollback_verified_at" IS NULL OR ("hermes_staging_acceptance_runs"."rollback_verified_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."rollback_verified_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."stop_stable_since" IS NULL OR ("hermes_staging_acceptance_runs"."stop_stable_since" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."stop_stable_since" <= "hermes_staging_acceptance_runs"."updated_at"))),
	CONSTRAINT "hermes_staging_acceptance_runs_cleanup_time_check" CHECK (("hermes_staging_acceptance_runs"."workload_cleanup_confirmed_at" IS NULL OR ("hermes_staging_acceptance_runs"."workload_cleanup_confirmed_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."workload_cleanup_confirmed_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."secrets_cleanup_confirmed_at" IS NULL OR ("hermes_staging_acceptance_runs"."secrets_cleanup_confirmed_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."secrets_cleanup_confirmed_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."firewall_cleanup_confirmed_at" IS NULL OR ("hermes_staging_acceptance_runs"."firewall_cleanup_confirmed_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."firewall_cleanup_confirmed_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."droplet_cleanup_confirmed_at" IS NULL OR ("hermes_staging_acceptance_runs"."droplet_cleanup_confirmed_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."droplet_cleanup_confirmed_at" <= "hermes_staging_acceptance_runs"."updated_at")) AND ("hermes_staging_acceptance_runs"."runner_cleanup_confirmed_at" IS NULL OR ("hermes_staging_acceptance_runs"."runner_cleanup_confirmed_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."runner_cleanup_confirmed_at" <= "hermes_staging_acceptance_runs"."updated_at"))),
	CONSTRAINT "hermes_staging_acceptance_runs_completed_after_created_check" CHECK ("hermes_staging_acceptance_runs"."completed_at" IS NULL OR ("hermes_staging_acceptance_runs"."completed_at" >= "hermes_staging_acceptance_runs"."created_at" AND "hermes_staging_acceptance_runs"."completed_at" <= "hermes_staging_acceptance_runs"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "runners" DROP CONSTRAINT "runners_digitalocean_provider_fields_check";--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "provider_firewall_id" text;--> statement-breakpoint
ALTER TABLE "hermes_staging_acceptance_runs" ADD CONSTRAINT "hermes_staging_acceptance_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_staging_acceptance_runs_idempotency_idx" ON "hermes_staging_acceptance_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "hermes_staging_acceptance_runs_owner_created_idx" ON "hermes_staging_acceptance_runs" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_staging_acceptance_runs_one_active_idx" ON "hermes_staging_acceptance_runs" USING btree ("scope_key") WHERE "hermes_staging_acceptance_runs"."state" <> 'complete';--> statement-breakpoint
CREATE INDEX "hermes_staging_acceptance_runs_claim_idx" ON "hermes_staging_acceptance_runs" USING btree ("next_attempt_at","lease_expires_at","created_at") WHERE "hermes_staging_acceptance_runs"."state" IN ('pending', 'executing', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX "runners_provider_firewall_idx" ON "runners" USING btree ("provider_firewall_id") WHERE "runners"."provider_firewall_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_provider_firewall_id_not_empty_check" CHECK ("runners"."provider_firewall_id" IS NULL OR length(trim("runners"."provider_firewall_id")) > 0);--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_digitalocean_provider_fields_check" CHECK (("runners"."kind" = 'manual_vps' AND "runners"."provider" IS NULL AND "runners"."provider_resource_id" IS NULL AND "runners"."provider_firewall_id" IS NULL AND "runners"."region" IS NULL AND "runners"."size_slug" IS NULL AND "runners"."image" IS NULL AND "runners"."provisioning_status" IS NULL AND "runners"."provisioning_error" IS NULL AND "runners"."provisioning_started_at" IS NULL AND "runners"."provisioning_completed_at" IS NULL) OR ("runners"."kind" = 'digitalocean' AND "runners"."provider" = 'digitalocean' AND "runners"."region" IS NOT NULL AND "runners"."size_slug" IS NOT NULL AND "runners"."image" IS NOT NULL AND "runners"."provisioning_status" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION hermes_staging_acceptance_runs_protect_evidence() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.scope_key IS DISTINCT FROM OLD.scope_key
		OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
		OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
		OR NEW.cleanup_deadline_at IS DISTINCT FROM OLD.cleanup_deadline_at
		OR NEW.expected_source_revision IS DISTINCT FROM OLD.expected_source_revision
		OR NEW.expected_publish_workflow_run_id IS DISTINCT FROM OLD.expected_publish_workflow_run_id
		OR NEW.expected_image_digest IS DISTINCT FROM OLD.expected_image_digest
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'hermes staging acceptance immutable input cannot change'
			USING ERRCODE = '23514', CONSTRAINT = 'hermes_staging_acceptance_runs_immutable_check';
	END IF;

	IF (OLD.observed_image_digest IS NOT NULL AND NEW.observed_image_digest IS DISTINCT FROM OLD.observed_image_digest)
		OR (OLD.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id)
		OR (OLD.deployment_id IS NOT NULL AND NEW.deployment_id IS DISTINCT FROM OLD.deployment_id)
		OR (OLD.runner_id IS NOT NULL AND NEW.runner_id IS DISTINCT FROM OLD.runner_id)
		OR (OLD.provider_resource_id IS NOT NULL AND NEW.provider_resource_id IS DISTINCT FROM OLD.provider_resource_id)
		OR (OLD.provider_firewall_id IS NOT NULL AND NEW.provider_firewall_id IS DISTINCT FROM OLD.provider_firewall_id)
		OR (OLD.initial_challenge_digest IS NOT NULL AND NEW.initial_challenge_digest IS DISTINCT FROM OLD.initial_challenge_digest)
		OR (OLD.initial_challenge_expires_at IS NOT NULL AND NEW.initial_challenge_expires_at IS DISTINCT FROM OLD.initial_challenge_expires_at)
		OR (OLD.initial_attestation_digest IS NOT NULL AND NEW.initial_attestation_digest IS DISTINCT FROM OLD.initial_attestation_digest)
		OR (OLD.initial_challenge_attested_at IS NOT NULL AND NEW.initial_challenge_attested_at IS DISTINCT FROM OLD.initial_challenge_attested_at)
		OR (OLD.post_restart_challenge_digest IS NOT NULL AND NEW.post_restart_challenge_digest IS DISTINCT FROM OLD.post_restart_challenge_digest)
		OR (OLD.post_restart_challenge_expires_at IS NOT NULL AND NEW.post_restart_challenge_expires_at IS DISTINCT FROM OLD.post_restart_challenge_expires_at)
		OR (OLD.post_restart_attestation_digest IS NOT NULL AND NEW.post_restart_attestation_digest IS DISTINCT FROM OLD.post_restart_attestation_digest)
		OR (OLD.post_restart_challenge_attested_at IS NOT NULL AND NEW.post_restart_challenge_attested_at IS DISTINCT FROM OLD.post_restart_challenge_attested_at)
		OR (OLD.published_image_verified_at IS NOT NULL AND NEW.published_image_verified_at IS DISTINCT FROM OLD.published_image_verified_at)
		OR (OLD.host_image_verified_at IS NOT NULL AND NEW.host_image_verified_at IS DISTINCT FROM OLD.host_image_verified_at)
		OR (OLD.agent_ready_verified_at IS NOT NULL AND NEW.agent_ready_verified_at IS DISTINCT FROM OLD.agent_ready_verified_at)
		OR (OLD.restart_requested_at IS NOT NULL AND NEW.restart_requested_at IS DISTINCT FROM OLD.restart_requested_at)
		OR (OLD.restart_verified_at IS NOT NULL AND NEW.restart_verified_at IS DISTINCT FROM OLD.restart_verified_at)
		OR (OLD.restarted_runtime_verified_at IS NOT NULL AND NEW.restarted_runtime_verified_at IS DISTINCT FROM OLD.restarted_runtime_verified_at)
		OR (OLD.diagnostics_redacted_confirmed_at IS NOT NULL AND NEW.diagnostics_redacted_confirmed_at IS DISTINCT FROM OLD.diagnostics_redacted_confirmed_at)
		OR (OLD.stop_verified_at IS NOT NULL AND NEW.stop_verified_at IS DISTINCT FROM OLD.stop_verified_at)
		OR (OLD.rollback_verified_at IS NOT NULL AND NEW.rollback_verified_at IS DISTINCT FROM OLD.rollback_verified_at)
		OR (OLD.workload_cleanup_confirmed_at IS NOT NULL AND NEW.workload_cleanup_confirmed_at IS DISTINCT FROM OLD.workload_cleanup_confirmed_at)
		OR (OLD.secrets_cleanup_confirmed_at IS NOT NULL AND NEW.secrets_cleanup_confirmed_at IS DISTINCT FROM OLD.secrets_cleanup_confirmed_at)
		OR (OLD.firewall_cleanup_confirmed_at IS NOT NULL AND NEW.firewall_cleanup_confirmed_at IS DISTINCT FROM OLD.firewall_cleanup_confirmed_at)
		OR (OLD.droplet_cleanup_confirmed_at IS NOT NULL AND NEW.droplet_cleanup_confirmed_at IS DISTINCT FROM OLD.droplet_cleanup_confirmed_at)
		OR (OLD.runner_cleanup_confirmed_at IS NOT NULL AND NEW.runner_cleanup_confirmed_at IS DISTINCT FROM OLD.runner_cleanup_confirmed_at)
		OR (OLD.published_image_verified AND NOT NEW.published_image_verified)
		OR (OLD.host_image_verified AND NOT NEW.host_image_verified)
		OR (OLD.agent_ready_verified AND NOT NEW.agent_ready_verified)
		OR (OLD.initial_human_proof_verified AND NOT NEW.initial_human_proof_verified)
		OR (OLD.restart_requested AND NOT NEW.restart_requested)
		OR (OLD.restart_verified AND NOT NEW.restart_verified)
		OR (OLD.restarted_runtime_verified AND NOT NEW.restarted_runtime_verified)
		OR (OLD.post_restart_human_proof_verified AND NOT NEW.post_restart_human_proof_verified)
		OR (OLD.diagnostics_redacted_confirmed AND NOT NEW.diagnostics_redacted_confirmed)
		OR (OLD.stop_verified AND NOT NEW.stop_verified)
		OR (OLD.rollback_verified AND NOT NEW.rollback_verified)
		OR (OLD.workload_cleanup_confirmed AND NOT NEW.workload_cleanup_confirmed)
		OR (OLD.secrets_cleanup_confirmed AND NOT NEW.secrets_cleanup_confirmed)
		OR (OLD.firewall_cleanup_confirmed AND NOT NEW.firewall_cleanup_confirmed)
		OR (OLD.droplet_cleanup_confirmed AND NOT NEW.droplet_cleanup_confirmed)
		OR (OLD.runner_cleanup_confirmed AND NOT NEW.runner_cleanup_confirmed) THEN
		RAISE EXCEPTION 'hermes staging acceptance evidence cannot be overwritten'
			USING ERRCODE = '23514', CONSTRAINT = 'hermes_staging_acceptance_runs_immutable_check';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hermes_staging_acceptance_runs_immutable_trigger
BEFORE UPDATE ON hermes_staging_acceptance_runs
FOR EACH ROW EXECUTE FUNCTION hermes_staging_acceptance_runs_protect_evidence();
