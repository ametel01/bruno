import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentRuntimePresentationForUser } from "@/src/server/agents/agent-runtime-read";
import { getActiveAgentForUser, listActiveAgentsForUser } from "@/src/server/agents/list-agents";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentConfigs,
  agentDeployments,
  agentRuntimeReconciliations,
  agents,
  users,
} from "@/src/server/db/schema";

const USER_A_ID = "00000000-0000-4000-8000-000000009301";
const USER_B_ID = "00000000-0000-4000-8000-000000009302";
const HEALTHY_AGENT_ID = "00000000-0000-4000-8000-000000009311";
const MISSING_RUNTIME_AGENT_ID = "00000000-0000-4000-8000-000000009312";
const FOREIGN_AGENT_ID = "00000000-0000-4000-8000-000000009313";
const RUNTIME_REVISION_CANARY = "PRIVATE-RUNTIME-REVISION-CANARY";

describe("Step 9 owner-scoped passive runtime reads", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await seed(connection);
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("projects safe runtime truth on list/detail and fails missing ready evidence closed", async () => {
    const list = await listActiveAgentsForUser(USER_A_ID, { createConnection: () => connection });
    const detail = await getActiveAgentForUser(USER_A_ID, HEALTHY_AGENT_ID, {
      createConnection: () => connection,
    });

    expect(list).toHaveLength(2);
    expect(list.find((agent) => agent.id === HEALTHY_AGENT_ID)?.runtime).toEqual({
      kind: "healthy",
      action: "none",
      label: "Ready",
      message: "Hermes gateway is ready.",
    });
    expect(list.find((agent) => agent.id === MISSING_RUNTIME_AGENT_ID)?.runtime).toEqual({
      kind: "unavailable",
      action: "wait",
      label: "Unavailable",
      message: "Runtime state could not be verified safely.",
    });
    expect(detail?.runtime).toEqual(list.find((agent) => agent.id === HEALTHY_AGENT_ID)?.runtime);

    for (const value of [list, detail]) {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain(RUNTIME_REVISION_CANARY);
      expect(serialized).not.toContain(FOREIGN_AGENT_ID);
      expect(serialized).not.toMatch(
        /runtimeGeneration|runtimeAttempt|runtimeRecovery|runtimeErrorCode|circuitOpened|leaseOwner|operationId|restartCount/,
      );
    }
  });

  it("conceals foreign runtime reads and returns null for manual history", async () => {
    await expect(
      getAgentRuntimePresentationForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: FOREIGN_AGENT_ID,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });

    await connection.db
      .delete(agentDeployments)
      .where(eq(agentDeployments.agentId, MISSING_RUNTIME_AGENT_ID));
    await expect(
      getAgentRuntimePresentationForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: MISSING_RUNTIME_AGENT_ID,
      }),
    ).resolves.toEqual({ ok: true, runtime: null });
  });
});

describe("Step 9 browser read passivity", () => {
  it("contains no lifecycle or reconciler call in list/detail/runtime read paths", async () => {
    const [listSource, routeSource, inventory, dashboard] = await Promise.all([
      readFile("src/server/agents/list-agents.ts", "utf8"),
      readFile("app/api/agents/[agentId]/runtime/route.ts", "utf8"),
      readFile("app/agents/page.tsx", "utf8"),
      readFile("app/dashboard/page.tsx", "utf8"),
    ]);

    for (const source of [listSource, routeSource]) {
      expect(source).not.toMatch(/reconcileDocker|reconcileAgentRuntime|schedule.*reconcil/i);
      expect(source).not.toMatch(/runnerAdapter|docker\.(?:start|stop|inspect)|fetch\(/i);
    }
    for (const source of [inventory, dashboard]) {
      expect(source).not.toContain("AgentRuntimeStatus");
      expect(source).not.toContain("setInterval(");
      expect(source).not.toContain("setTimeout(");
      expect(source).not.toContain("fetch(");
    }
  });
});

async function seed(connection: DatabaseConnection): Promise<void> {
  const at = new Date("2026-08-03T00:00:00.000Z");
  await connection.db.insert(users).values([{ id: USER_A_ID }, { id: USER_B_ID }]);
  await connection.db
    .insert(agents)
    .values([
      agentRow(HEALTHY_AGENT_ID, USER_A_ID, "Healthy"),
      agentRow(MISSING_RUNTIME_AGENT_ID, USER_A_ID, "Missing runtime"),
      agentRow(FOREIGN_AGENT_ID, USER_B_ID, "Foreign"),
    ]);
  await connection.db
    .insert(agentConfigs)
    .values([
      configRow(HEALTHY_AGENT_ID),
      configRow(MISSING_RUNTIME_AGENT_ID),
      configRow(FOREIGN_AGENT_ID),
    ]);
  await connection.db
    .insert(agentDeployments)
    .values([
      deploymentRow(HEALTHY_AGENT_ID, USER_A_ID, at),
      deploymentRow(MISSING_RUNTIME_AGENT_ID, USER_A_ID, at),
      deploymentRow(FOREIGN_AGENT_ID, USER_B_ID, at),
    ]);
  await connection.db.insert(agentRuntimeReconciliations).values([
    {
      agentId: HEALTHY_AGENT_ID,
      userId: USER_A_ID,
      state: "observing",
      configRevision: RUNTIME_REVISION_CANARY,
      operationId: HEALTHY_AGENT_ID,
      lastObservedAt: at,
      lastReadyAt: at,
      stableSince: at,
      nextAttemptAt: new Date(at.getTime() + 60_000),
      createdAt: at,
      updatedAt: at,
    },
    {
      agentId: FOREIGN_AGENT_ID,
      userId: USER_B_ID,
      state: "circuit_open",
      configRevision: "foreign-private-runtime",
      errorCode: "telegram_webhook_conflict",
      circuitOpenedAt: at,
      createdAt: at,
      updatedAt: at,
    },
  ]);
}

function agentRow(id: string, userId: string, name: string) {
  return {
    id,
    userId,
    name,
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status: "running" as const,
    desiredStatus: "running" as const,
  };
}

function configRow(agentId: string) {
  return {
    agentId,
    systemPrompt: "Deterministic runtime projection fixture.",
    modelProvider: "openrouter",
    modelName: "openai/gpt-4.1-mini",
    scheduleMode: "manual" as const,
    timezone: "UTC",
  };
}

function deploymentRow(agentId: string, userId: string, at: Date) {
  return {
    agentId,
    userId,
    stage: "ready" as const,
    configRevision: "historical-ready-revision",
    idempotencyKey: `${agentId}-ready`,
    runnerOperationId: agentId,
    runnerAcceptedAt: at,
    canaryState: "passed" as const,
    canaryAttemptedAt: at,
    canaryCompletedAt: at,
    startedAt: at,
    completedAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table agent_runtime_reconciliations, agent_deployments, agent_configs, agents, users restart identity cascade",
  );
}
