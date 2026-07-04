CREATE TYPE "public"."agent_schedule_mode" AS ENUM('manual', 'cron');--> statement-breakpoint
CREATE TABLE "agent_configs" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"system_prompt" text NOT NULL,
	"model_provider" text DEFAULT 'not_configured' NOT NULL,
	"model_name" text DEFAULT 'not_configured' NOT NULL,
	"max_daily_spend_cents" integer DEFAULT 0 NOT NULL,
	"schedule_mode" "agent_schedule_mode" DEFAULT 'manual' NOT NULL,
	"schedule_cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_configs_max_daily_spend_nonnegative_check" CHECK ("agent_configs"."max_daily_spend_cents" >= 0),
	CONSTRAINT "agent_configs_schedule_cron_mode_check" CHECK (("agent_configs"."schedule_mode" = 'manual' AND "agent_configs"."schedule_cron" IS NULL) OR ("agent_configs"."schedule_mode" = 'cron' AND "agent_configs"."schedule_cron" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "agent_configs" (
	"agent_id",
	"system_prompt",
	"model_provider",
	"model_name",
	"max_daily_spend_cents",
	"schedule_mode",
	"schedule_cron",
	"timezone"
)
SELECT
	"agents"."id",
	'You are an AgentBay agent. Follow the operator''s instructions and keep responses concise.',
	'not_configured',
	'not_configured',
	0,
	'manual',
	NULL,
	'UTC'
FROM "agents"
WHERE "agents"."deleted_at" IS NULL;
