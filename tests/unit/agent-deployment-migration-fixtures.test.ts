import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno";
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
      await expect(readEnumValues(sql, "agent_deployment_wakeup_state")).resolves.toEqual([
        "pending",
        "publishing",
        "published",
        "claimed",
        "terminal",
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
        "runner_operation_id",
        "runner_accepted_at",
        "canary_state",
        "canary_attempted_at",
        "canary_completed_at",
        "accepted_at",
        "origin",
        "initial_cohort",
        "deployment_environment",
        "owner_cancelled_at",
        "rollout_configuration_generation",
      ]);
      await expect(readColumnNames(sql, "agent_deployment_wakeups")).resolves.toEqual([
        "id",
        "deployment_id",
        "generation",
        "due_at",
        "state",
        "publish_attempt_count",
        "provider_message_id",
        "publish_lease_owner",
        "publish_lease_expires_at",
        "safe_error_code",
        "published_at",
        "claimed_at",
        "created_at",
        "updated_at",
      ]);
      await expect(readColumnNames(sql, "provider_trial_cohorts")).resolves.toEqual([
        "id",
        "cohort_key",
        "region",
        "runner_size_slug",
        "rollout_configuration_generation",
        "started_at",
        "created_at",
      ]);
      await expect(readColumnNames(sql, "provider_trial_slots")).resolves.toEqual([
        "id",
        "cohort_id",
        "slot_number",
        "request_attempt_id",
        "request_started_at",
        "request_outcome",
        "request_safe_code",
        "request_outcome_recorded_at",
        "deployment_id",
        "terminal_outcome",
        "terminal_safe_code",
        "terminal_recorded_at",
        "created_at",
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
        readIndexDefinition(sql, "agent_deployment_wakeups_generation_idx"),
      ).resolves.toContain("UNIQUE INDEX");
      await expect(
        readIndexDefinition(sql, "provider_trial_slots_cohort_number_idx"),
      ).resolves.toContain("UNIQUE INDEX");
      await expect(
        readIndexDefinition(sql, "provider_trial_slots_deployment_idx"),
      ).resolves.toContain("UNIQUE INDEX");
      await expect(readIndexDefinition(sql, "agent_deployment_wakeups_due_idx")).resolves.toContain(
        "WHERE (state = ANY",
      );
      await expect(
        readConstraintDefinition(sql, "agent_deployment_wakeups_publish_lease_pair_check"),
      ).resolves.toContain("publish_lease_owner");
      await expect(
        readConstraintDefinition(sql, "agent_deployments_agent_owner_fk"),
      ).resolves.toContain("FOREIGN KEY (agent_id, user_id) REFERENCES agents(id, user_id)");
      await expect(
        readConstraintDefinition(sql, "agent_deployments_canary_state_check"),
      ).resolves.toContain("'skipped'::text");
      await expect(
        readConstraintDefinition(sql, "agent_deployments_telegram_ready_canary_check"),
      ).resolves.toContain("'skipped'::text");
      await expect(
        readTriggerDefinition(sql, "agent_deployments_accepted_at_immutable_trigger"),
      ).resolves.toContain("BEFORE UPDATE");
      await expect(
        readTriggerDefinition(sql, "agent_deployments_accepted_at_required_trigger"),
      ).resolves.toContain("BEFORE INSERT");
      await expect(
        readTriggerDefinition(sql, "agent_deployments_slo_identity_required_trigger"),
      ).resolves.toContain("BEFORE INSERT");
      await expect(
        readTriggerDefinition(sql, "agent_deployments_slo_identity_immutable_trigger"),
      ).resolves.toContain("BEFORE UPDATE");
      await expect(
        readTriggerDefinition(sql, "provider_trial_cohorts_preserve_identity_trigger"),
      ).resolves.toContain("BEFORE INSERT OR DELETE OR UPDATE");
      await expect(
        readTriggerDefinition(sql, "provider_trial_slots_preserve_evidence_trigger"),
      ).resolves.toContain("BEFORE INSERT OR DELETE OR UPDATE");
      await expect(readConstraintDefinition(sql, "agents_id_user_id_unique")).resolves.toContain(
        "UNIQUE (id, user_id)",
      );
      await expect(readDeploymentCheckNames(sql)).resolves.toEqual(
        expect.arrayContaining([
          "agent_deployments_attempt_count_check",
          "agent_deployments_config_revision_check",
          "agent_deployments_idempotency_key_check",
          "agent_deployments_lease_pair_check",
          "agent_deployments_runner_operation_pair_check",
          "agent_deployments_canary_state_check",
          "agent_deployments_telegram_ready_canary_check",
          "agent_deployments_terminal_clear_work_check",
        ]),
      );
      await expect(
        readIndexDefinition(sql, "agent_usage_periods_one_open_agent_idx"),
      ).resolves.toContain("UNIQUE INDEX");
      await expect(
        readIndexDefinition(sql, "runners_provisioning_operation_key_idx"),
      ).resolves.toContain("UNIQUE INDEX");

      const [owner] = await sql<{ id: string }[]>`insert into users default values returning id`;

      if (!owner) {
        throw new Error("Migration fixture owner insert returned no row.");
      }

      const [agent] = await sql<{ id: string }[]>`
        insert into agents (user_id, name, template_key)
        values (${owner.id}, 'Legacy boundary fixture', 'research_agent')
        returning id
      `;
      if (!agent) throw new Error("Migration fixture agent insert returned no row.");
      await expect(sql`
        insert into agent_deployments (
          agent_id, user_id, config_revision, idempotency_key, accepted_at
        ) values (
          ${agent.id}, ${owner.id}, 'cfg-missing-boundary', 'missing-boundary-fixture', null
        )
      `).rejects.toMatchObject({
        constraint_name: "agent_deployments_accepted_at_required_check",
      });
      await expect(sql<
        {
          accepted_at: Date;
          origin: string;
          initial_cohort: string;
          deployment_environment: string;
          rollout_configuration_generation: number;
        }[]
      >`
        insert into agent_deployments (
          agent_id, user_id, config_revision, idempotency_key
        ) values (
          ${agent.id}, ${owner.id}, 'cfg-defaulted-boundary', 'defaulted-boundary-fixture'
        )
        returning accepted_at, origin, initial_cohort, deployment_environment,
          rollout_configuration_generation
      `).resolves.toEqual([
        {
          accepted_at: expect.any(Date),
          origin: "operator_trial",
          initial_cohort: "unknown",
          deployment_environment: "non_production",
          rollout_configuration_generation: 1,
        },
      ]);

      await expect(sql`
        insert into agent_deployments (
          agent_id, user_id, config_revision, idempotency_key,
          rollout_configuration_generation
        ) values (
          ${agent.id}, ${owner.id}, 'cfg-missing-rollout', 'missing-rollout-fixture', null
        )
      `).rejects.toMatchObject({
        constraint_name: "agent_deployments_slo_identity_required_check",
      });

      await expect(sql`
        insert into runners (
          user_id, name, kind, endpoint_url, provisioning_operation_key
        ) values (
          ${owner.id}, 'manual-key-blocked', 'manual_vps', 'http://127.0.0.1:3045',
          'bruno-deploy-11111111111141118111111111111111'
        )
      `).rejects.toMatchObject({ constraint_name: "runners_provisioning_operation_key_check" });
      await expect(sql`
        insert into runners (
          user_id, name, kind, provider, region, size_slug, image,
          provisioning_status, provisioning_operation_key
        ) values (
          ${owner.id}, 'automatic-cloud-runner', 'digitalocean', 'digitalocean', 'sfo3',
          's-1vcpu-512mb-10gb', 'ubuntu-24-04-x64', 'pending',
          'bruno-deploy-11111111111141118111111111111111'
        )
      `).resolves.toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it("fails closed instead of mutating duplicate open usage periods during upgrade", async () => {
    const database = await createDisposableDatabase("duplicate_usage");
    const databaseUrl = databaseUrlFor(database);
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      await applyMigrationsThrough0017(sql);
      await seedDuplicateOpenUsagePeriods(sql);

      await expect(applyMigrationFile(sql, "drizzle/0018_first_polaris.sql")).rejects.toThrow(
        /agent_usage_periods_open_duplicate_blocker/,
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

  it("keeps pre-boundary deployments as legacy rows while requiring the boundary on new inserts", async () => {
    const database = await createDisposableDatabase("accepted_boundary_upgrade");
    const databaseUrl = databaseUrlFor(database);
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      await applyMigrationsThrough0026(sql);
      await seedHistoricalAgents(sql);
      await sql`
        insert into agent_deployments (
          agent_id, user_id, config_revision, idempotency_key, created_at, updated_at
        ) values (
          '00000000-0000-4000-8000-00000000f101',
          '00000000-0000-4000-8000-00000000f001',
          'cfg-historical-boundary',
          'historical-boundary',
          '2026-08-03T01:05:00Z',
          '2026-08-03T01:05:00Z'
        )
      `;

      await runDbMigrate(databaseUrl);

      await expect(
        sql`select accepted_at, origin, initial_cohort, deployment_environment,
          rollout_configuration_generation
        from agent_deployments
        where idempotency_key = 'historical-boundary'`,
      ).resolves.toEqual([
        {
          accepted_at: null,
          origin: null,
          initial_cohort: null,
          deployment_environment: null,
          rollout_configuration_generation: null,
        },
      ]);
      await expect(sql`
        insert into agent_deployments (
          agent_id, user_id, config_revision, idempotency_key, accepted_at
        ) values (
          '00000000-0000-4000-8000-00000000f101',
          '00000000-0000-4000-8000-00000000f001',
          'cfg-missing-boundary',
          'missing-boundary-after-upgrade',
          null
        )
      `).rejects.toMatchObject({
        constraint_name: "agent_deployments_accepted_at_required_check",
      });
    } finally {
      await sql.end();
    }
  });
});

async function createDisposableDatabase(label: string): Promise<string> {
  const baseUrl = validatedLoopbackBaseUrl();
  const database = `bruno_step3_${label}_${process.pid}_${Date.now()}`.toLowerCase();
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
  try {
    await execFileAsync("bun", ["run", "db:migrate"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
      timeout: 30_000,
    });
  } catch (error) {
    if (error && typeof error === "object") {
      const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      throw new Error(`${stdout}\n${stderr}`.trim());
    }

    throw error;
  }
}

async function applyMigrationsThrough0015(sql: postgres.Sql): Promise<void> {
  await applyMigrationsThrough(sql, 15);
}

async function applyMigrationsThrough0017(sql: postgres.Sql): Promise<void> {
  await applyMigrationsThrough(sql, 17);
}

async function applyMigrationsThrough0026(sql: postgres.Sql): Promise<void> {
  await applyMigrationsThrough(sql, 26);
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

async function applyMigrationFile(sql: postgres.Sql, migrationFile: string): Promise<void> {
  const migrationSql = await readFile(migrationFile, "utf8");

  for (const statement of splitMigrationStatements(migrationSql)) {
    await sql.unsafe(statement);
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

async function seedDuplicateOpenUsagePeriods(sql: postgres.Sql): Promise<void> {
  await sql`
    insert into users (id, created_at, updated_at)
    values ('00000000-0000-4000-8000-00000000e001', '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z')
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
      desired_status,
      created_at,
      updated_at
    )
    values (
      '00000000-0000-4000-8000-00000000e101',
      '00000000-0000-4000-8000-00000000e001',
      'duplicate usage sentinel',
      'research_agent',
      '1.0.0',
      '{"key":"research_agent","version":"1.0.0","name":"Research Agent","description":"sentinel","defaultTools":[],"defaultSchedule":"Manual","defaultSystemPrompt":"sentinel","requiredIntegrations":[]}'::jsonb,
      'running',
      'running',
      '2026-08-03T00:00:00Z',
      '2026-08-03T00:00:00Z'
    )
  `;
  await sql`
    insert into agent_usage_periods (agent_id, source, started_at, stopped_at, created_at, updated_at)
    values
      ('00000000-0000-4000-8000-00000000e101', 'lifecycle', '2026-08-03T00:00:00Z', null, '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z'),
      ('00000000-0000-4000-8000-00000000e101', 'lifecycle', '2026-08-03T00:01:00Z', null, '2026-08-03T00:01:00Z', '2026-08-03T00:01:00Z')
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

async function readTriggerDefinition(sql: postgres.Sql, triggerName: string): Promise<string> {
  const [row] = await sql<{ definition: string }[]>`
    select pg_get_triggerdef(oid) as definition
    from pg_trigger
    where tgname = ${triggerName}
      and not tgisinternal
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
