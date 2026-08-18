CREATE TYPE "public"."operator_action_decision_kind" AS ENUM('approve', 'request_changes', 'decline');--> statement-breakpoint
CREATE TYPE "public"."operator_action_family" AS ENUM('observe_evidence', 'relationship_maintenance', 'prepare_work', 'external_communication', 'meeting_management', 'commercial_commitment', 'data_control');--> statement-breakpoint
CREATE TYPE "public"."operator_proposed_action_state" AS ENUM('proposed', 'awaiting_approval', 'authorized', 'executing', 'succeeded', 'failed', 'outcome_uncertain', 'declined', 'expired', 'superseded', 'cancelled', 'blocked');--> statement-breakpoint
CREATE TABLE "operator_action_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"proposed_action_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_action_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"proposed_action_id" uuid NOT NULL,
	"proposed_action_version" integer NOT NULL,
	"kind" "operator_action_decision_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_product_guardrails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"blocked_action_families" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_subtypes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_product_guardrails_version_check" CHECK ("operator_product_guardrails"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "operator_proposed_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"supersedes_action_id" uuid,
	"action_family" "operator_action_family" NOT NULL,
	"action_subtype" text,
	"business_outcome" text NOT NULL,
	"company_connection_id" uuid,
	"connection_resource_id" uuid,
	"destination" jsonb NOT NULL,
	"material_content" jsonb NOT NULL,
	"side_effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processing_consent_id" uuid,
	"authority_policy_id" uuid,
	"authority_policy_version" integer NOT NULL,
	"authority_mode" "operator_authority_mode" NOT NULL,
	"product_guardrails_version" integer DEFAULT 1 NOT NULL,
	"preconditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"execution_window_start" timestamp with time zone,
	"execution_window_end" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"state" "operator_proposed_action_state" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_proposed_actions_version_check" CHECK ("operator_proposed_actions"."version" >= 1),
	CONSTRAINT "operator_proposed_actions_business_outcome_check" CHECK (length(trim("operator_proposed_actions"."business_outcome")) BETWEEN 1 AND 2000),
	CONSTRAINT "operator_proposed_actions_validity_check" CHECK ("operator_proposed_actions"."execution_window_start" IS NULL OR "operator_proposed_actions"."execution_window_end" IS NULL OR "operator_proposed_actions"."execution_window_start" < "operator_proposed_actions"."execution_window_end")
);
--> statement-breakpoint
ALTER TABLE "operator_authority_policies" ADD COLUMN "action_families" jsonb DEFAULT '{"observe_evidence":"always","relationship_maintenance":"always","prepare_work":"always","external_communication":"approval_required","meeting_management":"approval_required","commercial_commitment":"approval_required","data_control":"approval_required"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_processing_consents" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_action_authorizations" ADD CONSTRAINT "operator_action_authorizations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_authorizations" ADD CONSTRAINT "operator_action_authorizations_proposed_action_id_operator_proposed_actions_id_fk" FOREIGN KEY ("proposed_action_id") REFERENCES "public"."operator_proposed_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_authorizations" ADD CONSTRAINT "operator_action_authorizations_decision_id_operator_action_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."operator_action_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_decisions" ADD CONSTRAINT "operator_action_decisions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_decisions" ADD CONSTRAINT "operator_action_decisions_proposed_action_id_operator_proposed_actions_id_fk" FOREIGN KEY ("proposed_action_id") REFERENCES "public"."operator_proposed_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_product_guardrails" ADD CONSTRAINT "operator_product_guardrails_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_proposed_actions" ADD CONSTRAINT "operator_proposed_actions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_action_authorizations_proposed_action_idx" ON "operator_action_authorizations" USING btree ("proposed_action_id");--> statement-breakpoint
CREATE INDEX "operator_action_authorizations_operator_idx" ON "operator_action_authorizations" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_action_decisions_proposed_action_idx" ON "operator_action_decisions" USING btree ("proposed_action_id");--> statement-breakpoint
CREATE INDEX "operator_action_decisions_operator_created_idx" ON "operator_action_decisions" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_product_guardrails_operator_version_idx" ON "operator_product_guardrails" USING btree ("operator_id","version");--> statement-breakpoint
CREATE INDEX "operator_product_guardrails_operator_idx" ON "operator_product_guardrails" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_proposed_actions_operator_version_idx" ON "operator_proposed_actions" USING btree ("operator_id","id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_proposed_actions_idempotency_idx" ON "operator_proposed_actions" USING btree ("operator_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "operator_proposed_actions_operator_state_idx" ON "operator_proposed_actions" USING btree ("operator_id","state","updated_at");--> statement-breakpoint
ALTER TABLE "operator_processing_consents" ADD CONSTRAINT "operator_processing_consents_version_check" CHECK ("operator_processing_consents"."version" >= 1);