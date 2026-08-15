CREATE OR REPLACE FUNCTION agent_deployments_preserve_terminal_outcome()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND (
		(
			OLD.stage IN ('ready', 'failed')
			AND (
				NEW.stage IS DISTINCT FROM OLD.stage
				OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
				OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
			)
		)
		OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
		OR (OLD.failed_at IS NOT NULL AND NEW.failed_at IS DISTINCT FROM OLD.failed_at)
	) THEN
		RAISE EXCEPTION 'agent deployment terminal outcome is immutable'
			USING ERRCODE = '23514', CONSTRAINT = 'agent_deployments_terminal_outcome_immutable_check';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_deployments_terminal_outcome_immutable_trigger
BEFORE UPDATE ON agent_deployments
FOR EACH ROW
EXECUTE FUNCTION agent_deployments_preserve_terminal_outcome();
