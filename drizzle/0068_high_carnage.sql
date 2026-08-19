ALTER TABLE "operator_conversation_works" ADD COLUMN "provider" text DEFAULT 'openai' NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD COLUMN "policy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD COLUMN "completion_identity" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD COLUMN "external_effect_started" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD COLUMN "recovery_choices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "external_action_pause" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "external_action_pause_reason" text;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "external_action_paused_at" timestamp with time zone;--> statement-breakpoint
UPDATE "operator_conversation_works" SET "paused_at" = "updated_at" WHERE "state" = 'paused' AND "paused_at" IS NULL;--> statement-breakpoint
UPDATE "operator_conversation_works" SET "completed_at" = "updated_at" WHERE "state" = 'completed' AND "completed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_conversation_works_completion_identity_idx" ON "operator_conversation_works" USING btree ("completion_identity") WHERE "operator_conversation_works"."completion_identity" <> 'legacy';--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD CONSTRAINT "operator_conversation_works_provider_check" CHECK ("operator_conversation_works"."provider" = 'openai');--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD CONSTRAINT "operator_conversation_works_policy_version_check" CHECK ("operator_conversation_works"."policy_version" >= 1);--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD CONSTRAINT "operator_conversation_works_completion_identity_check" CHECK (length(trim("operator_conversation_works"."completion_identity")) BETWEEN 1 AND 240);--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD CONSTRAINT "operator_conversation_works_pause_pair_check" CHECK (("operator_conversation_works"."state" = 'paused' AND "operator_conversation_works"."paused_at" IS NOT NULL) OR ("operator_conversation_works"."state" <> 'paused' AND "operator_conversation_works"."paused_at" IS NULL));--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD CONSTRAINT "operator_conversation_works_completed_pair_check" CHECK (("operator_conversation_works"."state" = 'completed' AND "operator_conversation_works"."completed_at" IS NOT NULL) OR ("operator_conversation_works"."state" <> 'completed' AND "operator_conversation_works"."completed_at" IS NULL));--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_external_action_pause_pair_check" CHECK (("operators"."external_action_pause" = false AND "operators"."external_action_pause_reason" IS NULL AND "operators"."external_action_paused_at" IS NULL) OR ("operators"."external_action_pause" = true AND "operators"."external_action_pause_reason" IS NOT NULL AND "operators"."external_action_paused_at" IS NOT NULL));
