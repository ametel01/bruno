DROP INDEX "operator_mail_connection_receipts_generation_idx";--> statement-breakpoint
CREATE INDEX "operator_mail_connection_receipts_generation_idx" ON "operator_mail_connection_receipts" USING btree ("connection_id","generation","kind");--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_operator_mail_receipt_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'operator mail connection receipts are immutable';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER operator_mail_connection_receipts_immutable_update
BEFORE UPDATE ON operator_mail_connection_receipts
FOR EACH ROW EXECUTE FUNCTION reject_operator_mail_receipt_mutation();--> statement-breakpoint
CREATE TRIGGER operator_mail_connection_receipts_immutable_delete
BEFORE DELETE ON operator_mail_connection_receipts
FOR EACH ROW EXECUTE FUNCTION reject_operator_mail_receipt_mutation();
