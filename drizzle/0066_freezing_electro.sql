CREATE TYPE "public"."operator_morning_brief_attention_kind" AS ENUM('unanswered_inbound', 'external_meeting', 'overdue_relationship_work', 'proposed_action');--> statement-breakpoint
CREATE TABLE "operator_morning_brief_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" "operator_morning_brief_attention_kind" NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"source_watermark" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_morning_brief_items_priority_check" CHECK ("operator_morning_brief_items"."priority" BETWEEN 0 AND 100),
	CONSTRAINT "operator_morning_brief_items_title_check" CHECK (length(trim("operator_morning_brief_items"."title")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_morning_brief_items_detail_check" CHECK (length(trim("operator_morning_brief_items"."detail")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "operator_morning_brief_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"delivery_local_time" text DEFAULT '07:00' NOT NULL,
	"next_delivery_at" timestamp with time zone,
	"last_delivered_local_date" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_morning_brief_preferences_delivery_time_check" CHECK ("operator_morning_brief_preferences"."delivery_local_time" ~ '^[0-2][0-9]:[0-5][0-9]$' AND substring("operator_morning_brief_preferences"."delivery_local_time" from 1 for 2)::integer BETWEEN 0 AND 23)
);
--> statement-breakpoint
ALTER TABLE "operator_morning_briefs" ADD COLUMN "evidence_watermark" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_morning_briefs" ADD COLUMN "calendar_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator_morning_briefs" ADD COLUMN "calendar_window_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator_morning_briefs" ADD COLUMN "mail_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator_morning_briefs" ADD COLUMN "mail_window_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator_relationship_evidence" ADD COLUMN "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_morning_brief_items" ADD CONSTRAINT "operator_morning_brief_items_brief_id_operator_morning_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."operator_morning_briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_morning_brief_items" ADD CONSTRAINT "operator_morning_brief_items_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_morning_brief_preferences" ADD CONSTRAINT "operator_morning_brief_preferences_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_morning_brief_items_identity_idx" ON "operator_morning_brief_items" USING btree ("brief_id","kind","source_id");--> statement-breakpoint
CREATE INDEX "operator_morning_brief_items_brief_priority_idx" ON "operator_morning_brief_items" USING btree ("brief_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_morning_brief_preferences_operator_idx" ON "operator_morning_brief_preferences" USING btree ("operator_id");