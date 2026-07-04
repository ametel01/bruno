CREATE TABLE "runner_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"credential_hash" text NOT NULL,
	"credential_prefix" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_credentials_hash_not_empty_check" CHECK (length(trim("runner_credentials"."credential_hash")) > 0),
	CONSTRAINT "runner_credentials_prefix_not_empty_check" CHECK (length(trim("runner_credentials"."credential_prefix")) > 0),
	CONSTRAINT "runner_credentials_status_check" CHECK ("runner_credentials"."status" IN ('active', 'revoked')),
	CONSTRAINT "runner_credentials_revoked_status_check" CHECK (("runner_credentials"."status" = 'revoked' AND "runner_credentials"."revoked_at" IS NOT NULL) OR ("runner_credentials"."status" <> 'revoked' AND "runner_credentials"."revoked_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "runner_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"status" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_heartbeats_status_check" CHECK ("runner_heartbeats"."status" IN ('online', 'offline', 'degraded'))
);
--> statement-breakpoint
CREATE TABLE "runner_registration_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runner_id" uuid,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_registration_tokens_hash_not_empty_check" CHECK (length(trim("runner_registration_tokens"."token_hash")) > 0),
	CONSTRAINT "runner_registration_tokens_prefix_not_empty_check" CHECK (length(trim("runner_registration_tokens"."token_prefix")) > 0),
	CONSTRAINT "runner_registration_tokens_status_check" CHECK ("runner_registration_tokens"."status" IN ('pending', 'used', 'revoked', 'expired')),
	CONSTRAINT "runner_registration_tokens_used_status_check" CHECK (("runner_registration_tokens"."status" = 'used' AND "runner_registration_tokens"."used_at" IS NOT NULL AND "runner_registration_tokens"."runner_id" IS NOT NULL) OR ("runner_registration_tokens"."status" <> 'used' AND "runner_registration_tokens"."used_at" IS NULL)),
	CONSTRAINT "runner_registration_tokens_revoked_status_check" CHECK (("runner_registration_tokens"."status" = 'revoked' AND "runner_registration_tokens"."revoked_at" IS NOT NULL) OR ("runner_registration_tokens"."status" <> 'revoked' AND "runner_registration_tokens"."revoked_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "runners" DROP CONSTRAINT "runners_status_check";--> statement-breakpoint
ALTER TABLE "runner_credentials" ADD CONSTRAINT "runner_credentials_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_heartbeats" ADD CONSTRAINT "runner_heartbeats_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_registration_tokens" ADD CONSTRAINT "runner_registration_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_registration_tokens" ADD CONSTRAINT "runner_registration_tokens_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_credentials_hash_idx" ON "runner_credentials" USING btree ("credential_hash");--> statement-breakpoint
CREATE INDEX "runner_credentials_runner_status_idx" ON "runner_credentials" USING btree ("runner_id","status");--> statement-breakpoint
CREATE INDEX "runner_heartbeats_runner_observed_idx" ON "runner_heartbeats" USING btree ("runner_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_registration_tokens_hash_idx" ON "runner_registration_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "runner_registration_tokens_user_status_expires_idx" ON "runner_registration_tokens" USING btree ("user_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "runner_registration_tokens_runner_idx" ON "runner_registration_tokens" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "agents_runner_id_idx" ON "agents" USING btree ("runner_id");--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_status_check" CHECK ("runners"."status" IN ('active', 'inactive', 'registering', 'online', 'offline', 'degraded', 'provisioning', 'provision_failed', 'deleting', 'deleted'));