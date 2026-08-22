CREATE TABLE "founder_trusted_preview_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_owner_user_id" uuid NOT NULL,
	"stage_decision_id" uuid NOT NULL,
	"cohort_slot" integer NOT NULL,
	"invitation_digest" text NOT NULL,
	"invited_clerk_subject_digest" text NOT NULL,
	"service_business_evidence_digest" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"participant_user_id" uuid,
	"participant_operator_id" uuid,
	"admission_decision_id" uuid,
	"invited_at" timestamp with time zone NOT NULL,
	"admitted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founder_trusted_preview_invitations_slot_check" CHECK ("founder_trusted_preview_invitations"."cohort_slot" BETWEEN 1 AND 3),
	CONSTRAINT "founder_trusted_preview_invitations_digest_check" CHECK ("founder_trusted_preview_invitations"."invitation_digest" ~ '^sha256:[a-f0-9]{64}$' AND "founder_trusted_preview_invitations"."invited_clerk_subject_digest" ~ '^sha256:[a-f0-9]{64}$' AND "founder_trusted_preview_invitations"."service_business_evidence_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_trusted_preview_invitations_state_check" CHECK (("founder_trusted_preview_invitations"."status" = 'invited' AND "founder_trusted_preview_invitations"."participant_user_id" IS NULL AND "founder_trusted_preview_invitations"."participant_operator_id" IS NULL AND "founder_trusted_preview_invitations"."admission_decision_id" IS NULL AND "founder_trusted_preview_invitations"."admitted_at" IS NULL AND "founder_trusted_preview_invitations"."revoked_at" IS NULL) OR ("founder_trusted_preview_invitations"."status" = 'admitted' AND "founder_trusted_preview_invitations"."participant_user_id" IS NOT NULL AND "founder_trusted_preview_invitations"."participant_operator_id" IS NOT NULL AND "founder_trusted_preview_invitations"."admission_decision_id" IS NOT NULL AND "founder_trusted_preview_invitations"."admitted_at" IS NOT NULL AND "founder_trusted_preview_invitations"."revoked_at" IS NULL) OR ("founder_trusted_preview_invitations"."status" = 'revoked' AND "founder_trusted_preview_invitations"."participant_user_id" IS NULL AND "founder_trusted_preview_invitations"."participant_operator_id" IS NULL AND "founder_trusted_preview_invitations"."admission_decision_id" IS NULL AND "founder_trusted_preview_invitations"."admitted_at" IS NULL AND "founder_trusted_preview_invitations"."revoked_at" IS NOT NULL)),
	CONSTRAINT "founder_trusted_preview_invitations_owner_participant_check" CHECK ("founder_trusted_preview_invitations"."participant_user_id" IS NULL OR "founder_trusted_preview_invitations"."participant_user_id" <> "founder_trusted_preview_invitations"."cohort_owner_user_id")
);
--> statement-breakpoint
ALTER TABLE "founder_trusted_preview_invitations" ADD CONSTRAINT "founder_trusted_preview_invitations_cohort_owner_user_id_users_id_fk" FOREIGN KEY ("cohort_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_trusted_preview_invitations" ADD CONSTRAINT "founder_trusted_preview_invitations_stage_decision_id_founder_release_decisions_id_fk" FOREIGN KEY ("stage_decision_id") REFERENCES "public"."founder_release_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_trusted_preview_invitations" ADD CONSTRAINT "founder_trusted_preview_invitations_participant_user_id_users_id_fk" FOREIGN KEY ("participant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_trusted_preview_invitations" ADD CONSTRAINT "founder_trusted_preview_invitations_participant_operator_id_operators_id_fk" FOREIGN KEY ("participant_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_trusted_preview_invitations" ADD CONSTRAINT "founder_trusted_preview_invitations_admission_decision_id_founder_release_decisions_id_fk" FOREIGN KEY ("admission_decision_id") REFERENCES "public"."founder_release_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_trusted_preview_invitations_slot_idx" ON "founder_trusted_preview_invitations" USING btree ("cohort_slot");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_trusted_preview_invitations_digest_idx" ON "founder_trusted_preview_invitations" USING btree ("invitation_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_trusted_preview_invitations_clerk_subject_idx" ON "founder_trusted_preview_invitations" USING btree ("invited_clerk_subject_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_trusted_preview_invitations_participant_idx" ON "founder_trusted_preview_invitations" USING btree ("participant_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_trusted_preview_invitations_operator_idx" ON "founder_trusted_preview_invitations" USING btree ("participant_operator_id");--> statement-breakpoint
CREATE INDEX "founder_trusted_preview_invitations_owner_status_idx" ON "founder_trusted_preview_invitations" USING btree ("cohort_owner_user_id","status","cohort_slot");--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_trusted_preview_manifest_check" CHECK ("founder_release_decisions"."stage" <> 'trusted_preview' OR (jsonb_array_length("founder_release_decisions"."capability_manifest") = 2 AND "founder_release_decisions"."capability_manifest" @> '["openai", "calendar_reading"]'::jsonb));--> statement-breakpoint
ALTER TABLE "founder_release_decisions" ADD CONSTRAINT "founder_release_decisions_trusted_preview_qualification_expiry_check" CHECK ("founder_release_decisions"."stage" <> 'trusted_preview' OR "founder_release_decisions"."outcome" NOT IN ('enter', 'resume') OR ("founder_release_decisions"."openai_qualification_expires_at" IS NOT NULL AND "founder_release_decisions"."calendar_qualification_expires_at" IS NOT NULL));
