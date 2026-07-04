import { readFile } from "node:fs/promises";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agentConfigs,
  agentApprovals,
  agentApprovalStatusEnum,
  agentEvents,
  agentLogs,
  agentScheduleModeEnum,
  agents,
  agentStatusEnum,
  appMetadata,
  dockerRunnerContainers,
  localRunnerProcesses,
  localRunnerProcessStatusEnum,
  users,
} from "@/src/server/db/schema";

describe("Milestone 1 agent persistence schema", () => {
  it("defines the expected tables and agent status values", () => {
    expect(getTableName(appMetadata)).toBe("app_metadata");
    expect(getTableName(users)).toBe("users");
    expect(getTableName(agents)).toBe("agents");
    expect(getTableName(agentConfigs)).toBe("agent_configs");
    expect(getTableName(agentApprovals)).toBe("agent_approvals");
    expect(getTableName(agentEvents)).toBe("agent_events");
    expect(getTableName(localRunnerProcesses)).toBe("local_runner_processes");
    expect(getTableName(dockerRunnerContainers)).toBe("docker_runner_containers");
    expect(getTableName(agentLogs)).toBe("agent_logs");
    expect(agentStatusEnum.enumValues).toEqual([
      "idle",
      "starting",
      "running",
      "stopped",
      "restarting",
      "error",
      "deleting",
    ]);
    expect(agentScheduleModeEnum.enumValues).toEqual(["manual", "cron"]);
    expect(agentApprovalStatusEnum.enumValues).toEqual([
      "pending",
      "approved",
      "denied",
      "expired",
      "cancelled",
    ]);
    expect(localRunnerProcessStatusEnum.enumValues).toEqual([
      "starting",
      "running",
      "stopped",
      "exited",
      "failed",
    ]);
  });

  it("keeps agent records owned, stopped by default, timestamped, and soft deletable", () => {
    const columns = getTableColumns(agents);

    expect(Object.keys(columns)).toEqual([
      "id",
      "userId",
      "name",
      "templateKey",
      "status",
      "statusReason",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]);
    expect(columns.userId.notNull).toBe(true);
    expect(columns.name.notNull).toBe(true);
    expect(columns.templateKey.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("stopped");
    expect(columns.statusReason.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(columns.deletedAt.notNull).toBe(false);
  });

  it("defines one typed config row per agent with safe non-secret defaults", () => {
    const columns = getTableColumns(agentConfigs);

    expect(Object.keys(columns)).toEqual([
      "agentId",
      "systemPrompt",
      "modelProvider",
      "modelName",
      "maxDailySpendCents",
      "scheduleMode",
      "scheduleCron",
      "timezone",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.systemPrompt.notNull).toBe(true);
    expect(columns.modelProvider.notNull).toBe(true);
    expect(columns.modelProvider.default).toBe("not_configured");
    expect(columns.modelName.notNull).toBe(true);
    expect(columns.modelName.default).toBe("not_configured");
    expect(columns.maxDailySpendCents.notNull).toBe(true);
    expect(columns.maxDailySpendCents.default).toBe(0);
    expect(columns.maxDailySpendCents.dataType).toBe("number");
    expect(columns.scheduleMode.notNull).toBe(true);
    expect(columns.scheduleMode.default).toBe("manual");
    expect(columns.scheduleCron.notNull).toBe(false);
    expect(columns.timezone.notNull).toBe(true);
    expect(columns.timezone.default).toBe("UTC");
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });

  it("supports agent.created audit event rows with JSON metadata", () => {
    const columns = getTableColumns(agentEvents);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "actorUserId",
      "type",
      "message",
      "metadata",
      "createdAt",
    ]);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.actorUserId.notNull).toBe(true);
    expect(columns.type.notNull).toBe(true);
    expect(columns.message.notNull).toBe(true);
    expect(columns.metadata.notNull).toBe(true);
    expect(columns.metadata.dataType).toBe("json");
    expect(columns.createdAt.notNull).toBe(true);
  });

  it("defines durable agent log rows scoped by agent and sequence", () => {
    const columns = getTableColumns(agentLogs);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "runnerId",
      "localRunnerProcessId",
      "dockerRunnerContainerId",
      "source",
      "stream",
      "level",
      "message",
      "metadata",
      "sequence",
      "createdAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(false);
    expect(columns.localRunnerProcessId.notNull).toBe(false);
    expect(columns.dockerRunnerContainerId.notNull).toBe(false);
    expect(columns.source.notNull).toBe(true);
    expect(columns.source.default).toBe("simulator");
    expect(columns.stream.notNull).toBe(true);
    expect(columns.level.notNull).toBe(true);
    expect(columns.message.notNull).toBe(true);
    expect(columns.metadata.notNull).toBe(true);
    expect(columns.metadata.dataType).toBe("json");
    expect(columns.sequence.notNull).toBe(true);
    expect(columns.sequence.dataType).toBe("number");
    expect(columns.createdAt.notNull).toBe(true);
  });

  it("defines Docker runner container metadata rows scoped to agents", () => {
    const columns = getTableColumns(dockerRunnerContainers);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "containerId",
      "containerName",
      "image",
      "observedStatus",
      "metadata",
      "observedAt",
      "startedAt",
      "finishedAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.containerId.notNull).toBe(true);
    expect(columns.containerName.notNull).toBe(true);
    expect(columns.image.notNull).toBe(true);
    expect(columns.observedStatus.notNull).toBe(true);
    expect(columns.metadata.notNull).toBe(true);
    expect(columns.metadata.dataType).toBe("json");
    expect(columns.observedAt.notNull).toBe(true);
    expect(columns.startedAt.notNull).toBe(false);
    expect(columns.finishedAt.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });

  it("defines local runner process metadata rows scoped to agents", () => {
    const columns = getTableColumns(localRunnerProcesses);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "pid",
      "commandMetadata",
      "status",
      "startedAt",
      "stoppedAt",
      "exitCode",
      "signal",
      "lastError",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.pid.notNull).toBe(true);
    expect(columns.pid.dataType).toBe("number");
    expect(columns.commandMetadata.notNull).toBe(true);
    expect(columns.commandMetadata.dataType).toBe("json");
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("running");
    expect(columns.startedAt.notNull).toBe(true);
    expect(columns.stoppedAt.notNull).toBe(false);
    expect(columns.exitCode.notNull).toBe(false);
    expect(columns.signal.notNull).toBe(false);
    expect(columns.lastError.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });

  it("defines pending approval rows without exposing raw payload through display contracts", () => {
    const columns = getTableColumns(agentApprovals);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "title",
      "description",
      "status",
      "payloadJson",
      "requestedBy",
      "resolvedBy",
      "createdAt",
      "resolvedAt",
      "expiresAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.title.notNull).toBe(true);
    expect(columns.description.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("pending");
    expect(columns.payloadJson.notNull).toBe(true);
    expect(columns.payloadJson.dataType).toBe("json");
    expect(columns.requestedBy.notNull).toBe(true);
    expect(columns.resolvedBy.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.resolvedAt.notNull).toBe(false);
    expect(columns.expiresAt.notNull).toBe(false);
  });

  it("generates a migration for the enum and Milestone 1 tables without changing app_metadata", async () => {
    const migration = await readFile("drizzle/0001_optimal_texas_twister.sql", "utf8");

    expect(migration).toContain('CREATE TYPE "public"."agent_status"');
    expect(migration).toContain('CREATE TABLE "users"');
    expect(migration).toContain('CREATE TABLE "agents"');
    expect(migration).toContain('CREATE TABLE "agent_events"');
    expect(migration).toContain('"status" "agent_status" DEFAULT \'stopped\' NOT NULL');
    expect(migration).toContain("\"metadata\" jsonb DEFAULT '{}'::jsonb NOT NULL");
    expect(migration).toContain('FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
    expect(migration).not.toContain('ALTER TABLE "app_metadata"');
  });

  it("generates an additive agent_logs migration without rewriting existing tables or enums", async () => {
    const migration = await readFile("drizzle/0002_icy_star_brand.sql", "utf8");

    expect(migration).toContain('CREATE TABLE "agent_logs"');
    expect(migration).toContain('"runner_id" uuid');
    expect(migration).toContain('"sequence" integer NOT NULL');
    expect(migration).toContain('CONSTRAINT "agent_logs_sequence_positive_check"');
    expect(migration).toContain('FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")');
    expect(migration).toContain('CREATE UNIQUE INDEX "agent_logs_agent_sequence_idx"');
    expect(migration).not.toContain('DROP TABLE "agents"');
    expect(migration).not.toContain('DROP TABLE "agent_events"');
    expect(migration).not.toContain('DROP TABLE "users"');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
    expect(migration).not.toContain('ALTER TYPE "public"."agent_status"');
    expect(migration).not.toContain('ALTER TABLE "agents"');
    expect(migration).not.toContain('ALTER TABLE "agent_events"');
    expect(migration).not.toContain('ALTER TABLE "users"');
    expect(migration).not.toContain('ALTER TABLE "app_metadata"');
  });

  it("generates an additive agent_configs migration with active-agent backfill and no secret columns", async () => {
    const migration = await readFile("drizzle/0003_mature_sandman.sql", "utf8");

    expect(migration).toContain('CREATE TYPE "public"."agent_schedule_mode"');
    expect(migration).toContain('CREATE TABLE "agent_configs"');
    expect(migration).toContain('"agent_id" uuid PRIMARY KEY NOT NULL');
    expect(migration).toContain('"system_prompt" text NOT NULL');
    expect(migration).toContain("\"model_provider\" text DEFAULT 'not_configured' NOT NULL");
    expect(migration).toContain("\"model_name\" text DEFAULT 'not_configured' NOT NULL");
    expect(migration).toContain('"max_daily_spend_cents" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain(
      '"schedule_mode" "agent_schedule_mode" DEFAULT \'manual\' NOT NULL',
    );
    expect(migration).toContain('"schedule_cron" text');
    expect(migration).toContain("\"timezone\" text DEFAULT 'UTC' NOT NULL");
    expect(migration).toContain('CONSTRAINT "agent_configs_max_daily_spend_nonnegative_check"');
    expect(migration).toContain('CONSTRAINT "agent_configs_schedule_cron_mode_check"');
    expect(migration).toContain('FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")');
    expect(migration).toContain('INSERT INTO "agent_configs"');
    expect(migration).toContain('FROM "agents"');
    expect(migration).toContain('WHERE "agents"."deleted_at" IS NULL');
    expect(migration).not.toMatch(/api[_ ]?key|token|password|secret/i);
    expect(migration).not.toContain('DROP TABLE "agents"');
    expect(migration).not.toContain('DROP TABLE "agent_events"');
    expect(migration).not.toContain('DROP TABLE "agent_logs"');
    expect(migration).not.toContain('DROP TABLE "users"');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
  });

  it("generates an additive agent_approvals migration with exact lifecycle statuses", async () => {
    const migration = await readFile("drizzle/0004_careless_santa_claus.sql", "utf8");

    expect(migration).toContain('CREATE TYPE "public"."agent_approval_status"');
    expect(migration).toContain("'pending'");
    expect(migration).toContain("'approved'");
    expect(migration).toContain("'denied'");
    expect(migration).toContain("'expired'");
    expect(migration).toContain("'cancelled'");
    expect(migration).toContain('CREATE TABLE "agent_approvals"');
    expect(migration).toContain('"agent_id" uuid NOT NULL');
    expect(migration).toContain('"title" text NOT NULL');
    expect(migration).toContain('"description" text NOT NULL');
    expect(migration).toContain('"status" "agent_approval_status" DEFAULT \'pending\' NOT NULL');
    expect(migration).toContain('"payload_json" jsonb NOT NULL');
    expect(migration).toContain('"requested_by" text NOT NULL');
    expect(migration).toContain('"resolved_by" text');
    expect(migration).toContain('"created_at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(migration).toContain('"resolved_at" timestamp with time zone');
    expect(migration).toContain('"expires_at" timestamp with time zone');
    expect(migration).toContain('FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")');
    expect(migration).not.toContain('DROP TABLE "agents"');
    expect(migration).not.toContain('DROP TABLE "agent_events"');
    expect(migration).not.toContain('DROP TABLE "agent_logs"');
    expect(migration).not.toContain('DROP TABLE "agent_configs"');
    expect(migration).not.toContain('DROP TABLE "users"');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
    expect(migration).not.toContain('ALTER TABLE "agents"');
    expect(migration).not.toContain('ALTER TABLE "agent_events"');
    expect(migration).not.toContain('ALTER TABLE "agent_logs"');
    expect(migration).not.toContain('ALTER TABLE "agent_configs"');
    expect(migration).not.toContain('ALTER TABLE "users"');
    expect(migration).not.toContain('ALTER TABLE "app_metadata"');
  });

  it("generates an additive local runner state migration without merging logs into audit events", async () => {
    const migration = await readFile("drizzle/0005_local_runner_state.sql", "utf8");

    expect(migration).toContain('CREATE TYPE "public"."local_runner_process_status"');
    expect(migration).toContain("'starting'");
    expect(migration).toContain("'running'");
    expect(migration).toContain("'stopped'");
    expect(migration).toContain("'exited'");
    expect(migration).toContain("'failed'");
    expect(migration).toContain('CREATE TABLE "local_runner_processes"');
    expect(migration).toContain('"agent_id" uuid NOT NULL');
    expect(migration).toContain('"pid" integer NOT NULL');
    expect(migration).toContain('"command_metadata" jsonb NOT NULL');
    expect(migration).toContain(
      '"status" "local_runner_process_status" DEFAULT \'running\' NOT NULL',
    );
    expect(migration).toContain('"started_at" timestamp with time zone NOT NULL');
    expect(migration).toContain('"stopped_at" timestamp with time zone');
    expect(migration).toContain('"exit_code" integer');
    expect(migration).toContain('"signal" text');
    expect(migration).toContain('"last_error" text');
    expect(migration).toContain('CONSTRAINT "local_runner_processes_pid_positive_check"');
    expect(migration).toContain('CONSTRAINT "local_runner_processes_exit_code_nonnegative_check"');
    expect(migration).toContain('CONSTRAINT "local_runner_processes_stopped_after_started_check"');
    expect(migration).toContain('ALTER TABLE "agent_logs" ADD COLUMN "local_runner_process_id"');
    expect(migration).toContain('CONSTRAINT "agent_logs_stream_check"');
    expect(migration).toContain('FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")');
    expect(migration).toContain(
      'FOREIGN KEY ("local_runner_process_id") REFERENCES "public"."local_runner_processes"("id")',
    );
    expect(migration).not.toContain('DROP TABLE "agents"');
    expect(migration).not.toContain('DROP TABLE "agent_events"');
    expect(migration).not.toContain('DROP TABLE "agent_logs"');
    expect(migration).not.toContain('DROP TABLE "agent_approvals"');
    expect(migration).not.toContain('DROP TABLE "agent_configs"');
    expect(migration).not.toContain('DROP TABLE "users"');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
    expect(migration).not.toContain('ALTER TABLE "agent_events"');
    expect(migration).not.toMatch(/api[_ ]?key|token|password|secret|credential/i);
  });
});
