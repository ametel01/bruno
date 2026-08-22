import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorAiConnections,
  operatorConversationMessages,
  operatorConversationWorks,
  operatorPreparations,
  operatorRuntimes,
  users,
} from "@/src/server/db/schema";
import { ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY } from "@/src/server/operators/founder-ai-routing";
import { FounderReleaseStageAccessError } from "@/src/server/founder-product-contract/release-stage-access";
import {
  assertFounderExternalActionsNotPaused,
  getFounderExternalActionPauseForUser,
  setFounderExternalActionPauseForUser,
} from "@/src/server/operators/founder-ai-work";
import {
  type FounderConversationAdapter,
  getFounderConversationForUser,
  resumeFounderConversationWorkForUser,
  sendFounderConversationMessageForUser,
} from "@/src/server/operators/founder-conversation";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";

const OWNER_ID = "00000000-0000-4000-8000-000000003401";
const MULTI_PROVIDER_POLICY = {
  ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY,
  providers: {
    ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.providers,
    openai: {
      ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.providers.openai,
      released: true,
    },
    anthropic: {
      ...ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY.providers.anthropic,
      released: true,
    },
  },
};

describe("Founder Conversation application seam", () => {
  let connection: DatabaseConnection;
  const now = new Date("2026-08-18T02:00:00.000Z");

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values({ id: OWNER_ID });
    await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => now,
    });
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

  it("persists one canonical conversation and returns the Operator response", async () => {
    const calls: string[] = [];
    const adapter: FounderConversationAdapter = {
      async send(input) {
        calls.push(input.requestId);
        return { ok: true, response: "I found one follow-up worth reviewing today." };
      },
    };

    const sent = await sendFounderConversationMessageForUser(OWNER_ID, "What needs my attention?", {
      createConnection: () => connection,
      requireOwnerPreviewAccess: allowOwnerPreviewWork,
      adapter,
      requestId: "request-1",
      now: () => now,
      requireReadyConnection: async () => ({
        provider: "openai",
        status: "ready",
        accountLabel: "founder@example.com",
        connectedAt: now.toISOString(),
        lastVerifiedAt: now.toISOString(),
        workState: "available",
        recoveryMessage: null,
        receipt: null,
      }),
    });

    expect(sent).toMatchObject({
      status: "active",
      messages: [
        { role: "founder", body: "What needs my attention?", status: "complete" },
        {
          role: "operator",
          body: "I found one follow-up worth reviewing today.",
          status: "complete",
        },
      ],
      activeWork: {
        state: "completed",
        checkpointId: expect.stringMatching(/^bruno-ai-checkpoint-/),
        provider: "openai",
        policyVersion: 2,
        completionIdentity: expect.stringMatching(/^bruno-ai-completion-/),
        externalEffectStarted: false,
        recoveryChoices: [],
      },
    });
    expect(calls).toEqual(["request-1"]);

    const duplicate = await sendFounderConversationMessageForUser(OWNER_ID, "ignored duplicate", {
      createConnection: () => connection,
      requireOwnerPreviewAccess: allowOwnerPreviewWork,
      adapter,
      requestId: "request-1",
      now: () => now,
      requireReadyConnection: async () => {
        throw new Error("duplicate should not recheck or send");
      },
    });
    expect(duplicate).toEqual(sent);
    expect(calls).toEqual(["request-1"]);

    await expect(
      getFounderConversationForUser(OWNER_ID, { createConnection: () => connection }),
    ).resolves.toEqual(sent);
  });

  it("checkpoints a message and shows paused work when connected AI capacity is unavailable", async () => {
    const adapter: FounderConversationAdapter = {
      async send() {
        return {
          ok: false,
          code: "capacity_unavailable",
          message: "Your connected AI account has no available capacity right now.",
        };
      },
    };

    const result = await sendFounderConversationMessageForUser(OWNER_ID, "Draft a client reply", {
      createConnection: () => connection,
      requireOwnerPreviewAccess: allowOwnerPreviewWork,
      adapter,
      requestId: "request-paused",
      now: () => now,
      requireReadyConnection: async () => ({
        provider: "openai",
        status: "ready",
        accountLabel: "founder@example.com",
        connectedAt: now.toISOString(),
        lastVerifiedAt: now.toISOString(),
        workState: "available",
        recoveryMessage: null,
        receipt: null,
      }),
    });

    expect(result).toMatchObject({
      status: "paused",
      messages: [
        { role: "founder", body: "Draft a client reply", status: "complete" },
        {
          role: "operator",
          status: "paused",
          body: "Your connected AI account has no available capacity right now.",
        },
      ],
      activeWork: {
        state: "paused",
        recoveryMessage: "Your connected AI account has no available capacity right now.",
        provider: "openai",
        policyVersion: 2,
        completionIdentity: expect.stringMatching(/^bruno-ai-completion-/),
        externalEffectStarted: false,
        recoveryChoices: [
          { kind: "reconnect" },
          { kind: "connect_provider" },
          { kind: "wait" },
          { kind: "upgrade" },
        ],
      },
    });
    await expect(connection.db.select().from(operatorConversationWorks)).resolves.toHaveLength(1);
    await expect(connection.db.select().from(operatorConversationMessages)).resolves.toHaveLength(
      2,
    );
  });

  it("rechecks OpenAI release protection inside the work-start transaction", async () => {
    let providerCalls = 0;

    await expect(
      sendFounderConversationMessageForUser(OWNER_ID, "Start protected work", {
        createConnection: () => connection,
        requestId: "request-held",
        now: () => now,
        requireOwnerPreviewAccess: async (_tx, input) => {
          expect(input.requiredCapabilities).toEqual(["openai"]);
          throw new FounderReleaseStageAccessError();
        },
        adapter: {
          async send() {
            providerCalls += 1;
            return { ok: true, response: "should not run" };
          },
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: "conversation_unavailable" });

    expect(providerCalls).toBe(0);
    await expect(connection.db.select().from(operatorConversationWorks)).resolves.toEqual([]);
    await expect(connection.db.select().from(operatorConversationMessages)).resolves.toEqual([]);
  });

  it("routes a work unit through the next Ready provider and records its account evidence", async () => {
    const [anthropic] = await connection.db
      .insert(operatorAiConnections)
      .values({
        operatorId: (
          await ensureFounderOperatorForUser(OWNER_ID, {
            createConnection: () => connection,
            now: () => now,
          })
        ).id,
        provider: "anthropic",
        providerSubjectId: "anthropic-account-1",
        accountLabel: "founder@anthropic.example",
        status: "ready",
        authorizationState: "authorized",
        capacityState: "available",
        inferenceState: "passed",
        eligibleAccount: true,
        billingVerified: true,
        privacyAccepted: true,
        retentionBounded: true,
        thirdPartyPermissionGranted: true,
        credentialHealthy: true,
        reconnectSupported: true,
        productionUseApproved: true,
        processingConsentActive: true,
        authorizationPersisted: true,
        approvedModelAssignment: "anthropic-claude",
        authorizedAt: now,
        lastVerifiedAt: now,
      })
      .returning();
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => now,
    });
    const sent = await sendFounderConversationMessageForUser(OWNER_ID, "Use the connected backup", {
      createConnection: () => connection,
      requireOwnerPreviewAccess: allowOwnerPreviewWork,
      adapters: {
        anthropic: {
          async send(input) {
            expect(input.provider).toBe("anthropic");
            expect(input.approvedModelAssignment).toBe("anthropic-claude");
            return { ok: true, response: "Handled by the connected backup." };
          },
        },
      },
      routingPolicy: MULTI_PROVIDER_POLICY,
      requestId: "request-anthropic",
      now: () => now,
      requireReadyConnection: async () => ({
        provider: "anthropic" as const,
        status: "ready" as const,
        accountLabel: "founder@anthropic.example",
        connectedAt: now.toISOString(),
        lastVerifiedAt: now.toISOString(),
        workState: "available" as const,
        recoveryMessage: null,
        receipt: null,
      }),
    });
    expect(sent.activeWork).toMatchObject({
      provider: "anthropic",
      policyVersion: 2,
      state: "completed",
    });
    const [work] = await connection.db.select().from(operatorConversationWorks);
    expect(work).toMatchObject({
      provider: "anthropic",
      providerConnectionId: anthropic?.id,
      providerSubjectId: "anthropic-account-1",
      providerAccountLabel: "founder@anthropic.example",
      policyVersion: 2,
    });
    expect(operator.id).toBeTruthy();
  });

  it("changes providers only when explicitly resuming the same paused checkpoint", async () => {
    const operator = await ensureFounderOperatorForUser(OWNER_ID, {
      createConnection: () => connection,
      now: () => now,
    });
    await connection.db.insert(operatorAiConnections).values([
      {
        operatorId: operator.id,
        provider: "openai",
        providerSubjectId: "openai-account-1",
        accountLabel: "founder@openai.example",
        status: "ready",
        authorizationState: "authorized",
        capacityState: "available",
        inferenceState: "passed",
        eligibleAccount: true,
        authorizationPersisted: true,
        approvedModelAssignment: "openai-codex",
        authorizedAt: now,
        lastVerifiedAt: now,
      },
      {
        operatorId: operator.id,
        provider: "anthropic",
        providerSubjectId: "anthropic-account-2",
        accountLabel: "founder@anthropic.example",
        status: "ready",
        authorizationState: "authorized",
        capacityState: "available",
        inferenceState: "passed",
        eligibleAccount: true,
        billingVerified: true,
        privacyAccepted: true,
        retentionBounded: true,
        thirdPartyPermissionGranted: true,
        credentialHealthy: true,
        reconnectSupported: true,
        productionUseApproved: true,
        processingConsentActive: true,
        authorizationPersisted: true,
        approvedModelAssignment: "anthropic-claude",
        authorizedAt: now,
        lastVerifiedAt: now,
      },
    ]);
    const calls: string[] = [];
    const paused = await sendFounderConversationMessageForUser(
      OWNER_ID,
      "Try the primary account",
      {
        createConnection: () => connection,
        requireOwnerPreviewAccess: allowOwnerPreviewWork,
        adapters: {
          openai: {
            async send(input) {
              calls.push(`${input.provider}:first`);
              return { ok: false, code: "capacity_unavailable", message: "OpenAI capacity ended." };
            },
          },
          anthropic: {
            async send(input) {
              calls.push(`${input.provider}:resume`);
              return { ok: true, response: "Recovered without duplicating the request." };
            },
          },
        },
        requestId: "request-failover",
        now: () => now,
        requireReadyConnection: async () => ({
          provider: "openai" as const,
          status: "ready" as const,
          accountLabel: "founder@openai.example",
          connectedAt: now.toISOString(),
          lastVerifiedAt: now.toISOString(),
          workState: "available" as const,
          recoveryMessage: null,
          receipt: null,
        }),
        routingPolicy: MULTI_PROVIDER_POLICY,
      },
    );
    expect(paused.activeWork).toMatchObject({ provider: "openai", state: "paused" });
    const resumed = await resumeFounderConversationWorkForUser(
      OWNER_ID,
      paused.activeWork?.id ?? "",
      {
        createConnection: () => connection,
        requireOwnerPreviewAccess: allowOwnerPreviewWork,
        adapters: {
          anthropic: {
            async send(input) {
              calls.push(`${input.provider}:resume`);
              return { ok: true, response: "Recovered without duplicating the request." };
            },
          },
        },
        routingPolicy: MULTI_PROVIDER_POLICY,
        now: () => now,
      },
    );
    expect(resumed.activeWork).toMatchObject({ provider: "anthropic", state: "completed" });
    expect(resumed.messages.filter((message) => message.role === "operator")).toHaveLength(1);
    expect(calls).toEqual(["openai:first", "anthropic:resume"]);
    const [persisted] = await connection.db.select().from(operatorConversationWorks);
    expect(persisted?.providerAttempts).toMatchObject([
      { provider: "openai", accountLabel: "founder@openai.example", state: "paused" },
      { provider: "anthropic", accountLabel: "founder@anthropic.example", state: "completed" },
    ]);
  });

  it("pauses external effects durably while leaving Conversation available", async () => {
    await expect(
      setFounderExternalActionPauseForUser(OWNER_ID, true, {
        createConnection: () => connection,
        now: () => now,
        reason: "Review the proposed action first.",
      }),
    ).resolves.toEqual({
      paused: true,
      reason: "Review the proposed action first.",
      pausedAt: now.toISOString(),
    });
    await expect(
      getFounderExternalActionPauseForUser(OWNER_ID, { createConnection: () => connection }),
    ).resolves.toEqual({
      paused: true,
      reason: "Review the proposed action first.",
      pausedAt: now.toISOString(),
    });
    await expect(
      assertFounderExternalActionsNotPaused(OWNER_ID, { createConnection: () => connection }),
    ).rejects.toMatchObject({ code: "external_action_paused", status: 409 });

    const sent = await sendFounderConversationMessageForUser(OWNER_ID, "Keep observing", {
      createConnection: () => connection,
      requireOwnerPreviewAccess: allowOwnerPreviewWork,
      adapter: {
        async send() {
          return { ok: true, response: "Conversation remains available." };
        },
      },
      requestId: "request-during-external-pause",
      now: () => now,
      requireReadyConnection: async () => ({
        provider: "openai",
        status: "ready",
        accountLabel: "founder@example.com",
        connectedAt: now.toISOString(),
        lastVerifiedAt: now.toISOString(),
        workState: "available",
        recoveryMessage: null,
        receipt: null,
      }),
    });
    expect(sent.activeWork).toMatchObject({ state: "completed" });

    await expect(
      setFounderExternalActionPauseForUser(OWNER_ID, false, {
        createConnection: () => connection,
        now: () => now,
      }),
    ).resolves.toEqual({ paused: false, reason: null, pausedAt: null });
    await expect(
      assertFounderExternalActionsNotPaused(OWNER_ID, { createConnection: () => connection }),
    ).resolves.toBeUndefined();
  });

  it("does not resubmit checkpointed work after an ambiguous provider failure", async () => {
    let calls = 0;
    const adapter: FounderConversationAdapter = {
      async send() {
        calls += 1;
        throw new Error("provider connection lost after submission");
      },
    };
    const dependencies = {
      createConnection: () => connection,
      requireOwnerPreviewAccess: allowOwnerPreviewWork,
      adapter,
      requestId: "request-ambiguous",
      now: () => now,
      requireReadyConnection: async () => ({
        provider: "openai" as const,
        status: "ready" as const,
        accountLabel: "founder@example.com",
        connectedAt: now.toISOString(),
        lastVerifiedAt: now.toISOString(),
        workState: "available" as const,
        recoveryMessage: null,
        receipt: null,
      }),
    };

    const paused = await sendFounderConversationMessageForUser(
      OWNER_ID,
      "Submit this once",
      dependencies,
    );
    expect(paused.activeWork).toMatchObject({ state: "paused" });
    expect(calls).toBe(1);

    const replay = await sendFounderConversationMessageForUser(OWNER_ID, "Do not submit twice", {
      ...dependencies,
      requireReadyConnection: async () => {
        throw new Error("replay should not recheck or send");
      },
    });
    expect(replay).toEqual(paused);
    expect(calls).toBe(1);
  });

  it("reserves checkpoint response identity across concurrent messages", async () => {
    const adapter: FounderConversationAdapter = {
      async send(input) {
        if (input.requestId === "request-first") {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { ok: true, response: `Response for ${input.requestId}` };
      },
    };
    const readyConnection = async () => ({
      provider: "openai" as const,
      status: "ready" as const,
      accountLabel: "founder@example.com",
      connectedAt: now.toISOString(),
      lastVerifiedAt: now.toISOString(),
      workState: "available" as const,
      recoveryMessage: null,
      receipt: null,
    });

    await Promise.all([
      sendFounderConversationMessageForUser(OWNER_ID, "First message", {
        createConnection: () => connection,
        requireOwnerPreviewAccess: allowOwnerPreviewWork,
        adapter,
        requestId: "request-first",
        now: () => now,
        requireReadyConnection: readyConnection,
      }),
      sendFounderConversationMessageForUser(OWNER_ID, "Second message", {
        createConnection: () => connection,
        requireOwnerPreviewAccess: allowOwnerPreviewWork,
        adapter,
        requestId: "request-second",
        now: () => now,
        requireReadyConnection: readyConnection,
      }),
    ]);

    const persisted = await getFounderConversationForUser(OWNER_ID, {
      createConnection: () => connection,
    });
    expect(persisted.messages.map(({ sequence, body }) => [sequence, body])).toEqual([
      [1, "First message"],
      [2, "Response for request-first"],
      [3, "Second message"],
      [4, "Response for request-second"],
    ]);
  });
});

async function allowOwnerPreviewWork(): Promise<void> {}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_conversation_messages, operator_conversation_works, operator_conversations, operator_ai_connection_receipts, operator_ai_connections, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
}
