CREATE TYPE "public"."founder_infrastructure_retirement_status" AS ENUM('in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."founder_product_contract_scenario" AS ENUM('release_stage_admission', 'product_entitlement_lifecycle', 'recovery_archive_lifecycle', 'infrastructure_retirement');--> statement-breakpoint
CREATE TYPE "public"."founder_product_entitlement_status" AS ENUM('verified', 'past_due', 'unpaid', 'cancelled', 'expired', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."founder_recovery_archive_status" AS ENUM('pending', 'verified', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."founder_release_decision_outcome" AS ENUM('enter', 'deny', 'hold', 'resume');--> statement-breakpoint
CREATE TYPE "public"."founder_release_stage" AS ENUM('owner_preview', 'trusted_preview', 'external_beta', 'initial_general_release');--> statement-breakpoint
CREATE TABLE "founder_checkout_correlations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"correlation_digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "founder_checkout_correlations_digest_check" CHECK ("founder_checkout_correlations"."correlation_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_checkout_correlations_status_check" CHECK ("founder_checkout_correlations"."status" IN ('pending', 'consumed')),
	CONSTRAINT "founder_checkout_correlations_consumed_check" CHECK (("founder_checkout_correlations"."status" = 'pending' AND "founder_checkout_correlations"."consumed_at" IS NULL) OR ("founder_checkout_correlations"."status" = 'consumed' AND "founder_checkout_correlations"."consumed_at" IS NOT NULL)),
	CONSTRAINT "founder_checkout_correlations_expiry_check" CHECK ("founder_checkout_correlations"."expires_at" > "founder_checkout_correlations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "founder_commerce_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"checkout_correlation_id" uuid NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_digest" text NOT NULL,
	"signature_verified" boolean NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_commerce_events_payload_digest_check" CHECK ("founder_commerce_events"."payload_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_commerce_events_signature_verified_check" CHECK ("founder_commerce_events"."signature_verified" = true)
);
--> statement-breakpoint
CREATE TABLE "founder_infrastructure_retirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"recovery_archive_id" uuid,
	"idempotency_key" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"provider_firewall_id" text NOT NULL,
	"status" "founder_infrastructure_retirement_status" NOT NULL,
	"resources_before" integer NOT NULL,
	"resources_after" integer,
	"work_stopped_at" timestamp with time zone,
	"credentials_disabled_at" timestamp with time zone,
	"firewall_deleted_at" timestamp with time zone,
	"droplet_deleted_at" timestamp with time zone,
	"absence_verified_at" timestamp with time zone,
	"failure_code" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_token" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_infrastructure_retirements_resources_check" CHECK ("founder_infrastructure_retirements"."resources_before" >= 0 AND ("founder_infrastructure_retirements"."resources_after" IS NULL OR "founder_infrastructure_retirements"."resources_after" >= 0)),
	CONSTRAINT "founder_infrastructure_retirements_lease_token_check" CHECK (length(trim("founder_infrastructure_retirements"."lease_token")) > 0),
	CONSTRAINT "founder_infrastructure_retirements_completed_check" CHECK ("founder_infrastructure_retirements"."status" <> 'completed' OR ("founder_infrastructure_retirements"."resources_after" = 0 AND "founder_infrastructure_retirements"."work_stopped_at" IS NOT NULL AND "founder_infrastructure_retirements"."credentials_disabled_at" IS NOT NULL AND "founder_infrastructure_retirements"."firewall_deleted_at" IS NOT NULL AND "founder_infrastructure_retirements"."droplet_deleted_at" IS NOT NULL AND "founder_infrastructure_retirements"."absence_verified_at" IS NOT NULL AND "founder_infrastructure_retirements"."failure_code" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "founder_product_contract_scenario_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scenario_id" "founder_product_contract_scenario" NOT NULL,
	"source_revision" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"resources_before" integer NOT NULL,
	"resources_after" integer NOT NULL,
	"cleanup_verified" boolean NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_product_contract_executions_revision_check" CHECK ("founder_product_contract_scenario_executions"."source_revision" ~ '^[a-f0-9]{40}$'),
	CONSTRAINT "founder_product_contract_executions_outcome_check" CHECK (("founder_product_contract_scenario_executions"."status" = 'in_progress' AND "founder_product_contract_scenario_executions"."attempts" = 1 AND "founder_product_contract_scenario_executions"."cleanup_verified" = false AND "founder_product_contract_scenario_executions"."resources_before" = 0 AND "founder_product_contract_scenario_executions"."resources_after" = 0) OR ("founder_product_contract_scenario_executions"."status" = 'failed' AND "founder_product_contract_scenario_executions"."attempts" >= 1 AND "founder_product_contract_scenario_executions"."cleanup_verified" = false AND "founder_product_contract_scenario_executions"."resources_before" >= 0 AND "founder_product_contract_scenario_executions"."resources_after" = 0) OR ("founder_product_contract_scenario_executions"."status" = 'passed' AND "founder_product_contract_scenario_executions"."attempts" = 1 AND "founder_product_contract_scenario_executions"."cleanup_verified" = true AND "founder_product_contract_scenario_executions"."resources_before" >= 0 AND "founder_product_contract_scenario_executions"."resources_after" = 0))
);
--> statement-breakpoint
CREATE TABLE "founder_product_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"status" "founder_product_entitlement_status" NOT NULL,
	"reconciled_provider_status" text NOT NULL,
	"reconciled_at" timestamp with time zone NOT NULL,
	"retirement_due_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_product_entitlements_provider_status_check" CHECK ("founder_product_entitlements"."reconciled_provider_status" IN ('active', 'past_due', 'unpaid', 'cancelled', 'expired', 'refunded')),
	CONSTRAINT "founder_product_entitlements_retirement_due_check" CHECK (("founder_product_entitlements"."status" IN ('verified', 'past_due') AND "founder_product_entitlements"."retirement_due_at" IS NULL) OR ("founder_product_entitlements"."status" IN ('unpaid', 'cancelled', 'expired', 'refunded') AND "founder_product_entitlements"."retirement_due_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "founder_recovery_archive_deletion_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"archive_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_confirmed" boolean DEFAULT false NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "founder_recovery_archive_deletions_status_check" CHECK ("founder_recovery_archive_deletion_receipts"."status" IN ('pending', 'completed')),
	CONSTRAINT "founder_recovery_archive_deletions_outcome_check" CHECK (("founder_recovery_archive_deletion_receipts"."status" = 'pending' AND "founder_recovery_archive_deletion_receipts"."provider_confirmed" = false AND "founder_recovery_archive_deletion_receipts"."completed_at" IS NULL) OR ("founder_recovery_archive_deletion_receipts"."status" = 'completed' AND "founder_recovery_archive_deletion_receipts"."provider_confirmed" = true AND "founder_recovery_archive_deletion_receipts"."completed_at" IS NOT NULL AND "founder_recovery_archive_deletion_receipts"."failure_code" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "founder_recovery_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"status" "founder_recovery_archive_status" NOT NULL,
	"storage_object_key" text,
	"ciphertext_digest" text,
	"restorable_verified" boolean NOT NULL,
	"failure_code" text,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "founder_recovery_archives_outcome_check" CHECK (("founder_recovery_archives"."status" = 'pending' AND "founder_recovery_archives"."storage_object_key" IS NULL AND "founder_recovery_archives"."ciphertext_digest" IS NULL AND "founder_recovery_archives"."restorable_verified" = false AND "founder_recovery_archives"."failure_code" IS NULL AND "founder_recovery_archives"."deleted_at" IS NULL) OR ("founder_recovery_archives"."status" = 'verified' AND "founder_recovery_archives"."storage_object_key" IS NOT NULL AND "founder_recovery_archives"."ciphertext_digest" IS NOT NULL AND "founder_recovery_archives"."restorable_verified" = true AND "founder_recovery_archives"."failure_code" IS NULL AND "founder_recovery_archives"."deleted_at" IS NULL) OR ("founder_recovery_archives"."status" = 'failed' AND "founder_recovery_archives"."restorable_verified" = false AND "founder_recovery_archives"."failure_code" IS NOT NULL AND "founder_recovery_archives"."deleted_at" IS NULL) OR ("founder_recovery_archives"."status" = 'deleted' AND "founder_recovery_archives"."storage_object_key" IS NULL AND "founder_recovery_archives"."restorable_verified" = false AND "founder_recovery_archives"."failure_code" IS NULL AND "founder_recovery_archives"."deleted_at" IS NOT NULL)),
	CONSTRAINT "founder_recovery_archives_ciphertext_digest_check" CHECK ("founder_recovery_archives"."ciphertext_digest" IS NULL OR "founder_recovery_archives"."ciphertext_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_recovery_archives_expiry_check" CHECK ("founder_recovery_archives"."expires_at" > "founder_recovery_archives"."observed_at")
);
--> statement-breakpoint
CREATE TABLE "founder_release_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"stage" "founder_release_stage" NOT NULL,
	"outcome" "founder_release_decision_outcome" NOT NULL,
	"application_revision" text NOT NULL,
	"runtime_revision" text NOT NULL,
	"capability_manifest" jsonb NOT NULL,
	"evidence_digests" jsonb NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founder_release_decisions_application_revision_check" CHECK ("founder_release_decisions"."application_revision" ~ '^[a-f0-9]{40}$'),
	CONSTRAINT "founder_release_decisions_runtime_revision_check" CHECK (length(trim("founder_release_decisions"."runtime_revision")) > 0)
);
--> statement-breakpoint
ALTER TABLE "founder_checkout_correlations" ADD CONSTRAINT "founder_checkout_correlations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_commerce_events" ADD CONSTRAINT "founder_commerce_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_commerce_events" ADD CONSTRAINT "founder_commerce_events_checkout_correlation_id_founder_checkout_correlations_id_fk" FOREIGN KEY ("checkout_correlation_id") REFERENCES "public"."founder_checkout_correlations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD CONSTRAINT "founder_infrastructure_retirements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD CONSTRAINT "founder_infrastructure_retirements_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD CONSTRAINT "founder_infrastructure_retirements_recovery_archive_id_founder_recovery_archives_id_fk" FOREIGN KEY ("recovery_archive_id") REFERENCES "public"."founder_recovery_archives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_product_contract_scenario_executions" ADD CONSTRAINT "founder_product_contract_scenario_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_product_entitlements" ADD CONSTRAINT "founder_product_entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_product_entitlements" ADD CONSTRAINT "founder_product_entitlements_source_event_id_founder_commerce_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."founder_commerce_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_recovery_archive_deletion_receipts" ADD CONSTRAINT "founder_recovery_archive_deletion_receipts_archive_id_founder_recovery_archives_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."founder_recovery_archives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_recovery_archive_deletion_receipts" ADD CONSTRAINT "founder_recovery_archive_deletion_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_recovery_archives" ADD CONSTRAINT "founder_recovery_archives_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_recovery_archives" ADD CONSTRAINT "founder_recovery_archives_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_checkout_correlations_digest_idx" ON "founder_checkout_correlations" USING btree ("correlation_digest");--> statement-breakpoint
CREATE INDEX "founder_checkout_correlations_user_status_idx" ON "founder_checkout_correlations" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_commerce_events_provider_event_id_idx" ON "founder_commerce_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "founder_commerce_events_user_occurred_idx" ON "founder_commerce_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_infrastructure_retirements_idempotency_idx" ON "founder_infrastructure_retirements" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_infrastructure_retirements_runner_idx" ON "founder_infrastructure_retirements" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "founder_infrastructure_retirements_user_status_idx" ON "founder_infrastructure_retirements" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_product_contract_executions_run_scenario_idx" ON "founder_product_contract_scenario_executions" USING btree ("run_id","user_id","scenario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_product_entitlements_user_idx" ON "founder_product_entitlements" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_recovery_archive_deletions_archive_idx" ON "founder_recovery_archive_deletion_receipts" USING btree ("archive_id");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_recovery_archive_deletions_key_idx" ON "founder_recovery_archive_deletion_receipts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "founder_recovery_archives_user_observed_idx" ON "founder_recovery_archives" USING btree ("user_id","observed_at");--> statement-breakpoint
CREATE INDEX "founder_release_decisions_user_stage_idx" ON "founder_release_decisions" USING btree ("user_id","stage","decided_at");