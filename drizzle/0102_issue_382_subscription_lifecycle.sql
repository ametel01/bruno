ALTER TYPE "public"."founder_product_contract_scenario" ADD VALUE 'subscription_lifecycle' AFTER 'product_entitlement_lifecycle';--> statement-breakpoint
CREATE TYPE "public"."founder_commerce_lifecycle_receipt_kind" AS ENUM('portal_issued', 'cancellation', 'refund');--> statement-breakpoint
CREATE TABLE "founder_commerce_lifecycle_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_event_id" uuid,
	"provider_subscription_id" text NOT NULL,
	"kind" "founder_commerce_lifecycle_receipt_kind" NOT NULL,
	"effective_at" timestamp with time zone,
	"portal_expires_at" timestamp with time zone,
	"evidence_digest" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_commerce_lifecycle_receipts_shape_check" CHECK (("founder_commerce_lifecycle_receipts"."kind" = 'portal_issued' AND "founder_commerce_lifecycle_receipts"."source_event_id" IS NULL AND "founder_commerce_lifecycle_receipts"."effective_at" IS NULL AND "founder_commerce_lifecycle_receipts"."portal_expires_at" IS NOT NULL) OR ("founder_commerce_lifecycle_receipts"."kind" = 'cancellation' AND "founder_commerce_lifecycle_receipts"."source_event_id" IS NOT NULL AND "founder_commerce_lifecycle_receipts"."effective_at" IS NOT NULL AND "founder_commerce_lifecycle_receipts"."portal_expires_at" IS NULL) OR ("founder_commerce_lifecycle_receipts"."kind" = 'refund' AND "founder_commerce_lifecycle_receipts"."source_event_id" IS NOT NULL AND "founder_commerce_lifecycle_receipts"."effective_at" IS NOT NULL AND "founder_commerce_lifecycle_receipts"."portal_expires_at" IS NULL)),
	CONSTRAINT "founder_commerce_lifecycle_receipts_digest_check" CHECK ("founder_commerce_lifecycle_receipts"."evidence_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "founder_commerce_lifecycle_receipts_portal_expiry_check" CHECK ("founder_commerce_lifecycle_receipts"."portal_expires_at" IS NULL OR "founder_commerce_lifecycle_receipts"."portal_expires_at" > "founder_commerce_lifecycle_receipts"."occurred_at")
);
--> statement-breakpoint
ALTER TABLE "founder_commerce_lifecycle_receipts" ADD CONSTRAINT "founder_commerce_lifecycle_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_commerce_lifecycle_receipts" ADD CONSTRAINT "founder_commerce_lifecycle_receipts_source_event_id_founder_commerce_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."founder_commerce_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_commerce_lifecycle_receipts_event_kind_idx" ON "founder_commerce_lifecycle_receipts" USING btree ("source_event_id","kind");--> statement-breakpoint
CREATE INDEX "founder_commerce_lifecycle_receipts_user_created_idx" ON "founder_commerce_lifecycle_receipts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_founder_commerce_lifecycle_receipt_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Founder commerce lifecycle receipts are immutable';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "founder_commerce_lifecycle_receipts_immutable_update"
BEFORE UPDATE ON "founder_commerce_lifecycle_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_founder_commerce_lifecycle_receipt_mutation();--> statement-breakpoint
CREATE TRIGGER "founder_commerce_lifecycle_receipts_immutable_delete"
BEFORE DELETE ON "founder_commerce_lifecycle_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_founder_commerce_lifecycle_receipt_mutation();
