ALTER TABLE "founder_recovery_archives" ADD COLUMN "runtime_revision" text;--> statement-breakpoint
ALTER TABLE "founder_recovery_archives" ADD CONSTRAINT "founder_recovery_archives_runtime_revision_check" CHECK ("founder_recovery_archives"."runtime_revision" IS NULL OR length(trim("founder_recovery_archives"."runtime_revision")) > 0);
