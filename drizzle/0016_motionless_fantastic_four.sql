CREATE TYPE "public"."agent_deployment_stage" AS ENUM('pending', 'provisioning_runner', 'configuring_hermes', 'starting_gateway', 'verifying_model', 'connecting_telegram', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_desired_status" AS ENUM('stopped', 'running');--> statement-breakpoint
CREATE TABLE "agent_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"stage" "agent_deployment_stage" DEFAULT 'pending' NOT NULL,
	"config_revision" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_detail" text,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_deployments_attempt_count_check" CHECK ("agent_deployments"."attempt_count" >= 0),
	CONSTRAINT "agent_deployments_config_revision_check" CHECK (trim("agent_deployments"."config_revision") = "agent_deployments"."config_revision" AND "agent_deployments"."config_revision" ~ '^[A-Za-z0-9_.:-]{1,80}$'),
	CONSTRAINT "agent_deployments_idempotency_key_check" CHECK (trim("agent_deployments"."idempotency_key") = "agent_deployments"."idempotency_key" AND length("agent_deployments"."idempotency_key") BETWEEN 8 AND 128),
	CONSTRAINT "agent_deployments_lease_owner_check" CHECK ("agent_deployments"."lease_owner" IS NULL OR (length(trim("agent_deployments"."lease_owner")) > 0 AND length("agent_deployments"."lease_owner") <= 128)),
	CONSTRAINT "agent_deployments_error_code_check" CHECK ("agent_deployments"."error_code" IS NULL OR "agent_deployments"."error_code" ~ '^[a-z0-9_.:-]{1,64}$'),
	CONSTRAINT "agent_deployments_error_detail_check" CHECK ("agent_deployments"."error_detail" IS NULL OR (length(trim("agent_deployments"."error_detail")) > 0 AND length("agent_deployments"."error_detail") <= 500)),
	CONSTRAINT "agent_deployments_error_detail_code_check" CHECK ("agent_deployments"."error_detail" IS NULL OR "agent_deployments"."error_code" IS NOT NULL),
	CONSTRAINT "agent_deployments_lease_pair_check" CHECK (("agent_deployments"."lease_owner" IS NULL AND "agent_deployments"."lease_expires_at" IS NULL) OR ("agent_deployments"."lease_owner" IS NOT NULL AND "agent_deployments"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "agent_deployments_completed_stage_check" CHECK (("agent_deployments"."stage" = 'ready' AND "agent_deployments"."completed_at" IS NOT NULL) OR ("agent_deployments"."stage" <> 'ready' AND "agent_deployments"."completed_at" IS NULL)),
	CONSTRAINT "agent_deployments_failed_stage_check" CHECK (("agent_deployments"."stage" = 'failed' AND "agent_deployments"."failed_at" IS NOT NULL) OR ("agent_deployments"."stage" <> 'failed' AND "agent_deployments"."failed_at" IS NULL)),
	CONSTRAINT "agent_deployments_failed_error_check" CHECK ("agent_deployments"."stage" <> 'failed' OR "agent_deployments"."error_code" IS NOT NULL),
	CONSTRAINT "agent_deployments_ready_error_check" CHECK ("agent_deployments"."stage" <> 'ready' OR ("agent_deployments"."error_code" IS NULL AND "agent_deployments"."error_detail" IS NULL)),
	CONSTRAINT "agent_deployments_terminal_clear_work_check" CHECK ("agent_deployments"."stage" NOT IN ('ready', 'failed') OR ("agent_deployments"."next_attempt_at" IS NULL AND "agent_deployments"."lease_owner" IS NULL AND "agent_deployments"."lease_expires_at" IS NULL)),
	CONSTRAINT "agent_deployments_completed_after_started_check" CHECK ("agent_deployments"."completed_at" IS NULL OR "agent_deployments"."started_at" IS NULL OR "agent_deployments"."completed_at" >= "agent_deployments"."started_at"),
	CONSTRAINT "agent_deployments_failed_after_started_check" CHECK ("agent_deployments"."failed_at" IS NULL OR "agent_deployments"."started_at" IS NULL OR "agent_deployments"."failed_at" >= "agent_deployments"."started_at")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "desired_status" "agent_desired_status" DEFAULT 'stopped' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_id_user_id_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_agent_owner_fk" FOREIGN KEY ("agent_id","user_id") REFERENCES "public"."agents"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_deployments_user_idempotency_idx" ON "agent_deployments" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_deployments_active_agent_idx" ON "agent_deployments" USING btree ("agent_id") WHERE "agent_deployments"."stage" NOT IN ('ready', 'failed');--> statement-breakpoint
CREATE INDEX "agent_deployments_user_agent_created_idx" ON "agent_deployments" USING btree ("user_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_deployments_claim_idx" ON "agent_deployments" USING btree ("next_attempt_at","lease_expires_at","created_at") WHERE "agent_deployments"."stage" NOT IN ('ready', 'failed');
