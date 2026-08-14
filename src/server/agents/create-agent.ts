import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  createAgentDeploymentForUser,
  getAgentDeploymentByIdempotencyKeyForUser,
} from "@/src/server/agents/agent-deployments";
import { captureAgentDeploymentChoicesFromEnvironment } from "@/src/server/agents/agent-deployment-choices";
import {
  type AgentDeploymentEnvironment,
  type AgentDeploymentOrigin,
  readColdProvisioningPolicy,
  readRolloutConfigurationGeneration,
} from "@/src/server/agents/deployment-slo-identity";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  AgentSecretKeyringError,
  AgentSecretLegacyBackfillRequiredError,
  AgentSecretTelegramConflictError,
  assertNoUnbackfilledActiveTelegramSecretsInTransaction,
  createGeneratedApiServerKey,
  hasPostgresConstraint,
  insertPreparedAgentSecretRowsInTransaction,
  parseAgentSecretKeyring,
  prepareAgentSecretRow,
} from "@/src/server/agents/agent-secrets";
import {
  type AssistantChoice,
  type AssistantProfile,
  getAssistantProfile,
  getAssistantProfileForManagedModel,
  isAssistantChoice,
  validateAssistantApiKey,
} from "@/src/server/agents/assistant-profiles";
import type { AgentDeploymentDto } from "@/src/server/agents/deployment-dto";
import { resolveReusableAssistantApiKeyInTransaction } from "@/src/server/agents/model-connections";
import {
  type AgentTemplateSnapshot,
  getAgentTemplateSnapshot,
  isSupportedTemplateKey,
  type SupportedAgentTemplateKey,
} from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { agentConfigs, agentSecrets, agents, runners } from "@/src/server/db/schema";
import { readDigitalOceanProviderConfig, readReadyAgentCreationFlag } from "@/src/server/env";
import { recordAgentEventInTransaction } from "@/src/server/events/agent-events";
import { type AppLogger, createAppLogger } from "@/src/server/logging/logger";
import { DIGITALOCEAN_RUNNER_KIND } from "@/src/server/runners/digitalocean-provider";
import {
  lockRunnerPlacementCapacityInTransaction,
  type RunnerPlacementCapacityOptions,
  type RunnerPlacementResult,
  selectRunnerPlacementForUserInTransaction,
} from "@/src/server/runners/runner-placement";
import {
  type RunnerPlacementVerificationResult,
  verifyRunnerPlacementCandidate,
} from "@/src/server/runners/runner-placement-verification";
import {
  type CreateRunnerProvisioningResult,
  createDigitalOceanRunnerForUser,
} from "@/src/server/runners/runner-provisioning";
import {
  type TelegramBotMetadata,
  type TelegramClientDependencies,
  validateTelegramBotTokenWithGetMe,
} from "@/src/server/telegram/telegram-client";
import { getOrCreateDevelopmentUserId } from "@/src/server/users/development-user";

const agentCreateLogger = createAppLogger("agent.create");

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
  field:
    | "body"
    | "name"
    | "templateKey"
    | "runnerId"
    | "launchMode"
    | "idempotencyKey"
    | "assistant"
    | "modelApiKey"
    | "openrouterModel"
    | "openrouterApiKey"
    | "telegramBotToken"
    | "telegramAllowedUserIds";
  message: string;
};

type StoppedCreateAgentInput = {
  name: string;
  templateKey: SupportedAgentTemplateKey;
  runnerId?: string | null;
};

export type ReadyCreateAgentInput = {
  name: string;
  templateKey: SupportedAgentTemplateKey;
  runnerId: string | null;
  launchMode: "ready";
  idempotencyKey: string;
  assistant?: unknown;
  modelApiKey?: unknown;
  telegramBotToken?: unknown;
  telegramAllowedUserIds?: unknown;
};

type CreateAgentInput = StoppedCreateAgentInput | ReadyCreateAgentInput;

export type CreateAgentValidationResult =
  | {
      ok: true;
      value: CreateAgentInput;
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

export type ReadyCreatedAgentResponse = {
  agent: CreatedAgentResponse["agent"] & {
    desiredStatus: "running";
    assistant: {
      id: AssistantChoice;
      displayName: "ChatGPT" | "Claude";
    };
    telegramBot: {
      id: string;
      username: string | null;
    };
  };
  deployment: AgentDeploymentDto;
};

export type CreateAgentResponse = CreatedAgentResponse | ReadyCreatedAgentResponse;

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
type TelegramBotValidator = (
  token: string,
) => Promise<Awaited<ReturnType<typeof validateTelegramBotTokenWithGetMe>>>;

const MAX_RUNNER_PLACEMENT_VERIFICATION_ATTEMPTS = 5;

export type CreateAgentDependencies = {
  createConnection?: () => DatabaseConnection;
  insertDefaultAgentConfig?: InsertDefaultAgentConfig;
  insertCreatedEvent?: InsertCreatedEvent;
  ensureCloudRunnerProvisioning?: EnsureCloudRunnerProvisioning;
  verifyRunnerPlacement?: VerifyRunnerPlacement;
  autoProvisionCloudRunner?: boolean;
  planMaxAgents?: number | null;
  runnerPlacementCapacityOptions?: RunnerPlacementCapacityOptions;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
  telegramClient?: TelegramClientDependencies;
  telegramBotValidator?: TelegramBotValidator;
  onReadyDeploymentCommitted?: (deploymentId: string) => void;
  readyDeploymentIdentity?: {
    origin: AgentDeploymentOrigin;
    environment: AgentDeploymentEnvironment;
  };
  readyCreateTestHooks?: {
    beforeCapacityLock?: (input: { runnerId: string; userId: string }) => Promise<void> | void;
    afterCapacityLock?: (input: { runnerId: string; userId: string }) => Promise<void> | void;
    beforeInsertBoundary?: (boundary: ReadyCreateInsertBoundary) => Promise<void> | void;
  };
};

export type ReadyCreateInsertBoundary =
  | "config"
  | "secret:openrouter_api_key"
  | "secret:openai_api_key"
  | "secret:anthropic_api_key"
  | "secret:telegram_bot_token"
  | "secret:telegram_allowed_users"
  | "secret:api_server_key"
  | "deployment"
  | "event";

function runnerPlacementOptions(dependencies: CreateAgentDependencies, now?: Date) {
  return {
    ...(now ? { now } : {}),
    ...(dependencies.runnerPlacementCapacityOptions
      ? { capacityOptions: dependencies.runnerPlacementCapacityOptions }
      : {}),
  };
}

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

export class ReadyAgentCreationDisabledError extends Error {
  readonly reason: "disabled" | "invalid_configuration" | "cold_provisioning_halted";

  constructor(reason: ReadyAgentCreationDisabledError["reason"]) {
    super("Ready agent creation is not enabled.");
    this.name = "ReadyAgentCreationDisabledError";
    this.reason = reason;
  }
}

export class ReadyAgentValidationError extends Error {
  readonly issues: CreateAgentValidationIssue[];

  constructor(issues: CreateAgentValidationIssue[]) {
    super("Ready agent creation validation failed.");
    this.name = "ReadyAgentValidationError";
    this.issues = issues;
  }
}

export class TelegramValidationUnavailableError extends Error {
  readonly reason:
    | "telegram_validation_timeout"
    | "telegram_validation_unavailable"
    | "telegram_validation_invalid_response";

  constructor(reason: TelegramValidationUnavailableError["reason"]) {
    super("Telegram bot validation is temporarily unavailable.");
    this.name = "TelegramValidationUnavailableError";
    this.reason = reason;
  }
}

export class TelegramBotInUseError extends Error {
  constructor(cause?: unknown) {
    super("Telegram bot is already assigned to an active agent.");
    this.name = "TelegramBotInUseError";
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
  const rawRunnerId = payload.runnerId;
  const rawLaunchMode = payload.launchMode;

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

  const launchMode = rawLaunchMode === undefined ? "stopped" : rawLaunchMode;

  if (launchMode !== "stopped" && launchMode !== "ready") {
    issues.push({ field: "launchMode", message: "Launch mode is not supported." });
  }

  if (issues.length > 0 || !templateKey) {
    return { ok: false, issues };
  }

  if (launchMode === "ready") {
    const idempotencyKey = normalizeReadyIdempotencyKey(payload.idempotencyKey);
    const readyForbiddenFields = [
      "provider",
      "openrouterModel",
      "openrouterApiKey",
      "modelProvider",
      "modelName",
      "contextTokens",
      "botId",
      "botUsername",
      "telegramBot",
      "deployment",
      "deploymentStage",
      "desiredStatus",
      "status",
      "configRevision",
      "apiServerKey",
      "ciphertext",
      "fingerprint",
      "event",
      "eventMetadata",
    ] as const;
    const readyForbiddenIssues = readyForbiddenFields.flatMap((field) =>
      payload[field] === undefined
        ? []
        : [{ field: "body" as const, message: "Ready launch metadata is server-owned." }],
    );

    if (!idempotencyKey.ok) {
      return {
        ok: false,
        issues: [{ field: "idempotencyKey", message: "Idempotency key is invalid." }],
      };
    }

    if (readyForbiddenIssues.length > 0) {
      return { ok: false, issues: readyForbiddenIssues };
    }

    return {
      ok: true,
      value: {
        name,
        templateKey,
        runnerId,
        launchMode: "ready",
        idempotencyKey: idempotencyKey.value,
        assistant: payload.assistant,
        modelApiKey: payload.modelApiKey,
        telegramBotToken: payload.telegramBotToken,
        telegramAllowedUserIds: payload.telegramAllowedUserIds,
      },
    };
  }

  const readyOnlyFields = [
    "idempotencyKey",
    "assistant",
    "modelApiKey",
    "openrouterModel",
    "openrouterApiKey",
    "telegramBotToken",
    "telegramAllowedUserIds",
  ] as const;
  const stoppedIssues = readyOnlyFields.flatMap((field) =>
    payload[field] === undefined
      ? []
      : [{ field, message: "Field is only accepted for ready launch mode." }],
  );

  if (stoppedIssues.length > 0) {
    return { ok: false, issues: stoppedIssues };
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
  const lifecycleId = randomUUID();
  const logger = agentCreateLogger.child({
    lifecycle: "agent_creation",
    lifecycleId,
    launchMode: "stopped",
  });
  const startedAt = Date.now();

  logAgentCreate(logger, "requested", {
    templateKey: input.templateKey,
    requestedRunnerId: input.runnerId ?? null,
  });

  try {
    const response = await createAgentWithUserResolver(
      connection,
      (tx) => getOrCreateDevelopmentUserId(tx),
      input,
      dependencies,
      logger,
    );

    logAgentCreate(logger, "completed", {
      agentId: response.agent.id,
      runnerId: response.agent.runnerId,
      durationMs: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    logAgentCreateError(logger, "failed", error, { durationMs: Date.now() - startedAt });
    return throwAgentCreateError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function createAgentForUser(
  userId: string,
  input: CreateAgentInput,
  dependencies: CreateAgentDependencies = {},
): Promise<CreateAgentResponse> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const lifecycleId = randomUUID();
  const launchMode = isReadyCreateInput(input) ? "ready" : "stopped";
  const logger = agentCreateLogger.child({
    lifecycle: "agent_creation",
    lifecycleId,
    launchMode,
    userId,
  });
  const startedAt = Date.now();

  logAgentCreate(logger, "requested", {
    templateKey: input.templateKey,
    requestedRunnerId: input.runnerId ?? null,
  });

  try {
    let response: CreateAgentResponse;

    if (isReadyCreateInput(input)) {
      response = await createReadyAgentForUser(connection, userId, input, dependencies);
    } else {
      response = await createAgentWithUserResolver(
        connection,
        () => userId,
        input,
        dependencies,
        logger,
      );
    }

    logAgentCreate(logger, "completed", {
      agentId: response.agent.id,
      runnerId: response.agent.runnerId,
      durationMs: Date.now() - startedAt,
      ...(isReadyCreateInput(input) && "deployment" in response
        ? { deploymentId: response.deployment.id }
        : {}),
    });
    return response;
  } catch (error) {
    logAgentCreateError(logger, "failed", error, { durationMs: Date.now() - startedAt });
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
  logger: AppLogger,
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
    const placement = await selectRunnerPlacementForUserInTransaction(
      tx,
      userId,
      {
        planMaxAgents: dependencies.planMaxAgents,
        runnerId: input.runnerId,
      },
      runnerPlacementOptions(dependencies),
    );

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
    logAgentCreate(logger, "created_without_runner", { agentId: initial.response.agent.id });
    return initial.response;
  }

  const { userId } = initial;

  for (let attempt = 1; attempt <= MAX_RUNNER_PLACEMENT_VERIFICATION_ATTEMPTS; attempt += 1) {
    const placement =
      attempt === 1
        ? initial.placement
        : await connection.db.transaction((tx) =>
            selectRunnerPlacementForUserInTransaction(
              tx,
              userId,
              {
                planMaxAgents: dependencies.planMaxAgents,
                runnerId: input.runnerId,
              },
              runnerPlacementOptions(dependencies),
            ),
          );

    logAgentCreate(logger, "placement_checked", {
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
        (input.runnerId && placement.reason === "runner_capacity_reached")
      ) {
        throw new AgentCreateBlockedError(placement);
      }

      if (autoProvisionCloudRunner) {
        logAgentCreate(logger, "cloud_runner_needed", {
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
          logger,
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

      logAgentCreate(logger, "created_without_runner", { agentId: response.agent.id });
      return response;
    }

    const { id: placementRunnerId } = placement.runner;
    const verification = await verifyRunnerPlacement(connection, {
      runnerId: placementRunnerId,
      userId,
    });

    if (!verification.ok) {
      logAgentCreate(
        logger,
        "runner_candidate_rejected",
        {
          action: verification.action,
          attempt,
          reason: verification.reason,
          runnerId: placementRunnerId,
          transitioned: verification.transitioned,
        },
        "warn",
      );

      if (verification.action === "fail_closed") {
        throw new AgentRunnerVerificationError(verification.reason);
      }

      if (input.runnerId) {
        throw new AgentRunnerAssignmentError();
      }

      continue;
    }

    const created = await connection.db.transaction(async (tx) => {
      const locked = await lockRunnerPlacementCapacityInTransaction(tx, {
        userId,
        runnerId: placementRunnerId,
      });
      if (!locked) {
        return {
          ok: false,
          placement: { ok: false, reason: "no_online_runner" } as const,
        } as const;
      }
      const finalPlacement = await selectRunnerPlacementForUserInTransaction(
        tx,
        userId,
        {
          planMaxAgents: dependencies.planMaxAgents,
          runnerId: placementRunnerId,
        },
        runnerPlacementOptions(dependencies),
      );

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
      const { reason } = created.placement;
      logAgentCreate(
        logger,
        "runner_candidate_changed_before_insert",
        {
          attempt,
          reason,
          runnerId: placementRunnerId,
        },
        "warn",
      );

      if (
        reason === "plan_limit_reached" ||
        (input.runnerId && reason === "runner_capacity_reached")
      ) {
        throw new AgentCreateBlockedError(created.placement);
      }

      if (autoProvisionCloudRunner) {
        logAgentCreate(logger, "cloud_runner_needed_after_capacity_revalidation", {
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
          logger,
        });
      }

      if (reason === "runner_capacity_reached") {
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

        logAgentCreate(logger, "created_without_runner", { agentId: response.agent.id });
        return response;
      }

      if (input.runnerId) {
        throw new AgentRunnerAssignmentError();
      }

      continue;
    }

    logAgentCreate(logger, "created_with_existing_runner", {
      agentId: created.response.agent.id,
      runnerId: verification.runner.id,
      runnerKind: verification.runner.kind,
      provisioningStatus: verification.runner.provisioningStatus,
    });
    return created.response;
  }

  throw new AgentRunnerVerificationError("verification_churn");
}

async function createReadyAgentForUser(
  connection: DatabaseConnection,
  userId: string,
  input: ReadyCreateAgentInput,
  dependencies: CreateAgentDependencies,
): Promise<ReadyCreatedAgentResponse> {
  const replay = await selectReadyCreateReplay(connection.db, {
    userId,
    idempotencyKey: input.idempotencyKey,
  });

  if (replay) {
    return replay;
  }

  const flag = readReadyAgentCreationFlag(dependencies.env);

  if (!flag.ok) {
    throw new ReadyAgentCreationDisabledError("invalid_configuration");
  }

  if (!flag.enabled) {
    throw new ReadyAgentCreationDisabledError("disabled");
  }

  const coldProvisioning = readColdProvisioningPolicy(dependencies.env);
  if (!coldProvisioning.ok) {
    throw new ReadyAgentCreationDisabledError("invalid_configuration");
  }
  if (!coldProvisioning.enabled) {
    throw new ReadyAgentCreationDisabledError("cold_provisioning_halted");
  }

  const rolloutConfigurationGeneration = readRolloutConfigurationGeneration(dependencies.env);

  const now = dependencies.now?.() ?? new Date();
  const placementPrecheck = await connection.db.transaction((tx) =>
    selectRunnerPlacementForUserInTransaction(
      tx,
      userId,
      {
        planMaxAgents: dependencies.planMaxAgents,
        runnerId: input.runnerId,
      },
      runnerPlacementOptions(dependencies, now),
    ),
  );

  if (!placementPrecheck.ok) {
    if (input.runnerId && placementPrecheck.reason === "no_online_runner") {
      throw new AgentRunnerAssignmentError();
    }

    if (
      placementPrecheck.reason === "plan_limit_reached" ||
      (input.runnerId && placementPrecheck.reason === "runner_capacity_reached")
    ) {
      throw new AgentCreateBlockedError(placementPrecheck);
    }

    requireReadyRunnerProvisioningConfig(dependencies.env ?? process.env);
  }

  const firstWriteValidation = validateReadyFirstWriteInput(input);

  if (!firstWriteValidation.ok) {
    throw new ReadyAgentValidationError(firstWriteValidation.issues);
  }

  const keyring = parseAgentSecretKeyring(dependencies.env);
  const modelApiKey =
    firstWriteValidation.modelApiKey ??
    (await connection.db.transaction((tx) =>
      resolveReusableAssistantApiKeyInTransaction(tx, {
        userId,
        assistant: firstWriteValidation.profile.assistant,
        ...(dependencies.env ? { env: dependencies.env } : {}),
      }),
    ));

  if (!modelApiKey) {
    throw new ReadyAgentValidationError([
      {
        field: "modelApiKey",
        message: `${firstWriteValidation.profile.credentialLabel} is required the first time you connect ${firstWriteValidation.profile.displayName}.`,
      },
    ]);
  }

  const telegramValidation = await (dependencies.telegramBotValidator?.(
    firstWriteValidation.telegramBotToken,
  ) ??
    validateTelegramBotTokenWithGetMe(
      firstWriteValidation.telegramBotToken,
      dependencies.telegramClient,
    ));

  if (!telegramValidation.ok) {
    if (telegramValidation.reason === "invalid_bot_token") {
      throw new ReadyAgentValidationError([
        { field: "telegramBotToken", message: "Telegram bot token format is invalid." },
      ]);
    }

    throw new TelegramValidationUnavailableError(telegramValidation.reason);
  }

  const agentId = dependencies.randomUUID?.() ?? randomUUID();
  const configRevision = `cfg-${now.getTime()}`;
  const templateSnapshot = getAgentTemplateSnapshot(input.templateKey);
  const randomBytesFn = dependencies.randomBytes ?? randomBytes;
  const apiServerKey = createGeneratedApiServerKey(randomBytesFn);
  const preparedSecrets = [
    prepareAgentSecretRow({
      agentId,
      kind: firstWriteValidation.profile.secretKind,
      value: modelApiKey,
      keyring,
      now,
      rotatedAt: null,
      randomBytes: randomBytesFn,
    }),
    prepareAgentSecretRow({
      agentId,
      kind: "telegram_bot_token",
      value: firstWriteValidation.telegramBotToken,
      keyring,
      now,
      rotatedAt: null,
      telegramBot: telegramValidation.bot,
      randomBytes: randomBytesFn,
    }),
    prepareAgentSecretRow({
      agentId,
      kind: "telegram_allowed_users",
      value: firstWriteValidation.telegramAllowedUsers,
      keyring,
      now,
      rotatedAt: null,
      randomBytes: randomBytesFn,
    }),
    prepareAgentSecretRow({
      agentId,
      kind: "api_server_key",
      value: apiServerKey,
      keyring,
      now,
      rotatedAt: null,
      randomBytes: randomBytesFn,
    }),
  ];

  let insertedDeploymentId: string | null = null;

  try {
    const response = await connection.db.transaction(async (tx) => {
      await takeReadyCreateIdempotencyLock(tx, {
        userId,
        idempotencyKey: input.idempotencyKey,
      });

      const replayInTransaction = await selectReadyCreateReplay(tx, {
        userId,
        idempotencyKey: input.idempotencyKey,
      });

      if (replayInTransaction) {
        return replayInTransaction;
      }

      const placement = await selectRunnerPlacementForUserInTransaction(
        tx,
        userId,
        {
          planMaxAgents: dependencies.planMaxAgents,
          runnerId: input.runnerId,
        },
        runnerPlacementOptions(dependencies, now),
      );

      let runnerId: string | null = null;

      if (!placement.ok) {
        if (input.runnerId && placement.reason === "no_online_runner") {
          throw new AgentRunnerAssignmentError();
        }

        if (
          placement.reason === "plan_limit_reached" ||
          (input.runnerId && placement.reason === "runner_capacity_reached")
        ) {
          throw new AgentCreateBlockedError(placement);
        }
      } else {
        await dependencies.readyCreateTestHooks?.beforeCapacityLock?.({
          userId,
          runnerId: placement.runner.id,
        });
        const locked = await lockRunnerPlacementCapacityInTransaction(tx, {
          userId,
          runnerId: placement.runner.id,
        });
        if (locked) {
          await dependencies.readyCreateTestHooks?.afterCapacityLock?.({
            userId,
            runnerId: placement.runner.id,
          });
          const confirmed = await selectRunnerPlacementForUserInTransaction(
            tx,
            userId,
            {
              planMaxAgents: dependencies.planMaxAgents,
              runnerId: placement.runner.id,
            },
            runnerPlacementOptions(dependencies, now),
          );
          if (confirmed.ok) {
            runnerId = confirmed.runner.id;
          } else if (input.runnerId) {
            if (confirmed.reason === "runner_capacity_reached") {
              throw new AgentCreateBlockedError(confirmed);
            }
            throw new AgentRunnerAssignmentError();
          }
        } else if (input.runnerId) {
          throw new AgentRunnerAssignmentError();
        }
      }

      await assertNoUnbackfilledActiveTelegramSecretsInTransaction(tx);

      const [agent] = await tx
        .insert(agents)
        .values({
          id: agentId,
          userId,
          runnerId,
          name: input.name,
          templateKey: input.templateKey,
          templateVersion: templateSnapshot.version,
          templateSnapshotJson: templateSnapshot,
          status: "stopped",
          desiredStatus: "running",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!agent) {
        throw new Error("Agent insert returned no rows.");
      }

      const createdAgent = agent as CreatedAgentRow;

      await dependencies.readyCreateTestHooks?.beforeInsertBoundary?.("config");
      await tx.insert(agentConfigs).values({
        agentId,
        systemPrompt: templateSnapshot.defaultSystemPrompt,
        modelProvider: firstWriteValidation.profile.hermesProvider,
        modelName: firstWriteValidation.profile.model,
        maxDailySpendCents: DEFAULT_AGENT_CONFIG_BASE.maxDailySpendCents,
        scheduleMode: DEFAULT_AGENT_CONFIG_BASE.scheduleMode,
        scheduleCron: DEFAULT_AGENT_CONFIG_BASE.scheduleCron,
        timezone: DEFAULT_AGENT_CONFIG_BASE.timezone,
        createdAt: now,
        updatedAt: now,
      });

      const beforeInsertBoundary = dependencies.readyCreateTestHooks?.beforeInsertBoundary;
      if (preparedSecrets.length > 0 && !beforeInsertBoundary) {
        await insertPreparedAgentSecretRowsInTransaction(tx, preparedSecrets);
      } else if (beforeInsertBoundary) {
        await preparedSecrets.reduce(
          (previous, preparedSecret) =>
            previous.then(async () => {
              await beforeInsertBoundary(
                `secret:${preparedSecret.kind}` as ReadyCreateInsertBoundary,
              );
              await insertPreparedAgentSecretRowsInTransaction(tx, [preparedSecret]);
            }),
          Promise.resolve(),
        );
      }

      await dependencies.readyCreateTestHooks?.beforeInsertBoundary?.("deployment");
      const deployment = await createAgentDeploymentForUser({
        db: tx,
        userId,
        agentId,
        configRevision,
        idempotencyKey: input.idempotencyKey,
        ...(dependencies.readyDeploymentIdentity
          ? {
              origin: dependencies.readyDeploymentIdentity.origin,
              deploymentEnvironment: dependencies.readyDeploymentIdentity.environment,
            }
          : {}),
        deploymentChoices: captureAgentDeploymentChoicesFromEnvironment(
          dependencies.env ?? process.env,
          rolloutConfigurationGeneration,
        ),
        rolloutConfigurationGeneration,
        now,
      });

      if (!deployment.ok || !deployment.inserted || deployment.deployment.agentId !== agentId) {
        throw new Error("Ready deployment insert failed.");
      }

      insertedDeploymentId = deployment.deployment.id;

      await dependencies.readyCreateTestHooks?.beforeInsertBoundary?.("event");
      await recordAgentEventInTransaction(tx, {
        agentId,
        actorUserId: userId,
        type: "agent.created",
        message: `Created agent "${input.name}".`,
        metadata: {
          templateKey: input.templateKey,
          templateVersion: templateSnapshot.version,
          status: "stopped",
          desiredStatus: "running",
          launchMode: "ready",
          assistant: firstWriteValidation.profile.assistant,
          runnerAssignment: runnerId ? "assigned" : "none",
          deploymentId: deployment.deployment.id,
        },
        createdAt: now,
      });

      return toReadyCreatedAgentResponse({
        agent: createdAgent,
        deployment: deployment.deployment,
        profile: firstWriteValidation.profile,
        telegramBot: telegramValidation.bot,
      });
    });

    if (insertedDeploymentId) {
      try {
        dependencies.onReadyDeploymentCommitted?.(insertedDeploymentId);
      } catch {
        // The committed deployment remains due for protected cron reconciliation.
      }
    }

    return response;
  } catch (error) {
    if (
      error instanceof AgentCreateBlockedError ||
      error instanceof AgentRunnerAssignmentError ||
      error instanceof AgentSecretKeyringError ||
      error instanceof AgentSecretLegacyBackfillRequiredError
    ) {
      throw error;
    }

    if (
      error instanceof AgentSecretTelegramConflictError ||
      isTelegramSecretUniquenessConstraint(error)
    ) {
      throw new TelegramBotInUseError(error);
    }

    throw error;
  }
}

function requireReadyRunnerProvisioningConfig(env: Record<string, string | undefined>): void {
  try {
    if (readDigitalOceanProviderConfig(env)) {
      return;
    }
  } catch (error) {
    throw new AgentRunnerProvisioningError("provider_not_configured", error);
  }

  throw new AgentRunnerProvisioningError("provider_not_configured");
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
    logger: AppLogger;
  },
): Promise<CreatedAgentResponse> {
  const { dependencies } = input;

  const ensureCloudRunnerProvisioning =
    dependencies.ensureCloudRunnerProvisioning ??
    (() => ensureDefaultCloudRunnerProvisioning(input.userId));
  logAgentCreate(input.logger, "cloud_runner_provisioning_start", {});
  const provisionedRunnerId = await ensureProvisionedRunnerId(
    ensureCloudRunnerProvisioning,
    input.logger,
  );
  logAgentCreate(input.logger, "cloud_runner_provisioning_runner_selected", {
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
    error instanceof ReadyAgentCreationDisabledError ||
    error instanceof ReadyAgentValidationError ||
    error instanceof TelegramValidationUnavailableError ||
    error instanceof TelegramBotInUseError ||
    error instanceof AgentSecretKeyringError ||
    error instanceof AgentSecretLegacyBackfillRequiredError ||
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
  logger: AppLogger,
): Promise<string> {
  let result: CreateRunnerProvisioningResult;

  try {
    result = await ensureCloudRunnerProvisioning();
  } catch (error) {
    logAgentCreateError(logger, "cloud_runner_provisioning_threw", error, {});
    throw new AgentRunnerProvisioningError("provisioning_failed", error);
  }

  if (!result.ok) {
    if (result.reason === "provider_not_configured") {
      logAgentCreate(logger, "cloud_runner_provider_not_configured", {}, "error");
      throw new AgentRunnerProvisioningError("provider_not_configured");
    }

    logAgentCreate(
      logger,
      "cloud_runner_provisioning_failed_result",
      { reason: result.reason },
      "error",
    );
    throw new AgentRunnerProvisioningError("provisioning_failed", result);
  }

  if (
    result.runner.provisioning.status === "failed" ||
    result.runner.provisioning.status === "deleted"
  ) {
    logAgentCreate(
      logger,
      "cloud_runner_unusable",
      {
        runnerId: result.runner.id,
        provisioningStatus: result.runner.provisioning.status,
      },
      "error",
    );
    throw new AgentRunnerProvisioningError("provisioning_failed", result);
  }

  logAgentCreate(logger, "cloud_runner_provisioning_result", {
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
    name: "Bruno Cloud Runner",
  });
}

function isReadyCreateInput(input: CreateAgentInput): input is ReadyCreateAgentInput {
  return "launchMode" in input && input.launchMode === "ready";
}

function normalizeReadyIdempotencyKey(value: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof value !== "string") {
    return { ok: false };
  }

  const normalizedValue = value.trim();

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalizedValue)) {
    return { ok: false };
  }

  return { ok: true, value: normalizedValue };
}

function validateReadyFirstWriteInput(input: ReadyCreateAgentInput):
  | {
      ok: true;
      profile: AssistantProfile;
      modelApiKey: string | null;
      telegramBotToken: string;
      telegramAllowedUsers: string;
    }
  | {
      ok: false;
      issues: CreateAgentValidationIssue[];
    } {
  const issues: CreateAgentValidationIssue[] = [];

  const profile = isAssistantChoice(input.assistant) ? getAssistantProfile(input.assistant) : null;

  if (!profile) {
    issues.push({ field: "assistant", message: "Choose ChatGPT or Claude." });
  }

  const modelApiKey =
    input.modelApiKey === undefined || input.modelApiKey === null || input.modelApiKey === ""
      ? ({ ok: true, value: null } as const)
      : profile
        ? validateAssistantApiKey(profile, input.modelApiKey)
        : ({ ok: false } as const);

  if (!modelApiKey.ok) {
    issues.push({ field: "modelApiKey", message: "The assistant API key format is invalid." });
  }

  const telegramBotToken = normalizeTelegramBotToken(input.telegramBotToken);

  if (!telegramBotToken.ok) {
    issues.push({ field: "telegramBotToken", message: "Telegram bot token format is invalid." });
  }

  const allowedUsers = normalizeReadyTelegramAllowedUserIds(input.telegramAllowedUserIds);

  if (!allowedUsers.ok) {
    issues.push({
      field: "telegramAllowedUserIds",
      message: "Telegram allowed user IDs must be canonical decimal strings.",
    });
  }

  if (
    issues.length > 0 ||
    !profile ||
    !modelApiKey.ok ||
    !telegramBotToken.ok ||
    !allowedUsers.ok
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    profile,
    modelApiKey: modelApiKey.value,
    telegramBotToken: telegramBotToken.value,
    telegramAllowedUsers: allowedUsers.value,
  };
}

function normalizeTelegramBotToken(value: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof value !== "string") {
    return { ok: false };
  }

  const normalizedValue = value.trim();

  if (
    Buffer.byteLength(normalizedValue, "utf8") > 256 ||
    !/^[1-9][0-9]{5,19}:[A-Za-z0-9_-]{20,}$/.test(normalizedValue) ||
    hasControlCharacter(normalizedValue)
  ) {
    return { ok: false };
  }

  return { ok: true, value: normalizedValue };
}

function normalizeReadyTelegramAllowedUserIds(
  value: unknown,
): { ok: true; value: string } | { ok: false } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    return { ok: false };
  }

  const values: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of value) {
    if (typeof rawValue !== "string" || !/^[1-9][0-9]{0,19}$/.test(rawValue)) {
      return { ok: false };
    }

    if (!seen.has(rawValue)) {
      values.push(rawValue);
      seen.add(rawValue);
    }
  }

  const serialized = values.join(",");

  if (Buffer.byteLength(serialized, "utf8") > 2_100) {
    return { ok: false };
  }

  return { ok: true, value: serialized };
}

async function takeReadyCreateIdempotencyLock(
  tx: AgentTransaction,
  input: { userId: string; idempotencyKey: string },
): Promise<void> {
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${`bruno:ready-create:${input.userId}:${input.idempotencyKey}`}, 0))
  `);
}

async function selectReadyCreateReplay(
  db: PostgresJsDatabase<typeof schema> | AgentTransaction,
  input: { userId: string; idempotencyKey: string },
): Promise<ReadyCreatedAgentResponse | null> {
  const deployment = await getAgentDeploymentByIdempotencyKeyForUser({
    db,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
  });

  if (!deployment) {
    return null;
  }

  const [row] = await db
    .select({
      agent: agents,
      config: agentConfigs,
      telegramBotId: agentSecrets.providerSubjectId,
      telegramUsername: agentSecrets.providerUsername,
    })
    .from(agents)
    .innerJoin(agentConfigs, eq(agentConfigs.agentId, agents.id))
    .leftJoin(
      agentSecrets,
      and(
        eq(agentSecrets.agentId, agents.id),
        eq(agentSecrets.kind, "telegram_bot_token"),
        eq(agentSecrets.status, "active"),
      ),
    )
    .where(
      and(
        eq(agents.id, deployment.agentId),
        eq(agents.userId, input.userId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const profile = getAssistantProfileForManagedModel(
    row.config.modelProvider,
    row.config.modelName,
  );

  if (!profile || !row.telegramBotId) {
    throw new AgentPersistenceError();
  }

  return toReadyCreatedAgentResponse({
    agent: row.agent as CreatedAgentRow,
    deployment,
    profile,
    telegramBot: {
      botId: row.telegramBotId,
      username: row.telegramUsername,
    },
  });
}

function toReadyCreatedAgentResponse(input: {
  agent: CreatedAgentRow;
  deployment: AgentDeploymentDto;
  profile: AssistantProfile;
  telegramBot: TelegramBotMetadata;
}): ReadyCreatedAgentResponse {
  const stoppedResponse = toCreatedAgentResponse(input.agent);

  return {
    agent: {
      ...stoppedResponse.agent,
      desiredStatus: "running",
      assistant: {
        id: input.profile.assistant,
        displayName: input.profile.displayName,
      },
      telegramBot: {
        id: input.telegramBot.botId,
        username: input.telegramBot.username,
      },
    },
    deployment: input.deployment,
  };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 32 || code === 127) {
      return true;
    }
  }

  return false;
}

function isTelegramSecretUniquenessConstraint(error: unknown): boolean {
  return hasPostgresConstraint(error, [
    "agent_secrets_active_telegram_uniqueness_idx",
    "agent_secrets_active_telegram_subject_idx",
  ]);
}

function logAgentCreate(
  logger: AppLogger,
  event: string,
  metadata: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  if (level === "error") {
    logger.errorEvent(event, metadata);
    return;
  }

  logger[level](event, metadata);
}

function logAgentCreateError(
  logger: AppLogger,
  event: string,
  error: unknown,
  metadata: Record<string, unknown>,
): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  logger.error(event, error, metadata);
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
