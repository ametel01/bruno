ALTER TABLE "runner_infrastructure_orphans" DROP CONSTRAINT "runner_infrastructure_orphans_operation_check";--> statement-breakpoint
ALTER TABLE "runner_replacements" DROP CONSTRAINT "runner_replacements_operation_key_check";--> statement-breakpoint
ALTER TABLE "runners" DROP CONSTRAINT "runners_provisioning_operation_key_check";--> statement-breakpoint
UPDATE "runners"
SET "provisioning_operation_key" = regexp_replace("provisioning_operation_key", '^[^-]+-deploy-', 'bruno-deploy-')
WHERE "provisioning_operation_key" IS NOT NULL
	AND "provisioning_operation_key" !~ '^bruno-deploy-';--> statement-breakpoint
UPDATE "runner_replacements"
SET "operation_key" = regexp_replace("operation_key", '^[^-]+-replace-', 'bruno-replace-')
WHERE "operation_key" !~ '^bruno-replace-';--> statement-breakpoint
UPDATE "runner_infrastructure_orphans"
SET
	"operation_tag" = regexp_replace("operation_tag", '^[^-]+-deploy-', 'bruno-deploy-'),
	"expected_name" = regexp_replace("expected_name", '^[^-]+-deploy-', 'bruno-deploy-')
WHERE "operation_tag" !~ '^bruno-deploy-';--> statement-breakpoint
ALTER TABLE "runner_infrastructure_orphans" ADD CONSTRAINT "runner_infrastructure_orphans_operation_check" CHECK ("runner_infrastructure_orphans"."operation_tag" ~ '^bruno-deploy-[0-9a-f]{32}$');--> statement-breakpoint
ALTER TABLE "runner_replacements" ADD CONSTRAINT "runner_replacements_operation_key_check" CHECK ("runner_replacements"."operation_key" ~ '^bruno-replace-[0-9a-f]{32}$');--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_provisioning_operation_key_check" CHECK ("runners"."provisioning_operation_key" IS NULL OR ("runners"."kind" = 'digitalocean' AND "runners"."provisioning_operation_key" ~ '^bruno-deploy-[0-9a-f]{32}$'));
