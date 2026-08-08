ALTER TABLE "agent_deployments" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_deployments" ALTER COLUMN "accepted_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
CREATE FUNCTION agent_deployments_preserve_accepted_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' AND NEW.accepted_at IS NULL THEN
		RAISE EXCEPTION 'new agent deployment requires accepted_at'
			USING ERRCODE = '23514', CONSTRAINT = 'agent_deployments_accepted_at_required_check';
	END IF;
	IF TG_OP = 'UPDATE' AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
		RAISE EXCEPTION 'agent deployment accepted_at cannot change'
			USING ERRCODE = '23514', CONSTRAINT = 'agent_deployments_accepted_at_immutable_check';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER agent_deployments_accepted_at_required_trigger
BEFORE INSERT ON agent_deployments
FOR EACH ROW
EXECUTE FUNCTION agent_deployments_preserve_accepted_at();--> statement-breakpoint
CREATE TRIGGER agent_deployments_accepted_at_immutable_trigger
BEFORE UPDATE ON agent_deployments
FOR EACH ROW
EXECUTE FUNCTION agent_deployments_preserve_accepted_at();
