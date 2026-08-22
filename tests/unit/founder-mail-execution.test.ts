import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestGoogleMailSendingAcceptanceRelease } from "@/scripts/founder-google-mail-sending-test-release";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderRecoveryArchives,
  founderReleaseDecisions,
  operatorActionAuthorizations,
  operatorActionExecutionAttempts,
  operatorActionReceipts,
  operatorCalendarConnections,
  operatorMailConnections,
  operatorMailSendingConnections,
  operatorPreparations,
  operatorPrimaryCommunicationsSuites,
  operatorProposedActions,
  operatorRuntimes,
  users,
} from "@/src/server/db/schema";
import {
  executeFounderApprovedGmailActionForUser,
  type FounderMailExecutionDependencies,
  reconcileFounderGmailActionForUser,
} from "@/src/server/operators/founder-mail-execution";
import {
  GOOGLE_MAIL_SENDING_PROVIDER,
  REQUIRED_MAIL_SENDING_SCOPE,
} from "@/src/server/operators/founder-mail-sending-connection";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";
import {
  createFounderProposedActionForUser,
  decideFounderProposedActionForUser,
} from "@/src/server/operators/founder-proposed-actions";
import {
  encryptOperatorSecret,
  type OperatorSecretKeyring,
} from "@/src/server/secrets/operator-secret-keyring";
import { insertPastDueFounderEntitlementFixture } from "@/tests/helpers/founder-entitlement";

const OWNER_ID = "00000000-0000-4000-8000-000000003501";
const NOW = new Date("2026-08-19T05:00:00.000Z");
const REVISION = "a".repeat(40);
const CONTROLLED_DEADLINE = new Date("2099-01-01T00:00:00.000Z");
const KEYRING: OperatorSecretKeyring = {
  activeVersion: "test-v1",
  keys: new Map([["test-v1", Buffer.alloc(32, 9)]]),
};
const ENV = {
  BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE:
    buildTestGoogleMailSendingAcceptanceRelease(NOW, REVISION),
  VERCEL_GIT_COMMIT_SHA: REVISION,
};

describe("Founder approved Gmail execution", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values({ id: OWNER_ID });
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => NOW,
    });
    await confirmFounderTimezoneForUser(OWNER_ID, "Asia/Manila", {
      createConnection: () => connection,
      now: () => NOW,
    });
    await connection.db.update(operatorPreparations).set({ status: "ready", completedAt: NOW });
    await connection.db.update(operatorRuntimes).set({
      status: "ready",
      transportState: "connected",
      safetyState: "verified",
      configRevision: "runtime-mail-v1",
      readyAt: NOW,
    });
    await seedOwnerPreviewAccess(operator.id);

    const calendar = await connection.db
      .insert(operatorCalendarConnections)
      .values(connectionValues(operator.id, "calendar"))
      .returning();
    const mail = await connection.db
      .insert(operatorMailConnections)
      .values({ ...connectionValues(operator.id, "mail"), suiteStatus: "matched" })
      .returning();
    const calendarConnection = calendar[0];
    const mailConnection = mail[0];
    if (!calendarConnection || !mailConnection) throw new Error("connection setup failed");
    await connection.db.insert(operatorPrimaryCommunicationsSuites).values({
      operatorId: operator.id,
      calendarConnectionId: calendarConnection.id,
      mailConnectionId: mailConnection.id,
      providerSubjectId: "google-sub-351",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const access = encryptOperatorSecret({
      value: "send-access",
      scope: "google-mail-sending-access",
      keyring: KEYRING,
    });
    const refresh = encryptOperatorSecret({
      value: "send-refresh",
      scope: "google-mail-sending-refresh",
      keyring: KEYRING,
    });
    await connection.db.insert(operatorMailSendingConnections).values({
      operatorId: operator.id,
      mailConnectionId: mailConnection.id,
      provider: GOOGLE_MAIL_SENDING_PROVIDER,
      providerSubjectId: "google-sub-351",
      accountLabel: "founder@example.com",
      status: "ready",
      authorizationState: "authorized",
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      refreshTokenCiphertext: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      refreshTokenAuthTag: refresh.authTag,
      secretKeyVersion: KEYRING.activeVersion,
      tokenExpiresAt: new Date("2026-08-20T05:00:00.000Z"),
      grantedScopes: ["openid", "email", "profile", REQUIRED_MAIL_SENDING_SCOPE],
      authorizedAt: NOW,
      lastVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("sends exactly one approved message and persists an immutable receipt", async () => {
    const action = await approveAction();
    const rawMessages: string[] = [];
    const result = await execute(action.id, {
      sendMessage: async ({ rawMessage }) => {
        rawMessages.push(rawMessage);
        return { ok: true, providerMessageId: "gmail-351", providerThreadId: "thread-351" };
      },
    });

    expect(result).toMatchObject({ status: "succeeded", duplicate: false });
    expect(result.receipt).toMatchObject({
      proposedActionId: action.id,
      proposedActionVersion: 1,
      providerMessageId: "gmail-351",
      outcome: "succeeded",
      attemptCount: 1,
    });
    expect(rawMessages).toHaveLength(1);
    expect(rawMessages[0]).toContain("To: ada@example.com");
    expect(rawMessages[0]).toContain(
      `X-Bruno-Message-Identity: bruno-gmail-message-${action.id}-v1`,
    );
    expect(await connection.db.select().from(operatorActionReceipts)).toHaveLength(1);
    expect(await connection.db.select().from(operatorActionExecutionAttempts)).toHaveLength(2);
    expect((await connection.db.select().from(operatorProposedActions))[0]?.state).toBe(
      "succeeded",
    );

    const duplicate = await execute(action.id, {
      sendMessage: async () => {
        throw new Error("must not resend");
      },
    });
    expect(duplicate).toMatchObject({ status: "succeeded", duplicate: true });
  });

  it("records an uncertain outcome and never speculatively resends", async () => {
    const action = await approveAction();
    let sendCount = 0;
    const first = await execute(action.id, {
      sendMessage: async () => {
        sendCount += 1;
        throw new Error("provider response was lost");
      },
    });
    expect(first).toMatchObject({ status: "outcome_uncertain", duplicate: false });
    expect(sendCount).toBe(1);
    expect((await connection.db.select().from(operatorActionReceipts))[0]?.outcome).toBe(
      "outcome_uncertain",
    );
    expect((await connection.db.select().from(operatorProposedActions))[0]?.state).toBe(
      "outcome_uncertain",
    );

    const replay = await execute(action.id, {
      sendMessage: async () => {
        sendCount += 1;
        throw new Error("must not resend");
      },
    });
    expect(replay).toMatchObject({ status: "outcome_uncertain", duplicate: true });
    expect(sendCount).toBe(1);
  });

  it("keeps the proposal history and blocks sending when the send-only grant is revoked", async () => {
    const action = await approveAction();
    await connection.db.update(operatorMailSendingConnections).set({ revokedAt: NOW });
    let sendCount = 0;
    await expect(
      execute(action.id, {
        sendMessage: async () => {
          sendCount += 1;
          return { ok: true, providerMessageId: "must-not-send", providerThreadId: null };
        },
      }),
    ).rejects.toMatchObject({ code: "execution_blocked" });
    expect(sendCount).toBe(0);
    expect(await connection.db.select().from(operatorActionReceipts)).toHaveLength(0);
    expect((await connection.db.select().from(operatorProposedActions))[0]?.state).toBe(
      "authorized",
    );
  });

  it("blocks Gmail effects throughout Calendar-only Owner Preview", async () => {
    const action = await approveAction();
    let sendCount = 0;

    await expect(
      execute(
        action.id,
        {
          sendMessage: async () => {
            sendCount += 1;
            return { ok: true, providerMessageId: "must-not-send", providerThreadId: null };
          },
        },
        true,
      ),
    ).rejects.toMatchObject({ code: "owner_preview_access_required" });
    expect(sendCount).toBe(0);
    expect(await connection.db.select().from(operatorActionExecutionAttempts)).toHaveLength(0);
    expect(
      (await connection.db.select().from(operatorActionAuthorizations))[0]?.claimedAt,
    ).toBeNull();
    expect((await connection.db.select().from(operatorProposedActions))[0]?.state).toBe(
      "authorized",
    );
  });

  it("uses the controlled send time when Product Entitlement reaches its deadline", async () => {
    const action = await approveAction({ validUntil: "2100-01-01T00:00:00.000Z" });
    await connection.db
      .update(operatorMailSendingConnections)
      .set({ tokenExpiresAt: new Date("2100-01-01T00:00:00.000Z") });
    await insertPastDueFounderEntitlementFixture({
      connection,
      userId: OWNER_ID,
      fixtureId: "gmail-execution-deadline",
      reconciledAt: NOW,
      retirementDueAt: CONTROLLED_DEADLINE,
    });
    let sendCount = 0;

    await expect(
      executeFounderApprovedGmailActionForUser(OWNER_ID, action.id, 1, {
        createConnection: () => connection,
        adapter: {
          createAuthorizationUrl: async () => ({ authorizationUrl: "", expiresAt: NOW }),
          exchangeAuthorizationCode: async () => ({
            accessToken: "",
            refreshToken: null,
            tokenExpiresAt: NOW,
            grantedScopes: [],
          }),
          getIdentity: async () => ({ providerSubjectId: "", accountLabel: null }),
          revokeAuthorization: async () => ({ providerRevoked: false }),
          sendMessage: async () => {
            sendCount += 1;
            return { ok: true, providerMessageId: "must-not-send", providerThreadId: null };
          },
        },
        keyring: KEYRING,
        env: ENV,
        now: () => CONTROLLED_DEADLINE,
        requireReleaseStageAccess: async () => undefined,
      }),
    ).rejects.toThrow("Product Entitlement no longer authorizes external work");
    expect(sendCount).toBe(0);
    expect(await connection.db.select().from(operatorActionExecutionAttempts)).toHaveLength(0);
  });

  it("reconciles a started attempt after a worker restart without resending", async () => {
    const action = await approveAction();
    const [authorization] = await connection.db
      .select()
      .from(operatorActionAuthorizations)
      .where(eq(operatorActionAuthorizations.proposedActionId, action.id));
    const [storedAction] = await connection.db
      .select()
      .from(operatorProposedActions)
      .where(eq(operatorProposedActions.id, action.id));
    if (!authorization || !storedAction) throw new Error("authorization setup failed");
    await connection.db.insert(operatorActionExecutionAttempts).values({
      id: "00000000-0000-4000-8000-000000003599",
      operatorId: storedAction.operatorId,
      proposedActionId: action.id,
      authorizationId: authorization.id,
      attemptNumber: 1,
      phase: "started",
      provider: GOOGLE_MAIL_SENDING_PROVIDER,
      messageIdentity: `bruno-gmail-message-${action.id}-v1`,
      requestDigest: `sha256:${"0".repeat(64)}`,
      createdAt: NOW,
    });
    await connection.db
      .update(operatorProposedActions)
      .set({ state: "executing", updatedAt: NOW })
      .where(eq(operatorProposedActions.id, action.id));

    const reconciled = await reconcileFounderGmailActionForUser(OWNER_ID, action.id, {
      createConnection: () => connection,
      now: () => new Date(NOW.getTime() + 6 * 60 * 1000),
    });
    expect(reconciled).toMatchObject({ status: "outcome_uncertain", duplicate: false });
    expect((await connection.db.select().from(operatorActionReceipts))[0]?.outcome).toBe(
      "outcome_uncertain",
    );
  });

  async function approveAction(
    overrides: Partial<Parameters<typeof createFounderProposedActionForUser>[1]> = {},
  ) {
    const action = await createFounderProposedActionForUser(
      OWNER_ID,
      {
        actionFamily: "external_communication",
        businessOutcome: "Send one exact message",
        companyConnectionId: null,
        connectionResourceId: null,
        processingConsentId: null,
        destination: { recipient: "ada@example.com" },
        materialContent: { subject: "A precise follow-up", body: "Hello Ada" },
        sideEffects: ["one message would be sent"],
        preconditions: [{ key: "mail_sending_ready", description: "Mail Sending is Ready." }],
        validUntil: "2026-08-20T05:00:00.000Z",
        ...overrides,
      },
      {
        createConnection: () => connection,
        now: () => NOW,
        requireReleaseStageAccess: async () => undefined,
      },
    );
    await decideFounderProposedActionForUser(OWNER_ID, action.id, "approve", 1, null, {
      createConnection: () => connection,
      now: () => NOW,
    });
    return action;
  }

  async function execute(
    actionId: string,
    transport: Pick<NonNullable<FounderMailExecutionDependencies["adapter"]>, "sendMessage">,
    enforceOwnerPreview = false,
  ) {
    return executeFounderApprovedGmailActionForUser(OWNER_ID, actionId, 1, {
      createConnection: () => connection,
      adapter: {
        ...transport,
        createAuthorizationUrl: async () => ({ authorizationUrl: "", expiresAt: NOW }),
        exchangeAuthorizationCode: async () => ({
          accessToken: "",
          refreshToken: null,
          tokenExpiresAt: NOW,
          grantedScopes: [],
        }),
        getIdentity: async () => ({ providerSubjectId: "", accountLabel: null }),
        revokeAuthorization: async () => ({ providerRevoked: false }),
      },
      keyring: KEYRING,
      env: ENV,
      now: () => NOW,
      ...(enforceOwnerPreview ? {} : { requireReleaseStageAccess: async () => undefined }),
    });
  }

  async function seedOwnerPreviewAccess(operatorId: string): Promise<void> {
    await connection.db.insert(founderReleaseDecisions).values({
      userId: OWNER_ID,
      operatorId,
      stage: "owner_preview",
      outcome: "enter",
      applicationRevision: REVISION,
      runtimeRevision: "runtime-mail-v1",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: new Date(NOW.valueOf() + 8 * 24 * 60 * 60 * 1_000),
      calendarQualificationExpiresAt: new Date(NOW.valueOf() + 8 * 24 * 60 * 60 * 1_000),
      evidenceDigests: [`sha256:${"6".repeat(64)}`],
      decidedAt: NOW,
      createdAt: NOW,
    });
    const archiveId = "00000000-0000-4000-8000-000000003573";
    await connection.db.insert(founderRecoveryArchives).values({
      id: archiveId,
      userId: OWNER_ID,
      operatorId,
      runtimeRevision: "runtime-mail-v1",
      status: "verified",
      formatVersion: 1,
      storageObjectKey: `founder-recovery/${OWNER_ID}/${archiveId}.age`,
      recoveryCredentialObjectKey: `founder-recovery/${OWNER_ID}/${archiveId}.key`,
      ciphertextDigest: `sha256:${"1".repeat(64)}`,
      recoveryCredentialDigest: `sha256:${"2".repeat(64)}`,
      stateDigest: `sha256:${"3".repeat(64)}`,
      restorableVerified: true,
      restoreVerifiedAt: NOW,
      observedAt: NOW,
      expiresAt: new Date(NOW.valueOf() + 30 * 24 * 60 * 60 * 1_000),
      createdAt: NOW,
    });
  }
});

function connectionValues(operatorId: string, scope: "calendar" | "mail") {
  const access = encryptOperatorSecret({
    value: `${scope}-access`,
    scope: `google-${scope}-access`,
    keyring: KEYRING,
  });
  const refresh = encryptOperatorSecret({
    value: `${scope}-refresh`,
    scope: `google-${scope}-refresh`,
    keyring: KEYRING,
  });
  return {
    operatorId,
    providerSubjectId: "google-sub-351",
    accountLabel: "founder@example.com",
    status: "ready" as const,
    authorizationState: "authorized" as const,
    accessTokenCiphertext: access.ciphertext,
    accessTokenIv: access.iv,
    accessTokenAuthTag: access.authTag,
    refreshTokenCiphertext: refresh.ciphertext,
    refreshTokenIv: refresh.iv,
    refreshTokenAuthTag: refresh.authTag,
    secretKeyVersion: KEYRING.activeVersion,
    tokenExpiresAt: new Date("2026-08-20T05:00:00.000Z"),
    grantedScopes: ["openid", "email", "profile"],
    authorizedAt: NOW,
    lastVerifiedAt: NOW,
    lastEvidenceAt: NOW,
    evidenceState: "current" as const,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_action_receipts, operator_action_execution_attempts, operator_action_authorizations, operator_action_decisions, operator_proposed_actions, operator_product_guardrails, operator_action_preview_revisions, operator_action_previews, operator_governance_receipts, operator_authority_policies, operator_processing_consents, operator_mail_sending_connection_receipts, operator_mail_sending_connections, operator_primary_communications_suites, operator_mail_connection_receipts, operator_mail_resources, operator_mail_connections, operator_calendar_connection_receipts, operator_calendar_resources, operator_calendar_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
