import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentDeploymentForUser } from "@/src/server/agents/agent-deployments";
import {
  claimDeploymentWakeupDelivery,
  inspectExhaustedDeploymentWakeup,
  listExhaustedDeploymentWakeups,
  type DeploymentWakeupPayload,
  publishLatestDeploymentWakeupAfterCommit,
  replaceDeploymentWakeupInTransaction,
  replayExhaustedDeploymentWakeupInTransaction,
  sweepDeploymentWakeupOutbox,
} from "@/src/server/agents/agent-deployment-dispatch";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeployments, agentDeploymentWakeups, agents, users } from "@/src/server/db/schema";

const USER_ID = "00000000-0000-4000-8000-000000000f01";
const AGENT_ID = "00000000-0000-4000-8000-000000000f11";
const NOW = new Date("2026-08-08T03:00:00.000Z");

describe("deployment wakeup exhaustion", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
    await connection.db.insert(users).values({ id: USER_ID });
    await connection.db.insert(agents).values({
      id: AGENT_ID,
      userId: USER_ID,
      name: "Poison wakeup agent",
      templateKey: "research_agent",
      templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
      desiredStatus: "running",
    });
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it.each([
    [401, "publish_authentication_rejected"],
    [403, "publish_authentication_rejected"],
    [400, "publish_payload_rejected"],
    [413, "publish_payload_rejected"],
    [422, "publish_payload_rejected"],
  ] as const)("exhausts permanent QStash status %i after one attempt without retaining provider detail", async (status, safeErrorCode) => {
    const payload = await createWakeupPayload(connection);
    const privateDetail = `private-token-for-status-${status}`;
    const publisher = {
      publish: vi.fn(async () => {
        throw Object.assign(new Error(privateDetail), { status });
      }),
    };

    await expect(
      publishLatestDeploymentWakeupAfterCommit(payload.deploymentId, {
        createConnection: () => connection,
        readConfig: () => qstashConfig(12),
        publisher,
        now: () => NOW,
        randomUUID: () => "00000000-0000-4000-8000-000000000f99",
      }),
    ).resolves.toBe("unavailable");

    const [wakeup] = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId));
    expect(wakeup).toMatchObject({
      state: "exhausted",
      publishAttemptCount: 1,
      safeErrorCode,
      exhaustedAt: NOW,
      publishLeaseOwner: null,
      publishLeaseExpiresAt: null,
    });
    expect(JSON.stringify(wakeup)).not.toContain(privateDetail);

    await expect(
      connection.db.transaction((tx) => claimDeploymentWakeupDelivery(tx, { payload, now: NOW })),
    ).resolves.toEqual({ ok: false, reason: "terminal" });
  });

  it("atomically exhausts retryable publication after the configured attempt bound", async () => {
    const payload = await createWakeupPayload(connection);
    const publisher = {
      publish: vi.fn(async () => {
        throw Object.assign(new Error("transient provider detail"), { status: 503 });
      }),
    };
    const dependencies = {
      createConnection: () => connection,
      readConfig: () => qstashConfig(3),
      publisher,
      now: () => NOW,
      randomUUID: () => "00000000-0000-4000-8000-000000000f99",
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await publishLatestDeploymentWakeupAfterCommit(payload.deploymentId, dependencies);
    }

    expect(publisher.publish).toHaveBeenCalledTimes(3);
    const [wakeup] = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId));
    expect(wakeup).toMatchObject({
      state: "exhausted",
      publishAttemptCount: 3,
      safeErrorCode: "publish_attempts_exhausted",
      exhaustedAt: NOW,
      publishLeaseOwner: null,
      publishLeaseExpiresAt: null,
    });
  });

  it("allows only one concurrent publisher to consume and exhaust an attempt", async () => {
    const payload = await createWakeupPayload(connection);
    let rejectPublication: ((reason: unknown) => void) | undefined;
    let publicationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const publication = new Promise<{ messageId: string }>((_resolve, reject) => {
      rejectPublication = reject;
    });
    const firstPublisher = {
      publish: vi.fn(async () => {
        publicationStarted?.();
        return await publication;
      }),
    };
    const dependencies = {
      createConnection: () => connection,
      readConfig: () => qstashConfig(12),
      now: () => NOW,
      randomUUID: () => "00000000-0000-4000-8000-000000000f99",
    };
    const first = publishLatestDeploymentWakeupAfterCommit(payload.deploymentId, {
      ...dependencies,
      publisher: firstPublisher,
    });
    await started;

    const reorderedPublisher = {
      publish: vi.fn(async () => ({ messageId: "duplicate-provider-effect" })),
    };
    await expect(
      publishLatestDeploymentWakeupAfterCommit(payload.deploymentId, {
        ...dependencies,
        publisher: reorderedPublisher,
      }),
    ).resolves.toBe("unavailable");
    expect(reorderedPublisher.publish).not.toHaveBeenCalled();

    rejectPublication?.(Object.assign(new Error("private auth detail"), { status: 401 }));
    await expect(first).resolves.toBe("unavailable");
    expect(firstPublisher.publish).toHaveBeenCalledOnce();
    const [wakeup] = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId));
    expect(wakeup).toMatchObject({
      state: "exhausted",
      publishAttemptCount: 1,
      safeErrorCode: "publish_authentication_rejected",
    });
  });

  it("exhausts a bound-consuming expired publication lease without another provider effect", async () => {
    const payload = await createWakeupPayload(connection);
    await connection.db
      .update(agentDeploymentWakeups)
      .set({
        state: "publishing",
        publishAttemptCount: 3,
        publishLeaseOwner: "publish:expired",
        publishLeaseExpiresAt: new Date(NOW.getTime() - 1),
      })
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId));
    const publisher = { publish: vi.fn(async () => ({ messageId: "must-not-publish" })) };

    await expect(
      sweepDeploymentWakeupOutbox({
        createConnection: () => connection,
        readConfig: () => qstashConfig(3),
        publisher,
        now: () => NOW,
        randomUUID: () => "00000000-0000-4000-8000-000000000f99",
      }),
    ).resolves.toEqual({ published: 0 });

    expect(publisher.publish).not.toHaveBeenCalled();
    const [wakeup] = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId));
    expect(wakeup).toMatchObject({
      state: "exhausted",
      publishAttemptCount: 3,
      safeErrorCode: "publish_attempts_exhausted",
      exhaustedAt: NOW,
    });
  });

  it("lists and inspects only sanitized exhaustion evidence", async () => {
    const payload = await createWakeupPayload(connection);
    await exhaustWakeup(connection, payload, 401);

    const evidence = {
      wakeupId: expect.any(String),
      deploymentId: payload.deploymentId,
      generation: payload.generation,
      dueAt: payload.dueAt,
      state: "exhausted",
      publishAttemptCount: 1,
      safeReason: "publish_authentication_rejected",
      exhaustedAt: NOW.toISOString(),
    };
    await expect(listExhaustedDeploymentWakeups(connection.db)).resolves.toEqual([evidence]);
    const [row] = await listExhaustedDeploymentWakeups(connection.db);
    if (!row) throw new Error("Expected exhausted wakeup evidence.");
    await expect(inspectExhaustedDeploymentWakeup(connection.db, row.wakeupId)).resolves.toEqual(
      evidence,
    );

    const serialized = JSON.stringify(await listExhaustedDeploymentWakeups(connection.db));
    expect(serialized).not.toMatch(
      /Poison wakeup agent|private|token|owner|userId|providerMessageId/i,
    );
  });

  it("requires operator replay to terminalize exhausted identity and create a fenced generation", async () => {
    const payload = await createWakeupPayload(connection);
    await exhaustWakeup(connection, payload, 401);
    const [evidence] = await listExhaustedDeploymentWakeups(connection.db);
    if (!evidence) throw new Error("Expected exhausted wakeup evidence.");

    await expect(
      connection.db.transaction((tx) =>
        replaceDeploymentWakeupInTransaction(tx, {
          deploymentId: payload.deploymentId,
          dueAt: NOW,
          now: NOW,
        }),
      ),
    ).resolves.toBeNull();

    const replayed = await connection.db.transaction((tx) =>
      replayExhaustedDeploymentWakeupInTransaction(tx, {
        wakeupId: evidence.wakeupId,
        now: NOW,
      }),
    );
    expect(replayed).toEqual({
      ok: true,
      exhaustedWakeupId: evidence.wakeupId,
      wakeup: {
        deploymentId: payload.deploymentId,
        generation: payload.generation + 1,
        dueAt: NOW.toISOString(),
      },
    });

    const wakeups = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId))
      .orderBy(agentDeploymentWakeups.generation);
    expect(
      wakeups.map(({ generation, state, exhaustedAt, safeErrorCode }) => ({
        generation,
        state,
        exhaustedAt,
        safeErrorCode,
      })),
    ).toEqual([
      {
        generation: payload.generation,
        state: "terminal",
        exhaustedAt: NOW,
        safeErrorCode: "publish_authentication_rejected",
      },
      {
        generation: payload.generation + 1,
        state: "pending",
        exhaustedAt: null,
        safeErrorCode: null,
      },
    ]);
    await expect(
      inspectExhaustedDeploymentWakeup(connection.db, evidence.wakeupId),
    ).resolves.toEqual(
      expect.objectContaining({ state: "terminal", safeReason: "publish_authentication_rejected" }),
    );

    await expect(
      connection.db.transaction((tx) =>
        replayExhaustedDeploymentWakeupInTransaction(tx, {
          wakeupId: evidence.wakeupId,
          now: NOW,
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "not_exhausted" });
    await expect(
      connection.db.transaction((tx) => claimDeploymentWakeupDelivery(tx, { payload, now: NOW })),
    ).resolves.toEqual({ ok: false, reason: "terminal" });
  });

  it("permits only one concurrent replay of an exhausted identity", async () => {
    const payload = await createWakeupPayload(connection);
    await exhaustWakeup(connection, payload, 401);
    const [evidence] = await listExhaustedDeploymentWakeups(connection.db);
    if (!evidence) throw new Error("Expected exhausted wakeup evidence.");

    const results = await Promise.all([
      connection.db.transaction((tx) =>
        replayExhaustedDeploymentWakeupInTransaction(tx, {
          wakeupId: evidence.wakeupId,
          now: NOW,
        }),
      ),
      connection.db.transaction((tx) =>
        replayExhaustedDeploymentWakeupInTransaction(tx, {
          wakeupId: evidence.wakeupId,
          now: NOW,
        }),
      ),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true }),
        { ok: false, reason: "not_exhausted" },
      ]),
    );
    const wakeups = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, payload.deploymentId));
    expect(wakeups).toHaveLength(2);
  });

  it("rejects replay when the deployment is terminal or the exhausted generation is superseded", async () => {
    const payload = await createWakeupPayload(connection);
    await exhaustWakeup(connection, payload, 401);
    const [evidence] = await listExhaustedDeploymentWakeups(connection.db);
    if (!evidence) throw new Error("Expected exhausted wakeup evidence.");

    await connection.db
      .update(agentDeployments)
      .set({ stage: "failed", errorCode: "replay_test_terminal", failedAt: NOW, updatedAt: NOW })
      .where(eq(agentDeployments.id, payload.deploymentId));
    await expect(
      connection.db.transaction((tx) =>
        replayExhaustedDeploymentWakeupInTransaction(tx, {
          wakeupId: evidence.wakeupId,
          now: NOW,
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "deployment_terminal" });

    await connection.db
      .update(agentDeployments)
      .set({ stage: "pending", errorCode: null, failedAt: null, updatedAt: NOW })
      .where(eq(agentDeployments.id, payload.deploymentId));
    await connection.db.insert(agentDeploymentWakeups).values({
      deploymentId: payload.deploymentId,
      generation: payload.generation + 1,
      dueAt: NOW,
    });
    await expect(
      connection.db.transaction((tx) =>
        replayExhaustedDeploymentWakeupInTransaction(tx, {
          wakeupId: evidence.wakeupId,
          now: NOW,
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "superseded" });
  });
});

async function createWakeupPayload(
  connection: DatabaseConnection,
): Promise<DeploymentWakeupPayload> {
  const created = await connection.db.transaction((tx) =>
    createAgentDeploymentForUser({
      db: tx,
      userId: USER_ID,
      agentId: AGENT_ID,
      configRevision: "cfg-poison-wakeup",
      idempotencyKey: "poison-wakeup",
      now: NOW,
    }),
  );
  if (!created.ok) throw new Error(`Deployment creation failed: ${created.reason}`);

  const [wakeup] = await connection.db
    .select()
    .from(agentDeploymentWakeups)
    .where(eq(agentDeploymentWakeups.deploymentId, created.deployment.id));
  if (!wakeup) throw new Error("Expected deployment wakeup row.");

  return {
    deploymentId: wakeup.deploymentId,
    generation: wakeup.generation,
    dueAt: wakeup.dueAt.toISOString(),
  };
}

function qstashConfig(maxPublishAttempts: number) {
  return {
    ok: true,
    mode: "qstash",
    token: "qstash_token_abcdefghijklmnopqrstuvwxyz012345",
    currentSigningKey: "current_signing_key_abcdefghijklmnopqrstuvwxyz012345",
    nextSigningKey: "next_signing_key_abcdefghijklmnopqrstuvwxyz012345",
    callbackBaseUrl: "https://app.example.test",
    maxPublishAttempts,
  } as const;
}

async function exhaustWakeup(
  connection: DatabaseConnection,
  payload: DeploymentWakeupPayload,
  status: number,
): Promise<void> {
  await publishLatestDeploymentWakeupAfterCommit(payload.deploymentId, {
    createConnection: () => connection,
    readConfig: () => qstashConfig(12),
    publisher: {
      publish: async () => {
        throw Object.assign(new Error("private provider failure"), { status });
      },
    },
    now: () => NOW,
    randomUUID: () => "00000000-0000-4000-8000-000000000f99",
  });
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_deployments, agents, users restart identity cascade`;
}
