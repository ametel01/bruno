import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorSupportAccessGrants,
  operatorSupportReceipts,
  operatorSupportRepairDecisions,
  operatorSupportToolInvocations,
  operatorTroubleshootingIncidents,
  users,
} from "@/src/server/db/schema";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import {
  createFounderRepairProposalForSupport,
  createFounderSupportAccessGrantForUser,
  decideFounderRepairProposalForUser,
  executeFounderRepairProposalForUser,
  FOUNDER_SUPPORT_TOOLS,
  FounderSupportError,
  invokeFounderSupportTool,
  revokeFounderSupportAccessGrantForUser,
} from "@/src/server/operators/founder-support";

const OWNER_ID = "00000000-0000-4000-8000-000000003601";
const INCIDENT_ID = "00000000-0000-4000-8000-000000003602";
const START = new Date("2026-08-20T00:00:00.000Z");

describe("Founder Support Access and typed repairs", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values({ id: OWNER_ID });
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => START,
    });
    await connection.db.insert(operatorTroubleshootingIncidents).values({
      id: INCIDENT_ID,
      operatorId: operator.id,
      recoveryCapability: "ai",
      attemptCount: 3,
      maxAttempts: 3,
      elapsedMs: 900_000,
      maxElapsedMs: 900_000,
      impactSummary: "AI responses are paused.",
      affectedCapabilities: ["AI responses"],
      unaffectedCapabilities: ["Calendar evidence"],
      deduplicationKey: "support-test-incident",
      supportCaseApprovedAt: START,
      openedAt: START,
      createdAt: START,
      updatedAt: START,
    });
  });

  it("never allowlists terminal access for support", () => {
    expect(FOUNDER_SUPPORT_TOOLS).not.toContain("terminal");
    expect(FOUNDER_SUPPORT_TOOLS).not.toContain("shell");
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("requires an exact scope, expires at sixty minutes, and makes revocation visible", async () => {
    const grant = await createFounderSupportAccessGrantForUser(
      OWNER_ID,
      {
        incidentId: INCIDENT_ID,
        supportActorName: "Support Ada",
        supportActorIdentity: "support-ada",
        mfaAuthenticated: true,
        scope: "troubleshooting_evidence",
        ttlMinutes: 60,
      },
      { createConnection: () => connection, now: () => START },
    );
    expect(grant.expiresAt).toBe(new Date(START.getTime() + 60 * 60_000).toISOString());
    expect(grant.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const supportAccessToken = grant.supportAccessToken;
    if (!supportAccessToken) throw new Error("Expected Support Access Token.");

    await expect(
      invokeFounderSupportTool(
        grant.id,
        {
          tool: "read_capability_status",
          incidentId: INCIDENT_ID,
          supportActorIdentity: "support-ada",
          supportAccessToken,
        },
        { createConnection: () => connection, now: () => START },
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });

    const revoked = await revokeFounderSupportAccessGrantForUser(OWNER_ID, grant.id, {
      createConnection: () => connection,
      now: () => new Date(START.getTime() + 1_000),
    });
    expect(revoked.status).toBe("revoked");
    await expect(
      invokeFounderSupportTool(
        grant.id,
        {
          tool: "read_troubleshooting_evidence",
          incidentId: INCIDENT_ID,
          supportActorIdentity: "support-ada",
          supportAccessToken,
        },
        { createConnection: () => connection, now: () => new Date(START.getTime() + 2_000) },
      ),
    ).rejects.toMatchObject({ code: "grant_revoked" });

    const receipts = await connection.db.select().from(operatorSupportReceipts);
    expect(
      receipts.filter((receipt) => receipt.grantId === grant.id).map((receipt) => receipt.kind),
    ).toEqual(["grant_created", "grant_revoked"]);
  });

  it("rejects an impersonating support actor and expires without allowing a tool call", async () => {
    const grant = await createFounderSupportAccessGrantForUser(
      OWNER_ID,
      {
        incidentId: INCIDENT_ID,
        supportActorName: "Support Ada",
        supportActorIdentity: "support-ada",
        mfaAuthenticated: true,
        scope: "troubleshooting_evidence",
        ttlMinutes: 1,
      },
      { createConnection: () => connection, now: () => START },
    );
    const supportAccessToken = grant.supportAccessToken;
    if (!supportAccessToken) throw new Error("Expected Support Access Token.");
    await expect(
      invokeFounderSupportTool(
        grant.id,
        {
          tool: "read_troubleshooting_evidence",
          incidentId: INCIDENT_ID,
          supportActorIdentity: OWNER_ID,
          supportAccessToken,
        },
        { createConnection: () => connection, now: () => START },
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });
    await expect(
      invokeFounderSupportTool(
        grant.id,
        {
          tool: "read_troubleshooting_evidence",
          incidentId: INCIDENT_ID,
          supportActorIdentity: "support-ada",
          supportAccessToken,
        },
        { createConnection: () => connection, now: () => new Date(START.getTime() + 60_001) },
      ),
    ).rejects.toMatchObject({ code: "grant_expired" });
    const expired = await connection.db.select().from(operatorSupportAccessGrants);
    expect(expired[0]?.status).toBe("expired");
    expect(await connection.db.select().from(operatorSupportToolInvocations)).toHaveLength(0);
  });

  it("keeps the first Founder decision, records the receipt, and never claims recovery without a live check", async () => {
    const grant = await createFounderSupportAccessGrantForUser(
      OWNER_ID,
      {
        incidentId: INCIDENT_ID,
        supportActorName: "Support Ada",
        supportActorIdentity: "support-ada",
        mfaAuthenticated: true,
        scope: "capability_status",
        ttlMinutes: 10,
      },
      { createConnection: () => connection, now: () => START },
    );
    const supportAccessToken = grant.supportAccessToken;
    if (!supportAccessToken) throw new Error("Expected Support Access Token.");
    const proposal = await createFounderRepairProposalForSupport(
      grant.id,
      {
        incidentId: INCIDENT_ID,
        kind: "restart_from_checkpoint",
        target: { checkpointId: "checkpoint-42" },
        supportActorIdentity: "support-ada",
        supportAccessToken,
      },
      { createConnection: () => connection, now: () => START },
    );
    const approved = await decideFounderRepairProposalForUser(
      OWNER_ID,
      {
        proposalId: proposal.id,
        proposalDigest: proposal.proposalDigest,
        decision: "approve",
      },
      { createConnection: () => connection, now: () => new Date(START.getTime() + 1_000) },
    );
    expect(approved.state).toBe("approved");
    await expect(
      decideFounderRepairProposalForUser(
        OWNER_ID,
        {
          proposalId: proposal.id,
          proposalDigest: proposal.proposalDigest,
          decision: "decline",
        },
        { createConnection: () => connection, now: () => new Date(START.getTime() + 2_000) },
      ),
    ).rejects.toBeInstanceOf(FounderSupportError);
    const closed = await executeFounderRepairProposalForUser(OWNER_ID, proposal.id, {
      createConnection: () => connection,
      now: () => new Date(START.getTime() + 3_000),
      executeRepair: async () => ({
        liveCheckPassed: false,
        capability: "AI responses",
        summary: "The live capability check did not pass.",
      }),
    });
    expect(closed.state).toBe("closed_without_recovery");
    expect(closed.verification?.liveCheckPassed).toBe(false);
    expect(await connection.db.select().from(operatorSupportRepairDecisions)).toHaveLength(1);
    expect(
      (await connection.db.select().from(operatorSupportReceipts)).some(
        (receipt) => receipt.kind === "repair_executed",
      ),
    ).toBe(true);
  });
});

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_support_tool_invocations, operator_support_repair_decisions, operator_support_repair_proposals, operator_support_receipts, operator_support_access_grants, operator_troubleshooting_evidence, operator_troubleshooting_incidents, operator_ai_connections, operators, users restart identity cascade",
  );
}
