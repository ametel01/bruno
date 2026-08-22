ALTER TABLE "founder_release_decisions" ADD COLUMN "openai_qualification_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD COLUMN "calendar_qualification_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "founder_release_decisions"
SET "openai_qualification_expires_at" = "decided_at",
    "calendar_qualification_expires_at" = "decided_at"
WHERE "stage" = 'owner_preview';--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_owner_preview_qualification_expiry_check" CHECK ("founder_release_decisions"."stage" <> 'owner_preview' OR ("founder_release_decisions"."openai_qualification_expires_at" IS NOT NULL AND "founder_release_decisions"."calendar_qualification_expires_at" IS NOT NULL));
