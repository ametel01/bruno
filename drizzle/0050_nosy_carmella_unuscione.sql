CREATE TYPE "public"."operator_authority_mode" AS ENUM('always', 'approval_required', 'never');--> statement-breakpoint
CREATE TYPE "public"."operator_governance_receipt_kind" AS ENUM('processing_consent', 'authority_policy');--> statement-breakpoint
CREATE TYPE "public"."operator_limited_operation_status" AS ENUM('awaiting_consent', 'limited', 'needs_attention');--> statement-breakpoint
CREATE TYPE "public"."operator_morning_brief_status" AS ENUM('prepared', 'opened');--> statement-breakpoint
CREATE TYPE "public"."operator_processing_consent_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "operator_authority_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"observation" "operator_authority_mode" DEFAULT 'always' NOT NULL,
	"preparation" "operator_authority_mode" DEFAULT 'always' NOT NULL,
	"external_effects" "operator_authority_mode" DEFAULT 'approval_required' NOT NULL,
	"mail_included" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_authority_policies_version_check" CHECK ("operator_authority_policies"."version" >= 1),
	CONSTRAINT "operator_authority_policies_safe_default_check" CHECK ("operator_authority_policies"."observation" = 'always' AND "operator_authority_policies"."preparation" = 'always' AND "operator_authority_policies"."external_effects" = 'approval_required' AND "operator_authority_policies"."mail_included" = false)
);
--> statement-breakpoint
CREATE TABLE "operator_founder_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"first_brief_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_digest" text NOT NULL,
	CONSTRAINT "operator_founder_activations_digest_check" CHECK ("operator_founder_activations"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_governance_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" "operator_governance_receipt_kind" NOT NULL,
	"processing_consent_id" uuid,
	"authority_policy_id" uuid,
	"evidence_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_governance_receipts_source_check" CHECK (("operator_governance_receipts"."kind" = 'processing_consent' AND "operator_governance_receipts"."processing_consent_id" IS NOT NULL AND "operator_governance_receipts"."authority_policy_id" IS NULL) OR ("operator_governance_receipts"."kind" = 'authority_policy' AND "operator_governance_receipts"."processing_consent_id" IS NULL AND "operator_governance_receipts"."authority_policy_id" IS NOT NULL)),
	CONSTRAINT "operator_governance_receipts_digest_check" CHECK ("operator_governance_receipts"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_limited_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"ai_connection_id" uuid NOT NULL,
	"calendar_connection_id" uuid NOT NULL,
	"processing_consent_id" uuid,
	"authority_policy_id" uuid,
	"status" "operator_limited_operation_status" DEFAULT 'awaiting_consent' NOT NULL,
	"first_brief_id" uuid,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_limited_operations_consent_shape_check" CHECK ("operator_limited_operations"."status" = 'awaiting_consent' OR ("operator_limited_operations"."processing_consent_id" IS NOT NULL AND "operator_limited_operations"."authority_policy_id" IS NOT NULL)),
	CONSTRAINT "operator_limited_operations_activation_shape_check" CHECK ("operator_limited_operations"."activated_at" IS NULL OR "operator_limited_operations"."first_brief_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "operator_morning_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"status" "operator_morning_brief_status" DEFAULT 'prepared' NOT NULL,
	"evidence_state" "operator_calendar_evidence_state" NOT NULL,
	"quiet" boolean NOT NULL,
	"attention_count" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"window_ended_at" timestamp with time zone NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_morning_briefs_generation_check" CHECK ("operator_morning_briefs"."generation" >= 1),
	CONSTRAINT "operator_morning_briefs_attention_count_check" CHECK ("operator_morning_briefs"."attention_count" >= 0),
	CONSTRAINT "operator_morning_briefs_quiet_truth_check" CHECK ("operator_morning_briefs"."quiet" = false OR ("operator_morning_briefs"."evidence_state" = 'current' AND "operator_morning_briefs"."attention_count" = 0)),
	CONSTRAINT "operator_morning_briefs_content_check" CHECK (length(trim("operator_morning_briefs"."content")) BETWEEN 1 AND 12000),
	CONSTRAINT "operator_morning_briefs_window_check" CHECK ("operator_morning_briefs"."window_ended_at" > "operator_morning_briefs"."window_started_at"),
	CONSTRAINT "operator_morning_briefs_opened_status_check" CHECK (("operator_morning_briefs"."status" = 'prepared' AND "operator_morning_briefs"."opened_at" IS NULL) OR ("operator_morning_briefs"."status" = 'opened' AND "operator_morning_briefs"."opened_at" IS NOT NULL)),
	CONSTRAINT "operator_morning_briefs_digest_check" CHECK ("operator_morning_briefs"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_processing_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"ai_connection_id" uuid NOT NULL,
	"calendar_connection_id" uuid NOT NULL,
	"status" "operator_processing_consent_status" DEFAULT 'active' NOT NULL,
	"purpose" text DEFAULT 'calendar_morning_brief' NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_processing_consents_purpose_check" CHECK ("operator_processing_consents"."purpose" = 'calendar_morning_brief'),
	CONSTRAINT "operator_processing_consents_revocation_check" CHECK (("operator_processing_consents"."status" = 'active' AND "operator_processing_consents"."revoked_at" IS NULL) OR ("operator_processing_consents"."status" = 'revoked' AND "operator_processing_consents"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "operator_authority_policies" ADD CONSTRAINT "operator_authority_policies_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_founder_activations" ADD CONSTRAINT "operator_founder_activations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_founder_activations" ADD CONSTRAINT "operator_founder_activations_first_brief_id_operator_morning_briefs_id_fk" FOREIGN KEY ("first_brief_id") REFERENCES "public"."operator_morning_briefs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_governance_receipts" ADD CONSTRAINT "operator_governance_receipts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_governance_receipts" ADD CONSTRAINT "operator_governance_receipts_processing_consent_id_operator_processing_consents_id_fk" FOREIGN KEY ("processing_consent_id") REFERENCES "public"."operator_processing_consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_governance_receipts" ADD CONSTRAINT "operator_governance_receipts_authority_policy_id_operator_authority_policies_id_fk" FOREIGN KEY ("authority_policy_id") REFERENCES "public"."operator_authority_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_limited_operations" ADD CONSTRAINT "operator_limited_operations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_limited_operations" ADD CONSTRAINT "operator_limited_operations_ai_connection_id_operator_ai_connections_id_fk" FOREIGN KEY ("ai_connection_id") REFERENCES "public"."operator_ai_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_limited_operations" ADD CONSTRAINT "operator_limited_operations_calendar_connection_id_operator_calendar_connections_id_fk" FOREIGN KEY ("calendar_connection_id") REFERENCES "public"."operator_calendar_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_limited_operations" ADD CONSTRAINT "operator_limited_operations_processing_consent_id_operator_processing_consents_id_fk" FOREIGN KEY ("processing_consent_id") REFERENCES "public"."operator_processing_consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_limited_operations" ADD CONSTRAINT "operator_limited_operations_authority_policy_id_operator_authority_policies_id_fk" FOREIGN KEY ("authority_policy_id") REFERENCES "public"."operator_authority_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_morning_briefs" ADD CONSTRAINT "operator_morning_briefs_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_morning_briefs" ADD CONSTRAINT "operator_morning_briefs_operation_id_operator_limited_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operator_limited_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_processing_consents" ADD CONSTRAINT "operator_processing_consents_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_processing_consents" ADD CONSTRAINT "operator_processing_consents_ai_connection_id_operator_ai_connections_id_fk" FOREIGN KEY ("ai_connection_id") REFERENCES "public"."operator_ai_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_processing_consents" ADD CONSTRAINT "operator_processing_consents_calendar_connection_id_operator_calendar_connections_id_fk" FOREIGN KEY ("calendar_connection_id") REFERENCES "public"."operator_calendar_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_authority_policies_operator_version_idx" ON "operator_authority_policies" USING btree ("operator_id","version");--> statement-breakpoint
CREATE INDEX "operator_authority_policies_operator_idx" ON "operator_authority_policies" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_founder_activations_operator_idx" ON "operator_founder_activations" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_founder_activations_brief_idx" ON "operator_founder_activations" USING btree ("first_brief_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_governance_receipts_consent_idx" ON "operator_governance_receipts" USING btree ("processing_consent_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_governance_receipts_policy_idx" ON "operator_governance_receipts" USING btree ("authority_policy_id","kind");--> statement-breakpoint
CREATE INDEX "operator_governance_receipts_operator_created_idx" ON "operator_governance_receipts" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_limited_operations_operator_idx" ON "operator_limited_operations" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_limited_operations_status_idx" ON "operator_limited_operations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_morning_briefs_operation_generation_idx" ON "operator_morning_briefs" USING btree ("operation_id","generation");--> statement-breakpoint
CREATE INDEX "operator_morning_briefs_operator_status_idx" ON "operator_morning_briefs" USING btree ("operator_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_processing_consents_connection_pair_idx" ON "operator_processing_consents" USING btree ("operator_id","ai_connection_id","calendar_connection_id");--> statement-breakpoint
CREATE INDEX "operator_processing_consents_status_idx" ON "operator_processing_consents" USING btree ("operator_id","status");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_operator_governance_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator governance receipts are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operator_governance_receipts_immutable_update
BEFORE UPDATE ON operator_governance_receipts
FOR EACH ROW EXECUTE FUNCTION reject_operator_governance_receipt_mutation();
--> statement-breakpoint
CREATE TRIGGER operator_governance_receipts_immutable_delete
BEFORE DELETE ON operator_governance_receipts
FOR EACH ROW EXECUTE FUNCTION reject_operator_governance_receipt_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_operator_founder_activation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator Founder activations are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operator_founder_activations_immutable_update
BEFORE UPDATE ON operator_founder_activations
FOR EACH ROW EXECUTE FUNCTION reject_operator_founder_activation_mutation();
--> statement-breakpoint
CREATE TRIGGER operator_founder_activations_immutable_delete
BEFORE DELETE ON operator_founder_activations
FOR EACH ROW EXECUTE FUNCTION reject_operator_founder_activation_mutation();
