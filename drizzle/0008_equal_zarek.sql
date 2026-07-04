CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'manual_vps' NOT NULL,
	"endpoint_url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "runners_name_not_empty_check" CHECK (length(trim("runners"."name")) > 0),
	CONSTRAINT "runners_kind_manual_vps_check" CHECK ("runners"."kind" = 'manual_vps'),
	CONSTRAINT "runners_endpoint_url_not_empty_check" CHECK (length(trim("runners"."endpoint_url")) > 0),
	CONSTRAINT "runners_status_check" CHECK ("runners"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runners_user_status_idx" ON "runners" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_active_user_endpoint_idx" ON "runners" USING btree ("user_id","endpoint_url") WHERE "runners"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;