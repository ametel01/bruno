CREATE TYPE "public"."agent_deployment_wakeup_state" AS ENUM('pending', 'publishing', 'published', 'claimed', 'terminal', 'failed');--> statement-breakpoint
CREATE TABLE "agent_deployment_wakeups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" "agent_deployment_wakeup_state" DEFAULT 'pending' NOT NULL,
	"publish_attempt_count" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"publish_lease_owner" text,
	"publish_lease_expires_at" timestamp with time zone,
	"safe_error_code" text,
	"published_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_deployment_wakeups_generation_check" CHECK ("agent_deployment_wakeups"."generation" >= 1),
	CONSTRAINT "agent_deployment_wakeups_publish_attempt_count_check" CHECK ("agent_deployment_wakeups"."publish_attempt_count" >= 0),
	CONSTRAINT "agent_deployment_wakeups_provider_message_id_check" CHECK ("agent_deployment_wakeups"."provider_message_id" IS NULL OR (length(trim("agent_deployment_wakeups"."provider_message_id")) > 0 AND length("agent_deployment_wakeups"."provider_message_id") <= 256)),
	CONSTRAINT "agent_deployment_wakeups_publish_lease_owner_check" CHECK ("agent_deployment_wakeups"."publish_lease_owner" IS NULL OR (length(trim("agent_deployment_wakeups"."publish_lease_owner")) > 0 AND length("agent_deployment_wakeups"."publish_lease_owner") <= 128)),
	CONSTRAINT "agent_deployment_wakeups_publish_lease_pair_check" CHECK (("agent_deployment_wakeups"."publish_lease_owner" IS NULL AND "agent_deployment_wakeups"."publish_lease_expires_at" IS NULL) OR ("agent_deployment_wakeups"."publish_lease_owner" IS NOT NULL AND "agent_deployment_wakeups"."publish_lease_expires_at" IS NOT NULL)),
	CONSTRAINT "agent_deployment_wakeups_safe_error_code_check" CHECK ("agent_deployment_wakeups"."safe_error_code" IS NULL OR "agent_deployment_wakeups"."safe_error_code" ~ '^[a-z0-9_.:-]{1,64}$'),
	CONSTRAINT "agent_deployment_wakeups_published_state_check" CHECK ("agent_deployment_wakeups"."state" <> 'published' OR ("agent_deployment_wakeups"."provider_message_id" IS NOT NULL AND "agent_deployment_wakeups"."published_at" IS NOT NULL)),
	CONSTRAINT "agent_deployment_wakeups_claimed_state_check" CHECK ("agent_deployment_wakeups"."state" <> 'claimed' OR "agent_deployment_wakeups"."claimed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_deployment_wakeups" ADD CONSTRAINT "agent_deployment_wakeups_deployment_id_agent_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."agent_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_deployment_wakeups_generation_idx" ON "agent_deployment_wakeups" USING btree ("deployment_id","generation");--> statement-breakpoint
CREATE INDEX "agent_deployment_wakeups_due_idx" ON "agent_deployment_wakeups" USING btree ("due_at","updated_at","deployment_id") WHERE "agent_deployment_wakeups"."state" IN ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "agent_deployment_wakeups_publish_lease_idx" ON "agent_deployment_wakeups" USING btree ("publish_lease_expires_at","updated_at") WHERE "agent_deployment_wakeups"."state" = 'publishing';--> statement-breakpoint
CREATE INDEX "agent_deployment_wakeups_delivery_idx" ON "agent_deployment_wakeups" USING btree ("deployment_id","generation","due_at") WHERE "agent_deployment_wakeups"."state" IN ('pending', 'published', 'failed');