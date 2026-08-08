import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryAgentDeploymentForUser } from "@/src/server/agents/agent-deployment-retry";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeployments, agentEvents, agents, users } from "@/src/server/db/schema";

const USER_A_ID = "00000000-0000-4000-8000-000000000791";
const USER_B_ID = "00000000-0000-4000-8000-000000000792";
const AGENT_A_ID = "00000000-0000-4000-8000-000000000793";
const AGENT_B_ID = "00000000-0000-4000-8000-000000000794";
const FAILED_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000795";
const NOW = new Date("2026-08-03T09:00:00.000Z");

describe("agent deployment retry persistence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await seedOwners(connection);
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("converges separate-connection same-key retries to one new pending operation", async () => {
    await seedFailedDeployment(connection, AGENT_A_ID, USER_A_ID);
    const first = createDatabaseConnection();
    const second = createDatabaseConnection();
    const onCommitted = vi.fn();

    try {
      const [left, right] = await Promise.all([
        retryAgentDeploymentForUser({
          userId: USER_A_ID,
          agentId: AGENT_A_ID,
          idempotencyKey: "  Retry-Key-Case  ",
          dependencies: {
            createConnection: () => first,
            now: () => NOW,
            onDeploymentCommitted: onCommitted,
          },
        }),
        retryAgentDeploymentForUser({
          userId: USER_A_ID,
          agentId: AGENT_A_ID,
          idempotencyKey: "Retry-Key-Case",
          dependencies: {
            createConnection: () => second,
            now: () => NOW,
            onDeploymentCommitted: onCommitted,
          },
        }),
      ]);

      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      expect(left.ok && right.ok ? left.deployment.id : null).toBe(
        left.ok && right.ok ? right.deployment.id : null,
      );
      expect(onCommitted).toHaveBeenCalledOnce();
      const rows = await connection.db.select().from(agentDeployments);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: FAILED_DEPLOYMENT_ID, stage: "failed" }),
          expect.objectContaining({
            stage: "pending",
            configRevision: "cfg-retry-1",
            idempotencyKey: "Retry-Key-Case",
            attemptCount: 0,
            acceptedAt: expect.any(Date),
          }),
        ]),
      );
      const events = await connection.db
        .select()
        .from(agentEvents)
        .where(eq(agentEvents.agentId, AGENT_A_ID));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "agent.deployment_retry_requested",
        metadata: { launchMode: "ready" },
      });
      expect(JSON.stringify(events[0]?.metadata)).not.toContain("Retry-Key-Case");
      expect(JSON.stringify(events[0]?.metadata)).not.toContain(USER_A_ID);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("conceals foreign and deleted agents while distinguishing intentional stop conflicts", async () => {
    await seedFailedDeployment(connection, AGENT_A_ID, USER_A_ID);

    await expect(
      retryAgentDeploymentForUser({
        userId: USER_B_ID,
        agentId: AGENT_A_ID,
        idempotencyKey: "Foreign-Key-001",
        dependencies: { createConnection: () => connection, now: () => NOW },
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });

    await connection.db
      .update(agents)
      .set({ desiredStatus: "stopped" })
      .where(eq(agents.id, AGENT_A_ID));
    await expect(
      retryAgentDeploymentForUser({
        userId: USER_A_ID,
        agentId: AGENT_A_ID,
        idempotencyKey: "Stopped-Key-001",
        dependencies: { createConnection: () => connection, now: () => NOW },
      }),
    ).resolves.toEqual({ ok: false, reason: "deployment_not_retryable" });

    await connection.db
      .update(agents)
      .set({ desiredStatus: "running", deletedAt: NOW })
      .where(eq(agents.id, AGENT_A_ID));
    await expect(
      retryAgentDeploymentForUser({
        userId: USER_A_ID,
        agentId: AGENT_A_ID,
        idempotencyKey: "Deleted-Key-001",
        dependencies: { createConnection: () => connection, now: () => NOW },
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });
  });

  it("does not replay an idempotency key belonging to another agent", async () => {
    await seedFailedDeployment(connection, AGENT_A_ID, USER_A_ID);
    await seedFailedDeployment(connection, AGENT_B_ID, USER_A_ID, {
      id: "00000000-0000-4000-8000-000000000796",
      key: "Used-By-Agent-B",
    });

    await expect(
      retryAgentDeploymentForUser({
        userId: USER_A_ID,
        agentId: AGENT_A_ID,
        idempotencyKey: "Used-By-Agent-B",
        dependencies: { createConnection: () => connection, now: () => NOW },
      }),
    ).resolves.toEqual({ ok: false, reason: "deployment_not_retryable" });
    await expect(connection.db.select().from(agentEvents)).resolves.toHaveLength(0);
  });

  it("never mistakes the failed creation key for a retry replay", async () => {
    await seedFailedDeployment(connection, AGENT_A_ID, USER_A_ID);

    await expect(
      retryAgentDeploymentForUser({
        userId: USER_A_ID,
        agentId: AGENT_A_ID,
        idempotencyKey: "Failed-Key-001",
        dependencies: { createConnection: () => connection, now: () => NOW },
      }),
    ).resolves.toEqual({ ok: false, reason: "deployment_not_retryable" });
    await expect(connection.db.select().from(agentDeployments)).resolves.toHaveLength(1);
    await expect(connection.db.select().from(agentEvents)).resolves.toHaveLength(0);
  });
});

async function seedOwners(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values([{ id: USER_A_ID }, { id: USER_B_ID }]);
  await connection.db.insert(agents).values([
    {
      id: AGENT_A_ID,
      userId: USER_A_ID,
      name: "Retry A",
      templateKey: "research_agent",
      templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
      desiredStatus: "running",
      status: "error",
    },
    {
      id: AGENT_B_ID,
      userId: USER_A_ID,
      name: "Retry B",
      templateKey: "research_agent",
      templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
      desiredStatus: "running",
      status: "error",
    },
  ]);
}

async function seedFailedDeployment(
  connection: DatabaseConnection,
  agentId: string,
  userId: string,
  options: { id?: string; key?: string } = {},
): Promise<void> {
  await connection.db.insert(agentDeployments).values({
    id: options.id ?? FAILED_DEPLOYMENT_ID,
    agentId,
    userId,
    stage: "failed",
    configRevision: "cfg-retry-1",
    idempotencyKey: options.key ?? "Failed-Key-001",
    errorCode: "runner_start_failed",
    failedAt: new Date(NOW.getTime() - 1_000),
    createdAt: new Date(NOW.getTime() - 2_000),
    updatedAt: new Date(NOW.getTime() - 1_000),
  });
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table agent_events, agent_deployments, agents, users restart identity cascade",
  );
}
