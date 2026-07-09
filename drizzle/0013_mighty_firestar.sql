CREATE TABLE "agent_usage_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"runner_id" uuid,
	"source" text DEFAULT 'lifecycle' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_usage_periods_source_check" CHECK ("agent_usage_periods"."source" IN ('lifecycle')),
	CONSTRAINT "agent_usage_periods_stopped_after_started_check" CHECK ("agent_usage_periods"."stopped_at" IS NULL OR "agent_usage_periods"."stopped_at" >= "agent_usage_periods"."started_at")
);
--> statement-breakpoint
ALTER TABLE "agent_usage_periods" ADD CONSTRAINT "agent_usage_periods_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_periods" ADD CONSTRAINT "agent_usage_periods_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_usage_periods_agent_started_idx" ON "agent_usage_periods" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_usage_periods_runner_started_idx" ON "agent_usage_periods" USING btree ("runner_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_usage_periods_agent_stopped_idx" ON "agent_usage_periods" USING btree ("agent_id","stopped_at");