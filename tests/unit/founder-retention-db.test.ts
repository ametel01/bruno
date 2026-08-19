import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorConversationMessages,
  operatorConversationWorks,
  operatorConversations,
  operatorRelationshipRecords,
  operatorRetentionRuns,
  operatorRetentionTombstones,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  FOUNDER_WORKING_CONTEXT_RETENTION_MS,
  getFounderRetentionStatusForUser,
  processFounderRetentionForUser,
} from "@/src/server/operators/founder-retention";

const OWNER_ID = "00000000-0000-4000-8000-000000003901";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000003902";
const OPERATOR_ID = "00000000-0000-4000-8000-000000003903";
const OTHER_OPERATOR_ID = "00000000-0000-4000-8000-000000003904";
const NOW = new Date("2026-08-20T00:00:00.000Z");

describe("Founder retention lifecycle", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.db.insert(users).values([{ id: OWNER_ID }, { id: OTHER_OWNER_ID }]);
    await connection.db.insert(operators).values([
      { id: OPERATOR_ID, userId: OWNER_ID, createdAt: NOW, updatedAt: NOW },
      { id: OTHER_OPERATOR_ID, userId: OTHER_OWNER_ID, createdAt: NOW, updatedAt: NOW },
    ]);
  });

  afterEach(async () => {
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.close();
  });

  it("expires working context at the injected 90-day boundary, preserves an owner-scoped tombstone, and is idempotent", async () => {
    const oldAt = new Date(NOW.getTime() - FOUNDER_WORKING_CONTEXT_RETENTION_MS - 1);
    const conversationId = "00000000-0000-4000-8000-000000003905";
    const workId = "00000000-0000-4000-8000-000000003906";
    await connection.db.insert(operatorConversations).values({
      id: conversationId,
      operatorId: OPERATOR_ID,
      createdAt: oldAt,
      updatedAt: oldAt,
    });
    await connection.db.insert(operatorConversationWorks).values({
      id: workId,
      conversationId,
      requestId: "request-old",
      checkpointId: "checkpoint-old",
      responseSequence: 1,
      createdAt: oldAt,
      updatedAt: oldAt,
    });
    await connection.db.insert(operatorConversationMessages).values({
      id: "00000000-0000-4000-8000-000000003907",
      conversationId,
      workId,
      sequence: 1,
      role: "founder",
      body: "private working context",
      createdAt: oldAt,
    });
    await connection.db.insert(operatorConversations).values({
      id: "00000000-0000-4000-8000-000000003908",
      operatorId: OTHER_OPERATOR_ID,
      createdAt: oldAt,
      updatedAt: oldAt,
    });

    const dependencies = {
      createConnection: () => connection,
      now: () => NOW,
      runKey: "test-boundary",
    };
    const first = await processFounderRetentionForUser(OWNER_ID, dependencies);
    const second = await processFounderRetentionForUser(OWNER_ID, dependencies);

    expect(first?.status).toBe("completed");
    expect(first?.counts.conversations).toBe(1);
    expect(second).toEqual(first);
    expect(await connection.db.select().from(operatorConversations)).toEqual([
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000003908" }),
    ]);
    expect(await connection.db.select().from(operatorConversationMessages)).toEqual([]);
    expect(await connection.db.select().from(operatorRetentionRuns)).toHaveLength(1);
    expect(await connection.db.select().from(operatorRetentionTombstones)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operatorId: OPERATOR_ID,
          entityType: "operator_conversations",
        }),
      ]),
    );
  });

  it("warns thirty days before a closed Relationship Record expires", async () => {
    const closedAt = new Date("2025-09-20T00:00:00.000Z");
    await connection.db.insert(operatorRelationshipRecords).values({
      id: "00000000-0000-4000-8000-000000003909",
      operatorId: OPERATOR_ID,
      displayName: "Former relationship",
      status: "closed",
      closedAt,
      createdAt: closedAt,
      updatedAt: closedAt,
    });

    const status = await getFounderRetentionStatusForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(status?.warnings).toEqual([
      expect.objectContaining({ entityId: "00000000-0000-4000-8000-000000003909" }),
    ]);
  });

  it("removes a closed Relationship Record at twelve months and keeps only identities", async () => {
    const closedAt = new Date("2025-08-20T00:00:00.000Z");
    const recordId = "00000000-0000-4000-8000-000000003911";
    await connection.db.insert(operatorRelationshipRecords).values({
      id: recordId,
      operatorId: OPERATOR_ID,
      displayName: "Expired relationship",
      status: "ignored",
      closedAt,
      createdAt: closedAt,
      updatedAt: closedAt,
    });

    const result = await processFounderRetentionForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
      runKey: "relationship-boundary",
    });
    expect(result?.counts.relationshipRecords).toBe(1);
    expect(
      await connection.db
        .select()
        .from(operatorRelationshipRecords)
        .where(eq(operatorRelationshipRecords.id, recordId)),
    ).toEqual([]);
    expect(await connection.db.select().from(operatorRetentionTombstones)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "operator_relationship_records",
          entityId: recordId,
        }),
      ]),
    );
  });

  it("does not expose another owner's records through a retention run", async () => {
    const oldAt = new Date(NOW.getTime() - FOUNDER_WORKING_CONTEXT_RETENTION_MS - 1);
    await connection.db.insert(operatorConversations).values({
      id: "00000000-0000-4000-8000-000000003910",
      operatorId: OTHER_OPERATOR_ID,
      createdAt: oldAt,
      updatedAt: oldAt,
    });
    await processFounderRetentionForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
      runKey: "owner-scope",
    });
    expect(
      await connection.db
        .select()
        .from(operatorConversations)
        .where(eq(operatorConversations.operatorId, OTHER_OPERATOR_ID)),
    ).toHaveLength(1);
  });
});
