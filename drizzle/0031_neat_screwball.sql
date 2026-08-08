CREATE TABLE "provider_trial_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_key" text NOT NULL,
	"region" text NOT NULL,
	"runner_size_slug" text NOT NULL,
	"rollout_configuration_generation" integer NOT NULL,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_trial_cohorts_key_check" CHECK ("provider_trial_cohorts"."cohort_key" ~ '^[a-z0-9][a-z0-9._:-]{7,127}$'),
	CONSTRAINT "provider_trial_cohorts_region_check" CHECK ("provider_trial_cohorts"."region" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "provider_trial_cohorts_runner_size_slug_check" CHECK ("provider_trial_cohorts"."runner_size_slug" ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
	CONSTRAINT "provider_trial_cohorts_rollout_generation_check" CHECK ("provider_trial_cohorts"."rollout_configuration_generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "provider_trial_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"slot_number" integer NOT NULL,
	"request_attempt_id" uuid,
	"request_started_at" timestamp with time zone,
	"request_outcome" text,
	"request_safe_code" text,
	"request_outcome_recorded_at" timestamp with time zone,
	"deployment_id" uuid,
	"terminal_outcome" text,
	"terminal_safe_code" text,
	"terminal_recorded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_trial_slots_number_check" CHECK ("provider_trial_slots"."slot_number" BETWEEN 1 AND 30),
	CONSTRAINT "provider_trial_slots_request_started_pair_check" CHECK (("provider_trial_slots"."request_attempt_id" IS NULL AND "provider_trial_slots"."request_started_at" IS NULL) OR ("provider_trial_slots"."request_attempt_id" IS NOT NULL AND "provider_trial_slots"."request_started_at" IS NOT NULL)),
	CONSTRAINT "provider_trial_slots_request_outcome_check" CHECK ("provider_trial_slots"."request_outcome" IS NULL OR "provider_trial_slots"."request_outcome" IN ('committed', 'pre_commit_failure')),
	CONSTRAINT "provider_trial_slots_request_safe_code_check" CHECK ("provider_trial_slots"."request_safe_code" IS NULL OR "provider_trial_slots"."request_safe_code" IN ('deployment_failed', 'ready_timeout', 'request_failed', 'request_outcome_unknown', 'request_rejected', 'request_validation_failed', 'safety_failure')),
	CONSTRAINT "provider_trial_slots_request_outcome_shape_check" CHECK (("provider_trial_slots"."request_outcome" IS NULL AND "provider_trial_slots"."request_outcome_recorded_at" IS NULL AND "provider_trial_slots"."request_safe_code" IS NULL AND "provider_trial_slots"."deployment_id" IS NULL) OR ("provider_trial_slots"."request_outcome" = 'committed' AND "provider_trial_slots"."request_outcome_recorded_at" IS NOT NULL AND "provider_trial_slots"."request_safe_code" IS NULL AND "provider_trial_slots"."deployment_id" IS NOT NULL) OR ("provider_trial_slots"."request_outcome" = 'pre_commit_failure' AND "provider_trial_slots"."request_outcome_recorded_at" IS NOT NULL AND "provider_trial_slots"."request_safe_code" IS NOT NULL AND "provider_trial_slots"."deployment_id" IS NULL)),
	CONSTRAINT "provider_trial_slots_request_outcome_after_start_check" CHECK ("provider_trial_slots"."request_outcome" IS NULL OR ("provider_trial_slots"."request_attempt_id" IS NOT NULL AND "provider_trial_slots"."request_started_at" IS NOT NULL AND "provider_trial_slots"."request_outcome_recorded_at" >= "provider_trial_slots"."request_started_at")),
	CONSTRAINT "provider_trial_slots_request_start_boundary_check" CHECK ("provider_trial_slots"."request_started_at" IS NULL OR "provider_trial_slots"."request_started_at" >= "provider_trial_slots"."created_at"),
	CONSTRAINT "provider_trial_slots_terminal_outcome_check" CHECK ("provider_trial_slots"."terminal_outcome" IS NULL OR "provider_trial_slots"."terminal_outcome" IN ('pre_commit_failure', 'ready_within_60', 'ready_after_60', 'deployment_failed', 'timed_out', 'safety_failure')),
	CONSTRAINT "provider_trial_slots_terminal_safe_code_check" CHECK ("provider_trial_slots"."terminal_safe_code" IS NULL OR "provider_trial_slots"."terminal_safe_code" IN ('deployment_failed', 'ready_timeout', 'request_failed', 'request_outcome_unknown', 'request_rejected', 'request_validation_failed', 'safety_failure')),
	CONSTRAINT "provider_trial_slots_terminal_outcome_shape_check" CHECK (("provider_trial_slots"."terminal_outcome" IS NULL AND "provider_trial_slots"."terminal_recorded_at" IS NULL AND "provider_trial_slots"."terminal_safe_code" IS NULL) OR ("provider_trial_slots"."terminal_outcome" = 'pre_commit_failure' AND "provider_trial_slots"."terminal_recorded_at" IS NOT NULL AND "provider_trial_slots"."terminal_safe_code" IS NOT NULL AND "provider_trial_slots"."request_outcome" = 'pre_commit_failure') OR ("provider_trial_slots"."terminal_outcome" IN ('ready_within_60', 'ready_after_60') AND "provider_trial_slots"."terminal_recorded_at" IS NOT NULL AND "provider_trial_slots"."terminal_safe_code" IS NULL AND "provider_trial_slots"."request_outcome" = 'committed') OR ("provider_trial_slots"."terminal_outcome" IN ('deployment_failed', 'timed_out', 'safety_failure') AND "provider_trial_slots"."terminal_recorded_at" IS NOT NULL AND "provider_trial_slots"."terminal_safe_code" IS NOT NULL AND "provider_trial_slots"."request_outcome" = 'committed')),
	CONSTRAINT "provider_trial_slots_terminal_after_request_check" CHECK ("provider_trial_slots"."terminal_outcome" IS NULL OR "provider_trial_slots"."terminal_recorded_at" >= "provider_trial_slots"."request_outcome_recorded_at"),
	CONSTRAINT "provider_trial_slots_precommit_code_match_check" CHECK ("provider_trial_slots"."terminal_outcome" <> 'pre_commit_failure' OR "provider_trial_slots"."terminal_safe_code" = "provider_trial_slots"."request_safe_code")
);
--> statement-breakpoint
ALTER TABLE "provider_trial_slots" ADD CONSTRAINT "provider_trial_slots_cohort_id_provider_trial_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."provider_trial_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_trial_slots" ADD CONSTRAINT "provider_trial_slots_deployment_id_agent_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."agent_deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_trial_cohorts_key_idx" ON "provider_trial_cohorts" USING btree ("cohort_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_trial_slots_cohort_number_idx" ON "provider_trial_slots" USING btree ("cohort_id","slot_number");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_trial_slots_request_attempt_idx" ON "provider_trial_slots" USING btree ("request_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_trial_slots_deployment_idx" ON "provider_trial_slots" USING btree ("deployment_id");--> statement-breakpoint
CREATE FUNCTION provider_trial_cohorts_preserve_identity()
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
$$;--> statement-breakpoint
CREATE TRIGGER provider_trial_cohorts_preserve_identity_trigger
BEFORE INSERT OR UPDATE OR DELETE ON provider_trial_cohorts
FOR EACH ROW
EXECUTE FUNCTION provider_trial_cohorts_preserve_identity();--> statement-breakpoint
CREATE FUNCTION provider_trial_slots_preserve_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	cohort_started_at timestamp with time zone;
	cohort_generation integer;
	deployment_origin text;
	deployment_generation integer;
	deployment_idempotency_key text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT started_at INTO cohort_started_at
		FROM provider_trial_cohorts
		WHERE id = NEW.cohort_id
		FOR UPDATE;

		IF cohort_started_at IS NOT NULL THEN
			RAISE EXCEPTION 'started Provider Trial Cohort membership cannot change'
				USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_membership_immutable_check';
		END IF;
		RETURN NEW;
	END IF;

	IF TG_OP = 'DELETE' THEN
		SELECT started_at INTO cohort_started_at
		FROM provider_trial_cohorts
		WHERE id = OLD.cohort_id
		FOR UPDATE;

		IF cohort_started_at IS NOT NULL THEN
			RAISE EXCEPTION 'started Provider Trial Cohort membership cannot change'
				USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_membership_immutable_check';
		END IF;
		RETURN OLD;
	END IF;

	IF NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
		OR NEW.slot_number IS DISTINCT FROM OLD.slot_number
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'Provider Trial slot identity cannot change'
			USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_identity_immutable_check';
	END IF;

	IF OLD.request_attempt_id IS NOT NULL AND (
		NEW.request_attempt_id IS DISTINCT FROM OLD.request_attempt_id
		OR NEW.request_started_at IS DISTINCT FROM OLD.request_started_at
	) THEN
		RAISE EXCEPTION 'Provider Trial request identity cannot change'
			USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_request_identity_immutable_check';
	END IF;

	IF OLD.request_attempt_id IS NULL AND NEW.request_attempt_id IS NOT NULL THEN
		SELECT started_at INTO cohort_started_at
		FROM provider_trial_cohorts
		WHERE id = NEW.cohort_id
		FOR SHARE;

		IF cohort_started_at IS NULL
			OR NEW.request_started_at < cohort_started_at
			OR NEW.request_started_at < NEW.created_at THEN
			RAISE EXCEPTION 'Provider Trial request must start after its locked cohort and durable slot'
				USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_request_start_boundary_check';
		END IF;
	END IF;

	IF OLD.request_outcome IS NOT NULL AND (
		NEW.request_outcome IS DISTINCT FROM OLD.request_outcome
		OR NEW.request_safe_code IS DISTINCT FROM OLD.request_safe_code
		OR NEW.request_outcome_recorded_at IS DISTINCT FROM OLD.request_outcome_recorded_at
		OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
	) THEN
		RAISE EXCEPTION 'Provider Trial request outcome cannot change'
			USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_outcome_immutable_check';
	END IF;

	IF OLD.terminal_outcome IS NOT NULL AND (
		NEW.terminal_outcome IS DISTINCT FROM OLD.terminal_outcome
		OR NEW.terminal_safe_code IS DISTINCT FROM OLD.terminal_safe_code
		OR NEW.terminal_recorded_at IS DISTINCT FROM OLD.terminal_recorded_at
	) THEN
		RAISE EXCEPTION 'Provider Trial terminal outcome cannot change'
			USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_outcome_immutable_check';
	END IF;

	IF NEW.deployment_id IS NOT NULL AND NEW.deployment_id IS DISTINCT FROM OLD.deployment_id THEN
		SELECT c.rollout_configuration_generation, d.origin, d.rollout_configuration_generation, d.idempotency_key
		INTO cohort_generation, deployment_origin, deployment_generation, deployment_idempotency_key
		FROM provider_trial_cohorts c
		JOIN agent_deployments d ON d.id = NEW.deployment_id
		WHERE c.id = NEW.cohort_id;

		IF deployment_origin IS DISTINCT FROM 'operator_trial' THEN
			RAISE EXCEPTION 'Provider Trial slot requires an exact operator-trial deployment'
				USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_deployment_identity_check';
		END IF;
		IF deployment_generation IS DISTINCT FROM cohort_generation THEN
			RAISE EXCEPTION 'Provider Trial deployment Rollout Configuration generation does not match its cohort'
				USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_deployment_generation_check';
		END IF;
		IF deployment_idempotency_key IS DISTINCT FROM 'provider-trial:' || NEW.request_attempt_id::text THEN
			RAISE EXCEPTION 'Provider Trial deployment does not belong to the exact request attempt'
				USING ERRCODE = '23514', CONSTRAINT = 'provider_trial_slots_deployment_attempt_check';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER provider_trial_slots_preserve_evidence_trigger
BEFORE INSERT OR UPDATE OR DELETE ON provider_trial_slots
FOR EACH ROW
EXECUTE FUNCTION provider_trial_slots_preserve_evidence();
