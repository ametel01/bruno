ALTER TABLE "runners" DROP CONSTRAINT "runners_kind_manual_vps_check";--> statement-breakpoint
ALTER TABLE "runners" DROP CONSTRAINT "runners_endpoint_url_not_empty_check";--> statement-breakpoint
DROP INDEX "runners_active_user_endpoint_idx";--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "endpoint_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "provider_resource_id" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "size_slug" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "provisioning_status" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "provisioning_error" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "provisioning_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "provisioning_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "runners_provider_resource_idx" ON "runners" USING btree ("provider","provider_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_active_user_endpoint_idx" ON "runners" USING btree ("user_id","endpoint_url") WHERE "runners"."deleted_at" IS NULL AND "runners"."endpoint_url" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_kind_check" CHECK ("runners"."kind" IN ('manual_vps', 'digitalocean'));--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_manual_endpoint_required_check" CHECK ("runners"."kind" <> 'manual_vps' OR "runners"."endpoint_url" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_provider_check" CHECK ("runners"."provider" IS NULL OR "runners"."provider" = 'digitalocean');--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_provider_resource_id_not_empty_check" CHECK ("runners"."provider_resource_id" IS NULL OR length(trim("runners"."provider_resource_id")) > 0);--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_region_not_empty_check" CHECK ("runners"."region" IS NULL OR length(trim("runners"."region")) > 0);--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_size_slug_not_empty_check" CHECK ("runners"."size_slug" IS NULL OR length(trim("runners"."size_slug")) > 0);--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_image_not_empty_check" CHECK ("runners"."image" IS NULL OR length(trim("runners"."image")) > 0);--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_provisioning_status_check" CHECK ("runners"."provisioning_status" IS NULL OR "runners"."provisioning_status" IN ('pending', 'creating', 'tagging', 'firewall_configuring', 'bootstrapping', 'waiting_for_runner', 'ready', 'failed', 'cleaning_up', 'deleted'));--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_digitalocean_provider_fields_check" CHECK (("runners"."kind" = 'manual_vps' AND "runners"."provider" IS NULL AND "runners"."provider_resource_id" IS NULL AND "runners"."region" IS NULL AND "runners"."size_slug" IS NULL AND "runners"."image" IS NULL AND "runners"."provisioning_status" IS NULL AND "runners"."provisioning_error" IS NULL AND "runners"."provisioning_started_at" IS NULL AND "runners"."provisioning_completed_at" IS NULL) OR ("runners"."kind" = 'digitalocean' AND "runners"."provider" = 'digitalocean' AND "runners"."region" IS NOT NULL AND "runners"."size_slug" IS NOT NULL AND "runners"."image" IS NOT NULL AND "runners"."provisioning_status" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_provisioning_completed_after_started_check" CHECK ("runners"."provisioning_completed_at" IS NULL OR "runners"."provisioning_started_at" IS NULL OR "runners"."provisioning_completed_at" >= "runners"."provisioning_started_at");--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_endpoint_url_not_empty_check" CHECK ("runners"."endpoint_url" IS NULL OR length(trim("runners"."endpoint_url")) > 0);