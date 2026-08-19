CREATE TYPE "public"."operator_deletion_backup_status" AS ENUM('pending', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."operator_deletion_request_kind" AS ENUM('retained_data', 'account_closure');--> statement-breakpoint
CREATE TYPE "public"."operator_deletion_request_status" AS ENUM('requested', 'access_stopped', 'purge_pending', 'active_purge_complete', 'backup_expiry_pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."operator_deletion_revocation_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."operator_deletion_stage" AS ENUM('requested', 'access_stopped', 'active_purge_complete', 'backup_expiry', 'revocation');--> statement-breakpoint
CREATE TABLE "operator_deletion_backup_expiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"backup_kind" text NOT NULL,
	"backup_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "operator_deletion_backup_status" DEFAULT 'pending' NOT NULL,
	"expired_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_deletion_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"stage" "operator_deletion_stage" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" "operator_deletion_request_kind" NOT NULL,
	"status" "operator_deletion_request_status" DEFAULT 'requested' NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_purge_due_at" timestamp with time zone NOT NULL,
	"backup_expiry_due_at" timestamp with time zone NOT NULL,
	"access_stopped_at" timestamp with time zone,
	"active_purge_completed_at" timestamp with time zone,
	"backup_expired_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_deletion_requests_due_order_check" CHECK ("operator_deletion_requests"."backup_expiry_due_at" >= "operator_deletion_requests"."active_purge_due_at" AND "operator_deletion_requests"."active_purge_due_at" >= "operator_deletion_requests"."requested_at"),
	CONSTRAINT "operator_deletion_requests_access_stage_check" CHECK ("operator_deletion_requests"."status" = 'requested' OR "operator_deletion_requests"."access_stopped_at" IS NOT NULL),
	CONSTRAINT "operator_deletion_requests_purge_stage_check" CHECK ("operator_deletion_requests"."status" IN ('requested', 'access_stopped', 'purge_pending') OR "operator_deletion_requests"."active_purge_completed_at" IS NOT NULL),
	CONSTRAINT "operator_deletion_requests_backup_stage_check" CHECK ("operator_deletion_requests"."status" NOT IN ('completed') OR ("operator_deletion_requests"."backup_expired_at" IS NOT NULL AND "operator_deletion_requests"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "operator_deletion_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"connection_kind" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_identity" text,
	"status" "operator_deletion_revocation_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_deletion_revocations_attempt_count_check" CHECK ("operator_deletion_revocations"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "operator_deletion_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"erased_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_deletion_backup_expiries" ADD CONSTRAINT "operator_deletion_backup_expiries_request_id_operator_deletion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."operator_deletion_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_backup_expiries" ADD CONSTRAINT "operator_deletion_backup_expiries_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_receipts" ADD CONSTRAINT "operator_deletion_receipts_request_id_operator_deletion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."operator_deletion_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_receipts" ADD CONSTRAINT "operator_deletion_receipts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_requests" ADD CONSTRAINT "operator_deletion_requests_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_revocations" ADD CONSTRAINT "operator_deletion_revocations_request_id_operator_deletion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."operator_deletion_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_revocations" ADD CONSTRAINT "operator_deletion_revocations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_tombstones" ADD CONSTRAINT "operator_deletion_tombstones_request_id_operator_deletion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."operator_deletion_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_deletion_tombstones" ADD CONSTRAINT "operator_deletion_tombstones_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_deletion_backup_expiries_identity_idx" ON "operator_deletion_backup_expiries" USING btree ("request_id","backup_kind","backup_id");--> statement-breakpoint
CREATE INDEX "operator_deletion_backup_expiries_due_idx" ON "operator_deletion_backup_expiries" USING btree ("operator_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_deletion_receipts_request_stage_idx" ON "operator_deletion_receipts" USING btree ("request_id","stage");--> statement-breakpoint
CREATE INDEX "operator_deletion_receipts_operator_occurred_idx" ON "operator_deletion_receipts" USING btree ("operator_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_deletion_requests_active_idx" ON "operator_deletion_requests" USING btree ("operator_id") WHERE "operator_deletion_requests"."status" NOT IN ('completed', 'failed');--> statement-breakpoint
CREATE INDEX "operator_deletion_requests_operator_status_idx" ON "operator_deletion_requests" USING btree ("operator_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_deletion_revocations_identity_idx" ON "operator_deletion_revocations" USING btree ("request_id","connection_kind","connection_id");--> statement-breakpoint
CREATE INDEX "operator_deletion_revocations_retry_idx" ON "operator_deletion_revocations" USING btree ("operator_id","status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_deletion_tombstones_identity_idx" ON "operator_deletion_tombstones" USING btree ("operator_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "operator_deletion_tombstones_request_idx" ON "operator_deletion_tombstones" USING btree ("request_id","erased_at");