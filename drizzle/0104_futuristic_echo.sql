CREATE TYPE "public"."founder_identity_recovery_reason" AS ENUM('clerk_user_deleted', 'clerk_identity_lost');--> statement-breakpoint
CREATE TYPE "public"."founder_identity_recovery_receipt_kind" AS ENUM('identity_loss_recorded', 'recovery_denied', 'identity_rebound');--> statement-breakpoint
CREATE TYPE "public"."founder_identity_recovery_status" AS ENUM('pending', 'recovered');--> statement-breakpoint
CREATE TYPE "public"."operator_deletion_commerce_cancellation_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
ALTER TYPE "public"."founder_product_contract_scenario" ADD VALUE 'identity_recovery_lifecycle' BEFORE 'recovery_archive_lifecycle';--> statement-breakpoint
ALTER TYPE "public"."operator_deletion_stage" ADD VALUE 'commerce_cancellation' BEFORE 'active_purge_complete';--> statement-breakpoint
CREATE TABLE "founder_identity_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "founder_identity_recovery_status" DEFAULT 'pending' NOT NULL,
	"reason" "founder_identity_recovery_reason" NOT NULL,
	"prior_clerk_subject_digest" text NOT NULL,
	"replacement_clerk_subject_digest" text,
	"provider_event_id" text NOT NULL,
	"provider_event_digest" text NOT NULL,
	"loss_observed_at" timestamp with time zone NOT NULL,
	"recovered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_identity_recoveries_prior_subject_digest_check" CHECK ("founder_identity_recoveries"."prior_clerk_subject_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_identity_recoveries_replacement_subject_digest_check" CHECK ("founder_identity_recoveries"."replacement_clerk_subject_digest" IS NULL OR "founder_identity_recoveries"."replacement_clerk_subject_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_identity_recoveries_provider_event_digest_check" CHECK ("founder_identity_recoveries"."provider_event_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_identity_recoveries_status_check" CHECK (("founder_identity_recoveries"."status" = 'pending' AND "founder_identity_recoveries"."replacement_clerk_subject_digest" IS NULL AND "founder_identity_recoveries"."recovered_at" IS NULL) OR ("founder_identity_recoveries"."status" = 'recovered' AND "founder_identity_recoveries"."replacement_clerk_subject_digest" IS NOT NULL AND "founder_identity_recoveries"."recovered_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "founder_identity_recovery_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recovery_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "founder_identity_recovery_receipt_kind" NOT NULL,
	"subject_digest" text,
	"evidence_digest" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_identity_recovery_receipts_subject_digest_check" CHECK ("founder_identity_recovery_receipts"."subject_digest" IS NULL OR "founder_identity_recovery_receipts"."subject_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_identity_recovery_receipts_evidence_digest_check" CHECK ("founder_identity_recovery_receipts"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_deletion_commerce_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"status" "operator_deletion_commerce_cancellation_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_deletion_commerce_cancellations_attempt_count_check" CHECK ("operator_deletion_commerce_cancellations"."attempt_count" >= 0),
	CONSTRAINT "operator_deletion_commerce_cancellations_status_check" CHECK (("operator_deletion_commerce_cancellations"."status" = 'pending' AND "operator_deletion_commerce_cancellations"."confirmed_at" IS NULL AND "operator_deletion_commerce_cancellations"."error_code" IS NULL) OR ("operator_deletion_commerce_cancellations"."status" = 'succeeded' AND "operator_deletion_commerce_cancellations"."confirmed_at" IS NOT NULL AND "operator_deletion_commerce_cancellations"."error_code" IS NULL) OR ("operator_deletion_commerce_cancellations"."status" = 'failed' AND "operator_deletion_commerce_cancellations"."confirmed_at" IS NULL AND "operator_deletion_commerce_cancellations"."error_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "founder_identity_recoveries" ADD CONSTRAINT "founder_identity_recoveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_identity_recovery_receipts" ADD CONSTRAINT "founder_identity_recovery_receipts_recovery_id_founder_identity_recoveries_id_fk" FOREIGN KEY ("recovery_id") REFERENCES "public"."founder_identity_recoveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_identity_recovery_receipts" ADD CONSTRAINT "founder_identity_recovery_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_commerce_cancellations" ADD CONSTRAINT "operator_deletion_commerce_cancellations_request_id_operator_deletion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."operator_deletion_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_commerce_cancellations" ADD CONSTRAINT "operator_deletion_commerce_cancellations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_identity_recoveries_provider_event_idx" ON "founder_identity_recoveries" USING btree ("provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_identity_recoveries_pending_user_idx" ON "founder_identity_recoveries" USING btree ("user_id") WHERE "founder_identity_recoveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "founder_identity_recoveries_user_status_idx" ON "founder_identity_recoveries" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_identity_recovery_receipts_evidence_idx" ON "founder_identity_recovery_receipts" USING btree ("evidence_digest");--> statement-breakpoint
CREATE INDEX "founder_identity_recovery_receipts_user_occurred_idx" ON "founder_identity_recovery_receipts" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_deletion_commerce_cancellations_request_idx" ON "operator_deletion_commerce_cancellations" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "operator_deletion_commerce_cancellations_status_idx" ON "operator_deletion_commerce_cancellations" USING btree ("status","updated_at");
