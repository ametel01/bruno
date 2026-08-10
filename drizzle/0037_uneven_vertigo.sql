CREATE TABLE "provider_trial_slot_cleanup_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"cleanup_attempt_number" integer NOT NULL,
	"cost_cents" integer NOT NULL,
	"active_provider_resources" integer NOT NULL,
	"ok" boolean NOT NULL,
	"authoritative" boolean NOT NULL,
	"remaining_resource_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_trial_slot_cleanup_events_attempt_check" CHECK ("provider_trial_slot_cleanup_events"."cleanup_attempt_number" >= 1),
	CONSTRAINT "provider_trial_slot_cleanup_events_cost_check" CHECK ("provider_trial_slot_cleanup_events"."cost_cents" >= 0),
	CONSTRAINT "provider_trial_slot_cleanup_events_resource_count_check" CHECK ("provider_trial_slot_cleanup_events"."active_provider_resources" >= 0 AND "provider_trial_slot_cleanup_events"."remaining_resource_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "provider_trial_slot_cleanup_events" ADD CONSTRAINT "provider_trial_slot_cleanup_events_slot_id_provider_trial_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."provider_trial_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_trial_slot_cleanup_events_attempt_idx" ON "provider_trial_slot_cleanup_events" USING btree ("slot_id","cleanup_attempt_number");--> statement-breakpoint
CREATE INDEX "provider_trial_slot_cleanup_events_created_idx" ON "provider_trial_slot_cleanup_events" USING btree ("created_at","slot_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_provider_trial_slot_cleanup_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'provider trial slot cleanup events are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "provider_trial_slot_cleanup_events_immutable_update"
BEFORE UPDATE ON "provider_trial_slot_cleanup_events"
FOR EACH ROW EXECUTE FUNCTION reject_provider_trial_slot_cleanup_event_mutation();
--> statement-breakpoint
CREATE TRIGGER "provider_trial_slot_cleanup_events_immutable_delete"
BEFORE DELETE ON "provider_trial_slot_cleanup_events"
FOR EACH ROW EXECUTE FUNCTION reject_provider_trial_slot_cleanup_event_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_provider_trial_run_configuration()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'provider trial run is immutable once initialized';
	END IF;
	IF NEW.configuration IS DISTINCT FROM OLD.configuration THEN
		RAISE EXCEPTION 'provider trial run configuration is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "provider_trial_runs_preserve_configuration_trigger"
BEFORE UPDATE OF "configuration" ON "provider_trial_runs"
FOR EACH ROW EXECUTE FUNCTION preserve_provider_trial_run_configuration();
--> statement-breakpoint
CREATE TRIGGER "provider_trial_runs_immutable_delete"
BEFORE DELETE ON "provider_trial_runs"
FOR EACH ROW EXECUTE FUNCTION preserve_provider_trial_run_configuration();
