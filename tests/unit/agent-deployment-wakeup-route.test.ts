import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/agent-deployments/wakeup/route";
import { createAgentDeploymentForUser } from "@/src/server/agents/agent-deployments";
import {
  deploymentWakeupSafeCodes,
  type DeploymentWakeupPayload,
  publishLatestDeploymentWakeupAfterCommit,
} from "@/src/server/agents/agent-deployment-dispatch";
import {
  DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS,
  drainTargetAgentDeployment,
} from "@/src/server/agents/agent-deployment-reconciler";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentConfigs,
  agentDeployments,
  agentDeploymentWakeups,
  agents,
  runners,
  users,
} from "@/src/server/db/schema";
import { sampleManagedLaunchSpec } from "@/tests/helpers/agent-launch-spec";

const USER_ID = "00000000-0000-4000-8000-000000000e01";
const AGENT_ID = "00000000-0000-4000-8000-000000000e11";
const RUNNER_ID = "00000000-0000-4000-8000-000000000e21";
const NOW = new Date("2026-08-07T02:00:00.000Z");
const CURRENT_SIGNING_KEY = "current_signing_key_abcdefghijklmnopqrstuvwxyz012345";
const NEXT_SIGNING_KEY = "next_signing_key_abcdefghijklmnopqrstuvwxyz012345";
const CALLBACK_URL = "https://app.example.test/api/internal/agent-deployments/wakeup";

describe("POST /api/internal/agent-deployments/wakeup", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
    await connection.db.insert(users).values({ id: USER_ID });
    await connection.db.insert(agents).values({
      id: AGENT_ID,
      userId: USER_ID,
      name: "Wakeup Agent",
      templateKey: "research_agent",
      templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
      desiredStatus: "running",
    });
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("verifies the unmodified body before parsing and rejects unsigned payloads safely", async () => {
    const payload = await createWakeupPayload();
    const body = JSON.stringify(payload);
    const reconcile = vi.fn();

    const response = await POST(
      new Request("https://app.example.test/api/internal/agent-deployments/wakeup", {
        method: "POST",
        headers: {
          [deploymentWakeupSafeCodes.signatureHeader]: await signQstashBody(`${body} `, {
            signingKey: CURRENT_SIGNING_KEY,
            subject: CALLBACK_URL,
          }),
        },
        body,
      }),
      undefined,
      {
        readConfig: readQstashConfig,
        createConnection: () => connection,
        reconcile,
        now: () => NOW,
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "deployment_wakeup_unauthorized",
        message: "Deployment wakeup delivery failed safely.",
      },
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("claims one due generation and invokes targeted reconciliation once", async () => {
    const payload = await createWakeupPayload();
    const body = JSON.stringify(payload);
    const reconcile = vi.fn(async () => ({ processed: 1 as const, outcome: "advanced" as const }));

    const request = await signedRequest(body, CURRENT_SIGNING_KEY);
    const response = await POST(request, undefined, {
      readConfig: readQstashConfig,
      createConnection: () => connection,
      reconcile,
      now: () => NOW,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, processed: 1, outcome: "advanced" });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(payload.deploymentId);

    const duplicate = await POST(await signedRequest(body, NEXT_SIGNING_KEY), undefined, {
      readConfig: readQstashConfig,
      createConnection: () => connection,
      reconcile,
      now: () => NOW,
    });

    expect(await duplicate.json()).toEqual({ ok: true, processed: 0, outcome: "already_claimed" });
    expect(reconcile).toHaveBeenCalledOnce();

    const [wakeup] = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId));
    expect(wakeup).toMatchObject({ state: "claimed", generation: payload.generation });
  });

  it("publishes the exact next wakeup persisted by a bounded drain", async () => {
    const payload = await createWakeupPayload();
    const body = JSON.stringify(payload);
    const reconcile = vi.fn(async () => ({
      processed: 1 as const,
      outcome: "retry_scheduled" as const,
    }));
    const publishWakeup = vi.fn(async () => "published" as const);

    const response = await POST(await signedRequest(body, CURRENT_SIGNING_KEY), undefined, {
      readConfig: readQstashConfig,
      createConnection: () => connection,
      reconcile,
      publishWakeup,
      now: () => NOW,
    });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(payload.deploymentId);
    expect(publishWakeup).toHaveBeenCalledOnce();
    expect(publishWakeup).toHaveBeenCalledWith(payload.deploymentId);
  });

  it("replaces and publishes a consumed generation when the real drain deadline aborts", async () => {
    const payload = await createWakeupPayload();
    const body = JSON.stringify(payload);
    const deadlineAt = new Date(NOW.getTime() + DEPLOYMENT_RECONCILE_ACTION_DEADLINE_MS);
    let current = NOW;
    const launchSpec = sampleManagedLaunchSpec({
      agent: {
        ...sampleManagedLaunchSpec().agent,
        id: AGENT_ID,
        configRevision: "cfg-wakeup",
      },
    });
    await connection.db.insert(runners).values({
      id: RUNNER_ID,
      userId: USER_ID,
      name: "Wakeup deadline runner",
      kind: "manual_vps",
      endpointUrl: "http://127.0.0.1:3045",
      status: "online",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await connection.db.insert(agentConfigs).values({
      agentId: AGENT_ID,
      systemPrompt: "Wakeup deadline regression.",
      modelProvider: "openrouter",
      modelName: "openai/gpt-4.1-mini",
      maxDailySpendCents: 0,
      scheduleMode: "manual",
      timezone: "UTC",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await connection.db
      .update(agents)
      .set({ runnerId: RUNNER_ID, status: "starting", updatedAt: NOW })
      .where(eq(agents.id, AGENT_ID));
    await connection.db
      .update(agentDeployments)
      .set({ stage: "configuring_hermes", updatedAt: NOW })
      .where(eq(agentDeployments.id, payload.deploymentId));

    const published = vi.fn(async () => ({ messageId: "msg-deadline-replacement" }));
    let pendingBeforePublish: typeof agentDeploymentWakeups.$inferSelect | undefined;
    const response = await POST(await signedRequest(body, CURRENT_SIGNING_KEY), undefined, {
      readConfig: readQstashConfig,
      createConnection: () => connection,
      now: () => NOW,
      reconcile: (deploymentId) =>
        drainTargetAgentDeployment(deploymentId, {
          createConnection: () => connection,
          now: () => current,
          launchSpec: async () => ({ ok: true, spec: launchSpec }),
          manualRunnerAdapter: () =>
            ({
              start: vi.fn(async () => {
                current = deadlineAt;
                throw new DOMException("Deployment action deadline exceeded.", "TimeoutError");
              }),
              status: vi.fn(),
              stop: vi.fn(),
              streamLogs: vi.fn(),
              canary: vi.fn(),
            }) as never,
        }),
      publishWakeup: async (deploymentId) => {
        [pendingBeforePublish] = await connection.db
          .select()
          .from(agentDeploymentWakeups)
          .where(eq(agentDeploymentWakeups.state, "pending"));
        return publishLatestDeploymentWakeupAfterCommit(deploymentId, {
          createConnection: () => connection,
          readConfig: readQstashConfig,
          publisher: { publish: published },
          now: () => current,
          randomUUID: () => "00000000-0000-4000-8000-000000000e99",
        });
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, processed: 0, outcome: "idle" });
    expect(pendingBeforePublish).toMatchObject({
      deploymentId: payload.deploymentId,
      generation: payload.generation + 1,
      dueAt: deadlineAt,
      state: "pending",
    });
    expect(published).toHaveBeenCalledOnce();
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          deploymentId: payload.deploymentId,
          generation: payload.generation + 1,
          dueAt: deadlineAt.toISOString(),
        },
        dueAt: deadlineAt,
      }),
    );
    const wakeups = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId))
      .orderBy(agentDeploymentWakeups.generation);
    expect(wakeups.map(({ generation, state, dueAt }) => ({ generation, state, dueAt }))).toEqual([
      { generation: payload.generation, state: "claimed", dueAt: NOW },
      { generation: payload.generation + 1, state: "published", dueAt: deadlineAt },
    ]);
  });

  it("rejects QStash JWTs with the wrong callback subject or invalid time claims", async () => {
    const payload = await createWakeupPayload();
    const body = JSON.stringify(payload);
    const reconcile = vi.fn();

    for (const signature of [
      await signQstashBody(body, {
        signingKey: CURRENT_SIGNING_KEY,
        subject: "https://app.example.test/api/internal/agent-deployments/other",
      }),
      await signQstashBody(body, {
        signingKey: CURRENT_SIGNING_KEY,
        subject: CALLBACK_URL,
        expiresInSeconds: -60,
      }),
      await signQstashBody(body, {
        signingKey: CURRENT_SIGNING_KEY,
        subject: CALLBACK_URL,
        notBeforeOffsetSeconds: 60,
      }),
    ]) {
      const response = await POST(
        new Request(CALLBACK_URL, {
          method: "POST",
          headers: {
            [deploymentWakeupSafeCodes.signatureHeader]: signature,
          },
          body,
        }),
        undefined,
        {
          readConfig: readQstashConfig,
          createConnection: () => connection,
          reconcile,
          now: () => NOW,
        },
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: {
          code: "deployment_wakeup_unauthorized",
          message: "Deployment wakeup delivery failed safely.",
        },
      });
    }

    expect(reconcile).not.toHaveBeenCalled();
    const [wakeup] = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId));
    expect(wakeup).toMatchObject({ state: "pending" });
  });

  it("rejects early deliveries without claiming or reconciling", async () => {
    const payload = await createWakeupPayload(new Date(NOW.getTime() + 2_000));
    const body = JSON.stringify(payload);
    const reconcile = vi.fn();

    const response = await POST(await signedRequest(body, CURRENT_SIGNING_KEY), undefined, {
      readConfig: readQstashConfig,
      createConnection: () => connection,
      reconcile,
      now: () => NOW,
    });

    expect(await response.json()).toEqual({ ok: true, processed: 0, outcome: "early" });
    expect(reconcile).not.toHaveBeenCalled();
  });

  async function createWakeupPayload(dueAt = NOW): Promise<DeploymentWakeupPayload> {
    const created = await connection.db.transaction((tx) =>
      createAgentDeploymentForUser({
        db: tx,
        userId: USER_ID,
        agentId: AGENT_ID,
        configRevision: "cfg-wakeup",
        idempotencyKey: `wakeup-${dueAt.getTime()}`,
        now: dueAt,
      }),
    );

    if (!created.ok) {
      throw new Error(`Deployment creation failed: ${created.reason}`);
    }

    const [wakeup] = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, created.deployment.id));

    if (!wakeup) {
      throw new Error("Expected deployment wakeup row.");
    }

    return {
      deploymentId: wakeup.deploymentId,
      generation: wakeup.generation,
      dueAt: wakeup.dueAt.toISOString(),
    };
  }
});

async function signedRequest(body: string, signingKey: string): Promise<Request> {
  return new Request(CALLBACK_URL, {
    method: "POST",
    headers: {
      [deploymentWakeupSafeCodes.signatureHeader]: await signQstashBody(body, {
        signingKey,
        subject: CALLBACK_URL,
      }),
    },
    body,
  });
}

async function signQstashBody(
  body: string,
  input: {
    signingKey: string;
    subject: string;
    now?: Date;
    notBeforeOffsetSeconds?: number;
    expiresInSeconds?: number;
  },
): Promise<string> {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  return await new SignJWT({ body: createHash("sha256").update(body).digest("base64url") })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("Upstash")
    .setSubject(input.subject)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt + (input.notBeforeOffsetSeconds ?? -1))
    .setExpirationTime(issuedAt + (input.expiresInSeconds ?? 60))
    .sign(new TextEncoder().encode(input.signingKey));
}

function readQstashConfig() {
  return {
    ok: true,
    mode: "qstash",
    token: "qstash_token_abcdefghijklmnopqrstuvwxyz012345",
    currentSigningKey: CURRENT_SIGNING_KEY,
    nextSigningKey: NEXT_SIGNING_KEY,
    callbackBaseUrl: "https://app.example.test",
    maxPublishAttempts: 12,
  } as const;
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_deployments, agents, users restart identity cascade`;
}
