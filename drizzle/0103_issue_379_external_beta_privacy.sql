CREATE TABLE "founder_external_beta_consent_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"participant_user_id" uuid NOT NULL,
	"participant_operator_id" uuid NOT NULL,
	"workspace_digest" text NOT NULL,
	"purpose" text NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founder_external_beta_consent_receipts_purpose_check" CHECK ("founder_external_beta_consent_receipts"."purpose" IN ('measurement', 'feedback', 'recording', 'testimonial', 'identity', 'name', 'logo', 'quotation', 'case_study')),
	CONSTRAINT "founder_external_beta_consent_receipts_decision_check" CHECK ("founder_external_beta_consent_receipts"."decision" IN ('grant', 'refuse', 'withdraw')),
	CONSTRAINT "founder_external_beta_consent_receipts_workspace_check" CHECK ("founder_external_beta_consent_receipts"."workspace_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "founder_external_beta_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"participant_user_id" uuid NOT NULL,
	"participant_operator_id" uuid NOT NULL,
	"workspace_digest" text NOT NULL,
	"event" text NOT NULL,
	"journey" text,
	"duration_seconds" integer,
	"capability" text,
	"capability_state" text,
	"safe_failure_category" text,
	"evidence_classification" text DEFAULT 'product_hardening' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founder_external_beta_measurements_workspace_check" CHECK ("founder_external_beta_measurements"."workspace_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_external_beta_measurements_event_check" CHECK ("founder_external_beta_measurements"."event" IN ('activation_completed', 'journey_completed', 'journey_timing_recorded', 'capability_state_observed', 'safe_failure_observed', 'support_duration_recorded')),
	CONSTRAINT "founder_external_beta_measurements_journey_check" CHECK ("founder_external_beta_measurements"."journey" IS NULL OR "founder_external_beta_measurements"."journey" IN ('activation', 'operator_setup', 'company_connections', 'morning_brief', 'lead_to_client_loop', 'authority', 'recovery', 'privacy')),
	CONSTRAINT "founder_external_beta_measurements_duration_check" CHECK ("founder_external_beta_measurements"."duration_seconds" IS NULL OR "founder_external_beta_measurements"."duration_seconds" BETWEEN 0 AND 2592000),
	CONSTRAINT "founder_external_beta_measurements_capability_check" CHECK ("founder_external_beta_measurements"."capability" IS NULL OR "founder_external_beta_measurements"."capability" IN ('openai', 'anthropic', 'calendar_reading', 'gmail_reading', 'gmail_sending')),
	CONSTRAINT "founder_external_beta_measurements_capability_state_check" CHECK ("founder_external_beta_measurements"."capability_state" IS NULL OR "founder_external_beta_measurements"."capability_state" IN ('available', 'paused')),
	CONSTRAINT "founder_external_beta_measurements_safe_failure_check" CHECK ("founder_external_beta_measurements"."safe_failure_category" IS NULL OR "founder_external_beta_measurements"."safe_failure_category" IN ('provider_unavailable', 'authorization_required', 'qualification_expired', 'connection_unavailable', 'recovery_exhausted', 'support_required')),
	CONSTRAINT "founder_external_beta_measurements_shape_check" CHECK (("founder_external_beta_measurements"."event" = 'activation_completed' AND "founder_external_beta_measurements"."journey" IS NULL AND "founder_external_beta_measurements"."duration_seconds" IS NULL AND "founder_external_beta_measurements"."capability" IS NULL AND "founder_external_beta_measurements"."capability_state" IS NULL AND "founder_external_beta_measurements"."safe_failure_category" IS NULL) OR ("founder_external_beta_measurements"."event" = 'journey_completed' AND "founder_external_beta_measurements"."journey" IS NOT NULL AND "founder_external_beta_measurements"."duration_seconds" IS NULL AND "founder_external_beta_measurements"."capability" IS NULL AND "founder_external_beta_measurements"."capability_state" IS NULL AND "founder_external_beta_measurements"."safe_failure_category" IS NULL) OR ("founder_external_beta_measurements"."event" = 'journey_timing_recorded' AND "founder_external_beta_measurements"."journey" IS NOT NULL AND "founder_external_beta_measurements"."duration_seconds" IS NOT NULL AND "founder_external_beta_measurements"."capability" IS NULL AND "founder_external_beta_measurements"."capability_state" IS NULL AND "founder_external_beta_measurements"."safe_failure_category" IS NULL) OR ("founder_external_beta_measurements"."event" = 'capability_state_observed' AND "founder_external_beta_measurements"."journey" IS NULL AND "founder_external_beta_measurements"."duration_seconds" IS NULL AND "founder_external_beta_measurements"."capability" IS NOT NULL AND "founder_external_beta_measurements"."capability_state" IS NOT NULL AND "founder_external_beta_measurements"."safe_failure_category" IS NULL) OR ("founder_external_beta_measurements"."event" = 'safe_failure_observed' AND "founder_external_beta_measurements"."journey" IS NULL AND "founder_external_beta_measurements"."duration_seconds" IS NULL AND "founder_external_beta_measurements"."capability" IS NULL AND "founder_external_beta_measurements"."capability_state" IS NULL AND "founder_external_beta_measurements"."safe_failure_category" IS NOT NULL) OR ("founder_external_beta_measurements"."event" = 'support_duration_recorded' AND "founder_external_beta_measurements"."journey" IS NULL AND "founder_external_beta_measurements"."duration_seconds" IS NOT NULL AND "founder_external_beta_measurements"."capability" IS NULL AND "founder_external_beta_measurements"."capability_state" IS NULL AND "founder_external_beta_measurements"."safe_failure_category" IS NULL)),
	CONSTRAINT "founder_external_beta_measurements_classification_check" CHECK ("founder_external_beta_measurements"."evidence_classification" = 'product_hardening')
);
--> statement-breakpoint
CREATE TABLE "founder_external_beta_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"participant_user_id" uuid NOT NULL,
	"participant_operator_id" uuid NOT NULL,
	"workspace_digest" text NOT NULL,
	"artifact_reference_digest" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"deletion_due_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"provider_deletion_verified" boolean DEFAULT false NOT NULL,
	"deletion_receipt_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founder_external_beta_recordings_digest_check" CHECK ("founder_external_beta_recordings"."workspace_digest" ~ '^sha256:[a-f0-9]{64}$' AND "founder_external_beta_recordings"."artifact_reference_digest" ~ '^sha256:[a-f0-9]{64}$' AND ("founder_external_beta_recordings"."deletion_receipt_digest" IS NULL OR "founder_external_beta_recordings"."deletion_receipt_digest" ~ '^sha256:[a-f0-9]{64}$')),
	CONSTRAINT "founder_external_beta_recordings_retention_check" CHECK ("founder_external_beta_recordings"."deletion_due_at" = "founder_external_beta_recordings"."recorded_at" + interval '30 days'),
	CONSTRAINT "founder_external_beta_recordings_state_check" CHECK (("founder_external_beta_recordings"."status" = 'active' AND "founder_external_beta_recordings"."deleted_at" IS NULL AND "founder_external_beta_recordings"."provider_deletion_verified" = false AND "founder_external_beta_recordings"."deletion_receipt_digest" IS NULL) OR ("founder_external_beta_recordings"."status" = 'deleted' AND "founder_external_beta_recordings"."deleted_at" IS NOT NULL AND "founder_external_beta_recordings"."deleted_at" <= "founder_external_beta_recordings"."deletion_due_at" AND "founder_external_beta_recordings"."provider_deletion_verified" = true AND "founder_external_beta_recordings"."deletion_receipt_digest" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "founder_external_beta_consent_receipts" ADD CONSTRAINT "founder_external_beta_consent_receipts_invitation_id_founder_external_beta_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."founder_external_beta_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_consent_receipts" ADD CONSTRAINT "founder_external_beta_consent_receipts_participant_user_id_users_id_fk" FOREIGN KEY ("participant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_consent_receipts" ADD CONSTRAINT "founder_external_beta_consent_receipts_participant_operator_id_operators_id_fk" FOREIGN KEY ("participant_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_measurements" ADD CONSTRAINT "founder_external_beta_measurements_invitation_id_founder_external_beta_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."founder_external_beta_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_measurements" ADD CONSTRAINT "founder_external_beta_measurements_participant_user_id_users_id_fk" FOREIGN KEY ("participant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_measurements" ADD CONSTRAINT "founder_external_beta_measurements_participant_operator_id_operators_id_fk" FOREIGN KEY ("participant_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_recordings" ADD CONSTRAINT "founder_external_beta_recordings_invitation_id_founder_external_beta_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."founder_external_beta_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_recordings" ADD CONSTRAINT "founder_external_beta_recordings_participant_user_id_users_id_fk" FOREIGN KEY ("participant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_recordings" ADD CONSTRAINT "founder_external_beta_recordings_participant_operator_id_operators_id_fk" FOREIGN KEY ("participant_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "founder_external_beta_consent_receipts_latest_idx" ON "founder_external_beta_consent_receipts" USING btree ("invitation_id","purpose","decided_at");--> statement-breakpoint
CREATE INDEX "founder_external_beta_consent_receipts_participant_idx" ON "founder_external_beta_consent_receipts" USING btree ("participant_user_id","participant_operator_id");--> statement-breakpoint
CREATE INDEX "founder_external_beta_measurements_participant_idx" ON "founder_external_beta_measurements" USING btree ("participant_user_id","participant_operator_id","captured_at");--> statement-breakpoint
CREATE INDEX "founder_external_beta_measurements_workspace_idx" ON "founder_external_beta_measurements" USING btree ("workspace_digest","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_external_beta_recordings_reference_idx" ON "founder_external_beta_recordings" USING btree ("artifact_reference_digest");--> statement-breakpoint
CREATE INDEX "founder_external_beta_recordings_retention_idx" ON "founder_external_beta_recordings" USING btree ("status","deletion_due_at");--> statement-breakpoint
CREATE INDEX "founder_external_beta_recordings_participant_idx" ON "founder_external_beta_recordings" USING btree ("participant_user_id","participant_operator_id");
