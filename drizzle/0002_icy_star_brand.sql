CREATE TABLE "agent_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"runner_id" uuid,
	"stream" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_logs_sequence_positive_check" CHECK ("agent_logs"."sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_logs_agent_sequence_idx" ON "agent_logs" USING btree ("agent_id","sequence");