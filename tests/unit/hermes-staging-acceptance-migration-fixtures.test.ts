import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";
const CREATED_DATABASES: string[] = [];

describe("Hermes staging acceptance migration", () => {
  afterEach(async () => {
    await cleanupCreatedDatabases();
  });

  it("installs cleanly twice with closed workflow enums, safe columns, ownership, and one active run", async () => {
    const databaseUrl = await createDisposableDatabaseUrl("clean");
    await runDbMigrate(databaseUrl);
    await runDbMigrate(databaseUrl);
    const db = postgres(databaseUrl, { max: 1 });

    try {
      await expect(readEnum(db, "hermes_staging_acceptance_phase")).resolves.toEqual([
        "preflight",
        "attesting_image",
        "creating_ready_agent",
        "observing_deployment",
        "verifying_host_image",
        "awaiting_initial_human_proof",
        "restarting",
        "reverifying_runtime",
        "awaiting_post_restart_human_proof",
        "auditing_diagnostics",
        "stopping_agent",
        "observing_stop_stability",
        "checking_rollback",
        "cleaning_workload",
        "cleaning_secrets",
        "cleaning_firewall",
        "cleaning_droplet",
        "cleaning_runner",
        "complete",
      ]);
      await expect(readEnum(db, "hermes_staging_acceptance_error_code")).resolves.toEqual([
        "invalid_begin",
        "preflight_failed",
        "image_attestation_failed",
        "agent_creation_failed",
        "deployment_failed",
        "deployment_stage_invalid",
        "host_image_unverified",
        "initial_human_proof_failed",
        "post_restart_human_proof_failed",
        "human_proof_expired",
        "restart_failed",
        "runtime_reverification_failed",
        "diagnostics_unsafe",
        "stop_failed",
        "rollback_failed",
        "acceptance_deadline_exceeded",
        "acceptance_cancelled",
        "cleanup_failed",
        "internal_state_invalid",
      ]);
      await expect(readEnum(db, "hermes_staging_acceptance_challenge_purpose")).resolves.toEqual([
        "initial",
        "post_restart",
      ]);
      await expect(readEnum(db, "hermes_staging_acceptance_state")).resolves.toEqual([
        "pending",
        "executing",
        "waiting",
        "blocked",
        "complete",
      ]);

      const columns = await readColumns(db, "hermes_staging_acceptance_runs");
      expect(columns).toEqual(
        expect.arrayContaining([
          "owner_user_id",
          "pending_effect",
          "deadline_at",
          "cleanup_deadline_at",
          "expected_source_revision",
          "expected_publish_workflow_run_id",
          "expected_image_digest",
          "observed_image_digest",
          "initial_challenge_digest",
          "initial_attestation_digest",
          "post_restart_challenge_digest",
          "post_restart_attestation_digest",
          "diagnostics_redacted_confirmed_at",
          "restart_requested_at",
          "secrets_cleanup_confirmed_at",
          "provider_firewall_id",
        ]),
      );
      expect(columns).not.toEqual(
        expect.arrayContaining([
          "credential",
          "telegram_user_id",
          "message_text",
          "reply_text",
          "private_endpoint",
          "raw_log",
          "provider_response",
          "metadata",
          "payload_json",
        ]),
      );
      await expect(
        readConstraint(db, "hermes_staging_acceptance_runs_owner_user_id_users_id_fk"),
      ).resolves.toContain("FOREIGN KEY (owner_user_id) REFERENCES users(id)");
      await expect(
        readIndex(db, "hermes_staging_acceptance_runs_one_active_idx"),
      ).resolves.toContain("WHERE (state <> 'complete'::hermes_staging_acceptance_state)");
      await expect(readTrigger(db)).resolves.toEqual({ enabled: "O" });
      await expect(readColumns(db, "runners")).resolves.toContain("provider_firewall_id");

      const [owner] = await db<{ id: string }[]>`insert into users default values returning id`;
      if (!owner) throw new Error("Expected migration owner fixture.");
      await db`
        insert into runners (user_id, name, kind, endpoint_url)
        values (${owner.id}, 'manual firewall guard', 'manual_vps', 'http://127.0.0.1:3045')
      `;
      await insertRun(db, owner.id, "acceptance-clean-1");
      await expect(insertRun(db, owner.id, "acceptance-clean-2")).rejects.toMatchObject({
        constraint_name: "hermes_staging_acceptance_runs_one_active_idx",
      });
      await expect(db`
        update hermes_staging_acceptance_runs
        set expected_image_digest = ${digest("b")}
      `).rejects.toMatchObject({
        constraint_name: "hermes_staging_acceptance_runs_immutable_check",
      });
      await expect(db`
        update hermes_staging_acceptance_runs
        set state = 'complete', phase = 'complete', desired_outcome = 'cleanup',
            terminal_outcome = 'cancelled', error_code = 'acceptance_cancelled',
            next_attempt_at = null, completed_at = updated_at
      `).rejects.toMatchObject({
        constraint_name: "hermes_staging_acceptance_runs_terminal_check",
      });
      await expect(db`
        update runners set provider_firewall_id = 'forbidden'
        where kind = 'manual_vps'
      `).rejects.toMatchObject({
        constraint_name: "runners_digitalocean_provider_fields_check",
      });
    } finally {
      await db.end();
    }
  });

  it("upgrades without backfilling runs or mutating existing users and runners", async () => {
    const databaseUrl = await createDisposableDatabaseUrl("upgrade");
    const db = postgres(databaseUrl, { max: 1 });

    try {
      await applyMigrationsThrough(db, 19);
      await db`insert into users (id) values ('00000000-0000-4000-8000-000000010001')`;
      await db`
        insert into runners (id, user_id, name, kind, endpoint_url, status)
        values (
          '00000000-0000-4000-8000-000000010101',
          '00000000-0000-4000-8000-000000010001',
          'upgrade sentinel', 'manual_vps', 'http://127.0.0.1:3045', 'offline'
        )
      `;
      const before = await db`select * from runners`;

      await runDbMigrate(databaseUrl);
      await runDbMigrate(databaseUrl);

      await expect(
        db`select count(*)::int as count from hermes_staging_acceptance_runs`,
      ).resolves.toEqual([{ count: 0 }]);
      const after = await db`select * from runners`;
      expect(after).toEqual(before.map((row) => ({ ...row, provider_firewall_id: null })));
    } finally {
      await db.end();
    }
  });

  it("has no generated schema drift in an isolated migration output", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "plingpling-step10-drizzle-"));
    const migrationCopy = join(temporaryRoot, "drizzle");
    try {
      await cp("drizzle", migrationCopy, { recursive: true });
      const before = await readdir(migrationCopy);
      const { stdout, stderr } = await execFileAsync(
        "bunx",
        [
          "drizzle-kit",
          "generate",
          "--dialect=postgresql",
          "--schema=./src/server/db/schema.ts",
          `--out=${relative(process.cwd(), migrationCopy)}`,
        ],
        { cwd: process.cwd(), timeout: 30_000 },
      );
      expect(`${stdout}\n${stderr}`).toContain("No schema changes");
      await expect(readdir(migrationCopy)).resolves.toEqual(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

async function insertRun(db: postgres.Sql, ownerUserId: string, idempotencyKey: string) {
  return db`
    insert into hermes_staging_acceptance_runs (
      owner_user_id, idempotency_key, next_attempt_at, deadline_at,
      cleanup_deadline_at, expected_source_revision, expected_publish_workflow_run_id,
      expected_image_digest, created_at, updated_at
    ) values (
      ${ownerUserId}, ${idempotencyKey}, '2026-08-03T10:00:00Z',
      '2026-08-03T11:00:00Z', '2026-08-03T12:00:00Z', ${"a".repeat(40)},
      '123456789', ${digest("a")},
      '2026-08-03T10:00:00Z', '2026-08-03T10:00:00Z'
    )
  `;
}

async function readEnum(db: postgres.Sql, name: string): Promise<string[]> {
  const rows = await db<{ enumlabel: string }[]>`
    select e.enumlabel from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = ${name}
    order by e.enumsortorder
  `;
  return rows.map((row) => row.enumlabel);
}

async function readColumns(db: postgres.Sql, table: string): Promise<string[]> {
  const rows = await db<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by ordinal_position
  `;
  return rows.map((row) => row.column_name);
}

async function readConstraint(db: postgres.Sql, name: string): Promise<string> {
  const [row] = await db<{ definition: string }[]>`
    select pg_get_constraintdef(oid) as definition from pg_constraint where conname = ${name}
  `;
  return row?.definition ?? "";
}

async function readIndex(db: postgres.Sql, name: string): Promise<string> {
  const [row] = await db<{ indexdef: string }[]>`
    select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}
  `;
  return row?.indexdef ?? "";
}

async function readTrigger(db: postgres.Sql): Promise<{ enabled: string } | undefined> {
  const [row] = await db<{ enabled: string }[]>`
    select tgenabled as enabled from pg_trigger
    where tgname = 'hermes_staging_acceptance_runs_immutable_trigger'
  `;
  return row;
}

async function createDisposableDatabaseUrl(label: string): Promise<string> {
  const database =
    `plingpling_step10_migration_${label}_${process.pid}_${Date.now()}`.toLowerCase();
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`create database ${quoteIdentifier(database)}`);
    CREATED_DATABASES.push(database);
  } finally {
    await admin.end();
  }
  return databaseUrlFor(database);
}

async function cleanupCreatedDatabases(): Promise<void> {
  const databases = CREATED_DATABASES.splice(0);
  if (databases.length === 0) return;
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
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
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 30_000,
  });
}

async function applyMigrationsThrough(db: postgres.Sql, lastIndex: number): Promise<void> {
  await db`create schema if not exists drizzle`;
  await db`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key, hash text not null, created_at bigint
    )
  `;
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const files = (await readdir("drizzle"))
    .filter((file) => /^00\d{2}_.+\.sql$/.test(file))
    .sort()
    .filter((file) => Number(file.slice(0, 4)) <= lastIndex);
  for (const file of files) {
    const migration = await readFile(`drizzle/${file}`, "utf8");
    for (const statement of migration
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await db.unsafe(statement);
    }
    const entry = journal.entries.find((candidate) => candidate.idx === Number(file.slice(0, 4)));
    if (!entry) throw new Error(`Missing journal entry for ${file}.`);
    await db`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values (${createHash("sha256").update(migration).digest("hex")}, ${entry.when})
    `;
  }
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function validatedBaseUrl(): URL {
  const url = new URL(BASE_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Staging migration fixtures require loopback PostgreSQL.");
  }
  return url;
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
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error("Invalid disposable database name.");
  return `"${value}"`;
}
