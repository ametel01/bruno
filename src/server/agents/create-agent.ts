import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { agentConfigs, agents } from "@/src/server/db/schema";
import {
  getAgentTemplateSnapshot,
  isSupportedTemplateKey,
  type AgentTemplateSnapshot,
  type SupportedAgentTemplateKey,
} from "@/src/server/agents/templates";
import { recordAgentEventInTransaction } from "@/src/server/events/agent-events";
import { getOrCreateDevelopmentUserId } from "@/src/server/users/development-user";

export const AGENT_NAME_MAX_LENGTH = 120;
export const DEFAULT_AGENT_CONFIG_BASE = {
  modelProvider: "not_configured",
  modelName: "not_configured",
  maxDailySpendCents: 0,
  scheduleMode: "manual",
  scheduleCron: null,
  timezone: "UTC",
} as const;

export const DEFAULT_AGENT_CONFIG = {
  systemPrompt: getAgentTemplateSnapshot("research_agent").defaultSystemPrompt,
  ...DEFAULT_AGENT_CONFIG_BASE,
} as const;

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
    templateVersion: string;
    templateSnapshotJson: AgentTemplateSnapshot;
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
  templateSnapshotJson: AgentTemplateSnapshot;
  status: "stopped";
};

type InsertCreatedEvent = (
  tx: AgentTransaction,
  input: {
    agent: CreatedAgentRow;
    actorUserId: string;
  },
) => Promise<void>;

type InsertDefaultAgentConfig = (
  tx: AgentTransaction,
  input: {
    agent: CreatedAgentRow;
  },
) => Promise<void>;

export type CreateAgentDependencies = {
  createConnection?: () => DatabaseConnection;
  insertDefaultAgentConfig?: InsertDefaultAgentConfig;
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
  const insertDefaultAgentConfig =
    dependencies.insertDefaultAgentConfig ?? insertDefaultConfigForCreatedAgent;
  const insertCreatedEvent = dependencies.insertCreatedEvent ?? insertDefaultCreatedEvent;

  try {
    const result = await connection.db.transaction(async (tx) => {
      const userId = await getOrCreateDevelopmentUserId(tx);
      const templateSnapshot = getAgentTemplateSnapshot(input.templateKey);
      const [agent] = await tx
        .insert(agents)
        .values({
          userId,
          name: input.name,
          templateKey: input.templateKey,
          templateVersion: templateSnapshot.version,
          templateSnapshotJson: templateSnapshot,
          status: "stopped",
        })
        .returning();

      if (!agent) {
        throw new Error("Agent insert returned no rows.");
      }

      const createdAgent = agent as CreatedAgentRow;
      await insertDefaultAgentConfig(tx, { agent: createdAgent });
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

async function insertDefaultConfigForCreatedAgent(
  tx: AgentTransaction,
  input: {
    agent: CreatedAgentRow;
  },
): Promise<void> {
  await tx.insert(agentConfigs).values({
    agentId: input.agent.id,
    systemPrompt: input.agent.templateSnapshotJson.defaultSystemPrompt,
    ...DEFAULT_AGENT_CONFIG_BASE,
  });
}

async function insertDefaultCreatedEvent(
  tx: AgentTransaction,
  input: {
    agent: CreatedAgentRow;
    actorUserId: string;
  },
): Promise<void> {
  await recordAgentEventInTransaction(tx, {
    agentId: input.agent.id,
    actorUserId: input.actorUserId,
    type: "agent.created",
    message: `Created agent "${input.agent.name}".`,
    metadata: {
      templateKey: input.agent.templateKey,
      templateVersion: input.agent.templateVersion,
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
      templateVersion: agent.templateVersion,
      templateSnapshotJson: agent.templateSnapshotJson,
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
