import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/agent-deployments/wakeup/route";
import { createAgentDeploymentForUser } from "@/src/server/agents/agent-deployments";
import {
  deploymentWakeupSafeCodes,
  signDeploymentWakeupBody,
  type DeploymentWakeupPayload,
} from "@/src/server/agents/agent-deployment-dispatch";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeploymentWakeups, agents, users } from "@/src/server/db/schema";

const USER_ID = "00000000-0000-4000-8000-000000000e01";
const AGENT_ID = "00000000-0000-4000-8000-000000000e11";
const NOW = new Date("2026-08-07T02:00:00.000Z");
const CURRENT_SIGNING_KEY = "current_signing_key_abcdefghijklmnopqrstuvwxyz012345";
const NEXT_SIGNING_KEY = "next_signing_key_abcdefghijklmnopqrstuvwxyz012345";

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
          [deploymentWakeupSafeCodes.signatureHeader]: signDeploymentWakeupBody(
            `${body} `,
            CURRENT_SIGNING_KEY,
          ),
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

    const request = signedRequest(body, CURRENT_SIGNING_KEY);
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

    const duplicate = await POST(signedRequest(body, NEXT_SIGNING_KEY), undefined, {
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

  it("rejects early deliveries without claiming or reconciling", async () => {
    const payload = await createWakeupPayload(new Date(NOW.getTime() + 2_000));
    const body = JSON.stringify(payload);
    const reconcile = vi.fn();

    const response = await POST(signedRequest(body, CURRENT_SIGNING_KEY), undefined, {
      readConfig: readQstashConfig,
      createConnection: () => connection,
      reconcile,
      now: () => NOW,
    });

    expect(await response.json()).toEqual({ ok: true, processed: 0, outcome: "early" });
    expect(reconcile).not.toHaveBeenCalled();
  });

  async function createWakeupPayload(dueAt = NOW): Promise<DeploymentWakeupPayload> {
    const created = await createAgentDeploymentForUser({
      db: connection.db,
      userId: USER_ID,
      agentId: AGENT_ID,
      configRevision: "cfg-wakeup",
      idempotencyKey: `wakeup-${dueAt.getTime()}`,
      now: dueAt,
    });

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

function signedRequest(body: string, signingKey: string): Request {
  return new Request("https://app.example.test/api/internal/agent-deployments/wakeup", {
    method: "POST",
    headers: {
      [deploymentWakeupSafeCodes.signatureHeader]: signDeploymentWakeupBody(body, signingKey),
    },
    body,
  });
}

function readQstashConfig() {
  return {
    ok: true,
    mode: "qstash",
    token: "qstash_token_abcdefghijklmnopqrstuvwxyz012345",
    currentSigningKey: CURRENT_SIGNING_KEY,
    nextSigningKey: NEXT_SIGNING_KEY,
    callbackBaseUrl: "https://app.example.test",
  } as const;
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_deployments, agents, users restart identity cascade`;
}
