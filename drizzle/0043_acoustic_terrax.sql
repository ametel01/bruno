CREATE TYPE "public"."operator_runtime_safety_state" AS ENUM('unknown', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."operator_runtime_status" AS ENUM('awaiting_timezone', 'preparing', 'ready', 'needs_attention');--> statement-breakpoint
CREATE TYPE "public"."operator_runtime_transport_state" AS ENUM('unknown', 'starting', 'connected', 'failed');--> statement-breakpoint
CREATE TABLE "operator_runtimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"status" "operator_runtime_status" DEFAULT 'awaiting_timezone' NOT NULL,
	"transport_state" "operator_runtime_transport_state" DEFAULT 'unknown' NOT NULL,
	"safety_state" "operator_runtime_safety_state" DEFAULT 'unknown' NOT NULL,
	"config_revision" text,
	"runtime_identity" text,
	"operation_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"recovery_message" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_runtimes_attempt_count_check" CHECK ("operator_runtimes"."attempt_count" >= 0),
	CONSTRAINT "operator_runtimes_lease_pair_check" CHECK (("operator_runtimes"."lease_owner" IS NULL AND "operator_runtimes"."lease_expires_at" IS NULL) OR ("operator_runtimes"."lease_owner" IS NOT NULL AND "operator_runtimes"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "operator_runtimes_recovery_message_check" CHECK ("operator_runtimes"."status" = 'needs_attention' OR "operator_runtimes"."recovery_message" IS NULL),
	CONSTRAINT "operator_runtimes_failure_code_check" CHECK ("operator_runtimes"."failure_code" IS NULL OR "operator_runtimes"."failure_code" ~ '^[a-z0-9_.:-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "operator_runtimes" ADD CONSTRAINT "operator_runtimes_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_runtimes_operator_id_idx" ON "operator_runtimes" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_runtimes_status_idx" ON "operator_runtimes" USING btree ("status");