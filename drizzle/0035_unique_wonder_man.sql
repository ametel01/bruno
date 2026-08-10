CREATE TABLE "agent_deployment_api_attempt_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"request_kind" text NOT NULL,
	"phase" text NOT NULL,
	"safe_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_deployment_api_attempt_events_kind_check" CHECK ("agent_deployment_api_attempt_events"."request_kind" IN ('create_ready', 'start')),
	CONSTRAINT "agent_deployment_api_attempt_events_phase_check" CHECK ("agent_deployment_api_attempt_events"."phase" IN ('started', 'accepted', 'rejected', 'outcome_unknown')),
	CONSTRAINT "agent_deployment_api_attempt_events_shape_check" CHECK (("agent_deployment_api_attempt_events"."phase" IN ('started', 'accepted') AND "agent_deployment_api_attempt_events"."safe_code" IS NULL) OR ("agent_deployment_api_attempt_events"."phase" IN ('rejected', 'outcome_unknown') AND "agent_deployment_api_attempt_events"."safe_code" ~ '^[a-z0-9_.:-]{1,64}$'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_deployment_api_attempt_events_attempt_phase_idx" ON "agent_deployment_api_attempt_events" USING btree ("attempt_id","phase");--> statement-breakpoint
CREATE INDEX "agent_deployment_api_attempt_events_created_idx" ON "agent_deployment_api_attempt_events" USING btree ("created_at","attempt_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_agent_deployment_api_attempt_event_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	started_kind text;
BEGIN
	SELECT request_kind INTO started_kind
	FROM agent_deployment_api_attempt_events
	WHERE attempt_id = NEW.attempt_id AND phase = 'started';
	IF NEW.phase = 'started' THEN
		IF started_kind IS NOT NULL THEN
			RAISE EXCEPTION 'agent deployment API attempt already started';
		END IF;
	ELSIF started_kind IS NULL OR started_kind <> NEW.request_kind THEN
		RAISE EXCEPTION 'agent deployment API attempt terminal event has no matching start';
	ELSIF EXISTS (
		SELECT 1 FROM agent_deployment_api_attempt_events
		WHERE attempt_id = NEW.attempt_id AND phase <> 'started'
	) THEN
		RAISE EXCEPTION 'agent deployment API attempt already has a terminal event';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_deployment_api_attempt_events_sequence_insert"
BEFORE INSERT ON "agent_deployment_api_attempt_events"
FOR EACH ROW EXECUTE FUNCTION enforce_agent_deployment_api_attempt_event_sequence();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_agent_deployment_api_attempt_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'agent deployment API attempt events are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_deployment_api_attempt_events_immutable_update"
BEFORE UPDATE ON "agent_deployment_api_attempt_events"
FOR EACH ROW EXECUTE FUNCTION reject_agent_deployment_api_attempt_event_mutation();
--> statement-breakpoint
CREATE TRIGGER "agent_deployment_api_attempt_events_immutable_delete"
BEFORE DELETE ON "agent_deployment_api_attempt_events"
FOR EACH ROW EXECUTE FUNCTION reject_agent_deployment_api_attempt_event_mutation();
