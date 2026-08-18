CREATE TYPE "public"."operator_relationship_candidate_match_kind" AS ENUM('exact_provider_identity', 'exact_email', 'fuzzy_name', 'fuzzy_company', 'fuzzy_domain');--> statement-breakpoint
CREATE TYPE "public"."operator_relationship_candidate_status" AS ENUM('pending', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."operator_relationship_evidence_source_kind" AS ENUM('calendar', 'mail');--> statement-breakpoint
CREATE TYPE "public"."operator_relationship_evidence_state" AS ENUM('current', 'stale', 'disconnected', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."operator_relationship_state" AS ENUM('lead', 'client', 'partner', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."operator_relationship_status" AS ENUM('active', 'closed', 'ignored');--> statement-breakpoint
CREATE TABLE "operator_relationship_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"match_kind" "operator_relationship_candidate_match_kind" NOT NULL,
	"status" "operator_relationship_candidate_status" DEFAULT 'pending' NOT NULL,
	"display_name" text NOT NULL,
	"company" text,
	"primary_email" text,
	"provider" text,
	"provider_identity" text,
	"domain" text,
	"candidate_key" text NOT NULL,
	"proposed_record_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_relationship_candidates_display_name_check" CHECK (length(trim("operator_relationship_candidates"."display_name")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_relationship_candidates_status_shape_check" CHECK (("operator_relationship_candidates"."status" = 'pending' AND "operator_relationship_candidates"."resolved_at" IS NULL) OR ("operator_relationship_candidates"."status" <> 'pending' AND "operator_relationship_candidates"."resolved_at" IS NOT NULL)),
	CONSTRAINT "operator_relationship_candidates_provider_check" CHECK (("operator_relationship_candidates"."provider" IS NULL AND "operator_relationship_candidates"."provider_identity" IS NULL) OR ("operator_relationship_candidates"."provider" IS NOT NULL AND "operator_relationship_candidates"."provider_identity" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "operator_relationship_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"field" text NOT NULL,
	"previous_value" jsonb,
	"next_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_relationship_corrections_field_check" CHECK ("operator_relationship_corrections"."field" IN ('relationship_state', 'status', 'next_action', 'next_action_due_at', 'commitments')),
	CONSTRAINT "operator_relationship_corrections_revision_check" CHECK ("operator_relationship_corrections"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "operator_relationship_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"record_id" uuid,
	"candidate_id" uuid,
	"source_kind" "operator_relationship_evidence_source_kind" NOT NULL,
	"calendar_connection_id" uuid,
	"mail_connection_id" uuid,
	"provider" text NOT NULL,
	"provider_item_id" text NOT NULL,
	"provider_identity" text,
	"email" text,
	"display_name" text,
	"company" text,
	"domain" text,
	"excerpt" text,
	"evidence_state" "operator_relationship_evidence_state" DEFAULT 'current' NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_relationship_evidence_source_connection_check" CHECK (("operator_relationship_evidence"."source_kind" = 'calendar' AND "operator_relationship_evidence"."calendar_connection_id" IS NOT NULL AND "operator_relationship_evidence"."mail_connection_id" IS NULL) OR ("operator_relationship_evidence"."source_kind" = 'mail' AND "operator_relationship_evidence"."mail_connection_id" IS NOT NULL AND "operator_relationship_evidence"."calendar_connection_id" IS NULL)),
	CONSTRAINT "operator_relationship_evidence_provider_item_check" CHECK (length(trim("operator_relationship_evidence"."provider_item_id")) BETWEEN 1 AND 500),
	CONSTRAINT "operator_relationship_evidence_display_name_check" CHECK ("operator_relationship_evidence"."display_name" IS NULL OR length(trim("operator_relationship_evidence"."display_name")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_relationship_evidence_excerpt_check" CHECK ("operator_relationship_evidence"."excerpt" IS NULL OR length(trim("operator_relationship_evidence"."excerpt")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "operator_relationship_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"company" text,
	"primary_email" text,
	"provider" text,
	"provider_identity" text,
	"relationship_state" "operator_relationship_state" DEFAULT 'lead' NOT NULL,
	"status" "operator_relationship_status" DEFAULT 'active' NOT NULL,
	"next_action" text,
	"next_action_due_at" timestamp with time zone,
	"commitments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"founder_confirmed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_relationship_records_display_name_check" CHECK (length(trim("operator_relationship_records"."display_name")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_relationship_records_company_check" CHECK ("operator_relationship_records"."company" IS NULL OR length(trim("operator_relationship_records"."company")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_relationship_records_email_check" CHECK ("operator_relationship_records"."primary_email" IS NULL OR length(trim("operator_relationship_records"."primary_email")) BETWEEN 3 AND 320),
	CONSTRAINT "operator_relationship_records_provider_check" CHECK (("operator_relationship_records"."provider" IS NULL AND "operator_relationship_records"."provider_identity" IS NULL) OR ("operator_relationship_records"."provider" IS NOT NULL AND "operator_relationship_records"."provider_identity" IS NOT NULL)),
	CONSTRAINT "operator_relationship_records_revision_check" CHECK ("operator_relationship_records"."revision" >= 1),
	CONSTRAINT "operator_relationship_records_closed_shape_check" CHECK (("operator_relationship_records"."status" = 'active' AND "operator_relationship_records"."closed_at" IS NULL) OR ("operator_relationship_records"."status" <> 'active' AND "operator_relationship_records"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "operator_relationship_candidates" ADD CONSTRAINT "operator_relationship_candidates_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_relationship_candidates" ADD CONSTRAINT "operator_relationship_candidates_proposed_record_id_operator_relationship_records_id_fk" FOREIGN KEY ("proposed_record_id") REFERENCES "public"."operator_relationship_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_relationship_corrections" ADD CONSTRAINT "operator_relationship_corrections_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_relationship_corrections" ADD CONSTRAINT "operator_relationship_corrections_record_id_operator_relationship_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."operator_relationship_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_relationship_evidence" ADD CONSTRAINT "operator_relationship_evidence_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_relationship_evidence" ADD CONSTRAINT "operator_relationship_evidence_record_id_operator_relationship_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."operator_relationship_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_relationship_evidence" ADD CONSTRAINT "operator_relationship_evidence_candidate_id_operator_relationship_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."operator_relationship_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_relationship_evidence" ADD CONSTRAINT "operator_relationship_evidence_calendar_connection_id_operator_calendar_connections_id_fk" FOREIGN KEY ("calendar_connection_id") REFERENCES "public"."operator_calendar_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_relationship_evidence" ADD CONSTRAINT "operator_relationship_evidence_mail_connection_id_operator_mail_connections_id_fk" FOREIGN KEY ("mail_connection_id") REFERENCES "public"."operator_mail_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_relationship_records" ADD CONSTRAINT "operator_relationship_records_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_relationship_candidates_key_idx" ON "operator_relationship_candidates" USING btree ("operator_id","candidate_key");--> statement-breakpoint
CREATE INDEX "operator_relationship_candidates_operator_status_idx" ON "operator_relationship_candidates" USING btree ("operator_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "operator_relationship_corrections_record_idx" ON "operator_relationship_corrections" USING btree ("operator_id","record_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_relationship_evidence_source_fingerprint_idx" ON "operator_relationship_evidence" USING btree ("operator_id","source_fingerprint");--> statement-breakpoint
CREATE INDEX "operator_relationship_evidence_record_idx" ON "operator_relationship_evidence" USING btree ("operator_id","record_id");--> statement-breakpoint
CREATE INDEX "operator_relationship_evidence_candidate_idx" ON "operator_relationship_evidence" USING btree ("operator_id","candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_relationship_records_provider_identity_idx" ON "operator_relationship_records" USING btree ("operator_id","provider","provider_identity") WHERE "operator_relationship_records"."provider_identity" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_relationship_records_primary_email_idx" ON "operator_relationship_records" USING btree ("operator_id","primary_email") WHERE "operator_relationship_records"."primary_email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "operator_relationship_records_operator_status_idx" ON "operator_relationship_records" USING btree ("operator_id","status","updated_at");