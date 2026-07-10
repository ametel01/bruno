import { and, desc, eq, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  type AgentLifecycleStatus,
  reconcileDockerRunnerAgentForDevelopmentUser,
  reconcileDockerRunnerAgentForUser,
  reconcileDockerRunnerAgentsForDevelopmentUser,
  reconcileDockerRunnerAgentsForUser,
} from "@/src/server/agents/lifecycle";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agents, runners } from "@/src/server/db/schema";
import {
  getAgentTemplateLabel,
  getAgentTemplateSnapshot,
  isSupportedTemplateKey,
  type AgentTemplateSnapshot,
} from "@/src/server/agents/templates";

export type ListedAgent = {
  id: string;
  name: string;
  templateKey: string;
  templateVersion: string;
  templateLabel: string;
  status: AgentLifecycleStatus;
  assignedRunnerKind?: string | null;
  assignedRunnerStatus?: string | null;
  assignedRunnerProvisioningStatus?: string | null;
  href: string;
  createdAt: string;
};

export type AgentDetail = ListedAgent & {
  statusReason: string | null;
  updatedAt: string;
  templateSnapshot: AgentTemplateSnapshot;
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
        templateVersion: agents.templateVersion,
        status: agents.status,
        assignedRunnerKind: runners.kind,
        assignedRunnerStatus: runners.status,
        assignedRunnerProvisioningStatus: runners.provisioningStatus,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .leftJoin(runners, eq(runners.id, agents.runnerId))
      .where(isNull(agents.deletedAt))
      .orderBy(desc(agents.createdAt), desc(agents.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      templateKey: row.templateKey,
      templateVersion: row.templateVersion,
      templateLabel: getAgentTemplateLabel(row.templateKey),
      status: row.status,
      assignedRunnerKind: row.assignedRunnerKind,
      assignedRunnerStatus: row.assignedRunnerStatus,
      assignedRunnerProvisioningStatus: row.assignedRunnerProvisioningStatus,
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

export async function listActiveAgentsForUser(
  userId: string,
  dependencies: ListAgentsDependencies = {},
): Promise<ListedAgent[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    await reconcileDockerRunnerAgentsForUser(userId, { createConnection: () => connection });

    const rows = await connection.db
      .select({
        id: agents.id,
        name: agents.name,
        templateKey: agents.templateKey,
        templateVersion: agents.templateVersion,
        status: agents.status,
        assignedRunnerKind: runners.kind,
        assignedRunnerStatus: runners.status,
        assignedRunnerProvisioningStatus: runners.provisioningStatus,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .leftJoin(runners, and(eq(runners.id, agents.runnerId), eq(runners.userId, userId)))
      .where(and(eq(agents.userId, userId), isNull(agents.deletedAt)))
      .orderBy(desc(agents.createdAt), desc(agents.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      templateKey: row.templateKey,
      templateVersion: row.templateVersion,
      templateLabel: getAgentTemplateLabel(row.templateKey),
      status: row.status,
      assignedRunnerKind: row.assignedRunnerKind,
      assignedRunnerStatus: row.assignedRunnerStatus,
      assignedRunnerProvisioningStatus: row.assignedRunnerProvisioningStatus,
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
        templateVersion: agents.templateVersion,
        templateSnapshotJson: agents.templateSnapshotJson,
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

    const templateSnapshot = normalizeTemplateSnapshot(row.templateKey, row.templateSnapshotJson);

    return {
      id: row.id,
      name: row.name,
      templateKey: row.templateKey,
      templateVersion: row.templateVersion,
      templateLabel: getAgentTemplateLabel(row.templateKey),
      status: row.status,
      statusReason: row.statusReason,
      href: `/agents/${row.id}`,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      templateSnapshot,
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

export async function getActiveAgentForUser(
  userId: string,
  agentId: string,
  dependencies: ListAgentsDependencies = {},
): Promise<AgentDetail | null> {
  if (!isValidAgentId(agentId)) {
    return null;
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    await reconcileDockerRunnerAgentForUser(userId, agentId, {
      createConnection: () => connection,
    });

    const [row] = await connection.db
      .select({
        id: agents.id,
        name: agents.name,
        templateKey: agents.templateKey,
        templateVersion: agents.templateVersion,
        templateSnapshotJson: agents.templateSnapshotJson,
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
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId), isNull(agents.deletedAt)))
      .limit(1);

    if (!row) {
      return null;
    }

    const templateSnapshot = normalizeTemplateSnapshot(row.templateKey, row.templateSnapshotJson);

    return {
      id: row.id,
      name: row.name,
      templateKey: row.templateKey,
      templateVersion: row.templateVersion,
      templateLabel: getAgentTemplateLabel(row.templateKey),
      status: row.status,
      statusReason: row.statusReason,
      href: `/agents/${row.id}`,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      templateSnapshot,
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

function normalizeTemplateSnapshot(
  templateKey: string,
  templateSnapshot: AgentTemplateSnapshot,
): AgentTemplateSnapshot {
  if (typeof templateSnapshot.defaultSystemPrompt === "string") {
    const defaultSystemPrompt = templateSnapshot.defaultSystemPrompt.trim();

    if (defaultSystemPrompt.length > 0) {
      return templateSnapshot;
    }
  }

  if (!isSupportedTemplateKey(templateKey)) {
    return templateSnapshot;
  }

  return {
    ...templateSnapshot,
    defaultSystemPrompt: getAgentTemplateSnapshot(templateKey).defaultSystemPrompt,
  };
}
