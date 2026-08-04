import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";
const createdDatabases: string[] = [];
const RUNNER_IMAGE = `ghcr.io/example/runner@sha256:${"6".repeat(64)}`;

describe("runner replacement migration", () => {
  afterAll(async () => {
    await Promise.all(createdDatabases.splice(0).map(dropDisposableDatabase));
  });

  it("installs cleanly and idempotently with exact states, reasons, codes, and indexes", async () => {
    const databaseUrl = await createDisposableDatabase("clean");
    await runDbMigrate(databaseUrl);
    await runDbMigrate(databaseUrl);
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await expect(readEnum(sql, "runner_replacement_state")).resolves.toEqual([
        "pending",
        "provisioning_target",
        "validating_target",
        "fencing_source",
        "reassigning",
        "converging_agents",
        "cleaning_source",
        "complete",
        "failed",
      ]);
      await expect(readEnum(sql, "runner_replacement_reason")).resolves.toEqual([
        "release_mismatch",
        "boot_failure",
        "provider_resource_missing",
        "stale_heartbeat",
        "endpoint_failure",
        "gateway_deadline",
      ]);
      await expect(readEnum(sql, "runner_replacement_terminal_code")).resolves.toContain(
        "replacement_budget_exhausted",
      );
      await expect(readIndexes(sql)).resolves.toEqual(
        expect.arrayContaining([
          "runner_replacements_active_deployment_idx",
          "runner_replacements_active_source_idx",
          "runner_replacements_claim_idx",
          "runner_replacements_operation_key_idx",
        ]),
      );
    } finally {
      await sql.end();
    }
  });

  it("upgrades through 0022 without mutating existing runner, agent, or deployment rows", async () => {
    const databaseUrl = await createDisposableDatabase("upgrade");
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await applyMigrationsThrough(sql, 22);
      await seedUpgradeFixture(sql);
      const before = await readProtectedRows(sql);

      await runDbMigrate(databaseUrl);
      await runDbMigrate(databaseUrl);

      await expect(readProtectedRows(sql)).resolves.toEqual(before);
      await expect(sql`select count(*)::int as count from runner_replacements`).resolves.toEqual([
        { count: 0 },
      ]);
      await expect(
        sql`select count(*)::int as count from agent_deployment_replacement_budgets`,
      ).resolves.toEqual([{ count: 0 }]);
    } finally {
      await sql.end();
    }
  });

  it("upgrades through 0023 to leased infrastructure evidence without mutating owned rows", async () => {
    const databaseUrl = await createDisposableDatabase("infrastructure_upgrade");
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await applyMigrationsThrough(sql, 23);
      await seedUpgradeFixture(sql);
      const before = await readProtectedRows(sql);

      await runDbMigrate(databaseUrl);
      await runDbMigrate(databaseUrl);

      await expect(readProtectedRows(sql)).resolves.toEqual(before);
      await expect(
        sql`select count(*)::int as count from runner_infrastructure_reconciliations`,
      ).resolves.toEqual([{ count: 0 }]);
      await expect(
        sql`select count(*)::int as count from runner_infrastructure_orphans`,
      ).resolves.toEqual([{ count: 0 }]);
    } finally {
      await sql.end();
    }
  });
});

async function seedUpgradeFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    insert into users (id, created_at, updated_at)
    values ('00000000-0000-4000-8000-000000006001', '2026-08-04T01:00:00Z', '2026-08-04T01:00:00Z')
  `;
  await sql`
    insert into runners (
      id, user_id, name, kind, status, provider, region, size_slug, image,
      provisioning_status, compatibility_state, created_at, updated_at
    ) values (
      '00000000-0000-4000-8000-000000006101',
      '00000000-0000-4000-8000-000000006001',
      'upgrade runner', 'digitalocean', 'online', 'digitalocean', 'sfo3',
      's-1vcpu-2gb', ${RUNNER_IMAGE},
      'ready', 'unknown', '2026-08-04T01:00:00Z', '2026-08-04T01:00:00Z'
    )
  `;
  await sql`
    insert into agents (
      id, user_id, runner_id, name, template_key, status, desired_status,
      created_at, updated_at
    ) values (
      '00000000-0000-4000-8000-000000006201',
      '00000000-0000-4000-8000-000000006001',
      '00000000-0000-4000-8000-000000006101',
      'upgrade agent', 'research_agent', 'running', 'running',
      '2026-08-04T01:00:00Z', '2026-08-04T01:00:00Z'
    )
  `;
  await sql`
    insert into agent_deployments (
      id, agent_id, user_id, stage, config_revision, idempotency_key,
      runner_operation_id, runner_accepted_at, canary_state, canary_attempted_at,
      canary_completed_at, started_at, completed_at, created_at, updated_at
    ) values (
      '00000000-0000-4000-8000-000000006301',
      '00000000-0000-4000-8000-000000006201',
      '00000000-0000-4000-8000-000000006001',
      'ready', 'cfg-upgrade-replacement', 'upgrade-replacement-key',
      '00000000-0000-4000-8000-000000006401',
      '2026-08-04T01:00:00Z', 'passed', '2026-08-04T01:00:00Z',
      '2026-08-04T01:00:00Z', '2026-08-04T01:00:00Z',
      '2026-08-04T01:00:00Z', '2026-08-04T01:00:00Z', '2026-08-04T01:00:00Z'
    )
  `;
}

async function readProtectedRows(sql: postgres.Sql): Promise<unknown> {
  const [runner] = await sql`
    select id::text, user_id::text, name, kind, status, provider, region,
           size_slug, image, provisioning_status, compatibility_state,
           created_at::text, updated_at::text
    from runners
  `;
  const [agent] = await sql`
    select id::text, user_id::text, runner_id::text, name, status, desired_status,
           created_at::text, updated_at::text
    from agents
  `;
  const [deployment] = await sql`
    select id::text, agent_id::text, user_id::text, stage::text, config_revision,
           idempotency_key, runner_operation_id::text, canary_state,
           created_at::text, updated_at::text
    from agent_deployments
  `;
  return { runner, agent, deployment };
}

async function readEnum(sql: postgres.Sql, name: string): Promise<string[]> {
  const rows = await sql<{ enumlabel: string }[]>`
    select e.enumlabel
    from pg_enum e
    inner join pg_type t on t.oid = e.enumtypid
    where t.typname = ${name}
    order by e.enumsortorder
  `;
  return rows.map((row) => row.enumlabel);
}

async function readIndexes(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ indexname: string }[]>`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'runner_replacements'
    order by indexname
  `;
  return rows.map((row) => row.indexname);
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
    if (!entry) throw new Error(`Missing journal entry for ${migrationFile}.`);
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

async function createDisposableDatabase(label: string): Promise<string> {
  const databaseName = `plingpling_replacement_${label}_${process.pid}_${Date.now()}`.toLowerCase();
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    createdDatabases.push(databaseName);
  } finally {
    await admin.end();
  }
  return databaseUrlFor(databaseName);
}

async function dropDisposableDatabase(databaseName: string): Promise<void> {
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
  } finally {
    await admin.end();
  }
}

async function runDbMigrate(databaseUrl: string): Promise<void> {
  await execFileAsync("bun", ["run", "db:migrate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 30_000,
  });
}

function validatedBaseUrl(): URL {
  const parsed = new URL(BASE_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Runner replacement migration fixtures require loopback PostgreSQL.");
  }
  return parsed;
}

function adminDatabaseUrl(): string {
  const url = validatedBaseUrl();
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(databaseName: string): string {
  const url = validatedBaseUrl();
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error("Disposable runner replacement migration database name is invalid.");
  }
  return `"${value}"`;
}
