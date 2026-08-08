ALTER TABLE "agent_deployments" ADD COLUMN "rollout_configuration_generation" integer;--> statement-breakpoint
ALTER TABLE "agent_deployments" ALTER COLUMN "rollout_configuration_generation" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_rollout_configuration_generation_check" CHECK ("agent_deployments"."rollout_configuration_generation" IS NULL OR "agent_deployments"."rollout_configuration_generation" >= 1);--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_deployments_preserve_slo_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' AND (
		NEW.origin IS NULL
		OR NEW.initial_cohort IS NULL
		OR NEW.deployment_environment IS NULL
		OR NEW.rollout_configuration_generation IS NULL
	) THEN
		RAISE EXCEPTION 'new agent deployment requires immutable SLO identity'
			USING ERRCODE = '23514', CONSTRAINT = 'agent_deployments_slo_identity_required_check';
	END IF;
	IF TG_OP = 'UPDATE' AND (
		NEW.origin IS DISTINCT FROM OLD.origin
		OR NEW.initial_cohort IS DISTINCT FROM OLD.initial_cohort
		OR NEW.deployment_environment IS DISTINCT FROM OLD.deployment_environment
		OR NEW.rollout_configuration_generation IS DISTINCT FROM OLD.rollout_configuration_generation
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
$$;
