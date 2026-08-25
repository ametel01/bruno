CREATE TYPE "public"."founder_operator_restoration_mode" AS ENUM('same_logical_operator', 'new_operator_environment');--> statement-breakpoint
CREATE TYPE "public"."founder_operator_restoration_status" AS ENUM('in_progress', 'provider_reauthorization_required', 'completed', 'refunded', 'failed');--> statement-breakpoint
CREATE TABLE "founder_operator_restorations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_operator_id" uuid NOT NULL,
	"restored_operator_id" uuid NOT NULL,
	"recovery_archive_id" uuid,
	"source_retirement_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"new_runner_id" uuid,
	"mode" "founder_operator_restoration_mode" NOT NULL,
	"status" "founder_operator_restoration_status" NOT NULL,
	"old_provider_resource_id" text NOT NULL,
	"old_provider_firewall_id" text NOT NULL,
	"new_provider_resource_id" text,
	"new_provider_firewall_id" text,
	"new_runtime_identity" text,
	"archive_verified_at" timestamp with time zone,
	"infrastructure_ready_at" timestamp with time zone,
	"providers_ready_at" timestamp with time zone,
	"entitlement_verified_at" timestamp with time zone,
	"work_resumed_at" timestamp with time zone,
	"refund_confirmed_at" timestamp with time zone,
	"cleanup_confirmed_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_operator_restorations_identity_check" CHECK (("founder_operator_restorations"."mode" = 'same_logical_operator' AND "founder_operator_restorations"."recovery_archive_id" IS NOT NULL AND "founder_operator_restorations"."source_operator_id" = "founder_operator_restorations"."restored_operator_id") OR ("founder_operator_restorations"."mode" = 'new_operator_environment' AND "founder_operator_restorations"."recovery_archive_id" IS NULL AND "founder_operator_restorations"."source_operator_id" <> "founder_operator_restorations"."restored_operator_id")),
	CONSTRAINT "founder_operator_restorations_resource_identity_check" CHECK ("founder_operator_restorations"."new_provider_resource_id" IS NULL OR ("founder_operator_restorations"."new_provider_firewall_id" IS NOT NULL AND "founder_operator_restorations"."new_runtime_identity" IS NOT NULL AND "founder_operator_restorations"."new_provider_resource_id" <> "founder_operator_restorations"."old_provider_resource_id" AND "founder_operator_restorations"."new_provider_firewall_id" <> "founder_operator_restorations"."old_provider_firewall_id")),
	CONSTRAINT "founder_operator_restorations_completed_check" CHECK ("founder_operator_restorations"."status" <> 'completed' OR ("founder_operator_restorations"."new_runner_id" IS NOT NULL AND "founder_operator_restorations"."new_provider_resource_id" IS NOT NULL AND "founder_operator_restorations"."new_provider_firewall_id" IS NOT NULL AND "founder_operator_restorations"."new_runtime_identity" IS NOT NULL AND "founder_operator_restorations"."infrastructure_ready_at" IS NOT NULL AND "founder_operator_restorations"."providers_ready_at" IS NOT NULL AND "founder_operator_restorations"."entitlement_verified_at" IS NOT NULL AND "founder_operator_restorations"."work_resumed_at" IS NOT NULL AND "founder_operator_restorations"."refund_confirmed_at" IS NULL AND "founder_operator_restorations"."cleanup_confirmed_at" IS NULL AND "founder_operator_restorations"."failure_code" IS NULL AND (("founder_operator_restorations"."mode" = 'same_logical_operator' AND "founder_operator_restorations"."archive_verified_at" IS NOT NULL) OR ("founder_operator_restorations"."mode" = 'new_operator_environment' AND "founder_operator_restorations"."archive_verified_at" IS NULL)))),
	CONSTRAINT "founder_operator_restorations_refunded_check" CHECK ("founder_operator_restorations"."status" <> 'refunded' OR ("founder_operator_restorations"."refund_confirmed_at" IS NOT NULL AND "founder_operator_restorations"."cleanup_confirmed_at" IS NOT NULL AND "founder_operator_restorations"."work_resumed_at" IS NULL AND "founder_operator_restorations"."failure_code" IS NOT NULL))
);
--> statement-breakpoint
DROP INDEX "operators_user_id_idx";--> statement-breakpoint
ALTER TABLE "founder_operator_restorations" ADD CONSTRAINT "founder_operator_restorations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_operator_restorations" ADD CONSTRAINT "founder_operator_restorations_source_operator_id_operators_id_fk" FOREIGN KEY ("source_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_operator_restorations" ADD CONSTRAINT "founder_operator_restorations_restored_operator_id_operators_id_fk" FOREIGN KEY ("restored_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_operator_restorations" ADD CONSTRAINT "founder_operator_restorations_recovery_archive_id_founder_recovery_archives_id_fk" FOREIGN KEY ("recovery_archive_id") REFERENCES "public"."founder_recovery_archives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_operator_restorations" ADD CONSTRAINT "founder_operator_restorations_source_retirement_id_founder_infrastructure_retirements_id_fk" FOREIGN KEY ("source_retirement_id") REFERENCES "public"."founder_infrastructure_retirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_operator_restorations" ADD CONSTRAINT "founder_operator_restorations_source_event_id_founder_commerce_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."founder_commerce_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_operator_restorations" ADD CONSTRAINT "founder_operator_restorations_new_runner_id_runners_id_fk" FOREIGN KEY ("new_runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_operator_restorations_source_event_idx" ON "founder_operator_restorations" USING btree ("source_event_id");--> statement-breakpoint
CREATE INDEX "founder_operator_restorations_user_created_idx" ON "founder_operator_restorations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operators_active_user_id_idx" ON "operators" USING btree ("user_id") WHERE "operators"."status" = 'active';