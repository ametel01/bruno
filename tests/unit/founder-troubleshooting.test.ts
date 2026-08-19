import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorAiConnections,
  operatorTroubleshootingEvidence,
  operatorTroubleshootingIncidents,
  users,
} from "@/src/server/db/schema";
import {
  approveFounderTroubleshootingCaseForUser,
  closeFounderTroubleshootingCaseForUser,
  getFounderTroubleshootingForUser,
  sanitizeTroubleshootingEvidence,
} from "@/src/server/operators/founder-troubleshooting";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";

const OWNER_ID = "00000000-0000-4000-8000-000000003581";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000003582";
const START = new Date("2026-08-20T00:00:00.000Z");

describe("Founder Troubleshooting incidents", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values([{ id: OWNER_ID }, { id: OTHER_OWNER_ID }]);
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("sanitizes from an allowlist and excludes provider and technical secrets", () => {
    const evidence = sanitizeTroubleshootingEvidence({
      capability: "mail",
      state: "recovery_exhausted",
      attemptCount: 4,
      maxAttempts: 3,
      elapsedMs: 99,
      maxElapsedMs: 100,
      affectedCapabilities: ["Mail reading", "provider account: private"],
      unaffectedCapabilities: ["Calendar evidence", "private internal id"],
      safeAction: "Review Mail access",
      unsafeAction: "open provider console",
      provider: "google",
      prompt: "private prompt",
      messageBody: "private message body",
      recipient: "ada@example.com",
      endpoint: "https://provider.invalid/private",
      credential: "secret-token",
    } as never);

    expect(evidence).toEqual({
      capability: "mail",
      state: "recovery_exhausted",
      attemptCount: 4,
      maxAttempts: 3,
      elapsedMs: 99,
      maxElapsedMs: 100,
      affectedCapabilities: ["Mail reading"],
      unaffectedCapabilities: ["Calendar evidence"],
      safeAction: "Review Mail access",
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /google|private prompt|private message body|ada@example.com|provider\.invalid|secret-token/,
    );
  });

  it("opens one durable incident after exhaustion and deduplicates repeated Help loads", async () => {
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => START,
    });
    await connection.db.insert(operatorAiConnections).values({
      operatorId: operator.id,
      status: "verifying",
      failureCode: "provider_unavailable",
      recoveryMessage: "private provider detail must never be retained in evidence",
      createdAt: START,
      updatedAt: START,
    });

    const exhaustedAt = new Date(START.getTime() + 16 * 60 * 1000);
    const first = await getFounderTroubleshootingForUser(OWNER_ID, "ai", {
      createConnection: () => connection,
      now: () => exhaustedAt,
    });
    const second = await getFounderTroubleshootingForUser(OWNER_ID, "ai", {
      createConnection: () => connection,
      now: () => exhaustedAt,
    });

    expect(first.help).toMatchObject({
      capability: "ai",
      state: "recovery_exhausted",
      technicalEvidenceAvailable: true,
    });
    expect(first.incidents).toHaveLength(1);
    expect(first.incidents[0]?.evidence).toHaveLength(3);
    expect(second.incidents).toHaveLength(1);
    expect(await connection.db.select().from(operatorTroubleshootingIncidents)).toHaveLength(1);
    expect(await connection.db.select().from(operatorTroubleshootingEvidence)).toHaveLength(3);
    expect(JSON.stringify(first)).not.toContain("private provider detail");
  });

  it("expires evidence after fourteen days and extends only an approved case to thirty days after closure", async () => {
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => START,
    });
    await connection.db.insert(operatorAiConnections).values({
      operatorId: operator.id,
      status: "verifying",
      failureCode: "provider_unavailable",
      recoveryMessage: "safe message",
      createdAt: START,
      updatedAt: START,
    });
    const exhaustedAt = new Date(START.getTime() + 16 * 60 * 1000);
    const opened = await getFounderTroubleshootingForUser(OWNER_ID, "ai", {
      createConnection: () => connection,
      now: () => exhaustedAt,
    });
    const incident = opened.incidents[0];
    if (!incident) throw new Error("Expected an incident.");

    const approvedAt = new Date(START.getTime() + 13 * 24 * 60 * 60 * 1000);
    const approved = await approveFounderTroubleshootingCaseForUser(OWNER_ID, incident.id, {
      createConnection: () => connection,
      now: () => approvedAt,
    });
    expect(approved.supportCase).toBe("open");
    expect(approved.evidenceExpiresAt).toBeNull();

    const closedAt = new Date(START.getTime() + 14 * 24 * 60 * 60 * 1000);
    const closed = await closeFounderTroubleshootingCaseForUser(OWNER_ID, incident.id, {
      createConnection: () => connection,
      now: () => closedAt,
    });
    expect(closed.supportCase).toBe("closed");
    expect(closed.evidenceExpiresAt).toBe(
      new Date(closedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const afterExpiry = await getFounderTroubleshootingForUser(OWNER_ID, "ai", {
      createConnection: () => connection,
      now: () => new Date(closedAt.getTime() + 31 * 24 * 60 * 60 * 1000),
    });
    expect(afterExpiry.incidents[0]?.evidence).toHaveLength(0);
  });

  it("keeps incident records owner-scoped", async () => {
    const owner = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => START,
    });
    await connection.db.insert(operatorAiConnections).values({
      operatorId: owner.id,
      status: "verifying",
      failureCode: "provider_unavailable",
      recoveryMessage: "safe message",
      createdAt: START,
      updatedAt: START,
    });
    const exhaustedAt = new Date(START.getTime() + 16 * 60 * 1000);
    const ownerView = await getFounderTroubleshootingForUser(OWNER_ID, "ai", {
      createConnection: () => connection,
      now: () => exhaustedAt,
    });
    const otherView = await getFounderTroubleshootingForUser(OTHER_OWNER_ID, "ai", {
      createConnection: () => connection,
      now: () => exhaustedAt,
    });
    expect(ownerView.incidents).toHaveLength(1);
    expect(otherView.incidents).toHaveLength(0);
  });
});

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_troubleshooting_evidence, operator_troubleshooting_incidents, operator_ai_connections, operators, users restart identity cascade",
  );
}
