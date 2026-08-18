CREATE TYPE "public"."operator_calendar_authorization_state" AS ENUM('pending', 'authorized', 'expired', 'revoked', 'revocation_unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."operator_calendar_connection_receipt_kind" AS ENUM('authorized', 'reauthorized', 'verified', 'verification_failed', 'revoked', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."operator_calendar_connection_status" AS ENUM('authorizing', 'selecting', 'verifying', 'ready', 'needs_attention', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."operator_calendar_evidence_state" AS ENUM('unknown', 'current', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."operator_calendar_resource_status" AS ENUM('available', 'removed');--> statement-breakpoint
CREATE TABLE "operator_calendar_connection_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"kind" "operator_calendar_connection_receipt_kind" NOT NULL,
	"provider" text DEFAULT 'google_calendar' NOT NULL,
	"provider_subject_id" text,
	"account_label" text,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_resource_count" integer DEFAULT 0 NOT NULL,
	"selected_resource_digest" text NOT NULL,
	"evidence_state" "operator_calendar_evidence_state" DEFAULT 'unknown' NOT NULL,
	"status" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_calendar_connection_receipts_provider_check" CHECK ("operator_calendar_connection_receipts"."provider" = 'google_calendar'),
	CONSTRAINT "operator_calendar_connection_receipts_subject_check" CHECK ("operator_calendar_connection_receipts"."provider_subject_id" IS NULL OR length(trim("operator_calendar_connection_receipts"."provider_subject_id")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_calendar_connection_receipts_account_label_check" CHECK ("operator_calendar_connection_receipts"."account_label" IS NULL OR length(trim("operator_calendar_connection_receipts"."account_label")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_calendar_connection_receipts_generation_check" CHECK ("operator_calendar_connection_receipts"."generation" >= 1),
	CONSTRAINT "operator_calendar_connection_receipts_count_check" CHECK ("operator_calendar_connection_receipts"."selected_resource_count" >= 0),
	CONSTRAINT "operator_calendar_connection_receipts_digest_check" CHECK ("operator_calendar_connection_receipts"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$' AND "operator_calendar_connection_receipts"."selected_resource_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"provider" text DEFAULT 'google_calendar' NOT NULL,
	"provider_subject_id" text,
	"account_label" text,
	"status" "operator_calendar_connection_status" DEFAULT 'authorizing' NOT NULL,
	"authorization_state" "operator_calendar_authorization_state" DEFAULT 'pending' NOT NULL,
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
	"last_evidence_at" timestamp with time zone,
	"failure_code" text,
	"recovery_message" text,
	"disconnected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_calendar_connections_provider_check" CHECK ("operator_calendar_connections"."provider" = 'google_calendar'),
	CONSTRAINT "operator_calendar_connections_subject_check" CHECK ("operator_calendar_connections"."provider_subject_id" IS NULL OR length(trim("operator_calendar_connections"."provider_subject_id")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_calendar_connections_account_label_check" CHECK ("operator_calendar_connections"."account_label" IS NULL OR length(trim("operator_calendar_connections"."account_label")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_calendar_connections_session_hash_check" CHECK ("operator_calendar_connections"."authorization_session_hash" IS NULL OR "operator_calendar_connections"."authorization_session_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "operator_calendar_connections_generation_check" CHECK ("operator_calendar_connections"."authorization_generation" >= 1),
	CONSTRAINT "operator_calendar_connections_token_pair_check" CHECK ((
        "operator_calendar_connections"."access_token_ciphertext" IS NULL AND "operator_calendar_connections"."access_token_iv" IS NULL AND "operator_calendar_connections"."access_token_auth_tag" IS NULL
        AND "operator_calendar_connections"."refresh_token_ciphertext" IS NULL AND "operator_calendar_connections"."refresh_token_iv" IS NULL AND "operator_calendar_connections"."refresh_token_auth_tag" IS NULL
        AND "operator_calendar_connections"."secret_key_version" IS NULL
      ) OR (
        "operator_calendar_connections"."access_token_ciphertext" IS NOT NULL AND "operator_calendar_connections"."access_token_iv" IS NOT NULL AND "operator_calendar_connections"."access_token_auth_tag" IS NOT NULL
        AND "operator_calendar_connections"."refresh_token_ciphertext" IS NOT NULL AND "operator_calendar_connections"."refresh_token_iv" IS NOT NULL AND "operator_calendar_connections"."refresh_token_auth_tag" IS NOT NULL
        AND "operator_calendar_connections"."secret_key_version" IS NOT NULL
      )),
	CONSTRAINT "operator_calendar_connections_failure_pair_check" CHECK (("operator_calendar_connections"."failure_code" IS NULL AND "operator_calendar_connections"."recovery_message" IS NULL) OR ("operator_calendar_connections"."failure_code" IS NOT NULL AND "operator_calendar_connections"."recovery_message" IS NOT NULL)),
	CONSTRAINT "operator_calendar_connections_ready_shape_check" CHECK ("operator_calendar_connections"."status" <> 'ready' OR ("operator_calendar_connections"."provider_subject_id" IS NOT NULL AND "operator_calendar_connections"."account_label" IS NOT NULL AND "operator_calendar_connections"."authorization_state" = 'authorized' AND "operator_calendar_connections"."authorization_session_hash" IS NULL AND "operator_calendar_connections"."access_token_ciphertext" IS NOT NULL AND "operator_calendar_connections"."refresh_token_ciphertext" IS NOT NULL AND "operator_calendar_connections"."last_verified_at" IS NOT NULL AND "operator_calendar_connections"."last_evidence_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "operator_calendar_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_resource_id" text NOT NULL,
	"summary" text NOT NULL,
	"time_zone" text,
	"access_role" text,
	"primary_calendar" boolean DEFAULT false NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"status" "operator_calendar_resource_status" DEFAULT 'available' NOT NULL,
	"selection_reviewed_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_calendar_resources_provider_id_check" CHECK (length(trim("operator_calendar_resources"."provider_resource_id")) BETWEEN 1 AND 500),
	CONSTRAINT "operator_calendar_resources_summary_check" CHECK (length(trim("operator_calendar_resources"."summary")) BETWEEN 1 AND 500),
	CONSTRAINT "operator_calendar_resources_selection_check" CHECK ("operator_calendar_resources"."selected" = false OR ("operator_calendar_resources"."status" = 'available' AND "operator_calendar_resources"."selection_reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "operator_calendar_connection_receipts" ADD CONSTRAINT "operator_calendar_connection_receipts_connection_id_operator_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."operator_calendar_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_calendar_connections" ADD CONSTRAINT "operator_calendar_connections_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_calendar_resources" ADD CONSTRAINT "operator_calendar_resources_connection_id_operator_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."operator_calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_calendar_connection_receipts_generation_idx" ON "operator_calendar_connection_receipts" USING btree ("connection_id","generation","kind");--> statement-breakpoint
CREATE INDEX "operator_calendar_connection_receipts_created_idx" ON "operator_calendar_connection_receipts" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_calendar_connections_operator_provider_idx" ON "operator_calendar_connections" USING btree ("operator_id","provider");--> statement-breakpoint
CREATE INDEX "operator_calendar_connections_status_idx" ON "operator_calendar_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_calendar_resources_connection_provider_id_idx" ON "operator_calendar_resources" USING btree ("connection_id","provider_resource_id");--> statement-breakpoint
CREATE INDEX "operator_calendar_resources_connection_selected_idx" ON "operator_calendar_resources" USING btree ("connection_id","selected");