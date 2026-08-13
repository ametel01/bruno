ALTER TABLE "cold_deployment_slo_evaluations" RENAME COLUMN "ready_within_60" TO "ready_within_objective";--> statement-breakpoint
ALTER TABLE "cold_deployment_slo_evaluations" DROP CONSTRAINT "cold_deployment_slo_evaluations_count_check";--> statement-breakpoint
ALTER TABLE "cold_deployment_slo_evaluations" DROP CONSTRAINT "cold_deployment_slo_evaluations_proven_check";--> statement-breakpoint
ALTER TABLE "provider_trial_slots" DROP CONSTRAINT "provider_trial_slots_terminal_outcome_check";--> statement-breakpoint
ALTER TABLE "provider_trial_slots" DROP CONSTRAINT "provider_trial_slots_terminal_outcome_shape_check";--> statement-breakpoint
ALTER TABLE "cold_deployment_slo_evaluations" ADD COLUMN "objective_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "cold_deployment_slo_evaluations" ALTER COLUMN "objective_seconds" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "provider_trial_cohorts" ADD COLUMN "readiness_objective_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_trial_cohorts" ALTER COLUMN "readiness_objective_seconds" SET DEFAULT 300;--> statement-breakpoint
ALTER TABLE "cold_deployment_slo_evaluations" ADD CONSTRAINT "cold_deployment_slo_evaluations_count_check" CHECK ("cold_deployment_slo_evaluations"."objective_seconds" IN (60, 300) AND "cold_deployment_slo_evaluations"."eligible_count" BETWEEN 0 AND 100 AND "cold_deployment_slo_evaluations"."ready_within_objective" BETWEEN 0 AND "cold_deployment_slo_evaluations"."eligible_count" AND "cold_deployment_slo_evaluations"."pending_count" BETWEEN 0 AND "cold_deployment_slo_evaluations"."eligible_count");--> statement-breakpoint
ALTER TABLE "cold_deployment_slo_evaluations" ADD CONSTRAINT "cold_deployment_slo_evaluations_proven_check" CHECK ("cold_deployment_slo_evaluations"."proven" = ("cold_deployment_slo_evaluations"."eligible_count" = 100 AND "cold_deployment_slo_evaluations"."pending_count" = 0 AND "cold_deployment_slo_evaluations"."ready_within_objective" >= 95));--> statement-breakpoint
ALTER TABLE "provider_trial_cohorts" ADD CONSTRAINT "provider_trial_cohorts_readiness_objective_check" CHECK ("provider_trial_cohorts"."readiness_objective_seconds" IN (60, 300));--> statement-breakpoint
ALTER TABLE "provider_trial_slots" ADD CONSTRAINT "provider_trial_slots_terminal_outcome_check" CHECK ("provider_trial_slots"."terminal_outcome" IS NULL OR "provider_trial_slots"."terminal_outcome" IN ('pre_commit_failure', 'ready_within_60', 'ready_after_60', 'ready_within_objective', 'ready_after_objective', 'deployment_failed', 'timed_out', 'safety_failure'));--> statement-breakpoint
ALTER TABLE "provider_trial_slots" ADD CONSTRAINT "provider_trial_slots_terminal_outcome_shape_check" CHECK (("provider_trial_slots"."terminal_outcome" IS NULL AND "provider_trial_slots"."terminal_recorded_at" IS NULL AND "provider_trial_slots"."terminal_safe_code" IS NULL) OR ("provider_trial_slots"."terminal_outcome" = 'pre_commit_failure' AND "provider_trial_slots"."terminal_recorded_at" IS NOT NULL AND "provider_trial_slots"."terminal_safe_code" IS NOT NULL AND "provider_trial_slots"."request_outcome" = 'pre_commit_failure') OR ("provider_trial_slots"."terminal_outcome" IN ('ready_within_60', 'ready_after_60', 'ready_within_objective', 'ready_after_objective') AND "provider_trial_slots"."terminal_recorded_at" IS NOT NULL AND "provider_trial_slots"."terminal_safe_code" IS NULL AND "provider_trial_slots"."request_outcome" = 'committed') OR ("provider_trial_slots"."terminal_outcome" IN ('deployment_failed', 'timed_out', 'safety_failure') AND "provider_trial_slots"."terminal_recorded_at" IS NOT NULL AND "provider_trial_slots"."terminal_safe_code" IS NOT NULL AND "provider_trial_slots"."request_outcome" = 'committed'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION provider_trial_cohorts_preserve_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	slot_count integer;
BEGIN
	IF TG_OP = 'INSERT' AND NEW.started_at IS NOT NULL THEN
		RAISE EXCEPTION 'Provider Trial Cohort cannot start before its slots exist'
			USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_cohorts_start_requires_slots_check';
	END IF;

	IF TG_OP = 'DELETE' THEN
		IF OLD.started_at IS NOT NULL THEN
			RAISE EXCEPTION 'started Provider Trial Cohort cannot be discarded'
				USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_cohorts_membership_immutable_check';
		END IF;
		RETURN OLD;
	END IF;

	IF TG_OP = 'UPDATE' AND (
		NEW.cohort_key IS DISTINCT FROM OLD.cohort_key
		OR NEW.region IS DISTINCT FROM OLD.region
		OR NEW.runner_size_slug IS DISTINCT FROM OLD.runner_size_slug
		OR NEW.rollout_configuration_generation IS DISTINCT FROM OLD.rollout_configuration_generation
		OR NEW.readiness_objective_seconds IS DISTINCT FROM OLD.readiness_objective_seconds
		OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
	) THEN
		RAISE EXCEPTION 'Provider Trial Cohort identity cannot change'
			USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_cohorts_identity_immutable_check';
	END IF;

	IF TG_OP = 'UPDATE' AND OLD.started_at IS NULL AND NEW.started_at IS NOT NULL THEN
		SELECT count(*) INTO slot_count
		FROM provider_trial_slots
		WHERE cohort_id = OLD.id;

		IF slot_count <> 30 THEN
			RAISE EXCEPTION 'Provider Trial Cohort requires exactly 30 slots before it starts'
				USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_cohorts_start_requires_slots_check';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
