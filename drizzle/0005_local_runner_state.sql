CREATE TYPE "public"."local_runner_process_status" AS ENUM('starting', 'running', 'stopped', 'exited', 'failed');--> statement-breakpoint
CREATE TABLE "local_runner_processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"pid" integer NOT NULL,
	"command_metadata" jsonb NOT NULL,
	"status" "local_runner_process_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"exit_code" integer,
	"signal" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_runner_processes_pid_positive_check" CHECK ("local_runner_processes"."pid" > 0),
	CONSTRAINT "local_runner_processes_exit_code_nonnegative_check" CHECK ("local_runner_processes"."exit_code" IS NULL OR "local_runner_processes"."exit_code" >= 0),
	CONSTRAINT "local_runner_processes_stopped_after_started_check" CHECK ("local_runner_processes"."stopped_at" IS NULL OR "local_runner_processes"."stopped_at" >= "local_runner_processes"."started_at")
);
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD COLUMN "local_runner_process_id" uuid;--> statement-breakpoint
ALTER TABLE "local_runner_processes" ADD CONSTRAINT "local_runner_processes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_runner_processes_agent_started_idx" ON "local_runner_processes" USING btree ("agent_id","started_at");--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_local_runner_process_id_local_runner_processes_id_fk" FOREIGN KEY ("local_runner_process_id") REFERENCES "public"."local_runner_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_stream_check" CHECK ("agent_logs"."stream" IN ('stdout', 'stderr'));