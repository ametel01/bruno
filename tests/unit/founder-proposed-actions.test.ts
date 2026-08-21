import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorActionAuthorizations,
  operatorActionDecisions,
  operatorAuthorityPolicies,
  operatorProductGuardrails,
  operatorProposedActions,
  users,
} from "@/src/server/db/schema";
import { setFounderExternalActionPauseForUser } from "@/src/server/operators/founder-ai-work";
import {
  changeFounderAuthorityPolicyForUser,
  claimFounderActionAuthorizationForUser,
  createFounderProposedActionForUser,
  decideFounderProposedActionForUser,
  getFounderProposedActionForUser,
  getFounderProposedActionsForUser,
} from "@/src/server/operators/founder-proposed-actions";
import { insertPastDueFounderEntitlementFixture } from "@/tests/helpers/founder-entitlement";

const OWNER_ID = "00000000-0000-4000-8000-000000003471";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000003472";
const NOW = new Date("2026-08-19T04:00:00.000Z");
const VALID_UNTIL = "2026-08-20T04:00:00.000Z";
const CONTROLLED_DEADLINE = new Date("2099-01-01T00:00:00.000Z");

describe("Founder Proposed Actions application seam", () => {
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

  it("binds the seven-family safe defaults and exact immutable material", async () => {
    const action = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ actionFamily: "external_communication" }),
      { createConnection: () => connection, now: () => NOW },
    );

    expect(action).toMatchObject({
      version: 1,
      actionFamily: "external_communication",
      state: "awaiting_approval",
      policy: { version: 1, mode: "approval_required" },
      productGuardrails: { version: 1, blocked: false },
      destination: { recipient: "ada@example.com" },
      materialContent: { subject: "A precise follow-up" },
      sideEffects: ["one message would be sent"],
    });
    expect(action.idempotencyKey).toBeTruthy();
    expect(action.connection.processingConsentId).toBeNull();
    expect(await connection.db.select().from(operatorAuthorityPolicies)).toHaveLength(1);
    expect(await connection.db.select().from(operatorProductGuardrails)).toHaveLength(1);
  });

  it("authorizes one exact version, creates one durable authorization, and wins duplicates", async () => {
    const action = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ actionFamily: "external_communication", idempotencyKey: "send-1" }),
      { createConnection: () => connection, now: () => NOW },
    );
    const first = await decideFounderProposedActionForUser(
      OWNER_ID,
      action.id,
      "approve",
      1,
      null,
      { createConnection: () => connection, now: () => NOW },
    );
    const duplicate = await decideFounderProposedActionForUser(
      OWNER_ID,
      action.id,
      "decline",
      1,
      null,
      { createConnection: () => connection, now: () => new Date(NOW.getTime() + 1_000) },
    );

    expect(first).toMatchObject({
      action: { state: "authorized" },
      decision: { kind: "approve" },
      duplicate: false,
    });
    expect(duplicate).toMatchObject({
      action: { state: "authorized" },
      decision: { kind: "approve" },
      duplicate: true,
    });
    expect(await connection.db.select().from(operatorActionDecisions)).toHaveLength(1);
    expect(await connection.db.select().from(operatorActionAuthorizations)).toHaveLength(1);
    expect(await connection.db.select().from(operatorProposedActions)).toHaveLength(1);
  });

  it("blocks new external effect claims while preserving Founder approval work", async () => {
    const action = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ actionFamily: "external_communication" }),
      { createConnection: () => connection, now: () => NOW },
    );
    await setFounderExternalActionPauseForUser(OWNER_ID, true, {
      createConnection: () => connection,
      now: () => NOW,
    });

    const approved = await decideFounderProposedActionForUser(
      OWNER_ID,
      action.id,
      "approve",
      1,
      null,
      {
        createConnection: () => connection,
        now: () => NOW,
      },
    );
    expect(approved).toMatchObject({
      action: { state: "authorized" },
      decision: { kind: "approve" },
    });

    await expect(
      claimFounderActionAuthorizationForUser(OWNER_ID, action.id, 1, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "external_action_paused", status: 409 });
    const [authorization] = await connection.db.select().from(operatorActionAuthorizations);
    expect(authorization?.claimedAt).toBeNull();
  });

  it("uses the captured claim time when Product Entitlement reaches its deadline", async () => {
    const action = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ actionFamily: "external_communication", validUntil: "2100-01-01T00:00:00.000Z" }),
      { createConnection: () => connection, now: () => NOW },
    );
    await decideFounderProposedActionForUser(OWNER_ID, action.id, "approve", 1, null, {
      createConnection: () => connection,
      now: () => NOW,
    });
    await insertPastDueFounderEntitlementFixture({
      connection,
      userId: OWNER_ID,
      fixtureId: "proposed-action-deadline",
      reconciledAt: NOW,
      retirementDueAt: CONTROLLED_DEADLINE,
    });

    await expect(
      claimFounderActionAuthorizationForUser(OWNER_ID, action.id, 1, {
        createConnection: () => connection,
        now: () => CONTROLLED_DEADLINE,
      }),
    ).rejects.toMatchObject({ code: "external_action_paused", status: 409 });
    const [authorization] = await connection.db.select().from(operatorActionAuthorizations);
    expect(authorization?.claimedAt).toBeNull();
  });

  it("claims an authorization once and treats replay as an already-started effect", async () => {
    const action = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ actionFamily: "external_communication" }),
      { createConnection: () => connection, now: () => NOW },
    );
    await expect(
      decideFounderProposedActionForUser(OWNER_ID, action.id, "approve", 1, null, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ action: { state: "authorized" } });

    const first = await claimFounderActionAuthorizationForUser(OWNER_ID, action.id, 1, {
      createConnection: () => connection,
      now: () => NOW,
    });
    const duplicate = await claimFounderActionAuthorizationForUser(OWNER_ID, action.id, 1, {
      createConnection: () => connection,
      now: () => new Date(NOW.getTime() + 1_000),
    });

    expect(first).toMatchObject({
      action: { state: "executing" },
      authorization: { claimedAt: NOW.toISOString() },
      duplicate: false,
    });
    expect(duplicate).toMatchObject({
      authorization: { id: first.authorization.id, claimedAt: first.authorization.claimedAt },
      duplicate: true,
    });
    expect(await connection.db.select().from(operatorActionDecisions)).toHaveLength(1);
    expect(await connection.db.select().from(operatorActionAuthorizations)).toHaveLength(1);
  });

  it("allows only one concurrent decision and rejects an incorrect duplicate version", async () => {
    const action = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ idempotencyKey: "concurrent-1" }),
      { createConnection: () => connection, now: () => NOW },
    );
    const results = await Promise.all([
      decideFounderProposedActionForUser(OWNER_ID, action.id, "approve", 1, null, {
        createConnection: () => connection,
        now: () => NOW,
      }),
      decideFounderProposedActionForUser(OWNER_ID, action.id, "decline", 1, null, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ]);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    await expect(
      decideFounderProposedActionForUser(OWNER_ID, action.id, "approve", 2, null, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "stale_proposal", status: 409 });
    expect(await connection.db.select().from(operatorActionDecisions)).toHaveLength(1);
  });

  it("supersedes the old version on Request changes and rejects stale decisions", async () => {
    const action = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ actionFamily: "external_communication" }),
      { createConnection: () => connection, now: () => NOW },
    );
    const changed = await decideFounderProposedActionForUser(
      OWNER_ID,
      action.id,
      "request_changes",
      1,
      draft({
        actionFamily: "external_communication",
        businessOutcome: "Send the corrected follow-up",
        idempotencyKey: "send-2",
      }),
      { createConnection: () => connection, now: () => NOW },
    );

    expect(changed.action).toMatchObject({
      version: 2,
      supersedesId: action.id,
      state: "awaiting_approval",
      businessOutcome: "Send the corrected follow-up",
    });
    await expect(
      decideFounderProposedActionForUser(OWNER_ID, action.id, "approve", 1, null, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ duplicate: true, decision: { kind: "request_changes" } });
    await expect(
      decideFounderProposedActionForUser(OWNER_ID, changed.action.id, "approve", 1, null, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "stale_proposal", status: 409 });
  });

  it("blocks Product Guardrails, keeps owner isolation, and never creates an authorization", async () => {
    const blocked = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ actionFamily: "external_communication", actionSubtype: "bulk_outreach" }),
      { createConnection: () => connection, now: () => NOW },
    );
    expect(blocked).toMatchObject({ state: "blocked", productGuardrails: { blocked: true } });
    await expect(
      decideFounderProposedActionForUser(OWNER_ID, blocked.id, "approve", 1, null, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "decision_conflict", status: 409 });
    expect(
      await getFounderProposedActionForUser(OTHER_OWNER_ID, { createConnection: () => connection }),
    ).toBeNull();
    expect(
      await getFounderProposedActionsForUser(OWNER_ID, { createConnection: () => connection }),
    ).toHaveLength(1);
    expect(await connection.db.select().from(operatorActionAuthorizations)).toHaveLength(0);
  });

  it("automatically authorizes safely delegable observation without an external effect path", async () => {
    const action = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ actionFamily: "observe_evidence" }),
      { createConnection: () => connection, now: () => NOW },
    );
    expect(action.state).toBe("authorized");
    expect(action.authorization).toMatchObject({ claimedAt: null });
    expect(await connection.db.select().from(operatorActionDecisions)).toHaveLength(0);
  });

  it("requires a structured policy change, records a Governance Receipt, and blocks pending work when stricter", async () => {
    const pending = await createFounderProposedActionForUser(
      OWNER_ID,
      draft({ actionFamily: "external_communication" }),
      { createConnection: () => connection, now: () => NOW },
    );
    const policy = await changeFounderAuthorityPolicyForUser(
      OWNER_ID,
      {
        observe_evidence: "always",
        relationship_maintenance: "always",
        prepare_work: "always",
        external_communication: "never",
        meeting_management: "approval_required",
        commercial_commitment: "approval_required",
        data_control: "approval_required",
      },
      { createConnection: () => connection, now: () => new Date(NOW.getTime() + 1000) },
    );
    expect(policy.after).toMatchObject({
      version: 2,
      actionFamilies: { external_communication: "never" },
    });
    expect(policy.after.governanceReceiptId).toBeTruthy();
    await expect(
      getFounderProposedActionForUser(OWNER_ID, { createConnection: () => connection }),
    ).resolves.toMatchObject({
      id: pending.id,
      state: "blocked",
    });
  });

  it("does not allow non-delegable commercial or data control families to become Always", async () => {
    await expect(
      changeFounderAuthorityPolicyForUser(
        OWNER_ID,
        {
          observe_evidence: "always",
          relationship_maintenance: "always",
          prepare_work: "always",
          external_communication: "approval_required",
          meeting_management: "approval_required",
          commercial_commitment: "always",
          data_control: "approval_required",
        },
        { createConnection: () => connection, now: () => NOW },
      ),
    ).rejects.toMatchObject({ code: "invalid_action", status: 400 });
  });
});

function draft(overrides: Partial<Parameters<typeof createFounderProposedActionForUser>[1]> = {}) {
  return {
    actionFamily: "external_communication" as const,
    businessOutcome: "Send a precise follow-up",
    companyConnectionId: null,
    connectionResourceId: null,
    processingConsentId: null,
    destination: { recipient: "ada@example.com" },
    materialContent: { subject: "A precise follow-up", body: "Hello Ada" },
    sideEffects: ["one message would be sent"],
    preconditions: [{ key: "mail_sending_ready", description: "Mail Sending is Ready." }],
    validUntil: VALID_UNTIL,
    ...overrides,
  };
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_action_authorizations, operator_action_decisions, operator_proposed_actions, operator_product_guardrails, operator_action_preview_revisions, operator_action_previews, operator_governance_receipts, operator_authority_policies, operator_processing_consents, operators, users restart identity cascade",
  );
}
