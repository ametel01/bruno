CREATE TYPE "public"."operator_preparation_status" AS ENUM('awaiting_timezone', 'preparing', 'ready', 'needs_attention');--> statement-breakpoint
CREATE TYPE "public"."operator_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "operator_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"status" "operator_preparation_status" DEFAULT 'awaiting_timezone' NOT NULL,
	"timezone" text,
	"timezone_confirmed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"recovery_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_preparations_timezone_confirmation_check" CHECK (("operator_preparations"."timezone" IS NULL AND "operator_preparations"."timezone_confirmed_at" IS NULL) OR ("operator_preparations"."timezone" IS NOT NULL AND "operator_preparations"."timezone_confirmed_at" IS NOT NULL)),
	CONSTRAINT "operator_preparations_started_after_created_check" CHECK ("operator_preparations"."started_at" IS NULL OR "operator_preparations"."started_at" >= "operator_preparations"."created_at"),
	CONSTRAINT "operator_preparations_completed_after_started_check" CHECK ("operator_preparations"."completed_at" IS NULL OR "operator_preparations"."started_at" IS NULL OR "operator_preparations"."completed_at" >= "operator_preparations"."started_at"),
	CONSTRAINT "operator_preparations_recovery_message_check" CHECK ("operator_preparations"."status" = 'needs_attention' OR "operator_preparations"."recovery_message" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "operator_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "operators_archived_status_check" CHECK (("operators"."status" = 'archived' AND "operators"."archived_at" IS NOT NULL) OR ("operators"."status" = 'active' AND "operators"."archived_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "operator_preparations" ADD CONSTRAINT "operator_preparations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_preparations_operator_id_idx" ON "operator_preparations" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_preparations_status_idx" ON "operator_preparations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "operators_user_id_idx" ON "operators" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "operators_status_idx" ON "operators" USING btree ("status");