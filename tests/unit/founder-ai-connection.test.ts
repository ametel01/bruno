import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  disconnectFounderOpenAiForUser,
  pollFounderOpenAiAuthorizationForUser,
  requireReadyFounderOpenAiConnectionForUser,
  recheckFounderOpenAiConnectionForUser,
  startFounderOpenAiAuthorizationForUser,
  type FounderOpenAiAdapter,
} from "@/src/server/operators/founder-ai-connection";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorAiConnectionReceipts,
  operatorAiConnections,
  operatorPreparations,
  operatorRuntimes,
  users,
} from "@/src/server/db/schema";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";

const OWNER_ID = "00000000-0000-4000-8000-000000003391";

describe("Founder OpenAI AI Connection application seam", () => {
  let connection: DatabaseConnection;
  const now = new Date("2026-08-18T01:00:00.000Z");

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values({ id: OWNER_ID });
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => now,
    });
    expect(operator.userId).toBe(OWNER_ID);
    await confirmFounderTimezoneForUser(OWNER_ID, "Asia/Manila", {
      createConnection: () => connection,
      now: () => now,
    });
    await connection.db.update(operatorPreparations).set({ status: "ready", completedAt: now });
    await connection.db
      .update(operatorRuntimes)
      .set({ status: "ready", transportState: "connected", safetyState: "verified", readyAt: now });
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("connects through device authorization and requires every readiness gate", async () => {
    const adapter = adapterFor({
      poll: {
        state: "authorized",
        providerIdentity: "acct_founder_123",
        accountLabel: "founder@example.com",
      },
      verification: readyVerification(),
    });
    const started = await startFounderOpenAiAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    expect(started.authorization).toMatchObject({
      authorizationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });

    const result = await pollFounderOpenAiAuthorizationForUser(OWNER_ID, "session-1", {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    expect(result).toMatchObject({
      provider: "openai",
      status: "ready",
      accountLabel: "founder@example.com",
      workState: "available",
      receipt: { outcome: "connected" },
    });
    expect(JSON.stringify(result)).not.toMatch(/model|token|secret|credential|api.?key/i);
    await expect(connection.db.select().from(operatorAiConnectionReceipts)).resolves.toHaveLength(
      1,
    );
  });

  it.each([
    ["denied", { state: "denied" as const }, "needs_attention"],
    ["expired", { state: "expired" as const }, "needs_attention"],
  ])("pauses ordinary setup after an authorization is %s", async (_name, poll, status) => {
    const adapter = adapterFor({ poll });
    const started = await startFounderOpenAiAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    const result = await pollFounderOpenAiAuthorizationForUser(
      OWNER_ID,
      started.authorization?.sessionId ?? "",
      {
        createConnection: () => connection,
        adapter,
        now: () => now,
      },
    );
    expect(result.status).toBe(status);
    expect(result.workState).toBe("paused");
  });

  it("keeps a quota-exhausted account connected but pauses affected work", async () => {
    const adapter = adapterFor({
      poll: {
        state: "authorized",
        providerIdentity: "acct_founder_123",
        accountLabel: "founder@example.com",
      },
      verification: { ...readyVerification(), capacity: "exhausted" },
    });
    const started = await startFounderOpenAiAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    const result = await pollFounderOpenAiAuthorizationForUser(
      OWNER_ID,
      started.authorization?.sessionId ?? "",
      {
        createConnection: () => connection,
        adapter,
        now: () => now,
      },
    );
    expect(result).toMatchObject({ status: "paused", workState: "paused" });
    expect(result.recoveryMessage).toContain("capacity");
  });

  it("blocks downstream work instead of allowing a provider fallback", async () => {
    await expect(
      requireReadyFounderOpenAiConnectionForUser(OWNER_ID, {
        createConnection: () => connection,
        adapter: adapterFor({
          verification: { ...readyVerification(), capacity: "exhausted" },
        }),
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: "ai_connection_paused" });
  });

  it("detects lost persisted authorization after a runtime restart", async () => {
    const adapter = adapterFor({
      poll: {
        state: "authorized",
        providerIdentity: "acct_founder_123",
        accountLabel: "founder@example.com",
      },
      verification: readyVerification(),
    });
    const started = await startFounderOpenAiAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    await pollFounderOpenAiAuthorizationForUser(OWNER_ID, started.authorization?.sessionId ?? "", {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    const afterRestart = await recheckFounderOpenAiConnectionForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter: adapterFor({
        verification: { ...readyVerification(), authorizationPersisted: false },
      }),
      now: () => new Date(now.getTime() + 60_000),
    });
    expect(afterRestart).toMatchObject({ status: "needs_attention", workState: "paused" });
  });

  it("revokes locally, pauses work, and reconnects the same identity with preserved receipts", async () => {
    const adapter = adapterFor({
      poll: {
        state: "authorized",
        providerIdentity: "acct_founder_123",
        accountLabel: "founder@example.com",
      },
      verification: readyVerification(),
    });
    const first = await startFounderOpenAiAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    await pollFounderOpenAiAuthorizationForUser(OWNER_ID, first.authorization?.sessionId ?? "", {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    const disconnected = await disconnectFounderOpenAiForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    expect(disconnected).toMatchObject({
      status: "disconnected",
      workState: "paused",
      receipt: { outcome: "disconnected" },
    });
    const second = await startFounderOpenAiAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    await pollFounderOpenAiAuthorizationForUser(OWNER_ID, second.authorization?.sessionId ?? "", {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    const rows = await connection.db.select().from(operatorAiConnectionReceipts);
    expect(rows.map((row) => row.kind)).toEqual(
      expect.arrayContaining(["authorized", "revoked", "reauthorized"]),
    );
    expect(
      (await connection.db.select().from(operatorAiConnections))[0]?.authorizationGeneration,
    ).toBe(2);
  });

  it("does not claim provider revocation when Hermes cannot confirm it", async () => {
    const adapter = adapterFor({
      poll: {
        state: "authorized",
        providerIdentity: "acct_founder_123",
        accountLabel: "founder@example.com",
      },
      verification: readyVerification(),
      providerRevoked: false,
    });
    const started = await startFounderOpenAiAuthorizationForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    await pollFounderOpenAiAuthorizationForUser(OWNER_ID, started.authorization?.sessionId ?? "", {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });

    const disconnected = await disconnectFounderOpenAiForUser(OWNER_ID, {
      createConnection: () => connection,
      adapter,
      now: () => now,
    });
    expect(disconnected).toMatchObject({
      status: "disconnected",
      workState: "paused",
      recoveryMessage: expect.stringContaining("could not be confirmed"),
    });
    const [row] = await connection.db.select().from(operatorAiConnections);
    expect(row?.authorizationState).toBe("revocation_unconfirmed");
    expect(row?.revokedAt).toBeNull();
    const receipts = await connection.db.select().from(operatorAiConnectionReceipts);
    expect(receipts.at(-1)?.kind).toBe("disconnected");
  });
});

function readyVerification() {
  return {
    providerIdentity: "acct_founder_123",
    accountLabel: "founder@example.com",
    eligibleAccount: true,
    authorizationPersisted: true,
    approvedModelAssigned: true,
    capacity: "available" as const,
    inference: "passed" as const,
  };
}

function adapterFor(
  input: Partial<Pick<FounderOpenAiAdapter, "pollAuthorization" | "verifyConnection">> & {
    poll?: Awaited<ReturnType<FounderOpenAiAdapter["pollAuthorization"]>>;
    verification?: Awaited<ReturnType<FounderOpenAiAdapter["verifyConnection"]>>;
    providerRevoked?: boolean;
  },
): FounderOpenAiAdapter {
  return {
    startAuthorization: async () => ({
      ok: true as const,
      authorization: {
        sessionId: "session-1",
        authorizationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        expiresAt: new Date("2026-08-18T01:15:00.000Z"),
      },
    }),
    pollAuthorization: async () => input.poll ?? { state: "pending" },
    verifyConnection: async () => input.verification ?? readyVerification(),
    revokeAuthorization: async () => ({ providerRevoked: input.providerRevoked ?? true }),
  };
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_ai_connection_receipts, operator_ai_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
