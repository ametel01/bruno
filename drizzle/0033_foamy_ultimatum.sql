CREATE TABLE "cold_deployment_slo_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"report_bytes" text NOT NULL,
	"report_digest" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"signature" text NOT NULL,
	"eligible_count" integer NOT NULL,
	"ready_within_60" integer NOT NULL,
	"pending_count" integer NOT NULL,
	"proven" boolean NOT NULL,
	"incident_opened" boolean DEFAULT false NOT NULL,
	"rollout_configuration_generations" jsonb NOT NULL,
	"previous_report_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cold_deployment_slo_evaluations_digest_check" CHECK ("cold_deployment_slo_evaluations"."report_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "cold_deployment_slo_evaluations_previous_digest_check" CHECK ("cold_deployment_slo_evaluations"."previous_report_digest" IS NULL OR "cold_deployment_slo_evaluations"."previous_report_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "cold_deployment_slo_evaluations_count_check" CHECK ("cold_deployment_slo_evaluations"."eligible_count" BETWEEN 0 AND 100 AND "cold_deployment_slo_evaluations"."ready_within_60" BETWEEN 0 AND "cold_deployment_slo_evaluations"."eligible_count" AND "cold_deployment_slo_evaluations"."pending_count" BETWEEN 0 AND "cold_deployment_slo_evaluations"."eligible_count"),
	CONSTRAINT "cold_deployment_slo_evaluations_proven_check" CHECK ("cold_deployment_slo_evaluations"."proven" = ("cold_deployment_slo_evaluations"."eligible_count" = 100 AND "cold_deployment_slo_evaluations"."pending_count" = 0 AND "cold_deployment_slo_evaluations"."ready_within_60" >= 95)),
	CONSTRAINT "cold_deployment_slo_evaluations_incident_check" CHECK (NOT "cold_deployment_slo_evaluations"."incident_opened" OR NOT "cold_deployment_slo_evaluations"."proven")
);
--> statement-breakpoint
CREATE TABLE "provider_trial_runs" (
	"cohort_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"configuration" jsonb NOT NULL,
	"next_slot_number" integer DEFAULT 1 NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"authorization_generation" integer NOT NULL,
	"authorization_id_hash" text NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"cleanup_evidence" jsonb,
	"signed_report_bytes" text,
	"signed_report_digest" text,
	"signed_report_key_id" text,
	"signed_report_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_trial_runs_state_check" CHECK ("provider_trial_runs"."state" IN ('running', 'paused', 'ready_to_finalize', 'complete')),
	CONSTRAINT "provider_trial_runs_next_slot_check" CHECK ("provider_trial_runs"."next_slot_number" BETWEEN 1 AND 31),
	CONSTRAINT "provider_trial_runs_spend_check" CHECK ("provider_trial_runs"."spent_cents" >= 0),
	CONSTRAINT "provider_trial_runs_authorization_generation_check" CHECK ("provider_trial_runs"."authorization_generation" >= 1),
	CONSTRAINT "provider_trial_runs_pause_pair_check" CHECK (("provider_trial_runs"."state" = 'paused' AND "provider_trial_runs"."paused_at" IS NOT NULL AND "provider_trial_runs"."pause_reason" IS NOT NULL) OR ("provider_trial_runs"."state" <> 'paused' AND "provider_trial_runs"."paused_at" IS NULL AND "provider_trial_runs"."pause_reason" IS NULL)),
	CONSTRAINT "provider_trial_runs_signed_report_shape_check" CHECK (("provider_trial_runs"."state" = 'complete' AND "provider_trial_runs"."signed_report_bytes" IS NOT NULL AND "provider_trial_runs"."signed_report_digest" IS NOT NULL AND "provider_trial_runs"."signed_report_key_id" IS NOT NULL AND "provider_trial_runs"."signed_report_signature" IS NOT NULL AND "provider_trial_runs"."cleanup_evidence" IS NOT NULL) OR ("provider_trial_runs"."state" <> 'complete' AND "provider_trial_runs"."signed_report_bytes" IS NULL AND "provider_trial_runs"."signed_report_digest" IS NULL AND "provider_trial_runs"."signed_report_key_id" IS NULL AND "provider_trial_runs"."signed_report_signature" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "deployment_choices" jsonb DEFAULT '{"schemaVersion":"bruno.agent-deployment.choices.v1","dispatchMode":"cron","rolloutConfigurationGeneration":1,"provider":{"mode":"unavailable","region":"unknown","sizeSlug":"unknown","image":"unknown","tags":[],"runnerImage":"unknown","hermesWorkloadImage":null,"hermesStateRoot":null,"hermesPrivateNetwork":null,"hermesReadinessTimeoutMs":null,"hermesDockerCpus":null,"hermesDockerMemory":null,"hermesDockerPidsLimit":null,"runnerMaxAgents":null,"snapshotMode":{"mode":"stock"}},"validation":{"mode":"full","releaseBundleDigest":null,"snapshotBundleDigest":null}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "safety_quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "safety_quarantine_reason" text;--> statement-breakpoint
ALTER TABLE "provider_trial_runs" ADD CONSTRAINT "provider_trial_runs_cohort_id_provider_trial_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."provider_trial_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cold_deployment_slo_evaluations_digest_idx" ON "cold_deployment_slo_evaluations" USING btree ("report_digest");--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_choices_schema_check" CHECK ("agent_deployments"."deployment_choices" ->> 'schemaVersion' = 'bruno.agent-deployment.choices.v1');--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_safety_quarantine_pair_check" CHECK (("agent_deployments"."safety_quarantined_at" IS NULL AND "agent_deployments"."safety_quarantine_reason" IS NULL) OR ("agent_deployments"."safety_quarantined_at" IS NOT NULL AND length(trim("agent_deployments"."safety_quarantine_reason")) BETWEEN 1 AND 200));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_agent_deployment_choices_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.deployment_choices IS DISTINCT FROM OLD.deployment_choices THEN
		RAISE EXCEPTION 'agent deployment choices are immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_deployments_immutable_choices_update"
BEFORE UPDATE ON "agent_deployments"
FOR EACH ROW EXECUTE FUNCTION reject_agent_deployment_choices_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_cold_deployment_slo_evaluation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'cold deployment SLO evaluations are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "cold_deployment_slo_evaluations_immutable_update"
BEFORE UPDATE ON "cold_deployment_slo_evaluations"
FOR EACH ROW EXECUTE FUNCTION reject_cold_deployment_slo_evaluation_mutation();
--> statement-breakpoint
CREATE TRIGGER "cold_deployment_slo_evaluations_immutable_delete"
BEFORE DELETE ON "cold_deployment_slo_evaluations"
FOR EACH ROW EXECUTE FUNCTION reject_cold_deployment_slo_evaluation_mutation();
