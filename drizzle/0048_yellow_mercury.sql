ALTER TABLE "operator_calendar_connections" ADD COLUMN "evidence_state" "operator_calendar_evidence_state" DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_operator_calendar_connection_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator Calendar connection receipts are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "operator_calendar_connection_receipts_immutable_update"
BEFORE UPDATE ON "operator_calendar_connection_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_operator_calendar_connection_receipt_mutation();
--> statement-breakpoint
CREATE TRIGGER "operator_calendar_connection_receipts_immutable_delete"
BEFORE DELETE ON "operator_calendar_connection_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_operator_calendar_connection_receipt_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_operator_calendar_connection_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.provider_subject_id IS NOT NULL
     AND NEW.provider_subject_id IS DISTINCT FROM OLD.provider_subject_id THEN
    RAISE EXCEPTION 'operator Calendar connection provider identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "operator_calendar_connections_identity_immutable_update"
BEFORE UPDATE OF "provider_subject_id" ON "operator_calendar_connections"
FOR EACH ROW EXECUTE FUNCTION preserve_operator_calendar_connection_identity();
