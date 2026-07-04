import { readFile } from "node:fs/promises";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agentEvents,
  agentLogs,
  agents,
  agentStatusEnum,
  appMetadata,
  users,
} from "@/src/server/db/schema";

describe("Milestone 1 agent persistence schema", () => {
  it("defines the expected tables and agent status values", () => {
    expect(getTableName(appMetadata)).toBe("app_metadata");
    expect(getTableName(users)).toBe("users");
    expect(getTableName(agents)).toBe("agents");
    expect(getTableName(agentEvents)).toBe("agent_events");
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
      "stream",
      "level",
      "message",
      "sequence",
      "createdAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(false);
    expect(columns.stream.notNull).toBe(true);
    expect(columns.level.notNull).toBe(true);
    expect(columns.message.notNull).toBe(true);
    expect(columns.sequence.notNull).toBe(true);
    expect(columns.sequence.dataType).toBe("number");
    expect(columns.createdAt.notNull).toBe(true);
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
});
