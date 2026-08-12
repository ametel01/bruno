CREATE TABLE "provider_trial_authorization_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"authorization_id_hash" text NOT NULL,
	"prerequisite_gate_evidence_digest" text NOT NULL,
	"deployment_choices_digest" text NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_trial_authorization_events_generation_check" CHECK ("provider_trial_authorization_events"."generation" >= 1),
	CONSTRAINT "provider_trial_authorization_events_id_hash_check" CHECK ("provider_trial_authorization_events"."authorization_id_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "provider_trial_authorization_events_gate_digest_check" CHECK ("provider_trial_authorization_events"."prerequisite_gate_evidence_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "provider_trial_authorization_events_choices_digest_check" CHECK ("provider_trial_authorization_events"."deployment_choices_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "provider_trial_authorization_events" ADD CONSTRAINT "provider_trial_authorization_events_cohort_id_provider_trial_runs_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."provider_trial_runs"("cohort_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_trial_authorization_events_generation_idx" ON "provider_trial_authorization_events" USING btree ("cohort_id","generation");
--> statement-breakpoint
INSERT INTO "provider_trial_authorization_events" (
	"cohort_id",
	"generation",
	"authorization_id_hash",
	"prerequisite_gate_evidence_digest",
	"deployment_choices_digest",
	"authorized_at"
)
SELECT
	"cohort_id",
	"authorization_generation",
	"authorization_id_hash",
	"configuration"->>'prerequisiteGateEvidenceDigest',
	"configuration"->>'deploymentChoicesDigest',
	"authorized_at"
FROM "provider_trial_runs";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_provider_trial_authorization_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'provider trial authorization events are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "provider_trial_authorization_events_immutable_update"
BEFORE UPDATE ON "provider_trial_authorization_events"
FOR EACH ROW EXECUTE FUNCTION reject_provider_trial_authorization_event_mutation();
--> statement-breakpoint
CREATE TRIGGER "provider_trial_authorization_events_immutable_delete"
BEFORE DELETE ON "provider_trial_authorization_events"
FOR EACH ROW EXECUTE FUNCTION reject_provider_trial_authorization_event_mutation();
