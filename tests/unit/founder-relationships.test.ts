import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorCalendarConnections,
  operatorMailConnections,
  operatorPreparations,
  operatorRelationshipCorrections,
  operatorRelationshipEvidence,
  operatorRelationshipRecords,
  operatorRuntimes,
  operators,
  users,
} from "@/src/server/db/schema";
import { FounderReleaseStageAccessError } from "@/src/server/founder-product-contract/release-stage-access";
import {
  confirmFounderRelationshipCandidateForUser,
  getFounderRelationshipsForUser,
  ingestFounderRelationshipEvidenceForUser,
  updateFounderRelationshipRecordForUser,
} from "@/src/server/operators/founder-relationships";

const OWNER_ID = "00000000-0000-4000-8000-000000003451";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000003452";
const NOW = new Date("2026-08-19T02:00:00.000Z");
const ALLOW_RELEASE_STAGE_ACCESS = async () => undefined;

describe("Founder Relationship Records", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await seedOwner(connection, OWNER_ID, "e2e-relationship-owner");
    await seedOwner(connection, OTHER_OWNER_ID, "e2e-relationship-other");
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("groups exact provider identity and email evidence without duplicates", async () => {
    const owner = await ownerIds(connection, OWNER_ID);
    const other = await ownerIds(connection, OTHER_OWNER_ID);
    await connection.db.insert(operatorRelationshipRecords).values({
      id: "00000000-0000-4000-8000-000000003461",
      operatorId: owner.operatorId,
      displayName: "Ari Singh",
      company: "Northstar Studio",
      primaryEmail: "ari@northstar.example",
      provider: "google",
      providerIdentity: "people/ari-1",
      founderConfirmedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await ingestFounderRelationshipEvidenceForUser(
      OWNER_ID,
      [
        observation(owner.calendarId, "calendar-event-1", {
          providerIdentity: "people/ari-1",
          displayName: "Ari Singh",
          company: "Northstar Studio",
          email: "ari@northstar.example",
        }),
        observation(
          owner.mailId,
          "mail-message-1",
          {
            displayName: "Ari (Northstar)",
            email: "ARI@NORTHSTAR.EXAMPLE",
            excerpt: "Follow up on the proposal.",
          },
          "mail",
        ),
      ],
      {
        createConnection: () => connection,
        now: () => NOW,
        requireReleaseStageAccess: ALLOW_RELEASE_STAGE_ACCESS,
      },
    );
    await ingestFounderRelationshipEvidenceForUser(
      OWNER_ID,
      [observation(owner.calendarId, "calendar-event-1", { email: "ari@northstar.example" })],
      {
        createConnection: () => connection,
        now: () => NOW,
        requireReleaseStageAccess: ALLOW_RELEASE_STAGE_ACCESS,
      },
    );

    const projected = await getFounderRelationshipsForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(projected.records).toHaveLength(1);
    expect(projected.records[0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000003461",
      evidenceState: "current",
    });
    expect(projected.records[0]?.evidence).toHaveLength(2);
    expect(projected.candidates).toHaveLength(0);
    expect(await connection.db.select().from(operatorRelationshipEvidence)).toHaveLength(2);
    expect(
      (
        await getFounderRelationshipsForUser(OTHER_OWNER_ID, {
          createConnection: () => connection,
          now: () => NOW,
        })
      ).records,
    ).toHaveLength(0);
    expect(other.operatorId).not.toBe(owner.operatorId);
  });

  it("keeps fuzzy evidence as a candidate until confirmation, then records corrections", async () => {
    const owner = await ownerIds(connection, OWNER_ID);
    await ingestFounderRelationshipEvidenceForUser(
      OWNER_ID,
      [
        observation(owner.calendarId, "calendar-fuzzy-1", {
          displayName: "Morgan Lee",
          company: "Acme Advisory",
          domain: "acme-advisory.example",
        }),
        observation(
          owner.mailId,
          "mail-fuzzy-1",
          {
            displayName: "Morgan Lee",
            company: "Acme Advisory",
            domain: "acme-advisory.example",
          },
          "mail",
        ),
      ],
      {
        createConnection: () => connection,
        now: () => NOW,
        requireReleaseStageAccess: ALLOW_RELEASE_STAGE_ACCESS,
      },
    );
    const before = await getFounderRelationshipsForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(before.records).toHaveLength(0);
    expect(before.candidates).toMatchObject([
      { matchKind: "fuzzy_domain", status: "pending", evidence: [{}, {}] },
    ]);

    const candidateId = before.candidates[0]?.id;
    if (!candidateId) throw new Error("Candidate was not created");
    const confirmed = await confirmFounderRelationshipCandidateForUser(OWNER_ID, candidateId, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(confirmed.records).toHaveLength(1);
    expect(confirmed.candidates[0]).toMatchObject({
      status: "confirmed",
      proposedRecordId: confirmed.records[0]?.id,
    });

    await ingestFounderRelationshipEvidenceForUser(
      OWNER_ID,
      [
        observation(owner.calendarId, "calendar-fuzzy-2", {
          displayName: "Morgan Lee",
          company: "Acme Advisory",
          domain: "acme-advisory.example",
        }),
      ],
      {
        createConnection: () => connection,
        now: () => NOW,
        requireReleaseStageAccess: ALLOW_RELEASE_STAGE_ACCESS,
      },
    );
    const withLaterEvidence = await getFounderRelationshipsForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(withLaterEvidence.records[0]?.evidence).toHaveLength(3);
    expect(withLaterEvidence.candidates.filter((item) => item.status === "pending")).toHaveLength(
      0,
    );

    const recordId = confirmed.records[0]?.id;
    if (!recordId) throw new Error("Record was not created");
    const updated = await updateFounderRelationshipRecordForUser(
      OWNER_ID,
      recordId,
      {
        relationshipState: "client",
        nextAction: "Send the revised proposal",
        commitments: ["Founder will send proposal", "Morgan will review by Friday"],
        status: "closed",
      },
      { createConnection: () => connection, now: () => new Date(NOW.getTime() + 1000) },
    );
    expect(updated.records[0]).toMatchObject({
      relationshipState: "client",
      status: "closed",
      nextAction: "Send the revised proposal",
      revision: 2,
      evidenceState: "current",
    });
    expect(await connection.db.select().from(operatorRelationshipCorrections)).toHaveLength(4);
  });

  it("shows source degradation honestly and blocks cross-owner edits", async () => {
    const owner = await ownerIds(connection, OWNER_ID);
    await connection.db.insert(operatorRelationshipRecords).values({
      id: "00000000-0000-4000-8000-000000003462",
      operatorId: owner.operatorId,
      displayName: "Disconnected source",
      primaryEmail: "disconnect@example.com",
      founderConfirmedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ingestFounderRelationshipEvidenceForUser(
      OWNER_ID,
      [observation(owner.calendarId, "calendar-degraded-1", { email: "disconnect@example.com" })],
      {
        createConnection: () => connection,
        now: () => NOW,
        requireReleaseStageAccess: ALLOW_RELEASE_STAGE_ACCESS,
      },
    );
    await connection.db
      .update(operatorCalendarConnections)
      .set({ evidenceState: "unknown", updatedAt: NOW })
      .where(eq(operatorCalendarConnections.id, owner.calendarId));
    const stale = await getFounderRelationshipsForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(stale.records[0]).toMatchObject({ evidenceState: "stale" });
    await connection.db
      .update(operatorCalendarConnections)
      .set({ status: "disconnected", disconnectedAt: NOW, updatedAt: NOW })
      .where(eq(operatorCalendarConnections.id, owner.calendarId));
    const projected = await getFounderRelationshipsForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(projected.records[0]).toMatchObject({ evidenceState: "disconnected" });
    await connection.db
      .delete(operatorCalendarConnections)
      .where(eq(operatorCalendarConnections.id, owner.calendarId));
    const afterDeletion = await getFounderRelationshipsForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    expect(afterDeletion.records[0]).toMatchObject({ evidenceState: "disconnected" });
    expect(afterDeletion.records[0]?.evidence).toHaveLength(1);
    await expect(
      updateFounderRelationshipRecordForUser(
        OTHER_OWNER_ID,
        "00000000-0000-4000-8000-000000003462",
        { nextAction: "Should not cross owners" },
        { createConnection: () => connection, now: () => NOW },
      ),
    ).rejects.toMatchObject({ code: "relationship_not_found", status: 404 });
  });

  it("checks source capability inside the write transaction and forbids Mail evidence", async () => {
    const owner = await ownerIds(connection, OWNER_ID);
    const competingConnection = createDatabaseConnection();
    const requireReleaseStageAccess = vi.fn(async (_tx, input) => {
      const rows = await competingConnection.db.execute<{ acquired: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${OWNER_ID}`}, 0)) as acquired`,
      );
      expect(rows[0]?.acquired).toBe(false);
      if (input.requiredCapabilities === "forbidden") {
        throw new FounderReleaseStageAccessError();
      }
    });

    await expect(
      ingestFounderRelationshipEvidenceForUser(
        OWNER_ID,
        [observation(owner.mailId, "mail-forbidden-1", { email: "blocked@example.com" }, "mail")],
        {
          createConnection: () => connection,
          env: { VERCEL_GIT_COMMIT_SHA: "a".repeat(40) },
          now: () => NOW,
          requireReleaseStageAccess,
        },
      ),
    ).rejects.toMatchObject({ code: "owner_preview_access_required" });
    expect(requireReleaseStageAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: OWNER_ID,
        applicationRevision: "a".repeat(40),
        requiredCapabilities: "forbidden",
      }),
    );
    await expect(connection.db.select().from(operatorRelationshipEvidence)).resolves.toEqual([]);
    await competingConnection.close();
  });
});

function observation(
  connectionId: string,
  providerItemId: string,
  values: Partial<Parameters<typeof ingestFounderRelationshipEvidenceForUser>[1][number]>,
  sourceKind: "calendar" | "mail" = "calendar",
) {
  return {
    sourceKind,
    connectionId,
    provider: sourceKind === "calendar" ? "google_calendar" : "google_gmail",
    providerItemId,
    observedAt: NOW,
    ...values,
  };
}

async function seedOwner(connection: DatabaseConnection, userId: string, runtimeIdentity: string) {
  const operatorId =
    userId === OWNER_ID
      ? "00000000-0000-4000-8000-000000003453"
      : "00000000-0000-4000-8000-000000003454";
  const preparationId =
    userId === OWNER_ID
      ? "00000000-0000-4000-8000-000000003455"
      : "00000000-0000-4000-8000-000000003456";
  const runtimeId =
    userId === OWNER_ID
      ? "00000000-0000-4000-8000-000000003457"
      : "00000000-0000-4000-8000-000000003458";
  const createdAt = new Date(NOW.getTime() - 1000);
  await connection.db.insert(users).values({ id: userId, createdAt, updatedAt: NOW });
  await connection.db
    .insert(operators)
    .values({ id: operatorId, userId, createdAt, updatedAt: NOW });
  await connection.db.insert(operatorPreparations).values({
    id: preparationId,
    operatorId,
    status: "ready",
    timezone: "Asia/Manila",
    timezoneConfirmedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    createdAt,
    updatedAt: NOW,
  });
  await connection.db.insert(operatorRuntimes).values({
    id: runtimeId,
    operatorId,
    status: "ready",
    transportState: "connected",
    safetyState: "verified",
    runtimeIdentity,
    attemptCount: 1,
    startedAt: NOW,
    readyAt: NOW,
    createdAt,
    updatedAt: NOW,
  });
  await connection.db.insert(operatorCalendarConnections).values({
    id:
      userId === OWNER_ID
        ? "00000000-0000-4000-8000-000000003459"
        : "00000000-0000-4000-8000-000000003460",
    operatorId,
    providerSubjectId: `calendar-${userId.slice(-4)}`,
    accountLabel: `${userId.slice(-4)}@example.com`,
    status: "ready",
    authorizationState: "authorized",
    accessTokenCiphertext: "a",
    accessTokenIv: "b",
    accessTokenAuthTag: "c",
    refreshTokenCiphertext: "d",
    refreshTokenIv: "e",
    refreshTokenAuthTag: "f",
    secretKeyVersion: "test-v1",
    authorizedAt: NOW,
    lastVerifiedAt: NOW,
    lastEvidenceAt: NOW,
    evidenceState: "current",
    createdAt,
    updatedAt: NOW,
  });
  await connection.db.insert(operatorMailConnections).values({
    id:
      userId === OWNER_ID
        ? "00000000-0000-4000-8000-000000003463"
        : "00000000-0000-4000-8000-000000003464",
    operatorId,
    providerSubjectId: `mail-${userId.slice(-4)}`,
    accountLabel: `${userId.slice(-4)}@example.com`,
    status: "ready",
    authorizationState: "authorized",
    accessTokenCiphertext: "a",
    accessTokenIv: "b",
    accessTokenAuthTag: "c",
    refreshTokenCiphertext: "d",
    refreshTokenIv: "e",
    refreshTokenAuthTag: "f",
    secretKeyVersion: "test-v1",
    authorizedAt: NOW,
    lastVerifiedAt: NOW,
    lastEvidenceAt: NOW,
    evidenceState: "current",
    suiteStatus: "matched",
    createdAt,
    updatedAt: NOW,
  });
}

async function ownerIds(connection: DatabaseConnection, userId: string) {
  const [operator] = await connection.db
    .select()
    .from(operators)
    .where(eq(operators.userId, userId));
  if (!operator) throw new Error("Operator fixture missing");
  const [calendar] = await connection.db
    .select()
    .from(operatorCalendarConnections)
    .where(eq(operatorCalendarConnections.operatorId, operator.id));
  const [mail] = await connection.db
    .select()
    .from(operatorMailConnections)
    .where(eq(operatorMailConnections.operatorId, operator.id));
  if (!calendar || !mail) throw new Error("Connection fixture missing");
  return { operatorId: operator.id, calendarId: calendar.id, mailId: mail.id };
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_relationship_corrections, operator_relationship_evidence, operator_relationship_candidates, operator_relationship_records, operator_mail_connections, operator_calendar_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
