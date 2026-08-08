ALTER TABLE "agent_deployments" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "initial_cohort" text;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "deployment_environment" text;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD COLUMN "owner_cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_deployments" ALTER COLUMN "origin" SET DEFAULT 'operator_trial';--> statement-breakpoint
ALTER TABLE "agent_deployments" ALTER COLUMN "initial_cohort" SET DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "agent_deployments" ALTER COLUMN "deployment_environment" SET DEFAULT 'non_production';--> statement-breakpoint
CREATE INDEX "agent_deployments_slo_selection_idx" ON "agent_deployments" USING btree ("accepted_at","id") WHERE "agent_deployments"."origin" = 'owner_request' AND "agent_deployments"."initial_cohort" = 'cold_deployment' AND "agent_deployments"."deployment_environment" = 'production';--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_origin_check" CHECK ("agent_deployments"."origin" IS NULL OR "agent_deployments"."origin" IN ('owner_request', 'operator_trial', 'runner_replacement'));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_initial_cohort_check" CHECK ("agent_deployments"."initial_cohort" IS NULL OR "agent_deployments"."initial_cohort" IN ('cold_deployment', 'same_owner_reuse', 'unknown'));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_environment_check" CHECK ("agent_deployments"."deployment_environment" IS NULL OR "agent_deployments"."deployment_environment" IN ('production', 'non_production'));--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_owner_cancelled_after_acceptance_check" CHECK ("agent_deployments"."owner_cancelled_at" IS NULL OR "agent_deployments"."accepted_at" IS NULL OR "agent_deployments"."owner_cancelled_at" >= "agent_deployments"."accepted_at");--> statement-breakpoint
CREATE FUNCTION agent_deployments_preserve_slo_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' AND (
		NEW.origin IS NULL
		OR NEW.initial_cohort IS NULL
		OR NEW.deployment_environment IS NULL
	) THEN
		RAISE EXCEPTION 'new agent deployment requires immutable SLO identity'
			USING ERRCODE = '23514', CONSTRAINT = 'agent_deployments_slo_identity_required_check';
	END IF;
	IF TG_OP = 'UPDATE' AND (
		NEW.origin IS DISTINCT FROM OLD.origin
		OR NEW.initial_cohort IS DISTINCT FROM OLD.initial_cohort
		OR NEW.deployment_environment IS DISTINCT FROM OLD.deployment_environment
	) THEN
		RAISE EXCEPTION 'agent deployment SLO identity cannot change'
			USING ERRCODE = '23514', CONSTRAINT = 'agent_deployments_slo_identity_immutable_check';
	END IF;
	IF TG_OP = 'UPDATE'
		AND OLD.owner_cancelled_at IS NOT NULL
		AND NEW.owner_cancelled_at IS DISTINCT FROM OLD.owner_cancelled_at THEN
		RAISE EXCEPTION 'agent deployment Owner cancellation cannot change'
			USING ERRCODE = '23514', CONSTRAINT = 'agent_deployments_owner_cancelled_at_immutable_check';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER agent_deployments_slo_identity_required_trigger
BEFORE INSERT ON agent_deployments
FOR EACH ROW
EXECUTE FUNCTION agent_deployments_preserve_slo_identity();--> statement-breakpoint
CREATE TRIGGER agent_deployments_slo_identity_immutable_trigger
BEFORE UPDATE ON agent_deployments
FOR EACH ROW
EXECUTE FUNCTION agent_deployments_preserve_slo_identity();
