CREATE TYPE "public"."operator_support_access_grant_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."operator_support_access_scope" AS ENUM('troubleshooting_evidence', 'capability_status', 'recovery_checkpoint');--> statement-breakpoint
CREATE TYPE "public"."operator_support_receipt_kind" AS ENUM('grant_created', 'grant_revoked', 'tool_invoked', 'proposal_created', 'decision_recorded', 'repair_executed');--> statement-breakpoint
CREATE TYPE "public"."operator_support_repair_decision_kind" AS ENUM('approve', 'decline');--> statement-breakpoint
CREATE TYPE "public"."operator_support_repair_kind" AS ENUM('rerun_verification', 'restart_from_checkpoint', 'replace_runtime_from_verified_release', 'rotate_bruno_transport_credential');--> statement-breakpoint
CREATE TYPE "public"."operator_support_repair_state" AS ENUM('proposed', 'approved', 'declined', 'executing', 'succeeded', 'failed', 'outcome_uncertain', 'closed_without_recovery');--> statement-breakpoint
CREATE TABLE "operator_support_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"support_actor_name" text NOT NULL,
	"support_actor_identity" text NOT NULL,
	"support_actor_mfa_verified_at" timestamp with time zone NOT NULL,
	"scope" "operator_support_access_scope" NOT NULL,
	"status" "operator_support_access_grant_status" DEFAULT 'active' NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_support_access_grants_actor_name_check" CHECK (length(trim("operator_support_access_grants"."support_actor_name")) BETWEEN 1 AND 160),
	CONSTRAINT "operator_support_access_grants_actor_identity_check" CHECK (length(trim("operator_support_access_grants"."support_actor_identity")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_support_access_grants_ttl_check" CHECK ("operator_support_access_grants"."expires_at" > "operator_support_access_grants"."granted_at" AND "operator_support_access_grants"."expires_at" <= "operator_support_access_grants"."granted_at" + interval '60 minutes'),
	CONSTRAINT "operator_support_access_grants_revocation_pair_check" CHECK (("operator_support_access_grants"."status" = 'revoked' AND "operator_support_access_grants"."revoked_at" IS NOT NULL) OR ("operator_support_access_grants"."status" <> 'revoked' AND "operator_support_access_grants"."revoked_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "operator_support_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"grant_id" uuid,
	"repair_proposal_id" uuid,
	"kind" "operator_support_receipt_kind" NOT NULL,
	"digest" text NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_support_receipts_digest_check" CHECK ("operator_support_receipts"."digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_support_repair_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" "operator_support_repair_decision_kind" NOT NULL,
	"proposal_digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_support_repair_decisions_digest_check" CHECK ("operator_support_repair_decisions"."proposal_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "operator_support_repair_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"support_actor_name" text NOT NULL,
	"kind" "operator_support_repair_kind" NOT NULL,
	"target" jsonb NOT NULL,
	"proposal_digest" text NOT NULL,
	"state" "operator_support_repair_state" DEFAULT 'proposed' NOT NULL,
	"decision_kind" "operator_support_repair_decision_kind",
	"decided_at" timestamp with time zone,
	"verification" jsonb,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_support_repair_proposals_digest_check" CHECK ("operator_support_repair_proposals"."proposal_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "operator_support_repair_proposals_decision_pair_check" CHECK (("operator_support_repair_proposals"."state" = 'proposed' AND "operator_support_repair_proposals"."decision_kind" IS NULL AND "operator_support_repair_proposals"."decided_at" IS NULL) OR ("operator_support_repair_proposals"."state" <> 'proposed' AND "operator_support_repair_proposals"."decision_kind" IS NOT NULL AND "operator_support_repair_proposals"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "operator_support_tool_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"argument_digest" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_support_tool_invocations_digest_check" CHECK ("operator_support_tool_invocations"."argument_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "operator_support_tool_invocations_tool_check" CHECK ("operator_support_tool_invocations"."tool" IN ('read_troubleshooting_evidence', 'read_capability_status', 'read_recovery_checkpoint'))
);
--> statement-breakpoint
ALTER TABLE "operator_support_access_grants" ADD CONSTRAINT "operator_support_access_grants_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_access_grants" ADD CONSTRAINT "operator_support_access_grants_incident_id_operator_troubleshooting_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."operator_troubleshooting_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_receipts" ADD CONSTRAINT "operator_support_receipts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_receipts" ADD CONSTRAINT "operator_support_receipts_grant_id_operator_support_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."operator_support_access_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_repair_decisions" ADD CONSTRAINT "operator_support_repair_decisions_proposal_id_operator_support_repair_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."operator_support_repair_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_repair_decisions" ADD CONSTRAINT "operator_support_repair_decisions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_repair_proposals" ADD CONSTRAINT "operator_support_repair_proposals_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_repair_proposals" ADD CONSTRAINT "operator_support_repair_proposals_incident_id_operator_troubleshooting_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."operator_troubleshooting_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_repair_proposals" ADD CONSTRAINT "operator_support_repair_proposals_grant_id_operator_support_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."operator_support_access_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_tool_invocations" ADD CONSTRAINT "operator_support_tool_invocations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_support_tool_invocations" ADD CONSTRAINT "operator_support_tool_invocations_grant_id_operator_support_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."operator_support_access_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_support_access_grants_active_incident_idx" ON "operator_support_access_grants" USING btree ("incident_id") WHERE "operator_support_access_grants"."status" = 'active';--> statement-breakpoint
CREATE INDEX "operator_support_access_grants_operator_status_idx" ON "operator_support_access_grants" USING btree ("operator_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "operator_support_receipts_operator_created_idx" ON "operator_support_receipts" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_support_repair_decisions_proposal_idx" ON "operator_support_repair_decisions" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_support_repair_proposals_grant_digest_idx" ON "operator_support_repair_proposals" USING btree ("grant_id","proposal_digest");--> statement-breakpoint
CREATE INDEX "operator_support_repair_proposals_operator_state_idx" ON "operator_support_repair_proposals" USING btree ("operator_id","state","created_at");--> statement-breakpoint
CREATE INDEX "operator_support_tool_invocations_grant_created_idx" ON "operator_support_tool_invocations" USING btree ("grant_id","created_at");