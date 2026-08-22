CREATE TABLE "founder_external_beta_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_owner_user_id" uuid NOT NULL,
	"stage_decision_id" uuid NOT NULL,
	"cohort" text NOT NULL,
	"cohort_slot" integer NOT NULL,
	"invitation_digest" text NOT NULL,
	"invited_clerk_subject_digest" text NOT NULL,
	"named_founder_digest" text NOT NULL,
	"workspace_digest" text NOT NULL,
	"independence_evidence_digest" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"participant_user_id" uuid,
	"participant_operator_id" uuid,
	"admission_decision_id" uuid,
	"beta_compact_digest" text,
	"invited_at" timestamp with time zone NOT NULL,
	"invitation_expires_at" timestamp with time zone NOT NULL,
	"admitted_at" timestamp with time zone,
	"access_expires_at" timestamp with time zone,
	"retirement_due_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"payment_method_collected" boolean DEFAULT false NOT NULL,
	"automatic_paid_conversion" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founder_external_beta_invitations_cohort_check" CHECK ("founder_external_beta_invitations"."cohort" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND "founder_external_beta_invitations"."cohort_slot" BETWEEN 1 AND 10),
	CONSTRAINT "founder_external_beta_invitations_digest_check" CHECK ("founder_external_beta_invitations"."invitation_digest" ~ '^sha256:[a-f0-9]{64}$' AND "founder_external_beta_invitations"."invited_clerk_subject_digest" ~ '^sha256:[a-f0-9]{64}$' AND "founder_external_beta_invitations"."named_founder_digest" ~ '^sha256:[a-f0-9]{64}$' AND "founder_external_beta_invitations"."workspace_digest" ~ '^sha256:[a-f0-9]{64}$' AND "founder_external_beta_invitations"."independence_evidence_digest" ~ '^sha256:[a-f0-9]{64}$' AND ("founder_external_beta_invitations"."beta_compact_digest" IS NULL OR "founder_external_beta_invitations"."beta_compact_digest" ~ '^sha256:[a-f0-9]{64}$')),
	CONSTRAINT "founder_external_beta_invitations_exact_windows_check" CHECK ("founder_external_beta_invitations"."invitation_expires_at" = "founder_external_beta_invitations"."invited_at" + interval '7 days' AND ("founder_external_beta_invitations"."admitted_at" IS NULL OR ("founder_external_beta_invitations"."access_expires_at" = "founder_external_beta_invitations"."admitted_at" + interval '14 days' AND "founder_external_beta_invitations"."retirement_due_at" = "founder_external_beta_invitations"."access_expires_at" + interval '1 hour'))),
	CONSTRAINT "founder_external_beta_invitations_free_nonconverting_check" CHECK ("founder_external_beta_invitations"."payment_method_collected" = false AND "founder_external_beta_invitations"."automatic_paid_conversion" = false),
	CONSTRAINT "founder_external_beta_invitations_state_check" CHECK (("founder_external_beta_invitations"."status" = 'invited' AND "founder_external_beta_invitations"."participant_user_id" IS NULL AND "founder_external_beta_invitations"."participant_operator_id" IS NULL AND "founder_external_beta_invitations"."admission_decision_id" IS NULL AND "founder_external_beta_invitations"."beta_compact_digest" IS NULL AND "founder_external_beta_invitations"."admitted_at" IS NULL AND "founder_external_beta_invitations"."access_expires_at" IS NULL AND "founder_external_beta_invitations"."retirement_due_at" IS NULL AND "founder_external_beta_invitations"."expired_at" IS NULL AND "founder_external_beta_invitations"."withdrawn_at" IS NULL) OR ("founder_external_beta_invitations"."status" = 'admitted' AND "founder_external_beta_invitations"."participant_user_id" IS NOT NULL AND "founder_external_beta_invitations"."participant_operator_id" IS NOT NULL AND "founder_external_beta_invitations"."admission_decision_id" IS NOT NULL AND "founder_external_beta_invitations"."beta_compact_digest" IS NOT NULL AND "founder_external_beta_invitations"."admitted_at" IS NOT NULL AND "founder_external_beta_invitations"."access_expires_at" IS NOT NULL AND "founder_external_beta_invitations"."retirement_due_at" IS NOT NULL AND "founder_external_beta_invitations"."expired_at" IS NULL AND "founder_external_beta_invitations"."withdrawn_at" IS NULL) OR ("founder_external_beta_invitations"."status" = 'expired' AND "founder_external_beta_invitations"."participant_user_id" IS NOT NULL AND "founder_external_beta_invitations"."participant_operator_id" IS NOT NULL AND "founder_external_beta_invitations"."admission_decision_id" IS NOT NULL AND "founder_external_beta_invitations"."beta_compact_digest" IS NOT NULL AND "founder_external_beta_invitations"."admitted_at" IS NOT NULL AND "founder_external_beta_invitations"."access_expires_at" IS NOT NULL AND "founder_external_beta_invitations"."retirement_due_at" IS NOT NULL AND "founder_external_beta_invitations"."expired_at" = "founder_external_beta_invitations"."access_expires_at" AND "founder_external_beta_invitations"."withdrawn_at" IS NULL) OR ("founder_external_beta_invitations"."status" = 'withdrawn' AND "founder_external_beta_invitations"."participant_user_id" IS NOT NULL AND "founder_external_beta_invitations"."participant_operator_id" IS NOT NULL AND "founder_external_beta_invitations"."admission_decision_id" IS NOT NULL AND "founder_external_beta_invitations"."beta_compact_digest" IS NOT NULL AND "founder_external_beta_invitations"."admitted_at" IS NOT NULL AND "founder_external_beta_invitations"."access_expires_at" IS NOT NULL AND "founder_external_beta_invitations"."retirement_due_at" IS NOT NULL AND "founder_external_beta_invitations"."expired_at" IS NULL AND "founder_external_beta_invitations"."withdrawn_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD COLUMN "external_beta_cohort" text;--> statement-breakpoint
ALTER TABLE "founder_external_beta_invitations" ADD CONSTRAINT "founder_external_beta_invitations_cohort_owner_user_id_users_id_fk" FOREIGN KEY ("cohort_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_invitations" ADD CONSTRAINT "founder_external_beta_invitations_stage_decision_id_founder_release_decisions_id_fk" FOREIGN KEY ("stage_decision_id") REFERENCES "public"."founder_release_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_invitations" ADD CONSTRAINT "founder_external_beta_invitations_participant_user_id_users_id_fk" FOREIGN KEY ("participant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_invitations" ADD CONSTRAINT "founder_external_beta_invitations_participant_operator_id_operators_id_fk" FOREIGN KEY ("participant_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_external_beta_invitations" ADD CONSTRAINT "founder_external_beta_invitations_admission_decision_id_founder_release_decisions_id_fk" FOREIGN KEY ("admission_decision_id") REFERENCES "public"."founder_release_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_external_beta_invitations_slot_idx" ON "founder_external_beta_invitations" USING btree ("stage_decision_id","cohort_slot");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_external_beta_invitations_digest_idx" ON "founder_external_beta_invitations" USING btree ("invitation_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_external_beta_invitations_clerk_subject_idx" ON "founder_external_beta_invitations" USING btree ("invited_clerk_subject_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_external_beta_invitations_workspace_idx" ON "founder_external_beta_invitations" USING btree ("workspace_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_external_beta_invitations_participant_idx" ON "founder_external_beta_invitations" USING btree ("participant_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_external_beta_invitations_operator_idx" ON "founder_external_beta_invitations" USING btree ("participant_operator_id");--> statement-breakpoint
CREATE INDEX "founder_external_beta_invitations_cohort_status_idx" ON "founder_external_beta_invitations" USING btree ("cohort","status","cohort_slot");--> statement-breakpoint
CREATE INDEX "founder_external_beta_invitations_expiry_idx" ON "founder_external_beta_invitations" USING btree ("status","access_expires_at","retirement_due_at");--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_external_beta_cohort_check" CHECK (("founder_release_decisions"."stage" = 'external_beta' AND "founder_release_decisions"."external_beta_cohort" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') OR ("founder_release_decisions"."stage" <> 'external_beta' AND "founder_release_decisions"."external_beta_cohort" IS NULL));--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_external_beta_manifest_check" CHECK ("founder_release_decisions"."stage" <> 'external_beta' OR (jsonb_array_length("founder_release_decisions"."capability_manifest") = 5 AND "founder_release_decisions"."capability_manifest" @> '["openai", "anthropic", "calendar_reading", "gmail_reading", "gmail_sending"]'::jsonb));
