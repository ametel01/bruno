CREATE TABLE "runner_provisioning_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"status" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_provisioning_events_phase_check" CHECK ("runner_provisioning_events"."phase" IN ('pending', 'creating', 'tagging', 'firewall_configuring', 'bootstrapping', 'waiting_for_runner', 'ready', 'failed', 'cleaning_up', 'deleted')),
	CONSTRAINT "runner_provisioning_events_status_check" CHECK ("runner_provisioning_events"."status" IN ('started', 'completed', 'failed')),
	CONSTRAINT "runner_provisioning_events_message_not_empty_check" CHECK (length(trim("runner_provisioning_events"."message")) > 0)
);
--> statement-breakpoint
ALTER TABLE "runner_provisioning_events" ADD CONSTRAINT "runner_provisioning_events_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_provisioning_events_runner_created_idx" ON "runner_provisioning_events" USING btree ("runner_id","created_at");