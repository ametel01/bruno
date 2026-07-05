import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { appMetadata, runnerCredentials, runners, users } from "@/src/server/db/schema";
import { recordRunnerHeartbeat } from "@/src/server/runners/runner-heartbeat";
import { hashRunnerSecret } from "@/src/server/runners/runner-auth-secrets";
import {
  revokeRunnerCredentialForDevelopmentUser,
  rotateRunnerCredentialForDevelopmentUser,
} from "@/src/server/runners/runner-credential-lifecycle";
import { DEVELOPMENT_USER_METADATA_KEY } from "@/src/server/users/development-user";

describe.sequential("runner credential lifecycle", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetRunnerCredentialLifecycleTables(connection);
  });

  afterEach(async () => {
    await resetRunnerCredentialLifecycleTables(connection);
    await connection.close();
  });

  it("rotates a runner credential once, stores only the new hash, and rejects the old credential through heartbeat auth", async () => {
    const oldCredential = "agb_run_oldcredential_123456789012345678901234567890";
    const runner = await seedDevelopmentRunnerCredential(connection, {
      credentialValue: oldCredential,
    });

    const beforeRotation = await recordRunnerHeartbeat(
      {
        authorizationHeader: `Bearer ${oldCredential}`,
        payload: { runnerId: runner.id },
      },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-05T08:00:00.000Z"),
      },
    );

    expect(beforeRotation.ok).toBe(true);

    const result = await rotateRunnerCredentialForDevelopmentUser(
      { runnerId: runner.id },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-05T08:01:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      runner: { id: runner.id },
      credential: {
        token: expect.stringMatching(/^agb_run_/),
        prefix: expect.any(String),
        rotatedAt: "2026-07-05T08:01:00.000Z",
      },
    });

    if (!result.ok) {
      throw new Error("Expected credential rotation to succeed.");
    }

    expect(result.credential.prefix).toBe(result.credential.token.slice(0, 16));
    expect(JSON.stringify(result)).not.toContain(oldCredential);

    const persistedCredentials = await connection.db
      .select()
      .from(runnerCredentials)
      .where(eq(runnerCredentials.runnerId, runner.id));
    const activeCredential = persistedCredentials.find(
      (credential) => credential.status === "active",
    );
    const revokedCredential = persistedCredentials.find(
      (credential) => credential.status === "revoked",
    );

    expect(persistedCredentials).toHaveLength(2);
    expect(activeCredential).toMatchObject({
      runnerId: runner.id,
      credentialPrefix: result.credential.prefix,
      revokedAt: null,
    });
    expect(activeCredential?.credentialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(revokedCredential).toMatchObject({
      runnerId: runner.id,
      credentialHash: hashRunnerSecret(oldCredential),
      status: "revoked",
      revokedAt: new Date("2026-07-05T08:01:00.000Z"),
    });
    expect(JSON.stringify(persistedCredentials)).not.toContain(result.credential.token);
    expect(JSON.stringify(persistedCredentials)).not.toContain(oldCredential);
    expect(JSON.stringify(result)).not.toContain(activeCredential?.credentialHash);
    expect(JSON.stringify(result)).not.toContain(revokedCredential?.credentialHash);

    const oldCredentialHeartbeat = await recordRunnerHeartbeat(
      {
        authorizationHeader: `Bearer ${oldCredential}`,
        payload: { runnerId: runner.id },
      },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-05T08:02:00.000Z"),
      },
    );
    const newCredentialHeartbeat = await recordRunnerHeartbeat(
      {
        authorizationHeader: `Bearer ${result.credential.token}`,
        payload: { runnerId: runner.id },
      },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-05T08:03:00.000Z"),
      },
    );

    expect(oldCredentialHeartbeat).toEqual({ ok: false, reason: "invalid_credential" });
    expect(newCredentialHeartbeat).toMatchObject({
      ok: true,
      runner: { id: runner.id, observedAt: "2026-07-05T08:03:00.000Z" },
    });
  });

  it("revokes active runner credentials and rejects revoked credentials through heartbeat auth", async () => {
    const credential = "agb_run_revokedcredential_123456789012345678901234567890";
    const runner = await seedDevelopmentRunnerCredential(connection, {
      credentialValue: credential,
    });

    const result = await revokeRunnerCredentialForDevelopmentUser(
      { runnerId: runner.id },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-05T09:00:00.000Z"),
      },
    );

    expect(result).toEqual({
      ok: true,
      runner: { id: runner.id },
      credential: {
        revokedAt: "2026-07-05T09:00:00.000Z",
        revokedCredentialCount: 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain(credential);

    const [persistedCredential] = await connection.db
      .select()
      .from(runnerCredentials)
      .where(eq(runnerCredentials.runnerId, runner.id))
      .limit(1);

    expect(persistedCredential).toMatchObject({
      runnerId: runner.id,
      credentialHash: hashRunnerSecret(credential),
      status: "revoked",
      revokedAt: new Date("2026-07-05T09:00:00.000Z"),
    });

    const heartbeat = await recordRunnerHeartbeat(
      {
        authorizationHeader: `Bearer ${credential}`,
        payload: { runnerId: runner.id },
      },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-05T09:01:00.000Z"),
      },
    );

    expect(heartbeat).toEqual({ ok: false, reason: "invalid_credential" });
    await expect(countRows(connection, "runner_heartbeats")).resolves.toBe(0);
  });

  it("returns safe management failures for malformed runner IDs, missing runners, and already-revoked credentials", async () => {
    const runner = await seedDevelopmentRunnerCredential(connection, {
      credentialValue: "agb_run_alreadyrevoked_123456789012345678901234567890",
      credentialOverrides: {
        status: "revoked",
        revokedAt: new Date("2026-07-05T10:00:00.000Z"),
      },
    });

    await expect(
      rotateRunnerCredentialForDevelopmentUser(
        { runnerId: "not-a-runner-id" },
        { createConnection: () => connection },
      ),
    ).resolves.toEqual({ ok: false, reason: "malformed_runner_id" });
    await expect(
      revokeRunnerCredentialForDevelopmentUser(
        { runnerId: "" },
        { createConnection: () => connection },
      ),
    ).resolves.toEqual({ ok: false, reason: "missing_runner_id" });
    await expect(
      rotateRunnerCredentialForDevelopmentUser(
        { runnerId: "00000000-0000-4000-8000-000000000131" },
        { createConnection: () => connection },
      ),
    ).resolves.toEqual({ ok: false, reason: "runner_not_found" });
    await expect(
      revokeRunnerCredentialForDevelopmentUser(
        { runnerId: runner.id },
        { createConnection: () => connection },
      ),
    ).resolves.toEqual({ ok: false, reason: "runner_credential_already_revoked" });
  });
});

async function seedDevelopmentRunnerCredential(
  connection: DatabaseConnection,
  input: {
    credentialValue: string;
    credentialOverrides?: Partial<typeof runnerCredentials.$inferInsert>;
  },
): Promise<{ id: string }> {
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

  if (!user) {
    throw new Error("Test user insert returned no rows.");
  }

  await connection.db.insert(appMetadata).values({
    key: DEVELOPMENT_USER_METADATA_KEY,
    value: user.id,
  });

  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId: user.id,
      name: "Lifecycle Test Runner",
      kind: "manual_vps",
      endpointUrl: "https://lifecycle-runner.example.com",
      status: "active",
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Test runner insert returned no rows.");
  }

  await connection.db.insert(runnerCredentials).values({
    runnerId: runner.id,
    credentialHash: hashRunnerSecret(input.credentialValue),
    credentialPrefix: input.credentialValue.slice(0, 16),
    status: "active",
    ...input.credentialOverrides,
  });

  return runner;
}

async function resetRunnerCredentialLifecycleTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}

async function countRows(
  connection: DatabaseConnection,
  tableName: "runner_heartbeats",
): Promise<number> {
  const [row] = await connection.db.execute<{ count: string }>(
    sql.raw(`select count(*)::text as count from ${tableName}`),
  );

  return Number(row?.count ?? 0);
}
