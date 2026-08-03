CREATE TYPE "public"."agent_runtime_reconciliation_state" AS ENUM('observing', 'recovering_stop', 'recovering_start', 'verifying', 'stopping', 'stopped', 'circuit_open');--> statement-breakpoint
CREATE TABLE "agent_runtime_reconciliations" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"state" "agent_runtime_reconciliation_state" NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"config_revision" text NOT NULL,
	"operation_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"recovery_count" integer DEFAULT 0 NOT NULL,
	"recovery_window_started_at" timestamp with time zone,
	"stable_since" timestamp with time zone,
	"telegram_non_connected_since" timestamp with time zone,
	"last_restart_count" integer,
	"last_observed_at" timestamp with time zone,
	"last_ready_at" timestamp with time zone,
	"error_code" text,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"circuit_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtime_reconciliations_generation_check" CHECK ("agent_runtime_reconciliations"."generation" >= 0),
	CONSTRAINT "agent_runtime_reconciliations_attempt_count_check" CHECK ("agent_runtime_reconciliations"."attempt_count" >= 0),
	CONSTRAINT "agent_runtime_reconciliations_recovery_count_check" CHECK ("agent_runtime_reconciliations"."recovery_count" >= 0),
	CONSTRAINT "agent_runtime_reconciliations_restart_count_check" CHECK ("agent_runtime_reconciliations"."last_restart_count" IS NULL OR "agent_runtime_reconciliations"."last_restart_count" >= 0),
	CONSTRAINT "agent_runtime_reconciliations_config_revision_check" CHECK (trim("agent_runtime_reconciliations"."config_revision") = "agent_runtime_reconciliations"."config_revision" AND "agent_runtime_reconciliations"."config_revision" ~ '^[A-Za-z0-9_.:-]{1,80}$'),
	CONSTRAINT "agent_runtime_reconciliations_error_code_check" CHECK ("agent_runtime_reconciliations"."error_code" IS NULL OR "agent_runtime_reconciliations"."error_code" IN ('runtime_runner_unavailable', 'runtime_container_absent', 'runtime_container_terminal', 'runtime_revision_mismatch', 'runtime_restart_policy_mismatch', 'runtime_gateway_unhealthy', 'runtime_api_server_unhealthy', 'runtime_telegram_unhealthy', 'telegram_webhook_conflict', 'telegram_polling_conflict_or_unavailable', 'runtime_secret_unavailable', 'runtime_capacity_blocked', 'runtime_recovery_exhausted', 'runtime_stop_unconfirmed', 'runtime_internal_failure')),
	CONSTRAINT "agent_runtime_reconciliations_lease_owner_check" CHECK ("agent_runtime_reconciliations"."lease_owner" IS NULL OR "agent_runtime_reconciliations"."lease_owner" ~ '^reconcile:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "agent_runtime_reconciliations_lease_pair_check" CHECK (("agent_runtime_reconciliations"."lease_owner" IS NULL AND "agent_runtime_reconciliations"."lease_expires_at" IS NULL) OR ("agent_runtime_reconciliations"."lease_owner" IS NOT NULL AND "agent_runtime_reconciliations"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "agent_runtime_reconciliations_operation_state_check" CHECK ("agent_runtime_reconciliations"."operation_id" IS NULL OR "agent_runtime_reconciliations"."state" IN ('verifying', 'observing')),
	CONSTRAINT "agent_runtime_reconciliations_terminal_work_check" CHECK ("agent_runtime_reconciliations"."state" NOT IN ('stopped', 'circuit_open') OR ("agent_runtime_reconciliations"."next_attempt_at" IS NULL AND "agent_runtime_reconciliations"."lease_owner" IS NULL AND "agent_runtime_reconciliations"."lease_expires_at" IS NULL)),
	CONSTRAINT "agent_runtime_reconciliations_circuit_check" CHECK ("agent_runtime_reconciliations"."state" <> 'circuit_open' OR ("agent_runtime_reconciliations"."circuit_opened_at" IS NOT NULL AND "agent_runtime_reconciliations"."error_code" IS NOT NULL)),
	CONSTRAINT "agent_runtime_reconciliations_stopped_check" CHECK ("agent_runtime_reconciliations"."state" <> 'stopped' OR ("agent_runtime_reconciliations"."operation_id" IS NULL AND "agent_runtime_reconciliations"."error_code" IS NULL AND "agent_runtime_reconciliations"."circuit_opened_at" IS NULL AND "agent_runtime_reconciliations"."next_attempt_at" IS NULL AND "agent_runtime_reconciliations"."lease_owner" IS NULL AND "agent_runtime_reconciliations"."lease_expires_at" IS NULL)),
	CONSTRAINT "agent_runtime_reconciliations_updated_after_created_check" CHECK ("agent_runtime_reconciliations"."updated_at" >= "agent_runtime_reconciliations"."created_at"),
	CONSTRAINT "agent_runtime_reconciliations_last_ready_observed_check" CHECK ("agent_runtime_reconciliations"."last_ready_at" IS NULL OR ("agent_runtime_reconciliations"."last_observed_at" IS NOT NULL AND "agent_runtime_reconciliations"."last_ready_at" <= "agent_runtime_reconciliations"."last_observed_at")),
	CONSTRAINT "agent_runtime_reconciliations_recovery_window_updated_check" CHECK ("agent_runtime_reconciliations"."recovery_window_started_at" IS NULL OR "agent_runtime_reconciliations"."recovery_window_started_at" <= "agent_runtime_reconciliations"."updated_at"),
	CONSTRAINT "agent_runtime_reconciliations_stable_ready_check" CHECK ("agent_runtime_reconciliations"."stable_since" IS NULL OR ("agent_runtime_reconciliations"."last_ready_at" IS NOT NULL AND "agent_runtime_reconciliations"."stable_since" <= "agent_runtime_reconciliations"."last_ready_at")),
	CONSTRAINT "agent_runtime_reconciliations_stable_updated_check" CHECK ("agent_runtime_reconciliations"."stable_since" IS NULL OR "agent_runtime_reconciliations"."stable_since" <= "agent_runtime_reconciliations"."updated_at"),
	CONSTRAINT "agent_runtime_reconciliations_telegram_observed_check" CHECK ("agent_runtime_reconciliations"."telegram_non_connected_since" IS NULL OR ("agent_runtime_reconciliations"."last_observed_at" IS NOT NULL AND "agent_runtime_reconciliations"."telegram_non_connected_since" <= "agent_runtime_reconciliations"."last_observed_at")),
	CONSTRAINT "agent_runtime_reconciliations_observed_updated_check" CHECK ("agent_runtime_reconciliations"."last_observed_at" IS NULL OR "agent_runtime_reconciliations"."last_observed_at" <= "agent_runtime_reconciliations"."updated_at"),
	CONSTRAINT "agent_runtime_reconciliations_ready_updated_check" CHECK ("agent_runtime_reconciliations"."last_ready_at" IS NULL OR "agent_runtime_reconciliations"."last_ready_at" <= "agent_runtime_reconciliations"."updated_at"),
	CONSTRAINT "agent_runtime_reconciliations_circuit_updated_check" CHECK ("agent_runtime_reconciliations"."circuit_opened_at" IS NULL OR "agent_runtime_reconciliations"."circuit_opened_at" <= "agent_runtime_reconciliations"."updated_at")
);
--> statement-breakpoint
ALTER TABLE "agent_runtime_reconciliations" ADD CONSTRAINT "agent_runtime_reconciliations_agent_owner_fk" FOREIGN KEY ("agent_id","user_id") REFERENCES "public"."agents"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runtime_reconciliations_owner_agent_idx" ON "agent_runtime_reconciliations" USING btree ("user_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_runtime_reconciliations_claim_idx" ON "agent_runtime_reconciliations" USING btree ("next_attempt_at","lease_expires_at","updated_at") WHERE "agent_runtime_reconciliations"."state" NOT IN ('stopped', 'circuit_open');--> statement-breakpoint
INSERT INTO "agent_runtime_reconciliations" (
	"agent_id", "user_id", "state", "generation", "config_revision", "operation_id",
	"attempt_count", "recovery_count", "stable_since", "last_observed_at", "last_ready_at",
	"next_attempt_at", "created_at", "updated_at"
)
SELECT
	"agents"."id",
	"agents"."user_id",
	CASE WHEN "agents"."desired_status" = 'running'
		THEN 'observing'::"agent_runtime_reconciliation_state"
		ELSE 'stopped'::"agent_runtime_reconciliation_state" END,
	0,
	"latest_deployment"."config_revision",
	CASE WHEN "agents"."desired_status" = 'running'
		THEN "latest_deployment"."runner_operation_id" ELSE NULL END,
	0,
	0,
	CASE WHEN "agents"."desired_status" = 'running'
		THEN "latest_deployment"."completed_at" ELSE NULL END,
	CASE WHEN "agents"."desired_status" = 'running'
		THEN "latest_deployment"."completed_at" ELSE NULL END,
	CASE WHEN "agents"."desired_status" = 'running'
		THEN "latest_deployment"."completed_at" ELSE NULL END,
	CASE WHEN "agents"."desired_status" = 'running' THEN now() ELSE NULL END,
	now(),
	now()
FROM "agents"
INNER JOIN LATERAL (
	SELECT
		"agent_deployments"."stage",
		"agent_deployments"."config_revision",
		"agent_deployments"."runner_operation_id",
		"agent_deployments"."runner_accepted_at",
		"agent_deployments"."completed_at",
		"agent_deployments"."canary_state",
		"agent_deployments"."canary_attempted_at",
		"agent_deployments"."canary_completed_at"
	FROM "agent_deployments"
	WHERE "agent_deployments"."agent_id" = "agents"."id"
		AND "agent_deployments"."user_id" = "agents"."user_id"
	ORDER BY "agent_deployments"."created_at" DESC, "agent_deployments"."id" DESC
	LIMIT 1
) AS "latest_deployment" ON true
WHERE "agents"."deleted_at" IS NULL
	AND "agents"."runner_id" IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM "runners"
		WHERE "runners"."id" = "agents"."runner_id"
			AND "runners"."user_id" = "agents"."user_id"
			AND "runners"."deleted_at" IS NULL
	)
	AND "agents"."desired_status" IN ('running', 'stopped')
	AND "latest_deployment"."stage" = 'ready'
	AND "latest_deployment"."runner_operation_id" IS NOT NULL
	AND "latest_deployment"."runner_accepted_at" IS NOT NULL
	AND "latest_deployment"."completed_at" IS NOT NULL
	AND "latest_deployment"."canary_state" = 'passed'
	AND "latest_deployment"."canary_attempted_at" IS NOT NULL
	AND "latest_deployment"."canary_completed_at" IS NOT NULL
	AND "latest_deployment"."canary_completed_at" >= "latest_deployment"."canary_attempted_at"
	AND "latest_deployment"."completed_at" >= "latest_deployment"."runner_accepted_at"
	AND "latest_deployment"."completed_at" >= "latest_deployment"."canary_completed_at"
	AND "latest_deployment"."config_revision" ~ '^[A-Za-z0-9_.:-]{1,80}$'
ON CONFLICT ("agent_id") DO NOTHING;
