import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorConversations,
  operatorMailConnections,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  FOUNDER_ACTIVE_PURGE_WINDOW_MS,
  FOUNDER_BACKUP_EXPIRY_WINDOW_MS,
  getFounderDeletionReceiptForUser,
  processFounderDeletionRequests,
  requestFounderDeletionForUser,
  retryFounderDeletionRevocationsForUser,
} from "@/src/server/operators/founder-deletion";

const OWNER_ID = "00000000-0000-4000-8000-000000003701";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000003702";
const OPERATOR_ID = "00000000-0000-4000-8000-000000003703";
const OTHER_OPERATOR_ID = "00000000-0000-4000-8000-000000003704";
const NOW = new Date("2026-08-20T00:00:00.000Z");

describe("Founder deletion lifecycle", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.db.insert(users).values([
      { id: OWNER_ID, createdAt: NOW, updatedAt: NOW },
      { id: OTHER_OWNER_ID, createdAt: NOW, updatedAt: NOW },
    ]);
    await connection.db.insert(operators).values([
      { id: OPERATOR_ID, userId: OWNER_ID, createdAt: NOW, updatedAt: NOW },
      { id: OTHER_OPERATOR_ID, userId: OTHER_OWNER_ID, createdAt: NOW, updatedAt: NOW },
    ]);
  });

  afterEach(async () => {
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.close();
  });

  it("stops access immediately, is idempotent, and purges only the requesting owner", async () => {
    await connection.db.insert(operatorConversations).values([
      {
        id: "00000000-0000-4000-8000-000000003705",
        operatorId: OPERATOR_ID,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "00000000-0000-4000-8000-000000003706",
        operatorId: OTHER_OPERATOR_ID,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const dependencies = { createConnection: () => connection, now: () => NOW };
    const first = await requestFounderDeletionForUser(OWNER_ID, "retained_data", {}, dependencies);
    const second = await requestFounderDeletionForUser(OWNER_ID, "retained_data", {}, dependencies);
    expect(first?.request.id).toBe(second?.request.id);
    expect(first?.request.accessStoppedAt).toBe(NOW.toISOString());
    const [operator] = await connection.db
      .select()
      .from(operators)
      .where(eq(operators.id, OPERATOR_ID));
    expect(operator?.externalActionPause).toBe(true);

    const processed = await processFounderDeletionRequests({
      createConnection: () => connection,
      now: () => new Date(NOW.getTime() + FOUNDER_ACTIVE_PURGE_WINDOW_MS),
    });
    expect(processed).toEqual({ processed: 1, failed: 0 });
    const remaining = await connection.db.select().from(operatorConversations);
    expect(remaining).toEqual([
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000003706" }),
    ]);
    const receipt = await getFounderDeletionReceiptForUser(OWNER_ID, {
      createConnection: () => connection,
    });
    expect(receipt?.request.status).toBe("backup_expiry_pending");
    expect(receipt?.stages.map((stage) => stage.stage)).toEqual(
      expect.arrayContaining(["requested", "access_stopped", "active_purge_complete"]),
    );
  });

  it("expires backup copies at the 30-day boundary and archives closed accounts", async () => {
    const receipt = await requestFounderDeletionForUser(
      OWNER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => NOW,
        revokeConnections: async () => [],
      },
    );
    expect(receipt?.revocations).toEqual([]);
    await processFounderDeletionRequests({
      createConnection: () => connection,
      now: () => new Date(NOW.getTime() + FOUNDER_BACKUP_EXPIRY_WINDOW_MS),
    });
    const [operator] = await connection.db
      .select()
      .from(operators)
      .where(eq(operators.id, OPERATOR_ID));
    expect(operator?.status).toBe("archived");
    const completed = await getFounderDeletionReceiptForUser(OWNER_ID, {
      createConnection: () => connection,
    });
    expect(completed?.request.status).toBe("completed");
    expect(completed?.stages.map((stage) => stage.stage)).toContain("backup_expiry");
  });

  it("keeps revocation failures visible and retryable after local credential removal", async () => {
    await connection.db.insert(operatorMailConnections).values({
      id: "00000000-0000-4000-8000-000000003707",
      operatorId: OPERATOR_ID,
      providerSubjectId: "gmail-founder",
      accountLabel: "founder@example.com",
      status: "ready",
      authorizationState: "authorized",
      accessTokenCiphertext: "access",
      accessTokenIv: "access-iv",
      accessTokenAuthTag: "access-tag",
      refreshTokenCiphertext: "refresh",
      refreshTokenIv: "refresh-iv",
      refreshTokenAuthTag: "refresh-tag",
      secretKeyVersion: "test-v1",
      authorizedAt: NOW,
      lastVerifiedAt: NOW,
      lastEvidenceAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const failed = await requestFounderDeletionForUser(
      OWNER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => NOW,
        revokeConnections: async () => [
          { connectionKind: "mail", ok: false, errorCode: "provider_503" },
        ],
      },
    );
    expect(failed?.revocations).toEqual([
      expect.objectContaining({
        connectionKind: "mail",
        status: "failed",
        attemptCount: 1,
        errorCode: "provider_503",
      }),
    ]);
    const [locallyRemoved] = await connection.db
      .select()
      .from(operatorMailConnections)
      .where(eq(operatorMailConnections.id, "00000000-0000-4000-8000-000000003707"));
    expect(locallyRemoved).toEqual(
      expect.objectContaining({
        status: "disconnected",
        authorizationState: "revocation_unconfirmed",
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
      }),
    );

    const retried = await retryFounderDeletionRevocationsForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => new Date(NOW.getTime() + 60 * 60 * 1000),
      revokeConnections: async () => [{ connectionKind: "mail", ok: true }],
    });
    expect(retried?.revocations).toEqual([
      expect.objectContaining({ connectionKind: "mail", status: "succeeded", attemptCount: 2 }),
    ]);
    expect(retried?.stages.map((stage) => stage.stage)).toContain("revocation");
  });
});
