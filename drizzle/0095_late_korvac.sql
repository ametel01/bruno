ALTER TABLE "founder_release_decisions" DROP CONSTRAINT "founder_release_decisions_owner_preview_qualification_expiry_check";--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_owner_preview_qualification_expiry_check" CHECK ("founder_release_decisions"."stage" <> 'owner_preview' OR "founder_release_decisions"."outcome" = 'deny' OR ("founder_release_decisions"."openai_qualification_expires_at" IS NOT NULL AND "founder_release_decisions"."calendar_qualification_expires_at" IS NOT NULL));--> statement-breakpoint
INSERT INTO "app_metadata" ("key", "value", "updated_at")
SELECT 'founder_owner_preview_owner_user_id:v1', min("user_id"::text), now()
FROM "founder_release_decisions"
WHERE "stage" = 'owner_preview' AND "outcome" IN ('enter', 'resume')
HAVING count(DISTINCT "user_id") = 1
ON CONFLICT ("key") DO NOTHING;
