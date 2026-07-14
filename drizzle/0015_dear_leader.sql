CREATE TYPE "public"."agent_secret_kind" AS ENUM('openrouter_api_key', 'telegram_bot_token', 'telegram_allowed_users', 'api_server_key');--> statement-breakpoint
CREATE TYPE "public"."agent_secret_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "agent_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "agent_secret_kind" NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "agent_secret_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_secrets_ciphertext_not_empty_check" CHECK (length(trim("agent_secrets"."ciphertext")) > 0),
	CONSTRAINT "agent_secrets_iv_not_empty_check" CHECK (length(trim("agent_secrets"."iv")) > 0),
	CONSTRAINT "agent_secrets_auth_tag_not_empty_check" CHECK (length(trim("agent_secrets"."auth_tag")) > 0),
	CONSTRAINT "agent_secrets_key_version_not_empty_check" CHECK (length(trim("agent_secrets"."key_version")) > 0),
	CONSTRAINT "agent_secrets_fingerprint_check" CHECK ("agent_secrets"."fingerprint" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "agent_secrets_revoked_status_check" CHECK (("agent_secrets"."status" = 'revoked' AND "agent_secrets"."revoked_at" IS NOT NULL) OR ("agent_secrets"."status" <> 'revoked' AND "agent_secrets"."revoked_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_secrets_active_agent_kind_idx" ON "agent_secrets" USING btree ("agent_id","kind") WHERE "agent_secrets"."status" = 'active';--> statement-breakpoint
CREATE INDEX "agent_secrets_agent_status_idx" ON "agent_secrets" USING btree ("agent_id","status");