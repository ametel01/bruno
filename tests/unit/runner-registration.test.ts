import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerCredentials, runnerRegistrationTokens, runners } from "@/src/server/db/schema";
import { createRunnerRegistrationToken } from "@/src/server/runners/runner-auth-secrets";
import {
  createRunnerRegistrationTokenForDevelopmentUser,
  exchangeRunnerRegistrationTokenForCredential,
  type ExchangeRunnerRegistrationTokenResult,
} from "@/src/server/runners/runner-registration";

type ExchangeFailureReason = Extract<
  ExchangeRunnerRegistrationTokenResult,
  { ok: false }
>["reason"];

describe.sequential("runner registration service", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("creates a visible-once registration token while persisting only hash material", async () => {
    const result = await createRunnerRegistrationTokenForDevelopmentUser({
      createConnection: () => connection,
      now: () => new Date("2026-07-05T08:00:00.000Z"),
    });

    expect(result.registrationToken.token).toMatch(/^agb_reg_/);
    expect(result.registrationToken.prefix).toBe(result.registrationToken.token.slice(0, 16));
    expect(result.registrationToken.expiresAt).toBe("2026-07-05T08:15:00.000Z");

    const persistedTokens = await connection.db.select().from(runnerRegistrationTokens);

    expect(persistedTokens).toHaveLength(1);
    expect(persistedTokens[0]).toMatchObject({
      id: result.registrationToken.id,
      tokenPrefix: result.registrationToken.prefix,
      status: "pending",
    });
    expect(persistedTokens[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persistedTokens)).not.toContain(result.registrationToken.token);
    expect(JSON.stringify(result)).not.toContain(persistedTokens[0]?.tokenHash);
  });

  it("exchanges a valid registration token for runner identity and one visible-once credential", async () => {
    const created = await createRunnerRegistrationTokenForDevelopmentUser({
      createConnection: () => connection,
      now: () => new Date("2026-07-05T08:00:00.000Z"),
    });

    const result = await exchangeRunnerRegistrationTokenForCredential(
      {
        registrationToken: created.registrationToken.token,
        endpointUrl: "http://127.0.0.1:8787",
        name: "Registered Runner",
      },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-05T08:01:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      runner: {
        id: expect.any(String),
      },
      credential: {
        token: expect.stringMatching(/^agb_run_/),
        prefix: expect.any(String),
      },
    });

    if (!result.ok) {
      throw new Error("Expected runner registration exchange to succeed.");
    }

    const [persistedToken] = await connection.db.select().from(runnerRegistrationTokens);
    const [persistedCredential] = await connection.db.select().from(runnerCredentials);
    const [persistedRunner] = await connection.db.select().from(runners);

    expect(persistedToken).toMatchObject({
      status: "used",
      runnerId: result.runner.id,
    });
    expect(persistedRunner).toMatchObject({
      id: result.runner.id,
      name: "Registered Runner",
      endpointUrl: "http://127.0.0.1:8787",
      status: "active",
    });
    expect(persistedCredential).toMatchObject({
      runnerId: result.runner.id,
      credentialPrefix: result.credential.prefix,
      status: "active",
    });
    expect(persistedCredential?.credentialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([persistedToken, persistedCredential, persistedRunner])).not.toContain(
      created.registrationToken.token,
    );
    expect(JSON.stringify([persistedToken, persistedCredential, persistedRunner])).not.toContain(
      result.credential.token,
    );
    expect(JSON.stringify(result)).not.toContain(persistedToken?.tokenHash);
    expect(JSON.stringify(result)).not.toContain(persistedCredential?.credentialHash);
  });

  it("fails safely for missing, malformed, wrong-prefix, unknown, expired, revoked, and used tokens", async () => {
    await expectExchangeReason("   ", "missing_registration_token");
    await expectExchangeReason("agb_reg_short", "malformed_registration_token");
    await expectExchangeReason(
      "agb_run_1234567890123456789012345678901234567890123",
      "wrong_registration_token_prefix",
    );
    await expectExchangeReason(createRunnerRegistrationToken().value, "unknown_registration_token");

    const expired = await createRunnerRegistrationTokenForDevelopmentUser({
      createConnection: () => connection,
      now: () => new Date("2026-07-05T08:00:00.000Z"),
    });
    await expectExchangeReason(
      expired.registrationToken.token,
      "expired_registration_token",
      new Date("2026-07-05T08:16:00.000Z"),
    );

    const revoked = await createRunnerRegistrationTokenForDevelopmentUser({
      createConnection: () => connection,
      now: () => new Date("2026-07-05T09:00:00.000Z"),
    });
    await connection.db
      .update(runnerRegistrationTokens)
      .set({
        status: "revoked",
        revokedAt: new Date("2026-07-05T09:01:00.000Z"),
      })
      .where(eq(runnerRegistrationTokens.id, revoked.registrationToken.id));
    await expectExchangeReason(
      revoked.registrationToken.token,
      "revoked_registration_token",
      new Date("2026-07-05T09:02:00.000Z"),
    );

    const used = await createRunnerRegistrationTokenForDevelopmentUser({
      createConnection: () => connection,
      now: () => new Date("2026-07-05T10:00:00.000Z"),
    });
    const firstUse = await exchangeRunnerRegistrationTokenForCredential(
      {
        registrationToken: used.registrationToken.token,
        endpointUrl: "http://127.0.0.1:8788",
        name: "Already Used Runner",
      },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-05T10:01:00.000Z"),
      },
    );

    expect(firstUse.ok).toBe(true);
    await expectExchangeReason(
      used.registrationToken.token,
      "used_registration_token",
      new Date("2026-07-05T10:02:00.000Z"),
    );
  });

  it("allows only one exchange under concurrent registration attempts", async () => {
    const created = await createRunnerRegistrationTokenForDevelopmentUser({
      createConnection: () => connection,
      now: () => new Date("2026-07-05T11:00:00.000Z"),
    });

    const attempts = await Promise.all([
      exchangeRunnerRegistrationTokenForCredential(
        {
          registrationToken: created.registrationToken.token,
          endpointUrl: "http://127.0.0.1:8790",
          name: "Concurrent Runner",
        },
        { now: () => new Date("2026-07-05T11:01:00.000Z") },
      ),
      exchangeRunnerRegistrationTokenForCredential(
        {
          registrationToken: created.registrationToken.token,
          endpointUrl: "http://127.0.0.1:8790",
          name: "Concurrent Runner",
        },
        { now: () => new Date("2026-07-05T11:01:00.000Z") },
      ),
    ]);

    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.ok)).toEqual([
      { ok: false, reason: "used_registration_token" },
    ]);

    const persistedCredentials = await connection.db.select().from(runnerCredentials);
    const persistedTokens = await connection.db.select().from(runnerRegistrationTokens);

    expect(persistedCredentials).toHaveLength(1);
    expect(persistedTokens).toHaveLength(1);
    expect(persistedTokens[0]).toMatchObject({
      status: "used",
      runnerId: persistedCredentials[0]?.runnerId,
    });
  });

  async function expectExchangeReason(
    registrationToken: string,
    reason: ExchangeFailureReason,
    now = new Date("2026-07-05T08:01:00.000Z"),
  ) {
    const result = await exchangeRunnerRegistrationTokenForCredential(
      {
        registrationToken,
        endpointUrl: "http://127.0.0.1:8789",
        name: "Rejected Runner",
      },
      {
        createConnection: () => connection,
        now: () => now,
      },
    );

    expect(result).toEqual({ ok: false, reason });
  }
});

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_credentials, runner_heartbeats, runner_registration_tokens, agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runners, app_metadata, users restart identity cascade`;
}
