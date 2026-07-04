import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const appMetadata = pgTable("app_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentStatusEnum = pgEnum("agent_status", [
  "idle",
  "starting",
  "running",
  "stopped",
  "restarting",
  "error",
  "deleting",
]);

export const agentScheduleModeEnum = pgEnum("agent_schedule_mode", ["manual", "cron"]);

export const agentApprovalStatusEnum = pgEnum("agent_approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);

export const localRunnerProcessStatusEnum = pgEnum("local_runner_process_status", [
  "starting",
  "running",
  "stopped",
  "exited",
  "failed",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  templateKey: text("template_key").notNull(),
  status: agentStatusEnum("status").notNull().default("stopped"),
  statusReason: text("status_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const agentConfigs = pgTable(
  "agent_configs",
  {
    agentId: uuid("agent_id")
      .primaryKey()
      .references(() => agents.id),
    systemPrompt: text("system_prompt").notNull(),
    modelProvider: text("model_provider").notNull().default("not_configured"),
    modelName: text("model_name").notNull().default("not_configured"),
    maxDailySpendCents: integer("max_daily_spend_cents").notNull().default(0),
    scheduleMode: agentScheduleModeEnum("schedule_mode").notNull().default("manual"),
    scheduleCron: text("schedule_cron"),
    timezone: text("timezone").notNull().default("UTC"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("agent_configs_max_daily_spend_nonnegative_check", sql`${table.maxDailySpendCents} >= 0`),
    check(
      "agent_configs_schedule_cron_mode_check",
      sql`(${table.scheduleMode} = 'manual' AND ${table.scheduleCron} IS NULL) OR (${table.scheduleMode} = 'cron' AND ${table.scheduleCron} IS NOT NULL)`,
    ),
  ],
);

export const agentEvents = pgTable("agent_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id),
  type: text("type").notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const localRunnerProcesses = pgTable(
  "local_runner_processes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    pid: integer("pid").notNull(),
    commandMetadata: jsonb("command_metadata").$type<Record<string, unknown>>().notNull(),
    status: localRunnerProcessStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("local_runner_processes_pid_positive_check", sql`${table.pid} > 0`),
    check(
      "local_runner_processes_exit_code_nonnegative_check",
      sql`${table.exitCode} IS NULL OR ${table.exitCode} >= 0`,
    ),
    check(
      "local_runner_processes_stopped_after_started_check",
      sql`${table.stoppedAt} IS NULL OR ${table.stoppedAt} >= ${table.startedAt}`,
    ),
    index("local_runner_processes_agent_started_idx").on(table.agentId, table.startedAt),
  ],
);

export const agentLogs = pgTable(
  "agent_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    runnerId: uuid("runner_id"),
    localRunnerProcessId: uuid("local_runner_process_id").references(() => localRunnerProcesses.id),
    stream: text("stream").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("agent_logs_sequence_positive_check", sql`${table.sequence} > 0`),
    check("agent_logs_stream_check", sql`${table.stream} IN ('stdout', 'stderr')`),
    uniqueIndex("agent_logs_agent_sequence_idx").on(table.agentId, table.sequence),
  ],
);

export const agentApprovals = pgTable("agent_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: agentApprovalStatusEnum("status").notNull().default("pending"),
  payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
  requestedBy: text("requested_by").notNull(),
  resolvedBy: text("resolved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
