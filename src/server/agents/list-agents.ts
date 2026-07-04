import { and, desc, eq, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  type AgentLifecycleStatus,
  reconcileDockerRunnerAgentForDevelopmentUser,
  reconcileDockerRunnerAgentsForDevelopmentUser,
} from "@/src/server/agents/lifecycle";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agents } from "@/src/server/db/schema";

const AGENT_TEMPLATE_LABELS = {
  github_issue_agent: "GitHub Issue Agent",
  inbox_triage_agent: "Inbox Triage Agent",
  research_agent: "Research Agent",
  social_content_agent: "Social Content Agent",
} as const;

export type ListedAgent = {
  id: string;
  name: string;
  templateKey: string;
  templateLabel: string;
  status: AgentLifecycleStatus;
  href: string;
  createdAt: string;
};

export type AgentDetail = ListedAgent & {
  statusReason: string | null;
  updatedAt: string;
  config: AgentDetailConfig;
};

export type AgentDetailConfig = {
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  maxDailySpendCents: number;
  scheduleMode: "manual" | "cron";
  scheduleCron: string | null;
  timezone: string;
  updatedAt: string;
};

export type ListAgentsDependencies = {
  createConnection?: () => DatabaseConnection;
};

export class AgentListPersistenceError extends Error {
  constructor() {
    super("Agent list failed.");
    this.name = "AgentListPersistenceError";
  }
}

export class AgentDetailPersistenceError extends Error {
  constructor() {
    super("Agent detail failed.");
    this.name = "AgentDetailPersistenceError";
  }
}

export async function listActiveAgentsForDevelopmentUser(
  dependencies: ListAgentsDependencies = {},
): Promise<ListedAgent[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    await reconcileDockerRunnerAgentsForDevelopmentUser({ createConnection: () => connection });

    const rows = await connection.db
      .select({
        id: agents.id,
        name: agents.name,
        templateKey: agents.templateKey,
        status: agents.status,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(isNull(agents.deletedAt))
      .orderBy(desc(agents.createdAt), desc(agents.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      templateKey: row.templateKey,
      templateLabel: getAgentTemplateLabel(row.templateKey),
      status: row.status,
      href: `/agents/${row.id}`,
      createdAt: row.createdAt.toISOString(),
    }));
  } catch {
    throw new AgentListPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function getActiveAgentForDevelopmentUser(
  agentId: string,
  dependencies: ListAgentsDependencies = {},
): Promise<AgentDetail | null> {
  if (!isValidAgentId(agentId)) {
    return null;
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    await reconcileDockerRunnerAgentForDevelopmentUser(agentId, {
      createConnection: () => connection,
    });

    const [row] = await connection.db
      .select({
        id: agents.id,
        name: agents.name,
        templateKey: agents.templateKey,
        status: agents.status,
        statusReason: agents.statusReason,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
        configSystemPrompt: agentConfigs.systemPrompt,
        configModelProvider: agentConfigs.modelProvider,
        configModelName: agentConfigs.modelName,
        configMaxDailySpendCents: agentConfigs.maxDailySpendCents,
        configScheduleMode: agentConfigs.scheduleMode,
        configScheduleCron: agentConfigs.scheduleCron,
        configTimezone: agentConfigs.timezone,
        configUpdatedAt: agentConfigs.updatedAt,
      })
      .from(agents)
      .innerJoin(agentConfigs, eq(agentConfigs.agentId, agents.id))
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      templateKey: row.templateKey,
      templateLabel: getAgentTemplateLabel(row.templateKey),
      status: row.status,
      statusReason: row.statusReason,
      href: `/agents/${row.id}`,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      config: {
        systemPrompt: row.configSystemPrompt,
        modelProvider: row.configModelProvider,
        modelName: row.configModelName,
        maxDailySpendCents: row.configMaxDailySpendCents,
        scheduleMode: row.configScheduleMode,
        scheduleCron: row.configScheduleCron,
        timezone: row.configTimezone,
        updatedAt: row.configUpdatedAt.toISOString(),
      },
    };
  } catch {
    throw new AgentDetailPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function getAgentTemplateLabel(templateKey: string): string {
  return AGENT_TEMPLATE_LABELS[templateKey as keyof typeof AGENT_TEMPLATE_LABELS] ?? templateKey;
}
