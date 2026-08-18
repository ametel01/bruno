ALTER TABLE "operator_action_preview_revisions" ALTER COLUMN "state" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "operator_action_preview_revisions" ALTER COLUMN "state" SET DEFAULT 'draft'::text;--> statement-breakpoint
DROP TYPE "public"."operator_action_preview_state";--> statement-breakpoint
CREATE TYPE "public"."operator_action_preview_state" AS ENUM('draft');--> statement-breakpoint
ALTER TABLE "operator_action_preview_revisions" ALTER COLUMN "state" SET DEFAULT 'draft'::"public"."operator_action_preview_state";--> statement-breakpoint
ALTER TABLE "operator_action_preview_revisions" ALTER COLUMN "state" SET DATA TYPE "public"."operator_action_preview_state" USING "state"::"public"."operator_action_preview_state";--> statement-breakpoint
ALTER TABLE "operator_action_previews" ADD COLUMN "mail_sending_offer_dismissed_at" timestamp with time zone;