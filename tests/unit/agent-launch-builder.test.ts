import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHermesAgentLaunchSpecForUser } from "@/src/server/agents/agent-launch-builder";
import { createAgentDeploymentForUser } from "@/src/server/agents/agent-deployments";
import { createAgentForDevelopmentUser } from "@/src/server/agents/create-agent";
import {
  generateApiServerKeyForUser,
  replaceAgentSecretForUser,
  revokeAgentSecretForUser,
} from "@/src/server/agents/agent-secrets";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentDeployments, agentSecrets } from "@/src/server/db/schema";

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

  it("builds managed v3 from the newest deployment revision and exactly four active secrets", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Managed Launch Builder", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const firstRevision = "cfg-first-revision";
    const newestRevision = "cfg-newest-revision";

    await configureManagedHermes(connection, created.agent.userId, created.agent.id, {
      createDeployment: false,
    });
    const firstDeployment = await createAgentDeploymentForUser({
      db: connection.db,
      userId: created.agent.userId,
      agentId: created.agent.id,
      configRevision: firstRevision,
      idempotencyKey: "managed-launch-first",
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
    if (!firstDeployment.ok) {
      throw new Error("Failed to create first deployment fixture.");
    }
    await connection.db
      .update(agentDeployments)
      .set({
        stage: "ready",
        completedAt: new Date("2026-08-03T00:01:00.000Z"),
        updatedAt: new Date("2026-08-03T00:01:00.000Z"),
      })
      .where(eq(agentDeployments.id, firstDeployment.deployment.id));
    await connection.db
      .update(agentConfigs)
      .set({ updatedAt: new Date("2026-08-03T00:01:00.000Z") })
      .where(eq(agentConfigs.agentId, created.agent.id));
    await createAgentDeploymentForUser({
      db: connection.db,
      userId: created.agent.userId,
      agentId: created.agent.id,
      configRevision: newestRevision,
      idempotencyKey: "managed-launch-newest",
      now: new Date("2026-08-03T00:02:00.000Z"),
    });

    const result = await buildHermesAgentLaunchSpecForUser(created.agent.userId, created.agent.id, {
      createConnection: () => connection,
      env: KEYRING_ENV,
      requestId: () => "managed-launch-0001",
    });

    expect(result).toMatchObject({
      ok: true,
      spec: {
        version: "agentbay.hermes.launch.v3",
        requestId: "managed-launch-0001",
        agent: {
          configRevision: newestRevision,
        },
        model: {
          provider: "openrouter",
          model: "openai/gpt-4.1-mini",
        },
        secrets: {
          openrouterApiKey: "sk-or-v1-managedopenrouterkey1234567890",
          telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
          telegramAllowedUsers: ["1", "222222"],
          apiServerKey: expect.stringMatching(/^agb_agent_/),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(firstRevision);
  });

  it("keeps deployment-backed non-OpenRouter agents on the native v2 path", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Native Deployment Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );

    await configureHermes(connection, created.agent.userId, created.agent.id);
    await connection.db
      .update(agentConfigs)
      .set({ modelProvider: "not_configured", modelName: "not_configured" })
      .where(eq(agentConfigs.agentId, created.agent.id));
    await createAgentDeploymentForUser({
      db: connection.db,
      userId: created.agent.userId,
      agentId: created.agent.id,
      configRevision: "cfg-stale-deployment",
      idempotencyKey: "native-stale-deployment",
      now: new Date("2026-08-03T00:00:00.000Z"),
    });

    const result = await buildHermesAgentLaunchSpecForUser(created.agent.userId, created.agent.id, {
      createConnection: () => connection,
      env: KEYRING_ENV,
      requestId: () => "native-launch-0001",
    });

    expect(result).toMatchObject({
      ok: true,
      spec: {
        version: "agentbay.hermes.launch.v2",
        model: { provider: "hermes", model: "configured-by-hermes" },
      },
    });
  });

  it("returns safe managed missing and revoked secret results without decrypting fallbacks", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Managed Missing Secret", templateKey: "research_agent" },
      { createConnection: () => connection },
    );

    await configureManagedHermes(connection, created.agent.userId, created.agent.id);
    await revokeAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      { kind: "telegram_bot_token" },
      { createConnection: () => connection },
    );

    const result = await buildHermesAgentLaunchSpecForUser(created.agent.userId, created.agent.id, {
      createConnection: () => connection,
      env: KEYRING_ENV,
    });

    expect(result).toEqual({
      ok: false,
      reason: "required_secret_revoked",
      message: "Managed Hermes secrets could not be loaded.",
      kind: "telegram_bot_token",
    });
    expect(JSON.stringify(result)).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ12");
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

async function configureManagedHermes(
  connection: DatabaseConnection,
  userId: string,
  agentId: string,
  options: { createDeployment?: boolean } = {},
): Promise<void> {
  await connection.db
    .update(agentConfigs)
    .set({
      modelProvider: "openrouter",
      modelName: "openai/gpt-4.1-mini",
      updatedAt: new Date("2026-08-03T03:00:00.000Z"),
    })
    .where(eq(agentConfigs.agentId, agentId));
  await replaceAgentSecretForUser(
    userId,
    agentId,
    {
      kind: "openrouter_api_key",
      value: "sk-or-v1-managedopenrouterkey1234567890",
    },
    { createConnection: () => connection, env: KEYRING_ENV },
  );
  await replaceAgentSecretForUser(
    userId,
    agentId,
    {
      kind: "telegram_bot_token",
      value: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
    },
    {
      createConnection: () => connection,
      env: KEYRING_ENV,
      telegramBotValidator: async () => ({
        ok: true,
        bot: { botId: "123456789", username: "managed_bot" },
      }),
    },
  );
  await replaceAgentSecretForUser(
    userId,
    agentId,
    {
      kind: "telegram_allowed_users",
      value: ["1", "222222"],
    },
    { createConnection: () => connection, env: KEYRING_ENV },
  );
  await generateApiServerKeyForUser(userId, agentId, {
    createConnection: () => connection,
    env: KEYRING_ENV,
    randomBytes: (size) => Buffer.alloc(size, 5),
  });
  if (options.createDeployment ?? true) {
    await createAgentDeploymentForUser({
      db: connection.db,
      userId,
      agentId,
      configRevision: "cfg-managed-revision",
      idempotencyKey: "managed-launch-builder",
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
  }
}

async function resetLaunchBuilderTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_secrets, agent_configs, agent_events, agents, app_metadata, users restart identity cascade`;
}
