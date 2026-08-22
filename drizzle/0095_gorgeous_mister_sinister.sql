ALTER TABLE "founder_infrastructure_retirements" DROP CONSTRAINT "founder_infrastructure_retirements_completed_check";--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "provider_operation_tag" text;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "provider_resource_name" text;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "provider_region" text;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "provider_size_slug" text;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "provider_firewall_name" text;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "provider_resource_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "hard_destruction_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "provider_droplet_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "provider_firewall_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "provider_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "archive_outcome" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "archive_failure_code" text;--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD COLUMN "billable_runtime_seconds" integer;--> statement-breakpoint
UPDATE "founder_infrastructure_retirements" AS retirement
SET
	"provider_operation_tag" = runner."provisioning_operation_key",
	"provider_resource_name" = runner."name",
	"provider_region" = runner."region",
	"provider_size_slug" = runner."size_slug",
	"provider_firewall_name" = CASE
		WHEN btrim(left(regexp_replace(lower(trim(retirement."provider_resource_id")), '[^a-z0-9-]+', '-', 'g'), 32), '-') = '' THEN 'bruno-runners'
		ELSE 'bruno-runners-' || btrim(left(regexp_replace(lower(trim(retirement."provider_resource_id")), '[^a-z0-9-]+', '-', 'g'), 32), '-')
	END,
	"hard_destruction_due_at" = (SELECT entitlement."retirement_due_at" FROM "founder_product_entitlements" AS entitlement WHERE entitlement."user_id" = retirement."user_id" LIMIT 1),
	"archive_outcome" = coalesce((SELECT CASE archive."status" WHEN 'verified' THEN 'verified' WHEN 'failed' THEN 'failed' ELSE 'pending' END FROM "founder_recovery_archives" AS archive WHERE archive."id" = retirement."recovery_archive_id" LIMIT 1), 'pending'),
	"archive_failure_code" = (SELECT CASE WHEN archive."status" = 'failed' THEN coalesce(archive."failure_code", 'archive_preservation_failed') ELSE NULL END FROM "founder_recovery_archives" AS archive WHERE archive."id" = retirement."recovery_archive_id" LIMIT 1)
FROM "runners" AS runner
WHERE runner."id" = retirement."runner_id";--> statement-breakpoint
UPDATE "founder_infrastructure_retirements" AS retirement
SET
	"provider_resource_created_at" = runner."created_at",
	"provider_droplet_state" = 'absent',
	"provider_firewall_state" = 'absent',
	"provider_observed_at" = retirement."absence_verified_at",
	"billable_runtime_seconds" = greatest(0, ceil(extract(epoch FROM (retirement."absence_verified_at" - runner."created_at")))::integer)
FROM "runners" AS runner
WHERE runner."id" = retirement."runner_id" AND retirement."status" = 'completed';--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD CONSTRAINT "founder_infrastructure_retirements_provider_state_check" CHECK ("founder_infrastructure_retirements"."provider_droplet_state" IN ('unknown', 'present', 'absent') AND "founder_infrastructure_retirements"."provider_firewall_state" IN ('unknown', 'present', 'absent'));--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD CONSTRAINT "founder_infrastructure_retirements_archive_outcome_check" CHECK (("founder_infrastructure_retirements"."archive_outcome" = 'pending' AND "founder_infrastructure_retirements"."archive_failure_code" IS NULL) OR ("founder_infrastructure_retirements"."archive_outcome" = 'verified' AND "founder_infrastructure_retirements"."archive_failure_code" IS NULL) OR ("founder_infrastructure_retirements"."archive_outcome" = 'failed' AND "founder_infrastructure_retirements"."archive_failure_code" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD CONSTRAINT "founder_infrastructure_retirements_billable_runtime_check" CHECK ("founder_infrastructure_retirements"."billable_runtime_seconds" IS NULL OR "founder_infrastructure_retirements"."billable_runtime_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "founder_infrastructure_retirements" ADD CONSTRAINT "founder_infrastructure_retirements_completed_check" CHECK ("founder_infrastructure_retirements"."status" <> 'completed' OR ("founder_infrastructure_retirements"."provider_operation_tag" IS NOT NULL AND "founder_infrastructure_retirements"."provider_resource_name" IS NOT NULL AND "founder_infrastructure_retirements"."provider_region" IS NOT NULL AND "founder_infrastructure_retirements"."provider_size_slug" IS NOT NULL AND "founder_infrastructure_retirements"."provider_firewall_name" IS NOT NULL AND "founder_infrastructure_retirements"."provider_resource_created_at" IS NOT NULL AND "founder_infrastructure_retirements"."hard_destruction_due_at" IS NOT NULL AND "founder_infrastructure_retirements"."resources_after" = 0 AND "founder_infrastructure_retirements"."provider_droplet_state" = 'absent' AND "founder_infrastructure_retirements"."provider_firewall_state" = 'absent' AND "founder_infrastructure_retirements"."provider_observed_at" IS NOT NULL AND "founder_infrastructure_retirements"."work_stopped_at" IS NOT NULL AND "founder_infrastructure_retirements"."credentials_disabled_at" IS NOT NULL AND "founder_infrastructure_retirements"."archive_outcome" <> 'pending' AND "founder_infrastructure_retirements"."firewall_deleted_at" IS NOT NULL AND "founder_infrastructure_retirements"."droplet_deleted_at" IS NOT NULL AND "founder_infrastructure_retirements"."absence_verified_at" IS NOT NULL AND "founder_infrastructure_retirements"."billable_runtime_seconds" IS NOT NULL AND "founder_infrastructure_retirements"."failure_code" IS NULL));
