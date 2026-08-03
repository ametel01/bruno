import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";
const CREATED_DATABASES: string[] = [];

describe("agent deployment migration fixtures", () => {
  afterEach(async () => {
    await cleanupCreatedDatabases();
  });

  it("applies clean migrations idempotently and exposes deployment catalog objects", async () => {
    const database = await createDisposableDatabase("clean");
    const databaseUrl = databaseUrlFor(database);

    await runDbMigrate(databaseUrl);
    await runDbMigrate(databaseUrl);

    const sql = postgres(databaseUrl, { max: 1 });

    try {
      await expect(readEnumValues(sql, "agent_desired_status")).resolves.toEqual([
        "stopped",
        "running",
      ]);
      await expect(readEnumValues(sql, "agent_deployment_stage")).resolves.toEqual([
        "pending",
        "provisioning_runner",
        "configuring_hermes",
        "starting_gateway",
        "verifying_model",
        "connecting_telegram",
        "ready",
        "failed",
      ]);
      await expect(readColumnNames(sql, "agent_deployments")).resolves.toEqual([
        "id",
        "agent_id",
        "user_id",
        "stage",
        "config_revision",
        "idempotency_key",
        "attempt_count",
        "error_code",
        "error_detail",
        "next_attempt_at",
        "lease_owner",
        "lease_expires_at",
        "started_at",
        "completed_at",
        "failed_at",
        "created_at",
        "updated_at",
      ]);
      await expect(readAgentsDesiredDefault(sql)).resolves.toEqual({
        column_default: "'stopped'::agent_desired_status",
        is_nullable: "NO",
      });
      await expect(
        readIndexDefinition(sql, "agent_deployments_user_idempotency_idx"),
      ).resolves.toContain("UNIQUE INDEX");
      await expect(
        readIndexDefinition(sql, "agent_deployments_active_agent_idx"),
      ).resolves.toContain(
        "WHERE (stage <> ALL (ARRAY['ready'::agent_deployment_stage, 'failed'::agent_deployment_stage]))",
      );
      await expect(readIndexDefinition(sql, "agent_deployments_claim_idx")).resolves.toContain(
        "WHERE (stage <> ALL",
      );
      await expect(
        readConstraintDefinition(sql, "agent_deployments_agent_owner_fk"),
      ).resolves.toContain("FOREIGN KEY (agent_id, user_id) REFERENCES agents(id, user_id)");
      await expect(readConstraintDefinition(sql, "agents_id_user_id_unique")).resolves.toContain(
        "UNIQUE (id, user_id)",
      );
      await expect(readDeploymentCheckNames(sql)).resolves.toEqual(
        expect.arrayContaining([
          "agent_deployments_attempt_count_check",
          "agent_deployments_config_revision_check",
          "agent_deployments_idempotency_key_check",
          "agent_deployments_lease_pair_check",
          "agent_deployments_terminal_clear_work_check",
        ]),
      );
    } finally {
      await sql.end();
    }
  });

  it("upgrades through 0015 without mutating historical agent sentinels or backfilling deployments", async () => {
    const database = await createDisposableDatabase("upgrade");
    const databaseUrl = databaseUrlFor(database);
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      await applyMigrationsThrough0015(sql);
      await seedHistoricalAgents(sql);
      const before = await readHistoricalSentinelsBeforeDesiredState(sql);

      await runDbMigrate(databaseUrl);

      const after = await readHistoricalSentinels(sql);
      expect(after).toEqual(
        before.map((row) => ({
          ...row,
          desired_status: "stopped",
        })),
      );
      await expect(sql`select count(*)::int as count from agent_deployments`).resolves.toEqual([
        { count: 0 },
      ]);

      await runDbMigrate(databaseUrl);
      await expect(readHistoricalSentinels(sql)).resolves.toEqual(after);
    } finally {
      await sql.end();
    }
  });
});

async function createDisposableDatabase(label: string): Promise<string> {
  const baseUrl = validatedLoopbackBaseUrl();
  const database = `plingpling_step3_${label}_${process.pid}_${Date.now()}`.toLowerCase();
  const admin = postgres(adminDatabaseUrl(baseUrl), { max: 1 });

  try {
    await admin.unsafe(`create database ${quoteIdentifier(database)}`);
    CREATED_DATABASES.push(database);
    return database;
  } finally {
    await admin.end();
  }
}

async function cleanupCreatedDatabases(): Promise<void> {
  if (CREATED_DATABASES.length === 0) {
    return;
  }

  const baseUrl = validatedLoopbackBaseUrl();
  const admin = postgres(adminDatabaseUrl(baseUrl), { max: 1 });
  const databases = CREATED_DATABASES.splice(0);

  try {
    for (const database of databases) {
      await admin.unsafe(`drop database if exists ${quoteIdentifier(database)} with (force)`);
    }
  } finally {
    await admin.end();
  }
}

async function runDbMigrate(databaseUrl: string): Promise<void> {
  await execFileAsync("bun", ["run", "db:migrate"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    timeout: 30_000,
  });
}

async function applyMigrationsThrough0015(sql: postgres.Sql): Promise<void> {
  await sql`create schema if not exists drizzle`;
  await sql`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `;

  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const migrationFiles = (await readdir("drizzle"))
    .filter((file) => /^00\d{2}_.+\.sql$/.test(file))
    .sort()
    .filter((file) => Number(file.slice(0, 4)) <= 15);

  for (const migrationFile of migrationFiles) {
    const migrationSql = await readFile(`drizzle/${migrationFile}`, "utf8");

    for (const statement of splitMigrationStatements(migrationSql)) {
      await sql.unsafe(statement);
    }

    const entry = journal.entries.find((candidate) =>
      migrationFile.startsWith(`${candidate.idx.toString().padStart(4, "0")}_`),
    );

    if (!entry) {
      throw new Error(`Missing journal entry for ${migrationFile}.`);
    }

    await sql`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values (${createHash("sha256").update(migrationSql).digest("hex")}, ${entry.when})
    `;
  }
}

function splitMigrationStatements(migrationSql: string): string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function seedHistoricalAgents(sql: postgres.Sql): Promise<void> {
  await sql`
    insert into users (id, created_at, updated_at)
    values
      ('00000000-0000-4000-8000-00000000f001', '2026-08-03T00:00:00Z', '2026-08-03T00:00:01Z'),
      ('00000000-0000-4000-8000-00000000f002', '2026-08-03T00:00:02Z', '2026-08-03T00:00:03Z')
  `;
  await sql`
    insert into agents (
      id,
      user_id,
      name,
      template_key,
      template_version,
      template_snapshot_json,
      status,
      status_reason,
      created_at,
      updated_at,
      deleted_at
    )
    values
      (
        '00000000-0000-4000-8000-00000000f101',
        '00000000-0000-4000-8000-00000000f001',
        'running sentinel',
        'research_agent',
        '1.0.0',
        '{"key":"research_agent","version":"1.0.0","name":"Research Agent","description":"sentinel","defaultTools":[],"defaultSchedule":"Manual","defaultSystemPrompt":"sentinel","requiredIntegrations":[]}'::jsonb,
        'running',
        'running-before-migration',
        '2026-08-03T01:00:00Z',
        '2026-08-03T01:00:01Z',
        null
      ),
      (
        '00000000-0000-4000-8000-00000000f102',
        '00000000-0000-4000-8000-00000000f001',
        'error sentinel',
        'research_agent',
        '1.0.0',
        '{"key":"research_agent","version":"1.0.0","name":"Research Agent","description":"sentinel","defaultTools":[],"defaultSchedule":"Manual","defaultSystemPrompt":"sentinel","requiredIntegrations":[]}'::jsonb,
        'error',
        'error-before-migration',
        '2026-08-03T01:01:00Z',
        '2026-08-03T01:01:01Z',
        null
      ),
      (
        '00000000-0000-4000-8000-00000000f103',
        '00000000-0000-4000-8000-00000000f002',
        'stopped sentinel',
        'research_agent',
        '1.0.0',
        '{"key":"research_agent","version":"1.0.0","name":"Research Agent","description":"sentinel","defaultTools":[],"defaultSchedule":"Manual","defaultSystemPrompt":"sentinel","requiredIntegrations":[]}'::jsonb,
        'stopped',
        null,
        '2026-08-03T01:02:00Z',
        '2026-08-03T01:02:01Z',
        null
      ),
      (
        '00000000-0000-4000-8000-00000000f104',
        '00000000-0000-4000-8000-00000000f002',
        'deleted sentinel',
        'research_agent',
        '1.0.0',
        '{"key":"research_agent","version":"1.0.0","name":"Research Agent","description":"sentinel","defaultTools":[],"defaultSchedule":"Manual","defaultSystemPrompt":"sentinel","requiredIntegrations":[]}'::jsonb,
        'running',
        'soft-deleted-before-migration',
        '2026-08-03T01:03:00Z',
        '2026-08-03T01:03:01Z',
        '2026-08-03T01:04:00Z'
      )
  `;
}

async function readHistoricalSentinelsBeforeDesiredState(sql: postgres.Sql) {
  return await sql`
    select id::text,
           user_id::text,
           name,
           status::text,
           status_reason,
           created_at::text,
           updated_at::text,
           deleted_at::text
    from agents
    order by id
  `;
}

async function readHistoricalSentinels(sql: postgres.Sql) {
  return await sql`
    select id::text,
           user_id::text,
           name,
           status::text,
           status_reason,
           created_at::text,
           updated_at::text,
           deleted_at::text,
           desired_status::text
    from agents
    order by id
  `;
}

async function readEnumValues(sql: postgres.Sql, enumName: string): Promise<string[]> {
  const rows = await sql<{ enumlabel: string }[]>`
    select e.enumlabel
    from pg_enum e
    inner join pg_type t on t.oid = e.enumtypid
    where t.typname = ${enumName}
    order by e.enumsortorder
  `;

  return rows.map((row) => row.enumlabel);
}

async function readColumnNames(sql: postgres.Sql, tableName: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = ${tableName}
    order by ordinal_position
  `;

  return rows.map((row) => row.column_name);
}

async function readAgentsDesiredDefault(sql: postgres.Sql) {
  const [row] = await sql<{ column_default: string; is_nullable: string }[]>`
    select column_default, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'agents'
      and column_name = 'desired_status'
  `;

  return row;
}

async function readIndexDefinition(sql: postgres.Sql, indexName: string): Promise<string> {
  const [row] = await sql<{ indexdef: string }[]>`
    select indexdef
    from pg_indexes
    where schemaname = 'public'
      and indexname = ${indexName}
  `;

  return row?.indexdef ?? "";
}

async function readConstraintDefinition(
  sql: postgres.Sql,
  constraintName: string,
): Promise<string> {
  const [row] = await sql<{ definition: string }[]>`
    select pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conname = ${constraintName}
  `;

  return row?.definition ?? "";
}

async function readDeploymentCheckNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ conname: string }[]>`
    select conname
    from pg_constraint
    where conrelid = 'agent_deployments'::regclass
      and contype = 'c'
    order by conname
  `;

  return rows.map((row) => row.conname);
}

function validatedLoopbackBaseUrl(): URL {
  const parsed = new URL(BASE_DATABASE_URL);

  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Migration fixture DATABASE_URL must target loopback PostgreSQL.");
  }

  return parsed;
}

function adminDatabaseUrl(baseUrl: URL): string {
  const adminUrl = new URL(baseUrl.toString());
  adminUrl.pathname = "/postgres";
  return adminUrl.toString();
}

function databaseUrlFor(database: string): string {
  const baseUrl = validatedLoopbackBaseUrl();
  baseUrl.pathname = `/${database}`;
  return baseUrl.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error("Disposable database name is invalid.");
  }

  return `"${value}"`;
}
