import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { agentConfigs, agents, runners } from "@/src/server/db/schema";
import {
  getAgentTemplateSnapshot,
  isSupportedTemplateKey,
  type AgentTemplateSnapshot,
  type SupportedAgentTemplateKey,
} from "@/src/server/agents/templates";
import { recordAgentEventInTransaction } from "@/src/server/events/agent-events";
import {
  selectRunnerPlacementForUserInTransaction,
  type RunnerPlacementResult,
} from "@/src/server/runners/runner-placement";
import {
  verifyRunnerPlacementCandidate,
  type RunnerPlacementVerificationResult,
} from "@/src/server/runners/runner-placement-verification";
import { DIGITALOCEAN_RUNNER_KIND } from "@/src/server/runners/digitalocean-provider";
import {
  createDigitalOceanRunnerForUser,
  type CreateRunnerProvisioningResult,
} from "@/src/server/runners/runner-provisioning";
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
  field: "body" | "name" | "templateKey" | "runnerId";
  message: string;
};

export type CreateAgentValidationResult =
  | {
      ok: true;
      value: {
        name: string;
        templateKey: SupportedAgentTemplateKey;
        runnerId: string | null;
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
    runnerId: string | null;
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

type EnsureCloudRunnerProvisioning = () => Promise<CreateRunnerProvisioningResult>;
type VerifyRunnerPlacement = (
  connection: DatabaseConnection,
  input: { runnerId: string; userId: string },
) => Promise<RunnerPlacementVerificationResult>;

const MAX_RUNNER_PLACEMENT_VERIFICATION_ATTEMPTS = 5;

export type CreateAgentDependencies = {
  createConnection?: () => DatabaseConnection;
  insertDefaultAgentConfig?: InsertDefaultAgentConfig;
  insertCreatedEvent?: InsertCreatedEvent;
  ensureCloudRunnerProvisioning?: EnsureCloudRunnerProvisioning;
  verifyRunnerPlacement?: VerifyRunnerPlacement;
  autoProvisionCloudRunner?: boolean;
  planMaxAgents?: number | null;
};

export class AgentPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Agent creation failed.");
    this.name = "AgentPersistenceError";
    this.cause = cause;
  }
}

export class AgentCreateBlockedError extends Error {
  readonly reason: "plan_limit_reached" | "runner_capacity_reached";
  readonly currentAgents?: number;
  readonly maxAgents?: number;

  constructor(
    result: Extract<
      RunnerPlacementResult,
      { reason: "plan_limit_reached" | "runner_capacity_reached" }
    >,
  ) {
    super("Agent creation blocked.");
    this.name = "AgentCreateBlockedError";
    this.reason = result.reason;

    if (result.reason === "plan_limit_reached") {
      this.currentAgents = result.currentAgents;
      this.maxAgents = result.maxAgents;
    }
  }
}

export class AgentRunnerAssignmentError extends Error {
  constructor() {
    super("Requested runner cannot be assigned to this agent.");
    this.name = "AgentRunnerAssignmentError";
  }
}

export class AgentRunnerProvisioningError extends Error {
  readonly reason: "provider_not_configured" | "provisioning_failed";

  constructor(reason: "provider_not_configured" | "provisioning_failed", cause?: unknown) {
    super("Cloud runner provisioning could not be started.");
    this.name = "AgentRunnerProvisioningError";
    this.reason = reason;
    this.cause = cause;
  }
}

export class AgentRunnerVerificationError extends Error {
  readonly reason: "provider_check_failed" | "provider_not_configured" | "verification_churn";

  constructor(reason: "provider_check_failed" | "provider_not_configured" | "verification_churn") {
    super("Runner eligibility could not be verified safely.");
    this.name = "AgentRunnerVerificationError";
    this.reason = reason;
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
  const rawRunnerId = payload.runnerId;

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
  const runnerId =
    typeof rawRunnerId === "string" && rawRunnerId.trim().length > 0 ? rawRunnerId.trim() : null;

  if (
    rawRunnerId !== undefined &&
    rawRunnerId !== null &&
    (typeof rawRunnerId !== "string" || (runnerId !== null && !isValidAgentId(runnerId)))
  ) {
    issues.push({ field: "runnerId", message: "Runner ID must be a valid UUID." });
  }

  if (issues.length > 0 || !templateKey) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      name,
      templateKey,
      runnerId,
    },
  };
}

export async function createAgentForDevelopmentUser(
  input: {
    name: string;
    templateKey: SupportedAgentTemplateKey;
    runnerId?: string | null;
  },
  dependencies: CreateAgentDependencies = {},
): Promise<CreatedAgentResponse> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await createAgentWithUserResolver(
      connection,
      (tx) => getOrCreateDevelopmentUserId(tx),
      input,
      dependencies,
    );
  } catch (error) {
    return throwAgentCreateError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function createAgentForUser(
  userId: string,
  input: {
    name: string;
    templateKey: SupportedAgentTemplateKey;
    runnerId?: string | null;
  },
  dependencies: CreateAgentDependencies = {},
): Promise<CreatedAgentResponse> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await createAgentWithUserResolver(connection, () => userId, input, dependencies);
  } catch (error) {
    return throwAgentCreateError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function createAgentWithUserResolver(
  connection: DatabaseConnection,
  resolveUserId: (tx: AgentTransaction) => Promise<string> | string,
  input: {
    name: string;
    templateKey: SupportedAgentTemplateKey;
    runnerId?: string | null;
  },
  dependencies: CreateAgentDependencies,
): Promise<CreatedAgentResponse> {
  const insertDefaultAgentConfig =
    dependencies.insertDefaultAgentConfig ?? insertDefaultConfigForCreatedAgent;
  const insertCreatedEvent = dependencies.insertCreatedEvent ?? insertDefaultCreatedEvent;
  const autoProvisionCloudRunner =
    dependencies.autoProvisionCloudRunner ?? process.env.NODE_ENV !== "test";
  const verifyRunnerPlacement =
    dependencies.verifyRunnerPlacement ?? verifyRunnerPlacementCandidate;
  const templateSnapshot = getAgentTemplateSnapshot(input.templateKey);
  const initial = await connection.db.transaction(async (tx) => {
    const userId = await resolveUserId(tx);
    const placement = await selectRunnerPlacementForUserInTransaction(tx, userId, {
      planMaxAgents: dependencies.planMaxAgents,
      runnerId: input.runnerId,
    });

    if (
      !placement.ok &&
      placement.reason === "no_online_runner" &&
      !autoProvisionCloudRunner &&
      !input.runnerId
    ) {
      return {
        status: "created" as const,
        response: await insertCreatedAgentInTransaction(tx, {
          userId,
          name: input.name,
          templateKey: input.templateKey,
          templateSnapshot,
          runnerId: null,
          insertDefaultAgentConfig,
          insertCreatedEvent,
        }),
      };
    }

    return { status: "placement_pending" as const, userId, placement };
  });

  if (initial.status === "created") {
    logAgentCreate("created_without_runner", { agentId: initial.response.agent.id });
    return initial.response;
  }

  const { userId } = initial;

  for (let attempt = 1; attempt <= MAX_RUNNER_PLACEMENT_VERIFICATION_ATTEMPTS; attempt += 1) {
    const placement =
      attempt === 1
        ? initial.placement
        : await connection.db.transaction((tx) =>
            selectRunnerPlacementForUserInTransaction(tx, userId, {
              planMaxAgents: dependencies.planMaxAgents,
              runnerId: input.runnerId,
            }),
          );

    logAgentCreate("placement_checked", {
      attempt,
      autoProvisionCloudRunner,
      requestedRunner: Boolean(input.runnerId),
      placement: placement.ok ? "online_runner" : placement.reason,
      ...(placement.ok ? { runnerId: placement.runner.id, runnerKind: placement.runner.kind } : {}),
    });

    if (!placement.ok) {
      if (input.runnerId && placement.reason === "no_online_runner") {
        throw new AgentRunnerAssignmentError();
      }

      if (
        placement.reason === "plan_limit_reached" ||
        placement.reason === "runner_capacity_reached"
      ) {
        throw new AgentCreateBlockedError(placement);
      }

      if (autoProvisionCloudRunner) {
        logAgentCreate("cloud_runner_needed", {
          autoProvisionCloudRunner,
          requestedRunner: Boolean(input.runnerId),
        });
        return createAgentWithProvisionedRunner(connection, {
          userId,
          name: input.name,
          templateKey: input.templateKey,
          templateSnapshot,
          insertDefaultAgentConfig,
          insertCreatedEvent,
          dependencies,
        });
      }

      const response = await connection.db.transaction(async (tx) => {
        await assertActiveAgentPlanAllowsInsert(tx, userId, dependencies.planMaxAgents);
        return insertCreatedAgentInTransaction(tx, {
          userId,
          name: input.name,
          templateKey: input.templateKey,
          templateSnapshot,
          runnerId: null,
          insertDefaultAgentConfig,
          insertCreatedEvent,
        });
      });

      logAgentCreate("created_without_runner", { agentId: response.agent.id });
      return response;
    }

    const verification = await verifyRunnerPlacement(connection, {
      runnerId: placement.runner.id,
      userId,
    });

    if (!verification.ok) {
      logAgentCreate("runner_candidate_rejected", {
        action: verification.action,
        attempt,
        reason: verification.reason,
        runnerId: placement.runner.id,
        transitioned: verification.transitioned,
      });

      if (verification.action === "fail_closed") {
        throw new AgentRunnerVerificationError(verification.reason);
      }

      if (input.runnerId) {
        throw new AgentRunnerAssignmentError();
      }

      continue;
    }

    const created = await connection.db.transaction(async (tx) => {
      const finalPlacement = await selectRunnerPlacementForUserInTransaction(tx, userId, {
        planMaxAgents: dependencies.planMaxAgents,
        runnerId: placement.runner.id,
      });

      if (!finalPlacement.ok) {
        return { ok: false, placement: finalPlacement } as const;
      }

      return {
        ok: true,
        response: await insertCreatedAgentInTransaction(tx, {
          userId,
          name: input.name,
          templateKey: input.templateKey,
          templateSnapshot,
          runnerId: finalPlacement.runner.id,
          insertDefaultAgentConfig,
          insertCreatedEvent,
        }),
      } as const;
    });

    if (!created.ok) {
      logAgentCreate("runner_candidate_changed_before_insert", {
        attempt,
        reason: created.placement.reason,
        runnerId: placement.runner.id,
      });

      if (
        created.placement.reason === "plan_limit_reached" ||
        created.placement.reason === "runner_capacity_reached"
      ) {
        throw new AgentCreateBlockedError(created.placement);
      }

      if (input.runnerId) {
        throw new AgentRunnerAssignmentError();
      }

      continue;
    }

    logAgentCreate("created_with_existing_runner", {
      agentId: created.response.agent.id,
      runnerId: verification.runner.id,
      runnerKind: verification.runner.kind,
      provisioningStatus: verification.runner.provisioningStatus,
    });
    return created.response;
  }

  throw new AgentRunnerVerificationError("verification_churn");
}

async function createAgentWithProvisionedRunner(
  connection: DatabaseConnection,
  input: {
    userId: string;
    name: string;
    templateKey: SupportedAgentTemplateKey;
    templateSnapshot: AgentTemplateSnapshot;
    insertDefaultAgentConfig: InsertDefaultAgentConfig;
    insertCreatedEvent: InsertCreatedEvent;
    dependencies: CreateAgentDependencies;
  },
): Promise<CreatedAgentResponse> {
  const { dependencies } = input;

  const ensureCloudRunnerProvisioning =
    dependencies.ensureCloudRunnerProvisioning ??
    (() => ensureDefaultCloudRunnerProvisioning(input.userId));
  logAgentCreate("cloud_runner_provisioning_start", {});
  const provisionedRunnerId = await ensureProvisionedRunnerId(ensureCloudRunnerProvisioning);
  logAgentCreate("cloud_runner_provisioning_runner_selected", {
    runnerId: provisionedRunnerId,
  });

  return await connection.db.transaction(async (tx) => {
    await assertActiveAgentPlanAllowsInsert(tx, input.userId, dependencies.planMaxAgents);
    await assertProvisioningRunnerAssignableToUser(tx, {
      userId: input.userId,
      runnerId: provisionedRunnerId,
    });

    return insertCreatedAgentInTransaction(tx, {
      userId: input.userId,
      name: input.name,
      templateKey: input.templateKey,
      templateSnapshot: input.templateSnapshot,
      runnerId: provisionedRunnerId,
      insertDefaultAgentConfig: input.insertDefaultAgentConfig,
      insertCreatedEvent: input.insertCreatedEvent,
    });
  });
}

function throwAgentCreateError(error: unknown): never {
  if (
    error instanceof AgentCreateBlockedError ||
    error instanceof AgentRunnerAssignmentError ||
    error instanceof AgentRunnerProvisioningError ||
    error instanceof AgentRunnerVerificationError ||
    error instanceof AgentPersistenceError
  ) {
    throw error;
  }

  throw new AgentPersistenceError(error);
}

async function insertCreatedAgentInTransaction(
  tx: AgentTransaction,
  input: {
    userId: string;
    name: string;
    templateKey: SupportedAgentTemplateKey;
    templateSnapshot: AgentTemplateSnapshot;
    runnerId: string | null;
    insertDefaultAgentConfig: InsertDefaultAgentConfig;
    insertCreatedEvent: InsertCreatedEvent;
  },
): Promise<CreatedAgentResponse> {
  const [agent] = await tx
    .insert(agents)
    .values({
      userId: input.userId,
      runnerId: input.runnerId,
      name: input.name,
      templateKey: input.templateKey,
      templateVersion: input.templateSnapshot.version,
      templateSnapshotJson: input.templateSnapshot,
      status: "stopped",
    })
    .returning();

  if (!agent) {
    throw new Error("Agent insert returned no rows.");
  }

  const createdAgent = agent as CreatedAgentRow;
  await input.insertDefaultAgentConfig(tx, { agent: createdAgent });
  await input.insertCreatedEvent(tx, { agent: createdAgent, actorUserId: input.userId });

  return toCreatedAgentResponse(createdAgent);
}

async function ensureProvisionedRunnerId(
  ensureCloudRunnerProvisioning: EnsureCloudRunnerProvisioning,
): Promise<string> {
  let result: CreateRunnerProvisioningResult;

  try {
    result = await ensureCloudRunnerProvisioning();
  } catch (error) {
    logAgentCreate("cloud_runner_provisioning_threw", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new AgentRunnerProvisioningError("provisioning_failed", error);
  }

  if (!result.ok) {
    if (result.reason === "provider_not_configured") {
      logAgentCreate("cloud_runner_provider_not_configured", {});
      throw new AgentRunnerProvisioningError("provider_not_configured");
    }

    logAgentCreate("cloud_runner_provisioning_failed_result", { reason: result.reason });
    throw new AgentRunnerProvisioningError("provisioning_failed", result);
  }

  if (
    result.runner.provisioning.status === "failed" ||
    result.runner.provisioning.status === "deleted"
  ) {
    logAgentCreate("cloud_runner_unusable", {
      runnerId: result.runner.id,
      provisioningStatus: result.runner.provisioning.status,
    });
    throw new AgentRunnerProvisioningError("provisioning_failed", result);
  }

  logAgentCreate("cloud_runner_provisioning_result", {
    duplicate: result.duplicate,
    runnerId: result.runner.id,
    runnerStatus: result.runner.status,
    provisioningStatus: result.runner.provisioning.status,
  });

  return result.runner.id;
}

async function assertActiveAgentPlanAllowsInsert(
  tx: AgentTransaction,
  userId: string,
  planMaxAgents: number | null | undefined,
): Promise<void> {
  const normalizedPlanMaxAgents =
    typeof planMaxAgents === "number" && Number.isInteger(planMaxAgents) && planMaxAgents > 0
      ? planMaxAgents
      : null;

  if (normalizedPlanMaxAgents === null) {
    return;
  }

  const activeAgentRows = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, userId), isNull(agents.deletedAt)));

  if (activeAgentRows.length >= normalizedPlanMaxAgents) {
    throw new AgentCreateBlockedError({
      ok: false,
      reason: "plan_limit_reached",
      currentAgents: activeAgentRows.length,
      maxAgents: normalizedPlanMaxAgents,
    });
  }
}

async function assertProvisioningRunnerAssignableToUser(
  tx: AgentTransaction,
  input: {
    userId: string;
    runnerId: string;
  },
): Promise<void> {
  const [runner] = await tx
    .select({
      id: runners.id,
      kind: runners.kind,
      provisioningStatus: runners.provisioningStatus,
    })
    .from(runners)
    .where(
      and(
        eq(runners.id, input.runnerId),
        eq(runners.userId, input.userId),
        eq(runners.kind, DIGITALOCEAN_RUNNER_KIND),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  if (
    !runner ||
    runner.provisioningStatus === "failed" ||
    runner.provisioningStatus === "deleted"
  ) {
    throw new AgentRunnerProvisioningError("provisioning_failed");
  }
}

function ensureDefaultCloudRunnerProvisioning(
  userId: string,
): Promise<CreateRunnerProvisioningResult> {
  return createDigitalOceanRunnerForUser(userId, {
    provider: "digitalocean",
    name: "plingpling Cloud Runner",
  });
}

function logAgentCreate(event: string, metadata: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  console.info("[agentbay] agent.create", { event, ...metadata });
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
      runnerAssignment: input.agent.runnerId ? "assigned" : "none",
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
      runnerId: agent.runnerId,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
      deletedAt: null,
    },
    event: {
      type: "agent.created",
    },
  };
}
