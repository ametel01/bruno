CREATE TABLE "docker_runner_containers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"container_id" text NOT NULL,
	"container_name" text NOT NULL,
	"image" text NOT NULL,
	"observed_status" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_runner_containers_observed_status_not_empty_check" CHECK (length(trim("docker_runner_containers"."observed_status")) > 0),
	CONSTRAINT "docker_runner_containers_started_finished_order_check" CHECK ("docker_runner_containers"."finished_at" IS NULL OR "docker_runner_containers"."started_at" IS NULL OR "docker_runner_containers"."finished_at" >= "docker_runner_containers"."started_at")
);
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD COLUMN "docker_runner_container_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_logs" ADD COLUMN "source" text DEFAULT 'simulator' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_logs" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_runner_containers" ADD CONSTRAINT "docker_runner_containers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docker_runner_containers_agent_observed_idx" ON "docker_runner_containers" USING btree ("agent_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_runner_containers_container_id_idx" ON "docker_runner_containers" USING btree ("container_id");--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_docker_runner_container_id_docker_runner_containers_id_fk" FOREIGN KEY ("docker_runner_container_id") REFERENCES "public"."docker_runner_containers"("id") ON DELETE no action ON UPDATE no action;