import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  ASSISTANT_CHOICES,
  type AssistantChoice,
  getAssistantProfile,
} from "@/src/server/agents/assistant-profiles";
import {
  readRequiredDecryptedActiveAgentSecretsInTransaction,
  type AgentSecretsReadTransaction,
} from "@/src/server/agents/agent-secrets";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentDeployments, agentSecrets, agents } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";

export type ModelConnectionView = {
  assistant: AssistantChoice;
  displayName: "ChatGPT" | "Claude";
  credentialLabel: "OpenAI API key" | "Anthropic API key";
  credentialHelpUrl: string;
  credentialBillingNote: string;
  status: "connected" | "action_required";
};

type ModelConnectionDependencies = {
  createConnection?: () => DatabaseConnection;
};

type ModelConnectionDatabase = PostgresJsDatabase<typeof schema> | AgentSecretsReadTransaction;

export class ModelConnectionPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Model connections could not be loaded.");
    this.name = "ModelConnectionPersistenceError";
    this.cause = cause;
  }
}

export async function listModelConnectionsForUser(
  userId: string,
  dependencies: ModelConnectionDependencies = {},
): Promise<ModelConnectionView[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const connected = await connection.db.transaction(async (tx) => {
      const entries = await Promise.all(
        ASSISTANT_CHOICES.map(
          async (assistant) =>
            [
              assistant,
              Boolean(await selectReusableCredentialAgentId(tx, userId, assistant)),
            ] as const,
        ),
      );

      return new Map(entries);
    });

    return ASSISTANT_CHOICES.map((assistant) => {
      const profile = getAssistantProfile(assistant);

      return {
        assistant,
        displayName: profile.displayName,
        credentialLabel: profile.credentialLabel,
        credentialHelpUrl: profile.credentialHelpUrl,
        credentialBillingNote: profile.credentialBillingNote,
        status: connected.get(assistant) ? "connected" : "action_required",
      };
    });
  } catch (error) {
    throw new ModelConnectionPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function resolveReusableAssistantApiKeyInTransaction(
  tx: AgentSecretsReadTransaction,
  input: {
    userId: string;
    assistant: AssistantChoice;
    env?: Record<string, string | undefined>;
  },
): Promise<string | null> {
  const profile = getAssistantProfile(input.assistant);
  const agentId = await selectReusableCredentialAgentId(tx, input.userId, input.assistant);

  if (!agentId) {
    return null;
  }

  const result = await readRequiredDecryptedActiveAgentSecretsInTransaction(tx, {
    userId: input.userId,
    agentId,
    kinds: [profile.secretKind],
    ...(input.env ? { env: input.env } : {}),
  });

  return result.ok ? result.secrets[profile.secretKind] : null;
}

async function selectReusableCredentialAgentId(
  db: ModelConnectionDatabase,
  userId: string,
  assistant: AssistantChoice,
): Promise<string | null> {
  const profile = getAssistantProfile(assistant);
  const [row] = await db
    .select({ agentId: agents.id })
    .from(agents)
    .innerJoin(agentConfigs, eq(agentConfigs.agentId, agents.id))
    .innerJoin(agentSecrets, eq(agentSecrets.agentId, agents.id))
    .innerJoin(agentDeployments, eq(agentDeployments.agentId, agents.id))
    .where(
      and(
        eq(agents.userId, userId),
        isNull(agents.deletedAt),
        eq(agentConfigs.modelProvider, profile.hermesProvider),
        eq(agentConfigs.modelName, profile.model),
        eq(agentSecrets.kind, profile.secretKind),
        eq(agentSecrets.status, "active"),
        eq(agentDeployments.userId, userId),
        eq(agentDeployments.stage, "ready"),
      ),
    )
    .orderBy(desc(agentSecrets.updatedAt), desc(agentSecrets.id))
    .limit(1);

  return row?.agentId ?? null;
}
