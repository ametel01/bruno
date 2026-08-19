CREATE TYPE "public"."operator_action_execution_attempt_phase" AS ENUM('started', 'acknowledged', 'rejected', 'ambiguous');--> statement-breakpoint
CREATE TYPE "public"."operator_action_receipt_outcome" AS ENUM('succeeded', 'failed', 'outcome_uncertain');--> statement-breakpoint
CREATE TABLE "operator_action_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"proposed_action_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"phase" "operator_action_execution_attempt_phase" NOT NULL,
	"provider" text DEFAULT 'google_gmail_sending' NOT NULL,
	"message_identity" text NOT NULL,
	"provider_message_id" text,
	"provider_thread_id" text,
	"request_digest" text,
	"response_digest" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_action_execution_attempts_attempt_check" CHECK ("operator_action_execution_attempts"."attempt_number" >= 1),
	CONSTRAINT "operator_action_execution_attempts_provider_check" CHECK ("operator_action_execution_attempts"."provider" = 'google_gmail_sending'),
	CONSTRAINT "operator_action_execution_attempts_identity_check" CHECK (length(trim("operator_action_execution_attempts"."message_identity")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_action_execution_attempts_request_digest_check" CHECK ("operator_action_execution_attempts"."request_digest" IS NULL OR "operator_action_execution_attempts"."request_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "operator_action_execution_attempts_response_digest_check" CHECK ("operator_action_execution_attempts"."response_digest" IS NULL OR "operator_action_execution_attempts"."response_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_action_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"proposed_action_id" uuid NOT NULL,
	"proposed_action_version" integer NOT NULL,
	"authority_policy_id" uuid,
	"authority_policy_version" integer NOT NULL,
	"decision_id" uuid,
	"authorization_id" uuid NOT NULL,
	"provider" text DEFAULT 'google_gmail_sending' NOT NULL,
	"provider_connection_id" uuid NOT NULL,
	"provider_connection_generation" integer NOT NULL,
	"connection_access_version" integer,
	"connection_resource_id" uuid,
	"processing_consent_id" uuid,
	"message_identity" text NOT NULL,
	"content_digest" text NOT NULL,
	"destination_digest" text NOT NULL,
	"provider_message_id" text,
	"provider_thread_id" text,
	"attempt_count" integer NOT NULL,
	"outcome" "operator_action_receipt_outcome" NOT NULL,
	"outcome_reason" text,
	"acknowledged_at" timestamp with time zone,
	"evidence_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_action_receipts_version_check" CHECK ("operator_action_receipts"."proposed_action_version" >= 1),
	CONSTRAINT "operator_action_receipts_policy_version_check" CHECK ("operator_action_receipts"."authority_policy_version" >= 1),
	CONSTRAINT "operator_action_receipts_generation_check" CHECK ("operator_action_receipts"."provider_connection_generation" >= 1),
	CONSTRAINT "operator_action_receipts_attempt_count_check" CHECK ("operator_action_receipts"."attempt_count" >= 1),
	CONSTRAINT "operator_action_receipts_provider_check" CHECK ("operator_action_receipts"."provider" = 'google_gmail_sending'),
	CONSTRAINT "operator_action_receipts_identity_check" CHECK (length(trim("operator_action_receipts"."message_identity")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_action_receipts_content_digest_check" CHECK ("operator_action_receipts"."content_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "operator_action_receipts_destination_digest_check" CHECK ("operator_action_receipts"."destination_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "operator_action_receipts_evidence_digest_check" CHECK ("operator_action_receipts"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "operator_action_receipts_ack_pair_check" CHECK (("operator_action_receipts"."outcome" = 'succeeded' AND "operator_action_receipts"."provider_message_id" IS NOT NULL AND "operator_action_receipts"."acknowledged_at" IS NOT NULL) OR ("operator_action_receipts"."outcome" <> 'succeeded' AND "operator_action_receipts"."acknowledged_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "operator_action_execution_attempts" ADD CONSTRAINT "operator_action_execution_attempts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_execution_attempts" ADD CONSTRAINT "operator_action_execution_attempts_proposed_action_id_operator_proposed_actions_id_fk" FOREIGN KEY ("proposed_action_id") REFERENCES "public"."operator_proposed_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_execution_attempts" ADD CONSTRAINT "operator_action_execution_attempts_authorization_id_operator_action_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."operator_action_authorizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_receipts" ADD CONSTRAINT "operator_action_receipts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_receipts" ADD CONSTRAINT "operator_action_receipts_proposed_action_id_operator_proposed_actions_id_fk" FOREIGN KEY ("proposed_action_id") REFERENCES "public"."operator_proposed_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_receipts" ADD CONSTRAINT "operator_action_receipts_authority_policy_id_operator_authority_policies_id_fk" FOREIGN KEY ("authority_policy_id") REFERENCES "public"."operator_authority_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_receipts" ADD CONSTRAINT "operator_action_receipts_decision_id_operator_action_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."operator_action_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_receipts" ADD CONSTRAINT "operator_action_receipts_authorization_id_operator_action_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."operator_action_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_receipts" ADD CONSTRAINT "operator_action_receipts_provider_connection_id_operator_mail_sending_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."operator_mail_sending_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_action_execution_attempts_phase_idx" ON "operator_action_execution_attempts" USING btree ("proposed_action_id","attempt_number","phase");--> statement-breakpoint
CREATE INDEX "operator_action_execution_attempts_action_idx" ON "operator_action_execution_attempts" USING btree ("proposed_action_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_action_receipts_action_idx" ON "operator_action_receipts" USING btree ("proposed_action_id");--> statement-breakpoint
CREATE INDEX "operator_action_receipts_operator_created_idx" ON "operator_action_receipts" USING btree ("operator_id","created_at");