CREATE TYPE "public"."operator_retention_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."operator_retention_tombstone_kind" AS ENUM('working_context', 'relationship_record', 'governance', 'connection', 'action', 'deletion', 'support');--> statement-breakpoint
CREATE TABLE "operator_retention_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"run_key" text NOT NULL,
	"status" "operator_retention_run_status" DEFAULT 'running' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_retention_runs_completion_shape_check" CHECK (("operator_retention_runs"."status" = 'completed' AND "operator_retention_runs"."completed_at" IS NOT NULL AND "operator_retention_runs"."failure_code" IS NULL) OR ("operator_retention_runs"."status" = 'failed' AND "operator_retention_runs"."completed_at" IS NOT NULL AND "operator_retention_runs"."failure_code" IS NOT NULL) OR ("operator_retention_runs"."status" = 'running' AND "operator_retention_runs"."completed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "operator_retention_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" "operator_retention_tombstone_kind" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"identity_digest" text NOT NULL,
	"source_created_at" timestamp with time zone,
	"expired_at" timestamp with time zone NOT NULL,
	"reason" text DEFAULT 'retention_expired' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_retention_tombstones_digest_check" CHECK ("operator_retention_tombstones"."identity_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "operator_retention_runs" ADD CONSTRAINT "operator_retention_runs_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_retention_tombstones" ADD CONSTRAINT "operator_retention_tombstones_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_retention_runs_operator_key_idx" ON "operator_retention_runs" USING btree ("operator_id","run_key");--> statement-breakpoint
CREATE INDEX "operator_retention_runs_operator_status_idx" ON "operator_retention_runs" USING btree ("operator_id","status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_retention_tombstones_identity_idx" ON "operator_retention_tombstones" USING btree ("operator_id","kind","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "operator_retention_tombstones_operator_expired_idx" ON "operator_retention_tombstones" USING btree ("operator_id","expired_at");