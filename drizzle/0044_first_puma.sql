CREATE TYPE "public"."operator_ai_authorization_state" AS ENUM('pending', 'authorized', 'denied', 'expired', 'revoked', 'revocation_unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."operator_ai_capacity_state" AS ENUM('unknown', 'available', 'exhausted', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."operator_ai_connection_receipt_kind" AS ENUM('authorized', 'reauthorized', 'verification_failed', 'revoked', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."operator_ai_connection_status" AS ENUM('authorizing', 'verifying', 'ready', 'needs_attention', 'paused', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."operator_ai_inference_state" AS ENUM('unknown', 'passed', 'failed');--> statement-breakpoint
CREATE TABLE "operator_ai_connection_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"kind" "operator_ai_connection_receipt_kind" NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"provider_subject_id" text,
	"account_label" text,
	"status" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_ai_connection_receipts_provider_check" CHECK ("operator_ai_connection_receipts"."provider" = 'openai'),
	CONSTRAINT "operator_ai_connection_receipts_subject_check" CHECK ("operator_ai_connection_receipts"."provider_subject_id" IS NULL OR length(trim("operator_ai_connection_receipts"."provider_subject_id")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_ai_connection_receipts_account_label_check" CHECK ("operator_ai_connection_receipts"."account_label" IS NULL OR length(trim("operator_ai_connection_receipts"."account_label")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_ai_connection_receipts_status_check" CHECK ("operator_ai_connection_receipts"."status" IN ('ready', 'needs_attention', 'paused', 'disconnected')),
	CONSTRAINT "operator_ai_connection_receipts_generation_check" CHECK ("operator_ai_connection_receipts"."generation" >= 1),
	CONSTRAINT "operator_ai_connection_receipts_digest_check" CHECK ("operator_ai_connection_receipts"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_ai_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"provider_subject_id" text,
	"account_label" text,
	"status" "operator_ai_connection_status" DEFAULT 'authorizing' NOT NULL,
	"authorization_state" "operator_ai_authorization_state" DEFAULT 'pending' NOT NULL,
	"capacity_state" "operator_ai_capacity_state" DEFAULT 'unknown' NOT NULL,
	"inference_state" "operator_ai_inference_state" DEFAULT 'unknown' NOT NULL,
	"eligible_account" boolean DEFAULT false NOT NULL,
	"authorization_persisted" boolean DEFAULT false NOT NULL,
	"authorization_session_hash" text,
	"authorization_expires_at" timestamp with time zone,
	"approved_model_assignment" text,
	"authorization_generation" integer DEFAULT 1 NOT NULL,
	"authorized_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"failure_code" text,
	"recovery_message" text,
	"work_paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_ai_connections_provider_check" CHECK ("operator_ai_connections"."provider" = 'openai'),
	CONSTRAINT "operator_ai_connections_subject_check" CHECK ("operator_ai_connections"."provider_subject_id" IS NULL OR length(trim("operator_ai_connections"."provider_subject_id")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_ai_connections_account_label_check" CHECK ("operator_ai_connections"."account_label" IS NULL OR length(trim("operator_ai_connections"."account_label")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_ai_connections_session_hash_check" CHECK ("operator_ai_connections"."authorization_session_hash" IS NULL OR "operator_ai_connections"."authorization_session_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "operator_ai_connections_generation_check" CHECK ("operator_ai_connections"."authorization_generation" >= 1),
	CONSTRAINT "operator_ai_connections_failure_pair_check" CHECK (("operator_ai_connections"."failure_code" IS NULL AND "operator_ai_connections"."recovery_message" IS NULL) OR ("operator_ai_connections"."failure_code" IS NOT NULL AND "operator_ai_connections"."recovery_message" IS NOT NULL)),
	CONSTRAINT "operator_ai_connections_ready_shape_check" CHECK ("operator_ai_connections"."status" <> 'ready' OR ("operator_ai_connections"."provider_subject_id" IS NOT NULL AND "operator_ai_connections"."account_label" IS NOT NULL AND "operator_ai_connections"."authorization_state" = 'authorized' AND "operator_ai_connections"."eligible_account" = true AND "operator_ai_connections"."authorization_persisted" = true AND "operator_ai_connections"."approved_model_assignment" IS NOT NULL AND "operator_ai_connections"."capacity_state" = 'available' AND "operator_ai_connections"."inference_state" = 'passed' AND "operator_ai_connections"."last_verified_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "operator_ai_connection_receipts" ADD CONSTRAINT "operator_ai_connection_receipts_connection_id_operator_ai_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."operator_ai_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_ai_connections" ADD CONSTRAINT "operator_ai_connections_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_ai_connection_receipts_generation_idx" ON "operator_ai_connection_receipts" USING btree ("connection_id","generation","kind");--> statement-breakpoint
CREATE INDEX "operator_ai_connection_receipts_created_idx" ON "operator_ai_connection_receipts" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_ai_connections_operator_provider_idx" ON "operator_ai_connections" USING btree ("operator_id","provider");--> statement-breakpoint
CREATE INDEX "operator_ai_connections_status_idx" ON "operator_ai_connections" USING btree ("status");--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_operator_ai_connection_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator AI connection receipts are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "operator_ai_connection_receipts_immutable_update"
BEFORE UPDATE ON "operator_ai_connection_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_operator_ai_connection_receipt_mutation();--> statement-breakpoint
CREATE TRIGGER "operator_ai_connection_receipts_immutable_delete"
BEFORE DELETE ON "operator_ai_connection_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_operator_ai_connection_receipt_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_operator_ai_connection_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.provider_subject_id IS NOT NULL
     AND NEW.provider_subject_id IS DISTINCT FROM OLD.provider_subject_id THEN
    RAISE EXCEPTION 'operator AI connection provider identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "operator_ai_connections_identity_immutable_update"
BEFORE UPDATE OF "provider_subject_id" ON "operator_ai_connections"
FOR EACH ROW EXECUTE FUNCTION preserve_operator_ai_connection_identity();
