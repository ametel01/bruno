CREATE TABLE "runner_infrastructure_orphans" (
	"provider_resource_id" text PRIMARY KEY NOT NULL,
	"operation_tag" text NOT NULL,
	"provider_firewall_id" text,
	"expected_name" text NOT NULL,
	"expected_region" text NOT NULL,
	"expected_size_slug" text NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_infrastructure_orphans_resource_check" CHECK (length(trim("runner_infrastructure_orphans"."provider_resource_id")) > 0),
	CONSTRAINT "runner_infrastructure_orphans_operation_check" CHECK ("runner_infrastructure_orphans"."operation_tag" ~ '^bruno-deploy-[0-9a-f]{32}$'),
	CONSTRAINT "runner_infrastructure_orphans_firewall_check" CHECK ("runner_infrastructure_orphans"."provider_firewall_id" IS NULL OR length(trim("runner_infrastructure_orphans"."provider_firewall_id")) > 0),
	CONSTRAINT "runner_infrastructure_orphans_expected_fields_check" CHECK (length(trim("runner_infrastructure_orphans"."expected_name")) > 0 AND length(trim("runner_infrastructure_orphans"."expected_region")) > 0 AND length(trim("runner_infrastructure_orphans"."expected_size_slug")) > 0),
	CONSTRAINT "runner_infrastructure_orphans_observation_count_check" CHECK ("runner_infrastructure_orphans"."observation_count" >= 1),
	CONSTRAINT "runner_infrastructure_orphans_observation_order_check" CHECK ("runner_infrastructure_orphans"."last_observed_at" >= "runner_infrastructure_orphans"."first_observed_at"),
	CONSTRAINT "runner_infrastructure_orphans_deleted_order_check" CHECK ("runner_infrastructure_orphans"."deleted_at" IS NULL OR "runner_infrastructure_orphans"."deleted_at" >= "runner_infrastructure_orphans"."first_observed_at")
);
--> statement-breakpoint
CREATE TABLE "runner_infrastructure_reconciliations" (
	"scope_key" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_infrastructure_reconciliations_scope_check" CHECK ("runner_infrastructure_reconciliations"."scope_key" = 'global'),
	CONSTRAINT "runner_infrastructure_reconciliations_generation_check" CHECK ("runner_infrastructure_reconciliations"."generation" >= 0),
	CONSTRAINT "runner_infrastructure_reconciliations_attempt_count_check" CHECK ("runner_infrastructure_reconciliations"."attempt_count" >= 0),
	CONSTRAINT "runner_infrastructure_reconciliations_lease_owner_check" CHECK ("runner_infrastructure_reconciliations"."lease_owner" IS NULL OR "runner_infrastructure_reconciliations"."lease_owner" ~ '^runner-infrastructure:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "runner_infrastructure_reconciliations_lease_pair_check" CHECK (("runner_infrastructure_reconciliations"."lease_owner" IS NULL AND "runner_infrastructure_reconciliations"."lease_expires_at" IS NULL) OR ("runner_infrastructure_reconciliations"."lease_owner" IS NOT NULL AND "runner_infrastructure_reconciliations"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "runner_infrastructure_orphans_grace_idx" ON "runner_infrastructure_orphans" USING btree ("deleted_at","first_observed_at","last_observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_infrastructure_orphans_active_operation_idx" ON "runner_infrastructure_orphans" USING btree ("operation_tag") WHERE "runner_infrastructure_orphans"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "runner_infrastructure_reconciliations_due_idx" ON "runner_infrastructure_reconciliations" USING btree ("next_attempt_at","lease_expires_at");