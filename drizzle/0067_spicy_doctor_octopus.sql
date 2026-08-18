CREATE TYPE "public"."operator_mail_sending_authorization_state" AS ENUM('pending', 'authorized', 'denied', 'expired', 'revoked', 'revocation_unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."operator_mail_sending_connection_receipt_kind" AS ENUM('authorized', 'reauthorized', 'verified', 'verification_failed', 'denied', 'revoked', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."operator_mail_sending_connection_status" AS ENUM('authorizing', 'verifying', 'ready', 'needs_attention', 'disconnected');--> statement-breakpoint
CREATE TABLE "operator_mail_sending_connection_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"kind" "operator_mail_sending_connection_receipt_kind" NOT NULL,
	"provider" text DEFAULT 'google_gmail_sending' NOT NULL,
	"provider_subject_id" text,
	"account_label" text,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_mail_sending_connection_receipts_provider_check" CHECK ("operator_mail_sending_connection_receipts"."provider" = 'google_gmail_sending'),
	CONSTRAINT "operator_mail_sending_connection_receipts_generation_check" CHECK ("operator_mail_sending_connection_receipts"."generation" >= 1),
	CONSTRAINT "operator_mail_sending_connection_receipts_digest_check" CHECK ("operator_mail_sending_connection_receipts"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_mail_sending_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"mail_connection_id" uuid,
	"provider" text DEFAULT 'google_gmail_sending' NOT NULL,
	"provider_subject_id" text,
	"account_label" text,
	"status" "operator_mail_sending_connection_status" DEFAULT 'authorizing' NOT NULL,
	"authorization_state" "operator_mail_sending_authorization_state" DEFAULT 'pending' NOT NULL,
	"authorization_session_hash" text,
	"authorization_expires_at" timestamp with time zone,
	"authorization_generation" integer DEFAULT 1 NOT NULL,
	"access_token_ciphertext" text,
	"access_token_iv" text,
	"access_token_auth_tag" text,
	"refresh_token_ciphertext" text,
	"refresh_token_iv" text,
	"refresh_token_auth_tag" text,
	"secret_key_version" text,
	"token_expires_at" timestamp with time zone,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authorized_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"failure_code" text,
	"recovery_message" text,
	"disconnected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_mail_sending_connections_provider_check" CHECK ("operator_mail_sending_connections"."provider" = 'google_gmail_sending'),
	CONSTRAINT "operator_mail_sending_connections_subject_check" CHECK ("operator_mail_sending_connections"."provider_subject_id" IS NULL OR length(trim("operator_mail_sending_connections"."provider_subject_id")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_mail_sending_connections_session_hash_check" CHECK ("operator_mail_sending_connections"."authorization_session_hash" IS NULL OR "operator_mail_sending_connections"."authorization_session_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "operator_mail_sending_connections_generation_check" CHECK ("operator_mail_sending_connections"."authorization_generation" >= 1),
	CONSTRAINT "operator_mail_sending_connections_token_pair_check" CHECK ((
        "operator_mail_sending_connections"."access_token_ciphertext" IS NULL AND "operator_mail_sending_connections"."access_token_iv" IS NULL AND "operator_mail_sending_connections"."access_token_auth_tag" IS NULL
        AND "operator_mail_sending_connections"."refresh_token_ciphertext" IS NULL AND "operator_mail_sending_connections"."refresh_token_iv" IS NULL AND "operator_mail_sending_connections"."refresh_token_auth_tag" IS NULL
        AND "operator_mail_sending_connections"."secret_key_version" IS NULL
      ) OR (
        "operator_mail_sending_connections"."access_token_ciphertext" IS NOT NULL AND "operator_mail_sending_connections"."access_token_iv" IS NOT NULL AND "operator_mail_sending_connections"."access_token_auth_tag" IS NOT NULL
        AND "operator_mail_sending_connections"."refresh_token_ciphertext" IS NOT NULL AND "operator_mail_sending_connections"."refresh_token_iv" IS NOT NULL AND "operator_mail_sending_connections"."refresh_token_auth_tag" IS NOT NULL
        AND "operator_mail_sending_connections"."secret_key_version" IS NOT NULL
      )),
	CONSTRAINT "operator_mail_sending_connections_failure_pair_check" CHECK (("operator_mail_sending_connections"."failure_code" IS NULL AND "operator_mail_sending_connections"."recovery_message" IS NULL) OR ("operator_mail_sending_connections"."failure_code" IS NOT NULL AND "operator_mail_sending_connections"."recovery_message" IS NOT NULL)),
	CONSTRAINT "operator_mail_sending_connections_ready_shape_check" CHECK ("operator_mail_sending_connections"."status" <> 'ready' OR ("operator_mail_sending_connections"."provider_subject_id" IS NOT NULL AND "operator_mail_sending_connections"."account_label" IS NOT NULL AND "operator_mail_sending_connections"."authorization_state" = 'authorized' AND "operator_mail_sending_connections"."authorization_session_hash" IS NULL AND "operator_mail_sending_connections"."access_token_ciphertext" IS NOT NULL AND "operator_mail_sending_connections"."refresh_token_ciphertext" IS NOT NULL AND "operator_mail_sending_connections"."last_verified_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "operator_mail_sending_connection_receipts" ADD CONSTRAINT "operator_mail_sending_connection_receipts_connection_id_operator_mail_sending_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."operator_mail_sending_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_mail_sending_connections" ADD CONSTRAINT "operator_mail_sending_connections_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_mail_sending_connections" ADD CONSTRAINT "operator_mail_sending_connections_mail_connection_id_operator_mail_connections_id_fk" FOREIGN KEY ("mail_connection_id") REFERENCES "public"."operator_mail_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_mail_sending_connection_receipts_generation_idx" ON "operator_mail_sending_connection_receipts" USING btree ("connection_id","generation","kind");--> statement-breakpoint
CREATE INDEX "operator_mail_sending_connection_receipts_created_idx" ON "operator_mail_sending_connection_receipts" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_mail_sending_connections_operator_idx" ON "operator_mail_sending_connections" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_mail_sending_connections_status_idx" ON "operator_mail_sending_connections" USING btree ("status");