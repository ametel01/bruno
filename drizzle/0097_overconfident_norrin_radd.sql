CREATE TABLE "founder_preview_qualifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" "founder_release_stage" NOT NULL,
	"cohort" text NOT NULL,
	"capability" text NOT NULL,
	"application_revision" text NOT NULL,
	"runtime_revision" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founder_preview_qualifications_external_beta_stage_check" CHECK ("founder_preview_qualifications"."stage" = 'external_beta'),
	CONSTRAINT "founder_preview_qualifications_cohort_check" CHECK ("founder_preview_qualifications"."cohort" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	CONSTRAINT "founder_preview_qualifications_capability_check" CHECK ("founder_preview_qualifications"."capability" IN ('openai', 'anthropic', 'calendar_reading', 'gmail_reading', 'gmail_sending')),
	CONSTRAINT "founder_preview_qualifications_application_revision_check" CHECK ("founder_preview_qualifications"."application_revision" ~ '^[a-f0-9]{40}$'),
	CONSTRAINT "founder_preview_qualifications_runtime_revision_check" CHECK (length(trim("founder_preview_qualifications"."runtime_revision")) > 0),
	CONSTRAINT "founder_preview_qualifications_evidence_digest_check" CHECK ("founder_preview_qualifications"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_preview_qualifications_time_check" CHECK ("founder_preview_qualifications"."observed_at" < "founder_preview_qualifications"."expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "founder_preview_qualifications_evidence_idx" ON "founder_preview_qualifications" USING btree ("stage","cohort","application_revision","runtime_revision","capability","evidence_digest");--> statement-breakpoint
CREATE INDEX "founder_preview_qualifications_candidate_idx" ON "founder_preview_qualifications" USING btree ("stage","cohort","application_revision","runtime_revision","capability","observed_at");