import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";
let createdDatabase: string | null = null;

describe("agent runtime reconciliation migration", () => {
  afterAll(async () => {
    if (createdDatabase) {
      await dropDisposableDatabase(createdDatabase);
    }
  });

  it("installs cleanly twice with the exact enum, ownership, checks, and due index", async () => {
    const databaseUrl = await createDisposableDatabase("runtime_clean");

    await runDbMigrate(databaseUrl);
    await runDbMigrate(databaseUrl);

    const sql = postgres(databaseUrl, { max: 1 });

    try {
      await expect(readEnumValues(sql)).resolves.toEqual([
        "observing",
        "recovering_stop",
        "recovering_start",
        "verifying",
        "stopping",
        "stopped",
        "circuit_open",
      ]);
      await expect(readColumnNames(sql)).resolves.toEqual([
        "agent_id",
        "user_id",
        "state",
        "generation",
        "config_revision",
        "operation_id",
        "attempt_count",
        "recovery_count",
        "recovery_window_started_at",
        "stable_since",
        "telegram_non_connected_since",
        "last_restart_count",
        "last_observed_at",
        "last_ready_at",
        "error_code",
        "next_attempt_at",
        "lease_owner",
        "lease_expires_at",
        "circuit_opened_at",
        "created_at",
        "updated_at",
      ]);
      await expect(
        readConstraintDefinition(sql, "agent_runtime_reconciliations_agent_owner_fk"),
      ).resolves.toContain("FOREIGN KEY (agent_id, user_id) REFERENCES agents(id, user_id)");
      await expect(readCheckNames(sql)).resolves.toEqual(
        expect.arrayContaining([
          "agent_runtime_reconciliations_attempt_count_check",
          "agent_runtime_reconciliations_circuit_check",
          "agent_runtime_reconciliations_config_revision_check",
          "agent_runtime_reconciliations_error_code_check",
          "agent_runtime_reconciliations_generation_check",
          "agent_runtime_reconciliations_lease_pair_check",
          "agent_runtime_reconciliations_operation_state_check",
          "agent_runtime_reconciliations_stopped_check",
          "agent_runtime_reconciliations_terminal_work_check",
        ]),
      );
      await expect(readIndexDefinition(sql)).resolves.toContain(
        "WHERE (state <> ALL (ARRAY['stopped'::agent_runtime_reconciliation_state, 'circuit_open'::agent_runtime_reconciliation_state]))",
      );
    } finally {
      await sql.end();
    }
  });

  it("backfills only exact latest-ready managed evidence without mutating existing ledgers", async () => {
    const databaseUrl = await createDisposableDatabase("runtime_upgrade");
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      await applyMigrationsThrough(sql, 18);
      await seedUpgradeFixture(sql);
      const before = await readProtectedFixtureState(sql);

      await runDbMigrate(databaseUrl);
      await runDbMigrate(databaseUrl);

      await expect(sql`
        select agent_id::text as "agentId", state::text, generation, config_revision as "configRevision",
               operation_id::text as "operationId", next_attempt_at is not null as "isDue"
        from agent_runtime_reconciliations
        order by agent_id
      `).resolves.toEqual([
        {
          agentId: "00000000-0000-4000-8000-000000009101",
          state: "observing",
          generation: 0,
          configRevision: "cfg-ready-running",
          operationId: "00000000-0000-4000-8000-000000009301",
          isDue: true,
        },
        {
          agentId: "00000000-0000-4000-8000-000000009102",
          state: "stopped",
          generation: 0,
          configRevision: "cfg-ready-stopped",
          operationId: null,
          isDue: false,
        },
      ]);
      await expect(readProtectedFixtureState(sql)).resolves.toEqual(before);
    } finally {
      await sql.end();
    }
  });
});

async function seedUpgradeFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    insert into users (id) values ('00000000-0000-4000-8000-000000009001')
  `;
  await sql`
    insert into runners (id, user_id, name, kind, endpoint_url)
    values (
      '00000000-0000-4000-8000-000000009201',
      '00000000-0000-4000-8000-000000009001',
      'runtime fixture runner',
      'manual_vps',
      'http://127.0.0.1:3045'
    )
  `;
  await sql`
    insert into agents (id, user_id, runner_id, name, template_key, status, desired_status, deleted_at)
    values
      ('00000000-0000-4000-8000-000000009101', '00000000-0000-4000-8000-000000009001', '00000000-0000-4000-8000-000000009201', 'ready running', 'research_agent', 'running', 'running', null),
      ('00000000-0000-4000-8000-000000009102', '00000000-0000-4000-8000-000000009001', '00000000-0000-4000-8000-000000009201', 'ready stopped', 'research_agent', 'stopped', 'stopped', null),
      ('00000000-0000-4000-8000-000000009103', '00000000-0000-4000-8000-000000009001', '00000000-0000-4000-8000-000000009201', 'manual running', 'research_agent', 'running', 'running', null),
      ('00000000-0000-4000-8000-000000009104', '00000000-0000-4000-8000-000000009001', '00000000-0000-4000-8000-000000009201', 'latest failed', 'research_agent', 'error', 'running', null),
      ('00000000-0000-4000-8000-000000009105', '00000000-0000-4000-8000-000000009001', '00000000-0000-4000-8000-000000009201', 'deleted ready', 'research_agent', 'running', 'running', '2026-08-03T01:20:00Z'),
      ('00000000-0000-4000-8000-000000009106', '00000000-0000-4000-8000-000000009001', '00000000-0000-4000-8000-000000009201', 'malformed correlation', 'research_agent', 'running', 'running', null)
  `;
  await insertReadyDeployment(sql, "9101", "9301", "cfg-ready-running", "01:00:00");
  await insertReadyDeployment(sql, "9102", "9302", "cfg-ready-stopped", "01:01:00");
  await insertReadyDeployment(sql, "9104", "9304", "cfg-before-failure", "01:02:00");
  await insertReadyDeployment(sql, "9105", "9305", "cfg-deleted", "01:03:00");
  await sql`
    insert into agent_deployments (
      id, agent_id, user_id, stage, config_revision, idempotency_key,
      runner_operation_id, runner_accepted_at, canary_state, canary_attempted_at,
      canary_completed_at, completed_at, created_at, updated_at
    ) values (
      '00000000-0000-4000-8000-00000000a106',
      '00000000-0000-4000-8000-000000009106',
      '00000000-0000-4000-8000-000000009001',
      'ready', 'cfg-malformed-correlation', 'runtime-ready-9106',
      '00000000-0000-4000-8000-000000009306',
      '2026-08-03T01:06:00Z', 'passed', '2026-08-03T01:05:00Z',
      '2026-08-03T01:05:00Z', '2026-08-03T01:05:00Z',
      '2026-08-03T01:05:00Z', '2026-08-03T01:05:00Z'
    )
  `;
  await sql`
    insert into agent_deployments (
      id, agent_id, user_id, stage, config_revision, idempotency_key, error_code,
      failed_at, created_at, updated_at
    ) values (
      '00000000-0000-4000-8000-000000009404',
      '00000000-0000-4000-8000-000000009104',
      '00000000-0000-4000-8000-000000009001',
      'failed', 'cfg-latest-failed', 'runtime-failed-key', 'runner_unavailable',
      '2026-08-03T01:10:00Z', '2026-08-03T01:10:00Z', '2026-08-03T01:10:00Z'
    )
  `;
  await sql`
    insert into agent_events (agent_id, actor_user_id, type, message, metadata)
    values (
      '00000000-0000-4000-8000-000000009101',
      '00000000-0000-4000-8000-000000009001',
      'fixture.sentinel', 'sentinel', '{"keep":true}'::jsonb
    )
  `;
  await sql`
    insert into agent_usage_periods (agent_id, runner_id, source, started_at)
    values (
      '00000000-0000-4000-8000-000000009101',
      '00000000-0000-4000-8000-000000009201',
      'lifecycle', '2026-08-03T01:00:00Z'
    )
  `;
}

async function insertReadyDeployment(
  sql: postgres.Sql,
  agentSuffix: string,
  operationSuffix: string,
  configRevision: string,
  time: string,
): Promise<void> {
  const agentId = `00000000-0000-4000-8000-00000000${agentSuffix}`;
  const deploymentId = `00000000-0000-4000-8000-00000000a${agentSuffix.slice(1)}`;
  const operationId = `00000000-0000-4000-8000-00000000${operationSuffix}`;
  await sql`
    insert into agent_deployments (
      id, agent_id, user_id, stage, config_revision, idempotency_key,
      runner_operation_id, runner_accepted_at, canary_state, canary_attempted_at,
      canary_completed_at, completed_at, created_at, updated_at
    ) values (
      ${deploymentId}, ${agentId}, '00000000-0000-4000-8000-000000009001',
      'ready', ${configRevision}, ${`runtime-ready-${agentSuffix}`}, ${operationId},
      ${`2026-08-03T${time}Z`}, 'passed', ${`2026-08-03T${time}Z`},
      ${`2026-08-03T${time}Z`}, ${`2026-08-03T${time}Z`},
      ${`2026-08-03T${time}Z`}, ${`2026-08-03T${time}Z`}
    )
  `;
}

async function readProtectedFixtureState(sql: postgres.Sql) {
  return await sql`
    select
      (select jsonb_agg(jsonb_build_array(id, desired_status, status, deleted_at) order by id) from agents) as agents,
      (select count(*)::int from agent_events) as events,
      (select count(*)::int from agent_usage_periods) as usage,
      (select count(*)::int from agent_deployments) as deployments
  `;
}

async function createDisposableDatabase(label: string): Promise<string> {
  if (createdDatabase) {
    await dropDisposableDatabase(createdDatabase);
  }

  const database = `plingpling_step9_${label}_${process.pid}_${Date.now()}`.toLowerCase();
  const admin = postgres(adminDatabaseUrl(), { max: 1 });

  try {
    await admin.unsafe(`create database ${quoteIdentifier(database)}`);
    createdDatabase = database;
    return databaseUrlFor(database);
  } finally {
    await admin.end();
  }
}

async function dropDisposableDatabase(database: string): Promise<void> {
  const admin = postgres(adminDatabaseUrl(), { max: 1 });

  try {
    await admin.unsafe(`drop database if exists ${quoteIdentifier(database)} with (force)`);
    if (createdDatabase === database) {
      createdDatabase = null;
    }
  } finally {
    await admin.end();
  }
}

async function runDbMigrate(databaseUrl: string): Promise<void> {
  try {
    await execFileAsync("bun", ["run", "db:migrate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 30_000,
    });
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? error.stdout : "";
    const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : "";
    throw new Error(`${stdout}\n${stderr}`.trim());
  }
}

async function applyMigrationsThrough(sql: postgres.Sql, lastIndex: number): Promise<void> {
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
    .filter((file) => Number(file.slice(0, 4)) <= lastIndex);

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
    .filter(Boolean);
}

async function readEnumValues(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ enumlabel: string }[]>`
    select e.enumlabel
    from pg_enum e
    inner join pg_type t on t.oid = e.enumtypid
    where t.typname = 'agent_runtime_reconciliation_state'
    order by e.enumsortorder
  `;
  return rows.map((row) => row.enumlabel);
}

async function readColumnNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_runtime_reconciliations'
    order by ordinal_position
  `;
  return rows.map((row) => row.column_name);
}

async function readCheckNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ conname: string }[]>`
    select conname from pg_constraint
    where conrelid = 'agent_runtime_reconciliations'::regclass and contype = 'c'
    order by conname
  `;
  return rows.map((row) => row.conname);
}

async function readConstraintDefinition(sql: postgres.Sql, name: string): Promise<string> {
  const [row] = await sql<{ definition: string }[]>`
    select pg_get_constraintdef(oid) as definition from pg_constraint where conname = ${name}
  `;
  return row?.definition ?? "";
}

async function readIndexDefinition(sql: postgres.Sql): Promise<string> {
  const [row] = await sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'agent_runtime_reconciliations_claim_idx'
  `;
  return row?.indexdef ?? "";
}

function validatedBaseUrl(): URL {
  const parsed = new URL(BASE_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Runtime migration fixtures require loopback PostgreSQL.");
  }
  return parsed;
}

function adminDatabaseUrl(): string {
  const url = validatedBaseUrl();
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(database: string): string {
  const url = validatedBaseUrl();
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error("Disposable runtime fixture database name is invalid.");
  }
  return `"${value}"`;
}
