import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { agentEvents, agents, appMetadata, users } from "@/src/server/db/schema";

const DEVELOPMENT_USER_METADATA_KEY = "local_development_user_id";
export const AGENT_NAME_MAX_LENGTH = 120;
export const SUPPORTED_AGENT_TEMPLATE_KEYS = [
  "research_agent",
  "inbox_triage_agent",
  "github_issue_agent",
  "social_content_agent",
] as const;

export type SupportedAgentTemplateKey = (typeof SUPPORTED_AGENT_TEMPLATE_KEYS)[number];

export type CreateAgentValidationIssue = {
  field: "body" | "name" | "templateKey";
  message: string;
};

export type CreateAgentValidationResult =
  | {
      ok: true;
      value: {
        name: string;
        templateKey: SupportedAgentTemplateKey;
      };
    }
  | {
      ok: false;
      issues: CreateAgentValidationIssue[];
    };

export type CreatedAgentResponse = {
  agent: {
    id: string;
    userId: string;
    name: string;
    templateKey: SupportedAgentTemplateKey;
    status: "stopped";
    statusReason: null;
    createdAt: string;
    updatedAt: string;
    deletedAt: null;
  };
  event: {
    type: "agent.created";
  };
};

type AgentTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type CreatedAgentRow = typeof agents.$inferSelect & {
  templateKey: SupportedAgentTemplateKey;
  status: "stopped";
};

type InsertCreatedEvent = (
  tx: AgentTransaction,
  input: {
    agent: CreatedAgentRow;
    actorUserId: string;
  },
) => Promise<void>;

export type CreateAgentDependencies = {
  createConnection?: () => DatabaseConnection;
  insertCreatedEvent?: InsertCreatedEvent;
};

export class AgentPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Agent creation failed.");
    this.name = "AgentPersistenceError";
    this.cause = cause;
  }
}

export function validateCreateAgentPayload(payload: unknown): CreateAgentValidationResult {
  if (!isPlainObject(payload)) {
    return {
      ok: false,
      issues: [{ field: "body", message: "Request body must be a JSON object." }],
    };
  }

  const issues: CreateAgentValidationIssue[] = [];
  const rawName = payload.name;
  const rawTemplateKey = payload.templateKey;

  if (typeof rawName !== "string") {
    issues.push({ field: "name", message: "Name is required." });
  }

  const name = typeof rawName === "string" ? rawName.trim() : "";

  if (typeof rawName === "string" && name.length === 0) {
    issues.push({ field: "name", message: "Name is required." });
  }

  if (name.length > AGENT_NAME_MAX_LENGTH) {
    issues.push({
      field: "name",
      message: `Name must be ${AGENT_NAME_MAX_LENGTH} characters or fewer.`,
    });
  }

  if (!isSupportedTemplateKey(rawTemplateKey)) {
    issues.push({ field: "templateKey", message: "Template key is not supported." });
  }
  const templateKey = isSupportedTemplateKey(rawTemplateKey) ? rawTemplateKey : undefined;

  if (issues.length > 0 || !templateKey) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      name,
      templateKey,
    },
  };
}

export async function createAgentForDevelopmentUser(
  input: {
    name: string;
    templateKey: SupportedAgentTemplateKey;
  },
  dependencies: CreateAgentDependencies = {},
): Promise<CreatedAgentResponse> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const insertCreatedEvent = dependencies.insertCreatedEvent ?? insertDefaultCreatedEvent;

  try {
    const result = await connection.db.transaction(async (tx) => {
      const userId = await getOrCreateDevelopmentUserId(tx);
      const [agent] = await tx
        .insert(agents)
        .values({
          userId,
          name: input.name,
          templateKey: input.templateKey,
          status: "stopped",
        })
        .returning();

      if (!agent) {
        throw new Error("Agent insert returned no rows.");
      }

      const createdAgent = agent as CreatedAgentRow;
      await insertCreatedEvent(tx, { agent: createdAgent, actorUserId: userId });

      return toCreatedAgentResponse(createdAgent);
    });

    return result;
  } catch (error) {
    throw new AgentPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedTemplateKey(value: unknown): value is SupportedAgentTemplateKey {
  return (
    typeof value === "string" &&
    SUPPORTED_AGENT_TEMPLATE_KEYS.includes(value as SupportedAgentTemplateKey)
  );
}

async function getOrCreateDevelopmentUserId(tx: AgentTransaction): Promise<string> {
  const [developmentUserPointer] = await tx
    .select({ value: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, DEVELOPMENT_USER_METADATA_KEY))
    .limit(1);

  if (developmentUserPointer) {
    const [metadataUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, developmentUserPointer.value))
      .limit(1);

    if (metadataUser) {
      return metadataUser.id;
    }
  }

  const [existingUser] = await tx
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (existingUser) {
    await rememberDevelopmentUserId(tx, existingUser.id);
    return existingUser.id;
  }

  const [createdUser] = await tx.insert(users).values({}).returning({ id: users.id });

  if (!createdUser) {
    throw new Error("Development user insert returned no rows.");
  }

  await rememberDevelopmentUserId(tx, createdUser.id);
  return createdUser.id;
}

async function rememberDevelopmentUserId(tx: AgentTransaction, userId: string): Promise<void> {
  await tx
    .insert(appMetadata)
    .values({
      key: DEVELOPMENT_USER_METADATA_KEY,
      value: userId,
    })
    .onConflictDoUpdate({
      target: appMetadata.key,
      set: {
        value: userId,
        updatedAt: new Date(),
      },
    });
}

async function insertDefaultCreatedEvent(
  tx: AgentTransaction,
  input: {
    agent: CreatedAgentRow;
    actorUserId: string;
  },
): Promise<void> {
  await tx.insert(agentEvents).values({
    agentId: input.agent.id,
    actorUserId: input.actorUserId,
    type: "agent.created",
    message: `Created agent "${input.agent.name}".`,
    metadata: {
      templateKey: input.agent.templateKey,
      status: input.agent.status,
    },
  });
}

function toCreatedAgentResponse(agent: CreatedAgentRow): CreatedAgentResponse {
  return {
    agent: {
      id: agent.id,
      userId: agent.userId,
      name: agent.name,
      templateKey: agent.templateKey,
      status: "stopped",
      statusReason: null,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
      deletedAt: null,
    },
    event: {
      type: "agent.created",
    },
  };
}
