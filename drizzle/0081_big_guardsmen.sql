CREATE TYPE "public"."operator_troubleshooting_evidence_kind" AS ENUM('recovery_summary', 'capability_impact', 'safe_action');--> statement-breakpoint
CREATE TYPE "public"."operator_troubleshooting_incident_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "operator_troubleshooting_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" "operator_troubleshooting_evidence_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"evidence_digest" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_troubleshooting_evidence_digest_check" CHECK ("operator_troubleshooting_evidence"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_troubleshooting_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"recovery_capability" text NOT NULL,
	"recovery_state" text DEFAULT 'recovery_exhausted' NOT NULL,
	"attempt_count" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"max_elapsed_ms" integer NOT NULL,
	"impact_summary" text NOT NULL,
	"affected_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unaffected_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deduplication_key" text NOT NULL,
	"status" "operator_troubleshooting_incident_status" DEFAULT 'open' NOT NULL,
	"support_case_approved_at" timestamp with time zone,
	"support_case_closed_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_troubleshooting_incidents_capability_check" CHECK ("operator_troubleshooting_incidents"."recovery_capability" IN ('ai', 'calendar', 'mail', 'mail_sending', 'brief', 'conversation', 'external_effect')),
	CONSTRAINT "operator_troubleshooting_incidents_state_check" CHECK ("operator_troubleshooting_incidents"."recovery_state" = 'recovery_exhausted'),
	CONSTRAINT "operator_troubleshooting_incidents_budget_check" CHECK ("operator_troubleshooting_incidents"."attempt_count" >= 0 AND "operator_troubleshooting_incidents"."max_attempts" >= 1 AND "operator_troubleshooting_incidents"."elapsed_ms" >= 0 AND "operator_troubleshooting_incidents"."max_elapsed_ms" >= 1),
	CONSTRAINT "operator_troubleshooting_incidents_status_pair_check" CHECK (("operator_troubleshooting_incidents"."status" = 'open' AND "operator_troubleshooting_incidents"."closed_at" IS NULL) OR ("operator_troubleshooting_incidents"."status" = 'closed' AND "operator_troubleshooting_incidents"."closed_at" IS NOT NULL)),
	CONSTRAINT "operator_troubleshooting_incidents_case_pair_check" CHECK ("operator_troubleshooting_incidents"."support_case_closed_at" IS NULL OR ("operator_troubleshooting_incidents"."support_case_approved_at" IS NOT NULL AND "operator_troubleshooting_incidents"."support_case_closed_at" >= "operator_troubleshooting_incidents"."support_case_approved_at"))
);
--> statement-breakpoint
ALTER TABLE "operator_troubleshooting_evidence" ADD CONSTRAINT "operator_troubleshooting_evidence_incident_id_operator_troubleshooting_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."operator_troubleshooting_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_troubleshooting_incidents" ADD CONSTRAINT "operator_troubleshooting_incidents_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_troubleshooting_evidence_incident_kind_idx" ON "operator_troubleshooting_evidence" USING btree ("incident_id","kind");--> statement-breakpoint
CREATE INDEX "operator_troubleshooting_evidence_expiry_idx" ON "operator_troubleshooting_evidence" USING btree ("incident_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_troubleshooting_incidents_dedup_idx" ON "operator_troubleshooting_incidents" USING btree ("operator_id","deduplication_key");--> statement-breakpoint
CREATE INDEX "operator_troubleshooting_incidents_operator_status_idx" ON "operator_troubleshooting_incidents" USING btree ("operator_id","status","updated_at");