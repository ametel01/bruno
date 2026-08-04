import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveAgentForUser, listActiveAgentsForUser } from "@/src/server/agents/list-agents";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentDeployments, agents, users } from "@/src/server/db/schema";

const USER_A_ID = "00000000-0000-4000-8000-000000008101";
const USER_B_ID = "00000000-0000-4000-8000-000000008102";
const AGENT_A_ID = "00000000-0000-4000-8000-000000008111";
const AGENT_B_ID = "00000000-0000-4000-8000-000000008112";
const DELETED_AGENT_ID = "00000000-0000-4000-8000-000000008113";
const OLDER_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000008121";
const LATEST_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000008122";
const CREATED_AT_TIE = new Date("2026-08-03T10:00:00.000Z");

const PRIVATE_CANARIES = [
  "step8-create-idempotency-key",
  "reconcile:00000000-0000-4000-8000-000000008199",
  "STEP8-UPSTREAM-ERROR-DETAIL",
] as const;

describe("Step 8 owner-scoped deployment projections", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await seedProjectionRows(connection);
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("selects the latest concurrent-retry snapshot by createdAt then UUID for list and detail", async () => {
    const list = await listActiveAgentsForUser(USER_A_ID, {
      createConnection: () => connection,
    });
    const detail = await getActiveAgentForUser(USER_A_ID, AGENT_A_ID, {
      createConnection: () => connection,
    });

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: AGENT_A_ID,
      desiredStatus: "running",
      latestDeployment: {
        id: LATEST_DEPLOYMENT_ID,
        agentId: AGENT_A_ID,
        stage: "pending",
        configRevision: "cfg-latest-retry",
        attemptCount: 1,
        error: { code: "provider_unavailable" },
        createdAt: CREATED_AT_TIE.toISOString(),
      },
    });
    expect(detail).toMatchObject({
      id: AGENT_A_ID,
      desiredStatus: "running",
      latestDeployment: {
        id: LATEST_DEPLOYMENT_ID,
        stage: "pending",
      },
    });
    expect(detail?.latestDeployment).toEqual(list[0]?.latestDeployment);
  });

  it("conceals foreign and deleted agents and projects no deployment internals", async () => {
    const listJson = JSON.stringify(
      await listActiveAgentsForUser(USER_A_ID, { createConnection: () => connection }),
    );
    const detailJson = JSON.stringify(
      await getActiveAgentForUser(USER_A_ID, AGENT_A_ID, {
        createConnection: () => connection,
      }),
    );

    await expect(
      getActiveAgentForUser(USER_A_ID, AGENT_B_ID, {
        createConnection: () => connection,
      }),
    ).resolves.toBeNull();
    await expect(
      getActiveAgentForUser(USER_A_ID, DELETED_AGENT_ID, {
        createConnection: () => connection,
      }),
    ).resolves.toBeNull();

    for (const serialized of [listJson, detailJson]) {
      expect(serialized).toContain(LATEST_DEPLOYMENT_ID);
      expect(serialized).not.toContain(AGENT_B_ID);
      expect(serialized).not.toContain(DELETED_AGENT_ID);
      expect(serialized).not.toContain(OLDER_DEPLOYMENT_ID);
      for (const canary of PRIVATE_CANARIES) {
        expect(serialized).not.toContain(canary);
      }
      for (const internalField of [
        "idempotencyKey",
        "leaseOwner",
        "leaseExpiresAt",
        "runnerOperationId",
        "runnerAcceptedAt",
        "canaryState",
        "canaryAttemptedAt",
        "canaryCompletedAt",
        "errorDetail",
        "detail",
      ]) {
        expect(serialized).not.toContain(internalField);
      }
    }
  });

  it("projects only the safe active-recovery state from private replacement evidence", async () => {
    await connection.db
      .update(agentDeployments)
      .set({
        errorCode: "runner_recovery_in_progress",
        errorDetail:
          "runner=private-runner droplet=private-resource endpoint=https://private.example replacement=private-workflow",
      })
      .where(eq(agentDeployments.id, LATEST_DEPLOYMENT_ID));

    const [agent] = await listActiveAgentsForUser(USER_A_ID, {
      createConnection: () => connection,
    });
    expect(agent?.latestDeployment?.recovery).toEqual({ state: "preparing_capacity" });
    expect(JSON.stringify(agent?.latestDeployment)).not.toMatch(
      /private-runner|private-resource|private\.example|private-workflow/,
    );
  });
});

describe("Step 8 latest-deployment query shape", () => {
  it("bounds the deployment projection to one latest row per requested agent in SQL", async () => {
    const source = await readFile("src/server/agents/list-agents.ts", "utf8");
    const latestMapSource = source.slice(source.indexOf("async function loadLatestDeploymentMap"));

    expect(latestMapSource).toMatch(/selectDistinctOn|distinct\s+on|row_number\s*\(|lateral/i);
    expect(latestMapSource).not.toMatch(
      /const rows = await input\.db[\s\S]*for \(const row of rows\)/,
    );
  });
});

async function seedProjectionRows(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values([{ id: USER_A_ID }, { id: USER_B_ID }]);
  await connection.db.insert(agents).values([
    agentRow(AGENT_A_ID, USER_A_ID, "A managed agent"),
    agentRow(AGENT_B_ID, USER_B_ID, "B private agent"),
    {
      ...agentRow(DELETED_AGENT_ID, USER_A_ID, "Deleted managed agent"),
      deletedAt: new Date("2026-08-03T10:05:00.000Z"),
    },
  ]);
  await connection.db
    .insert(agentConfigs)
    .values([configRow(AGENT_A_ID), configRow(AGENT_B_ID), configRow(DELETED_AGENT_ID)]);
  await connection.db.insert(agentDeployments).values([
    {
      id: OLDER_DEPLOYMENT_ID,
      agentId: AGENT_A_ID,
      userId: USER_A_ID,
      stage: "failed",
      configRevision: "cfg-original",
      idempotencyKey: "original-create-key",
      errorCode: "telegram_not_connected",
      errorDetail: "OLDER-PRIVATE-ERROR-DETAIL",
      failedAt: CREATED_AT_TIE,
      createdAt: CREATED_AT_TIE,
      updatedAt: CREATED_AT_TIE,
    },
    {
      id: LATEST_DEPLOYMENT_ID,
      agentId: AGENT_A_ID,
      userId: USER_A_ID,
      stage: "pending",
      configRevision: "cfg-latest-retry",
      idempotencyKey: PRIVATE_CANARIES[0],
      attemptCount: 1,
      errorCode: "provider_unavailable",
      errorDetail: PRIVATE_CANARIES[2],
      nextAttemptAt: new Date("2026-08-03T10:00:05.000Z"),
      leaseOwner: PRIVATE_CANARIES[1],
      leaseExpiresAt: new Date("2026-08-03T10:01:00.000Z"),
      createdAt: CREATED_AT_TIE,
      updatedAt: CREATED_AT_TIE,
    },
    {
      agentId: AGENT_B_ID,
      userId: USER_B_ID,
      stage: "failed",
      configRevision: "cfg-foreign",
      idempotencyKey: "foreign-private-key",
      errorCode: "runner_start_failed",
      errorDetail: "FOREIGN-PRIVATE-DETAIL",
      failedAt: CREATED_AT_TIE,
      createdAt: CREATED_AT_TIE,
      updatedAt: CREATED_AT_TIE,
    },
    {
      agentId: DELETED_AGENT_ID,
      userId: USER_A_ID,
      stage: "failed",
      configRevision: "cfg-deleted",
      idempotencyKey: "deleted-private-key",
      errorCode: "deployment_cancelled",
      errorDetail: "DELETED-PRIVATE-DETAIL",
      failedAt: CREATED_AT_TIE,
      createdAt: CREATED_AT_TIE,
      updatedAt: CREATED_AT_TIE,
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
    status: "stopped" as const,
    desiredStatus: "running" as const,
    createdAt: new Date("2026-08-03T09:00:00.000Z"),
    updatedAt: new Date("2026-08-03T09:00:00.000Z"),
  };
}

function configRow(agentId: string) {
  return {
    agentId,
    systemPrompt: "Keep the projection test deterministic.",
    modelProvider: "openrouter",
    modelName: "openai/gpt-4.1-mini",
    scheduleMode: "manual" as const,
    timezone: "UTC",
  };
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table agent_deployments, agent_configs, agents, users restart identity cascade",
  );
}
