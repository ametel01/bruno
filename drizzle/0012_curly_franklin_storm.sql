CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"runner_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_uri" text,
	"manifest_json" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone,
	CONSTRAINT "backups_status_check" CHECK ("backups"."status" IN ('pending', 'uploading', 'ready', 'failed', 'restoring', 'restored')),
	CONSTRAINT "backups_storage_uri_not_empty_check" CHECK ("backups"."storage_uri" IS NULL OR length(trim("backups"."storage_uri")) > 0),
	CONSTRAINT "backups_restored_at_status_check" CHECK (("backups"."status" = 'restored' AND "backups"."restored_at" IS NOT NULL) OR ("backups"."status" <> 'restored' AND "backups"."restored_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_agent_created_idx" ON "backups" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "backups_runner_idx" ON "backups" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "backups_created_by_idx" ON "backups" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "backups_status_idx" ON "backups" USING btree ("status");