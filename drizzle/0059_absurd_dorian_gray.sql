CREATE TYPE "public"."operator_action_preview_state" AS ENUM('draft', 'proposed', 'approved');--> statement-breakpoint
CREATE TABLE "operator_action_preview_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preview_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"state" "operator_action_preview_state" DEFAULT 'draft' NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_address" text NOT NULL,
	"content" text NOT NULL,
	"supporting_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_external_effect" text NOT NULL,
	"supersedes_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_action_preview_revisions_revision_check" CHECK ("operator_action_preview_revisions"."revision" >= 1),
	CONSTRAINT "operator_action_preview_revisions_recipient_name_check" CHECK (length(trim("operator_action_preview_revisions"."recipient_name")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_action_preview_revisions_recipient_address_check" CHECK (length(trim("operator_action_preview_revisions"."recipient_address")) BETWEEN 1 AND 320),
	CONSTRAINT "operator_action_preview_revisions_content_check" CHECK (length(trim("operator_action_preview_revisions"."content")) BETWEEN 1 AND 12000),
	CONSTRAINT "operator_action_preview_revisions_effect_check" CHECK (length(trim("operator_action_preview_revisions"."expected_external_effect")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "operator_action_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_action_preview_revisions" ADD CONSTRAINT "operator_action_preview_revisions_preview_id_operator_action_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."operator_action_previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_action_previews" ADD CONSTRAINT "operator_action_previews_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_action_preview_revisions_identity_idx" ON "operator_action_preview_revisions" USING btree ("preview_id","revision");--> statement-breakpoint
CREATE INDEX "operator_action_preview_revisions_current_idx" ON "operator_action_preview_revisions" USING btree ("preview_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_action_previews_operator_idx" ON "operator_action_previews" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_action_previews_updated_idx" ON "operator_action_previews" USING btree ("operator_id","updated_at");