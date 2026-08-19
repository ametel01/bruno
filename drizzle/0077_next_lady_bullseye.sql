CREATE TABLE "operator_founder_data_export_accesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"export_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"format" text NOT NULL,
	"outcome" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_founder_data_export_accesses_format_check" CHECK ("operator_founder_data_export_accesses"."format" IN ('json', 'html')),
	CONSTRAINT "operator_founder_data_export_accesses_outcome_check" CHECK ("operator_founder_data_export_accesses"."outcome" IN ('downloaded', 'expired', 'owner_mismatch'))
);
--> statement-breakpoint
CREATE TABLE "operator_founder_data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_founder_data_exports_token_hash_check" CHECK ("operator_founder_data_exports"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "operator_founder_data_export_accesses" ADD CONSTRAINT "operator_founder_data_export_accesses_export_id_operator_founder_data_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."operator_founder_data_exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_founder_data_exports" ADD CONSTRAINT "operator_founder_data_exports_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_founder_data_export_accesses_export_accessed_idx" ON "operator_founder_data_export_accesses" USING btree ("export_id","accessed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_founder_data_exports_token_hash_idx" ON "operator_founder_data_exports" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "operator_founder_data_exports_operator_expires_idx" ON "operator_founder_data_exports" USING btree ("operator_id","expires_at");