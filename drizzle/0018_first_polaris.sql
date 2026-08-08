ALTER TABLE "agent_deployments" ADD COLUMN "runner_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "runner_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "canary_state" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "canary_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "canary_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "provisioning_operation_key" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_usage_periods"
    WHERE "stopped_at" IS NULL
    GROUP BY "agent_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'agent_usage_periods_open_duplicate_blocker'
      USING ERRCODE = 'check_violation',
            DETAIL = 'Close or reconcile duplicate open agent usage periods before applying migration 0018.';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_usage_periods_one_open_agent_idx" ON "agent_usage_periods" USING btree ("agent_id") WHERE "agent_usage_periods"."stopped_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "runners_provisioning_operation_key_idx" ON "runners" USING btree ("provisioning_operation_key") WHERE "runners"."provisioning_operation_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_runner_operation_pair_check" CHECK (("agent_deployments"."runner_operation_id" IS NULL AND "agent_deployments"."runner_accepted_at" IS NULL) OR ("agent_deployments"."runner_operation_id" IS NOT NULL AND "agent_deployments"."runner_accepted_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_stage_runner_operation_check" CHECK ("agent_deployments"."stage" NOT IN ('starting_gateway', 'verifying_model', 'connecting_telegram', 'ready') OR ("agent_deployments"."runner_operation_id" IS NOT NULL AND "agent_deployments"."runner_accepted_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_canary_state_check" CHECK ("agent_deployments"."canary_state" IN ('not_started', 'started', 'passed', 'failed', 'outcome_unknown'));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_canary_stage_check" CHECK ("agent_deployments"."canary_state" = 'not_started' OR "agent_deployments"."stage" IN ('verifying_model', 'connecting_telegram', 'ready', 'failed'));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_canary_started_check" CHECK ("agent_deployments"."canary_state" <> 'started' OR ("agent_deployments"."canary_attempted_at" IS NOT NULL AND "agent_deployments"."canary_completed_at" IS NULL));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_canary_terminal_check" CHECK ("agent_deployments"."canary_state" NOT IN ('passed', 'failed') OR ("agent_deployments"."canary_attempted_at" IS NOT NULL AND "agent_deployments"."canary_completed_at" IS NOT NULL AND "agent_deployments"."canary_completed_at" >= "agent_deployments"."canary_attempted_at"));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_canary_unknown_check" CHECK ("agent_deployments"."canary_state" <> 'outcome_unknown' OR ("agent_deployments"."canary_attempted_at" IS NOT NULL AND "agent_deployments"."canary_completed_at" IS NULL));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_telegram_ready_canary_check" CHECK ("agent_deployments"."stage" NOT IN ('connecting_telegram', 'ready') OR "agent_deployments"."canary_state" = 'passed');--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_provisioning_operation_key_check" CHECK ("runners"."provisioning_operation_key" IS NULL OR ("runners"."kind" = 'digitalocean' AND "runners"."provisioning_operation_key" ~ '^bruno-deploy-[0-9a-f]{32}$'));
