import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHermesAgentLaunchSpecForUser } from "@/src/server/agents/agent-launch-builder";
import { createAgentForDevelopmentUser } from "@/src/server/agents/create-agent";
import {
  generateApiServerKeyForUser,
  replaceAgentSecretForUser,
} from "@/src/server/agents/agent-secrets";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentSecrets } from "@/src/server/db/schema";

const KEYRING_ENV = {
  AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION: "v1",
  AGENTBAY_AGENT_SECRET_KEYS_JSON: JSON.stringify({
    v1: Buffer.alloc(32, 31).toString("base64url"),
  }),
};

describe("Hermes launch spec builder", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetLaunchBuilderTables(connection);
  });

  afterEach(async () => {
    await resetLaunchBuilderTables(connection);
    await connection.close();
  });

  it("builds a deterministic owner-scoped spec while decrypting only its internal key", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Launch Builder Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );

    await configureHermes(connection, created.agent.userId, created.agent.id);
    await replaceAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      {
        kind: "openrouter_api_key",
        value: "sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890",
      },
      { createConnection: () => connection, env: KEYRING_ENV },
    );
    await connection.db
      .update(agentSecrets)
      .set({ ciphertext: "intentionally-invalid-legacy-ciphertext" })
      .where(
        and(
          eq(agentSecrets.agentId, created.agent.id),
          eq(agentSecrets.kind, "openrouter_api_key"),
        ),
      );

    const result = await buildHermesAgentLaunchSpecForUser(created.agent.userId, created.agent.id, {
      createConnection: () => connection,
      env: KEYRING_ENV,
      hermesWorkloadImage: "ghcr.io/ametel01/agentbay-hermes:sha-test",
      requestId: () => "launch-request-0001",
    });

    expect(result).toMatchObject({
      ok: true,
      spec: {
        requestId: "launch-request-0001",
        agent: {
          id: created.agent.id,
          name: "Launch Builder Agent",
          templateKey: "research_agent",
        },
        image: {
          ref: "ghcr.io/ametel01/agentbay-hermes:sha-test",
        },
        model: {
          provider: "hermes",
          model: "configured-by-hermes",
        },
        secrets: {
          apiServerKey: expect.stringMatching(/^agb_agent_/),
        },
      },
    });
  });

  it("returns safe setup failures without echoing secret values", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Incomplete Launch Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );

    await connection.db
      .update(agentConfigs)
      .set({ modelProvider: "openrouter", modelName: "openai/gpt-4.1-mini" })
      .where(eq(agentConfigs.agentId, created.agent.id));
    const result = await buildHermesAgentLaunchSpecForUser(created.agent.userId, created.agent.id, {
      createConnection: () => connection,
      env: KEYRING_ENV,
    });

    expect(result).toEqual({
      ok: false,
      reason: "hermes_setup_incomplete",
      message: "Run Hermes setup before starting this agent.",
    });
    expect(JSON.stringify(result)).not.toContain("sk-or-v1");
  });
});

async function configureHermes(
  connection: DatabaseConnection,
  userId: string,
  agentId: string,
): Promise<void> {
  await connection.db
    .update(agentConfigs)
    .set({
      modelProvider: "openrouter",
      modelName: "openai/gpt-4.1-mini",
      updatedAt: new Date("2026-07-14T03:00:00.000Z"),
    })
    .where(eq(agentConfigs.agentId, agentId));
  await generateApiServerKeyForUser(userId, agentId, {
    createConnection: () => connection,
    env: KEYRING_ENV,
    randomBytes: (size) => Buffer.alloc(size, 4),
  });
}

async function resetLaunchBuilderTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_secrets, agent_configs, agent_events, agents, app_metadata, users restart identity cascade`;
}
