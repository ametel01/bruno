CREATE TYPE "public"."runner_replacement_reason" AS ENUM('release_mismatch', 'boot_failure', 'provider_resource_missing', 'stale_heartbeat', 'endpoint_failure', 'gateway_deadline');--> statement-breakpoint
CREATE TYPE "public"."runner_replacement_state" AS ENUM('pending', 'provisioning_target', 'validating_target', 'fencing_source', 'reassigning', 'converging_agents', 'cleaning_source', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."runner_replacement_terminal_code" AS ENUM('replacement_budget_exhausted', 'target_provisioning_failed', 'target_validation_failed', 'source_fence_failed', 'reassignment_failed', 'agent_convergence_failed', 'source_cleanup_failed', 'state_invalid');--> statement-breakpoint
CREATE TABLE "agent_deployment_replacement_budgets" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"replacement_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_deployment_replacement_budgets_count_check" CHECK ("agent_deployment_replacement_budgets"."replacement_count" BETWEEN 1 AND 2),
	CONSTRAINT "agent_deployment_replacement_budgets_updated_check" CHECK ("agent_deployment_replacement_budgets"."updated_at" >= "agent_deployment_replacement_budgets"."window_started_at")
);
--> statement-breakpoint
CREATE TABLE "runner_replacements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_runner_id" uuid NOT NULL,
	"target_runner_id" uuid,
	"trigger_deployment_id" uuid,
	"reason" "runner_replacement_reason" NOT NULL,
	"state" "runner_replacement_state" DEFAULT 'pending' NOT NULL,
	"operation_key" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"replacement_count" integer DEFAULT 0 NOT NULL,
	"replacement_window_started_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"terminal_code" "runner_replacement_terminal_code",
	"terminal_summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_replacements_source_target_check" CHECK ("runner_replacements"."target_runner_id" IS NULL OR "runner_replacements"."target_runner_id" <> "runner_replacements"."source_runner_id"),
	CONSTRAINT "runner_replacements_operation_key_check" CHECK ("runner_replacements"."operation_key" ~ '^bruno-replace-[0-9a-f]{32}$'),
	CONSTRAINT "runner_replacements_generation_check" CHECK ("runner_replacements"."generation" >= 0),
	CONSTRAINT "runner_replacements_attempt_count_check" CHECK ("runner_replacements"."attempt_count" >= 0),
	CONSTRAINT "runner_replacements_replacement_count_check" CHECK ("runner_replacements"."replacement_count" BETWEEN 0 AND 2),
	CONSTRAINT "runner_replacements_replacement_window_check" CHECK (("runner_replacements"."replacement_count" = 0 AND "runner_replacements"."replacement_window_started_at" IS NULL) OR ("runner_replacements"."replacement_count" BETWEEN 1 AND 2 AND "runner_replacements"."replacement_window_started_at" IS NOT NULL)),
	CONSTRAINT "runner_replacements_lease_owner_check" CHECK ("runner_replacements"."lease_owner" IS NULL OR "runner_replacements"."lease_owner" ~ '^runner-replacement:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "runner_replacements_lease_pair_check" CHECK (("runner_replacements"."lease_owner" IS NULL AND "runner_replacements"."lease_expires_at" IS NULL) OR ("runner_replacements"."lease_owner" IS NOT NULL AND "runner_replacements"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "runner_replacements_terminal_summary_check" CHECK ("runner_replacements"."terminal_summary" IS NULL OR (length(trim("runner_replacements"."terminal_summary")) BETWEEN 1 AND 240 AND "runner_replacements"."terminal_code" IS NOT NULL)),
	CONSTRAINT "runner_replacements_terminal_evidence_check" CHECK (("runner_replacements"."terminal_code" IS NULL AND "runner_replacements"."terminal_summary" IS NULL) OR ("runner_replacements"."terminal_code" = 'replacement_budget_exhausted' AND "runner_replacements"."terminal_summary" = 'Automatic runner replacement budget was exhausted.') OR ("runner_replacements"."terminal_code" = 'target_provisioning_failed' AND "runner_replacements"."terminal_summary" = 'Replacement runner provisioning did not complete.') OR ("runner_replacements"."terminal_code" = 'target_validation_failed' AND "runner_replacements"."terminal_summary" = 'Replacement runner validation did not pass.') OR ("runner_replacements"."terminal_code" = 'source_fence_failed' AND "runner_replacements"."terminal_summary" = 'The source runner could not be fenced safely.') OR ("runner_replacements"."terminal_code" = 'reassignment_failed' AND "runner_replacements"."terminal_summary" = 'Agent reassignment did not complete safely.') OR ("runner_replacements"."terminal_code" = 'agent_convergence_failed' AND "runner_replacements"."terminal_summary" = 'Agents did not converge on the replacement runner.') OR ("runner_replacements"."terminal_code" = 'source_cleanup_failed' AND "runner_replacements"."terminal_summary" = 'The obsolete source runner could not be cleaned up safely.') OR ("runner_replacements"."terminal_code" = 'state_invalid' AND "runner_replacements"."terminal_summary" = 'The replacement workflow reached an invalid state.')),
	CONSTRAINT "runner_replacements_terminal_state_check" CHECK (("runner_replacements"."state" = 'complete' AND "runner_replacements"."completed_at" IS NOT NULL AND "runner_replacements"."failed_at" IS NULL AND "runner_replacements"."terminal_code" IS NULL AND "runner_replacements"."terminal_summary" IS NULL) OR ("runner_replacements"."state" = 'failed' AND "runner_replacements"."failed_at" IS NOT NULL AND "runner_replacements"."completed_at" IS NULL AND "runner_replacements"."terminal_code" IS NOT NULL AND "runner_replacements"."terminal_summary" IS NOT NULL) OR ("runner_replacements"."state" NOT IN ('complete', 'failed') AND "runner_replacements"."completed_at" IS NULL AND "runner_replacements"."failed_at" IS NULL AND "runner_replacements"."terminal_code" IS NULL AND "runner_replacements"."terminal_summary" IS NULL)),
	CONSTRAINT "runner_replacements_terminal_clear_work_check" CHECK ("runner_replacements"."state" NOT IN ('complete', 'failed') OR ("runner_replacements"."next_attempt_at" IS NULL AND "runner_replacements"."lease_owner" IS NULL AND "runner_replacements"."lease_expires_at" IS NULL)),
	CONSTRAINT "runner_replacements_active_work_check" CHECK ("runner_replacements"."state" IN ('complete', 'failed') OR "runner_replacements"."next_attempt_at" IS NOT NULL OR "runner_replacements"."lease_owner" IS NOT NULL),
	CONSTRAINT "runner_replacements_target_state_check" CHECK ("runner_replacements"."state" IN ('pending', 'provisioning_target', 'failed') OR "runner_replacements"."target_runner_id" IS NOT NULL),
	CONSTRAINT "runner_replacements_completed_after_started_check" CHECK ("runner_replacements"."completed_at" IS NULL OR "runner_replacements"."completed_at" >= "runner_replacements"."started_at"),
	CONSTRAINT "runner_replacements_failed_after_started_check" CHECK ("runner_replacements"."failed_at" IS NULL OR "runner_replacements"."failed_at" >= "runner_replacements"."started_at")
);
--> statement-breakpoint
ALTER TABLE "agent_deployment_replacement_budgets" ADD CONSTRAINT "agent_deployment_replacement_budgets_deployment_id_agent_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."agent_deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_replacements" ADD CONSTRAINT "runner_replacements_source_runner_id_runners_id_fk" FOREIGN KEY ("source_runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_replacements" ADD CONSTRAINT "runner_replacements_target_runner_id_runners_id_fk" FOREIGN KEY ("target_runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_replacements" ADD CONSTRAINT "runner_replacements_trigger_deployment_id_agent_deployments_id_fk" FOREIGN KEY ("trigger_deployment_id") REFERENCES "public"."agent_deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_replacements_operation_key_idx" ON "runner_replacements" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_replacements_active_source_idx" ON "runner_replacements" USING btree ("source_runner_id") WHERE "runner_replacements"."state" NOT IN ('complete', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "runner_replacements_active_deployment_idx" ON "runner_replacements" USING btree ("trigger_deployment_id") WHERE "runner_replacements"."trigger_deployment_id" IS NOT NULL AND "runner_replacements"."state" NOT IN ('complete', 'failed');--> statement-breakpoint
CREATE INDEX "runner_replacements_claim_idx" ON "runner_replacements" USING btree ("next_attempt_at","lease_expires_at","created_at") WHERE "runner_replacements"."state" NOT IN ('complete', 'failed');--> statement-breakpoint
CREATE INDEX "runner_replacements_deployment_budget_idx" ON "runner_replacements" USING btree ("trigger_deployment_id","replacement_window_started_at");
