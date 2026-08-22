ALTER TABLE "founder_release_decisions" ADD COLUMN "affected_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "founder_release_decisions"
SET "affected_capabilities" = "capability_manifest"
WHERE "outcome" = 'hold';--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_affected_capabilities_check" CHECK (("founder_release_decisions"."outcome" = 'hold' AND jsonb_array_length("founder_release_decisions"."affected_capabilities") > 0) OR ("founder_release_decisions"."outcome" <> 'hold' AND jsonb_array_length("founder_release_decisions"."affected_capabilities") = 0));--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_affected_capabilities_manifest_check" CHECK ("founder_release_decisions"."affected_capabilities" <@ "founder_release_decisions"."capability_manifest");
