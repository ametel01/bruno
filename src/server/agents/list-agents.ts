import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  mapAgentDeploymentRowToDto,
  type AgentDeploymentRowForDto,
} from "@/src/server/agents/deployment-dto";
import {
  reconcileDockerRunnerAgentForDevelopmentUser,
  reconcileDockerRunnerAgentForUser,
  reconcileDockerRunnerAgentsForDevelopmentUser,
  reconcileDockerRunnerAgentsForUser,
} from "@/src/server/agents/lifecycle";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentDeployments, agents, runners } from "@/src/server/db/schema";
import {
  getAgentTemplateLabel,
  getAgentTemplateSnapshot,
  isSupportedTemplateKey,
  type AgentTemplateSnapshot,
} from "@/src/server/agents/templates";
import type { AgentDetailConfigUi, ListedAgentUi } from "@/src/shared/agent-ui-types";
import type { PublicAgentDeployment } from "@/src/shared/agent-deployment-presentation";

export type ListedAgent = ListedAgentUi;

export type AgentDetail = ListedAgent & {
  statusReason: string | null;
  updatedAt: string;
  templateSnapshot: AgentTemplateSnapshot;
  config: AgentDetailConfigUi;
};

export type AgentDetailConfig = AgentDetailConfigUi;

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
        desiredStatus: agents.desiredStatus,
        assignedRunnerKind: runners.kind,
        assignedRunnerStatus: runners.status,
        assignedRunnerProvisioningStatus: runners.provisioningStatus,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .leftJoin(runners, eq(runners.id, agents.runnerId))
      .where(isNull(agents.deletedAt))
      .orderBy(desc(agents.createdAt), desc(agents.id));

    const deployments = await loadLatestDeploymentMap({
      db: connection.db,
      userId: null,
      agentIds: rows.map((row) => row.id),
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      templateKey: row.templateKey,
      templateVersion: row.templateVersion,
      templateLabel: getAgentTemplateLabel(row.templateKey),
      status: row.status,
      desiredStatus: row.desiredStatus,
      latestDeployment: deployments.get(row.id) ?? null,
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
        desiredStatus: agents.desiredStatus,
        assignedRunnerKind: runners.kind,
        assignedRunnerStatus: runners.status,
        assignedRunnerProvisioningStatus: runners.provisioningStatus,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .leftJoin(runners, and(eq(runners.id, agents.runnerId), eq(runners.userId, userId)))
      .where(and(eq(agents.userId, userId), isNull(agents.deletedAt)))
      .orderBy(desc(agents.createdAt), desc(agents.id));

    const deployments = await loadLatestDeploymentMap({
      db: connection.db,
      userId,
      agentIds: rows.map((row) => row.id),
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      templateKey: row.templateKey,
      templateVersion: row.templateVersion,
      templateLabel: getAgentTemplateLabel(row.templateKey),
      status: row.status,
      desiredStatus: row.desiredStatus,
      latestDeployment: deployments.get(row.id) ?? null,
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
        desiredStatus: agents.desiredStatus,
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
      desiredStatus: row.desiredStatus,
      latestDeployment: await loadLatestDeploymentForAgent({
        db: connection.db,
        userId: null,
        agentId: row.id,
      }),
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
        desiredStatus: agents.desiredStatus,
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
      desiredStatus: row.desiredStatus,
      latestDeployment: await loadLatestDeploymentForAgent({
        db: connection.db,
        userId,
        agentId: row.id,
      }),
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

async function loadLatestDeploymentForAgent(input: {
  db: DatabaseConnection["db"];
  userId: string | null;
  agentId: string;
}): Promise<PublicAgentDeployment | null> {
  const [row] = await input.db
    .select(latestDeploymentSelection)
    .from(agentDeployments)
    .innerJoin(
      agents,
      and(eq(agents.id, agentDeployments.agentId), eq(agents.userId, agentDeployments.userId)),
    )
    .where(
      and(
        eq(agentDeployments.agentId, input.agentId),
        isNull(agents.deletedAt),
        ...(input.userId === null
          ? []
          : [eq(agents.userId, input.userId), eq(agentDeployments.userId, input.userId)]),
      ),
    )
    .orderBy(desc(agentDeployments.createdAt), desc(agentDeployments.id))
    .limit(1);

  return row ? mapDeploymentRowToUi(row) : null;
}

async function loadLatestDeploymentMap(input: {
  db: DatabaseConnection["db"];
  userId: string | null;
  agentIds: string[];
}): Promise<Map<string, PublicAgentDeployment>> {
  if (input.agentIds.length === 0) {
    return new Map();
  }

  const rows = await input.db
    .selectDistinctOn([agentDeployments.agentId], latestDeploymentSelection)
    .from(agentDeployments)
    .innerJoin(
      agents,
      and(eq(agents.id, agentDeployments.agentId), eq(agents.userId, agentDeployments.userId)),
    )
    .where(
      and(
        inArray(agentDeployments.agentId, input.agentIds),
        isNull(agents.deletedAt),
        ...(input.userId === null
          ? []
          : [eq(agents.userId, input.userId), eq(agentDeployments.userId, input.userId)]),
      ),
    )
    .orderBy(agentDeployments.agentId, desc(agentDeployments.createdAt), desc(agentDeployments.id));

  return new Map(rows.map((row) => [row.agentId, mapDeploymentRowToUi(row)]));
}

const latestDeploymentSelection = {
  id: agentDeployments.id,
  agentId: agentDeployments.agentId,
  stage: agentDeployments.stage,
  configRevision: agentDeployments.configRevision,
  attemptCount: agentDeployments.attemptCount,
  errorCode: agentDeployments.errorCode,
  nextAttemptAt: agentDeployments.nextAttemptAt,
  startedAt: agentDeployments.startedAt,
  completedAt: agentDeployments.completedAt,
  failedAt: agentDeployments.failedAt,
  createdAt: agentDeployments.createdAt,
  updatedAt: agentDeployments.updatedAt,
};

function mapDeploymentRowToUi(
  row: Omit<AgentDeploymentRowForDto, "errorDetail">,
): PublicAgentDeployment {
  return toUiSafeDeployment(mapAgentDeploymentRowToDto({ ...row, errorDetail: null }));
}

function toUiSafeDeployment(deployment: ReturnType<typeof mapAgentDeploymentRowToDto>) {
  return {
    id: deployment.id,
    agentId: deployment.agentId,
    stage: deployment.stage,
    configRevision: deployment.configRevision,
    attemptCount: deployment.attemptCount,
    error: deployment.error ? { code: deployment.error.code } : null,
    nextAttemptAt: deployment.nextAttemptAt,
    startedAt: deployment.startedAt,
    completedAt: deployment.completedAt,
    failedAt: deployment.failedAt,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
  } satisfies PublicAgentDeployment;
}
