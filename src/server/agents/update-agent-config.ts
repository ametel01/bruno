import { and, eq, exists, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import { AGENT_NAME_MAX_LENGTH } from "@/src/server/agents/create-agent";
import { reviseManagedRuntimeConfiguration } from "@/src/server/agents/agent-runtime-lifecycle";
import { scheduleAgentRuntimeReconcileAfterResponse } from "@/src/server/agents/agent-runtime-triggers";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { agentConfigs, agents } from "@/src/server/db/schema";
import { recordAgentEventInTransaction } from "@/src/server/events/agent-events";

export const CONFIG_UPDATED_EVENT_TYPE = "config.updated";
export const MAX_DAILY_SPEND_DOLLARS = 1_000;
const MAX_DAILY_SPEND_CENTS = MAX_DAILY_SPEND_DOLLARS * 100;
const CONFIG_CHANGED_MESSAGE = "Configuration updated.";
const DISPLAY_VALUE_MAX_LENGTH = 80;
const SECRET_KEY_PATTERN =
  /(api[_\s-]*key|apikey|access[_\s-]*token|refresh[_\s-]*token|token|password|secret|credential|private[_\s-]*key|privatekey|bearer|authorization)/i;
const CRON_FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

const EDITABLE_FIELDS = [
  "name",
  "systemPrompt",
  "modelProvider",
  "modelName",
  "maxDailySpend",
  "scheduleMode",
  "scheduleCron",
  "timezone",
] as const;

const CONFIG_FIELDS = [
  "systemPrompt",
  "modelProvider",
  "modelName",
  "maxDailySpendCents",
  "scheduleMode",
  "scheduleCron",
  "timezone",
] as const;

export type UpdateAgentConfigField =
  | "name"
  | "systemPrompt"
  | "modelProvider"
  | "modelName"
  | "maxDailySpend"
  | "scheduleMode"
  | "scheduleCron"
  | "timezone";

export type ConfigChangedField = {
  field: UpdateAgentConfigField;
  before: string;
  after: string;
};

export type UpdateAgentConfigValidationIssue = {
  field: UpdateAgentConfigField | "agentId" | "body";
  message: string;
};

export type UpdateAgentConfigInput = Partial<{
  name: string;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  maxDailySpendCents: number;
  scheduleMode: "manual" | "cron";
  scheduleCron: string | null;
  timezone: string;
}>;

export type UpdateAgentConfigValidationResult =
  | {
      ok: true;
      value: UpdateAgentConfigInput;
    }
  | {
      ok: false;
      issues: UpdateAgentConfigValidationIssue[];
    };

export type UpdatedAgentConfigDto = {
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  maxDailySpendCents: number;
  scheduleMode: "manual" | "cron";
  scheduleCron: string | null;
  timezone: string;
  updatedAt: string;
};

export type UpdatedAgentDto = {
  id: string;
  userId: string;
  name: string;
  templateKey: string;
  status: string;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
};

export type UpdateAgentConfigSuccess = {
  ok: true;
  noOp: boolean;
  agent: UpdatedAgentDto;
  config: UpdatedAgentConfigDto;
  changedFields: ConfigChangedField[];
  event: {
    type: typeof CONFIG_UPDATED_EVENT_TYPE;
  } | null;
};

export type UpdateAgentConfigResult =
  | UpdateAgentConfigSuccess
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id" | "agent_not_found";
    }
  | {
      ok: false;
      reason: "validation_failed";
      issues: UpdateAgentConfigValidationIssue[];
    };

type AgentTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type ActiveAgentRow = typeof agents.$inferSelect & {
  deletedAt: null;
};
type AgentConfigRow = typeof agentConfigs.$inferSelect & {
  scheduleMode: "manual" | "cron";
};
type RecordConfigUpdatedEvent = (
  tx: AgentTransaction,
  input: {
    agent: ActiveAgentRow;
    changedFields: ConfigChangedField[];
  },
) => Promise<void>;

export type UpdateAgentConfigDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  recordConfigUpdatedEvent?: RecordConfigUpdatedEvent;
  scheduleRuntimeReconcile?: typeof scheduleAgentRuntimeReconcileAfterResponse;
};

export class AgentConfigUpdatePersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Agent config update failed.");
    this.name = "AgentConfigUpdatePersistenceError";
    this.cause = cause;
  }
}

export function validateUpdateAgentConfigPayload(
  payload: unknown,
): UpdateAgentConfigValidationResult {
  if (!isPlainObject(payload)) {
    return {
      ok: false,
      issues: [{ field: "body", message: "Request body must be a JSON object." }],
    };
  }

  const secretKey = findSecretLikeKey(payload);

  if (secretKey) {
    return {
      ok: false,
      issues: [
        {
          field: "body",
          message: `Secret-like payload key "${secretKey}" is not allowed in agent config updates.`,
        },
      ],
    };
  }

  const issues: UpdateAgentConfigValidationIssue[] = [];
  const value: UpdateAgentConfigInput = {};
  const editableFieldSet = new Set<string>(EDITABLE_FIELDS);

  for (const field of Object.keys(payload)) {
    if (!editableFieldSet.has(field)) {
      issues.push({ field: "body", message: `Field "${field}" is not editable.` });
    }
  }

  assignTrimmedString(payload, value, issues, "name", {
    requiredMessage: "Name is required.",
    maxLength: AGENT_NAME_MAX_LENGTH,
  });
  assignTrimmedString(payload, value, issues, "systemPrompt", {
    requiredMessage: "System prompt is required.",
  });
  assignTrimmedString(payload, value, issues, "modelProvider", {
    requiredMessage: "Model provider is required.",
  });
  assignTrimmedString(payload, value, issues, "modelName", {
    requiredMessage: "Model name is required.",
  });
  assignTrimmedString(payload, value, issues, "timezone", {
    requiredMessage: "Timezone is required.",
    validate: isValidTimezone,
    invalidMessage: "Timezone must be a valid IANA timezone.",
  });

  if ("maxDailySpend" in payload) {
    const spend = normalizeMaxDailySpendCents(payload.maxDailySpend);

    if (spend.ok) {
      value.maxDailySpendCents = spend.value;
    } else {
      issues.push({ field: "maxDailySpend", message: spend.message });
    }
  }

  if ("scheduleMode" in payload) {
    if (payload.scheduleMode === "manual" || payload.scheduleMode === "cron") {
      value.scheduleMode = payload.scheduleMode;
    } else {
      issues.push({ field: "scheduleMode", message: "Schedule mode must be manual or cron." });
    }
  }

  if ("scheduleCron" in payload) {
    if (payload.scheduleCron === null) {
      value.scheduleCron = null;
    } else if (typeof payload.scheduleCron === "string") {
      const scheduleCron = payload.scheduleCron.trim();

      if (scheduleCron.length === 0) {
        issues.push({ field: "scheduleCron", message: "Schedule cron is required for cron mode." });
      } else if (!isValidCronExpression(scheduleCron)) {
        issues.push({
          field: "scheduleCron",
          message: "Schedule cron must be a valid 5-field cron expression.",
        });
      } else {
        value.scheduleCron = scheduleCron;
      }
    } else {
      issues.push({ field: "scheduleCron", message: "Schedule cron must be a string or null." });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value };
}

export async function updateAgentConfigForDevelopmentUser(
  agentId: string,
  input: UpdateAgentConfigInput,
  dependencies: UpdateAgentConfigDependencies = {},
): Promise<UpdateAgentConfigResult> {
  const normalizedAgentId = agentId.trim();

  if (normalizedAgentId.length === 0 || !isValidAgentId(normalizedAgentId)) {
    return updateAgentConfigForUser("", agentId, input, dependencies);
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const [agent] = await connection.db
      .select({ userId: agents.userId })
      .from(agents)
      .where(and(eq(agents.id, normalizedAgentId), isNull(agents.deletedAt)))
      .limit(1);

    if (!agent) {
      return { ok: false, reason: "agent_not_found" };
    }

    return await updateAgentConfigForUser(agent.userId, normalizedAgentId, input, {
      ...dependencies,
      createConnection: () => connection,
    });
  } catch (error) {
    if (error instanceof AgentConfigUpdatePersistenceError) {
      throw error;
    }

    throw new AgentConfigUpdatePersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function updateAgentConfigForUser(
  userId: string,
  agentId: string,
  input: UpdateAgentConfigInput,
  dependencies: UpdateAgentConfigDependencies = {},
): Promise<UpdateAgentConfigResult> {
  const normalizedAgentId = agentId.trim();

  if (normalizedAgentId.length === 0) {
    return { ok: false, reason: "missing_agent_id" };
  }

  if (!isValidAgentId(normalizedAgentId)) {
    return { ok: false, reason: "malformed_agent_id" };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const recordConfigUpdatedEvent =
    dependencies.recordConfigUpdatedEvent ?? recordDefaultConfigUpdatedEvent;
  let scheduleRuntimeReconcile = false;

  try {
    const result: UpdateAgentConfigResult = await connection.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          agent: agents,
          config: agentConfigs,
        })
        .from(agents)
        .innerJoin(agentConfigs, eq(agentConfigs.agentId, agents.id))
        .where(
          and(
            eq(agents.id, normalizedAgentId),
            eq(agents.userId, userId),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);

      if (!row) {
        return { ok: false, reason: "agent_not_found" };
      }

      const currentAgent = row.agent as ActiveAgentRow;
      const currentConfig = row.config as AgentConfigRow;
      const scheduleValidation = validateEffectiveSchedule(currentConfig, input);

      if (!scheduleValidation.ok) {
        return { ok: false, reason: "validation_failed", issues: scheduleValidation.issues };
      }

      const nextAgent = {
        ...currentAgent,
        name: input.name ?? currentAgent.name,
      };
      const nextConfig: AgentConfigRow = {
        ...currentConfig,
        systemPrompt: input.systemPrompt ?? currentConfig.systemPrompt,
        modelProvider: input.modelProvider ?? currentConfig.modelProvider,
        modelName: input.modelName ?? currentConfig.modelName,
        maxDailySpendCents: input.maxDailySpendCents ?? currentConfig.maxDailySpendCents,
        scheduleMode: scheduleValidation.scheduleMode,
        scheduleCron: scheduleValidation.scheduleCron,
        timezone: input.timezone ?? currentConfig.timezone,
      };
      const changedFields = buildChangedFields({
        currentAgent,
        currentConfig,
        nextAgent,
        nextConfig,
      });

      if (changedFields.length === 0) {
        return toUpdateAgentConfigSuccess({
          agent: currentAgent,
          config: currentConfig,
          changedFields,
          event: null,
        });
      }

      let persistedAgent = currentAgent;
      let persistedConfig = currentConfig;

      if (currentAgent.name !== nextAgent.name) {
        const [updatedAgent] = await tx
          .update(agents)
          .set({
            name: nextAgent.name,
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, normalizedAgentId),
              eq(agents.userId, userId),
              isNull(agents.deletedAt),
            ),
          )
          .returning();

        if (!updatedAgent) {
          throw new Error("Agent config update returned no agent row.");
        }

        persistedAgent = updatedAgent as ActiveAgentRow;
      }

      if (configChanged(currentConfig, nextConfig)) {
        const [updatedConfig] = await tx
          .update(agentConfigs)
          .set({
            systemPrompt: nextConfig.systemPrompt,
            modelProvider: nextConfig.modelProvider,
            modelName: nextConfig.modelName,
            maxDailySpendCents: nextConfig.maxDailySpendCents,
            scheduleMode: nextConfig.scheduleMode,
            scheduleCron: nextConfig.scheduleCron,
            timezone: nextConfig.timezone,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentConfigs.agentId, normalizedAgentId),
              exists(
                tx
                  .select({ id: agents.id })
                  .from(agents)
                  .where(
                    and(
                      eq(agents.id, agentConfigs.agentId),
                      eq(agents.userId, userId),
                      isNull(agents.deletedAt),
                    ),
                  ),
              ),
            ),
          )
          .returning();

        if (!updatedConfig) {
          throw new Error("Agent config update returned no config row.");
        }

        persistedConfig = updatedConfig as AgentConfigRow;
      }

      await recordConfigUpdatedEvent(tx, {
        agent: persistedAgent,
        changedFields,
      });

      if (changedFields.some((change) => change.field !== "maxDailySpend")) {
        const runtime = await reviseManagedRuntimeConfiguration(tx, {
          agentId: normalizedAgentId,
          userId,
          now,
        });
        scheduleRuntimeReconcile = runtime.schedule;
      }

      return toUpdateAgentConfigSuccess({
        agent: persistedAgent,
        config: persistedConfig,
        changedFields,
        event: {
          type: CONFIG_UPDATED_EVENT_TYPE,
        },
      });
    });

    if (scheduleRuntimeReconcile) {
      (dependencies.scheduleRuntimeReconcile ?? scheduleAgentRuntimeReconcileAfterResponse)(
        normalizedAgentId,
      );
    }

    return result;
  } catch (error) {
    throw new AgentConfigUpdatePersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function assignTrimmedString(
  payload: Record<string, unknown>,
  value: UpdateAgentConfigInput,
  issues: UpdateAgentConfigValidationIssue[],
  field: "name" | "systemPrompt" | "modelProvider" | "modelName" | "timezone",
  options: {
    requiredMessage: string;
    maxLength?: number;
    validate?: (value: string) => boolean;
    invalidMessage?: string;
  },
): void {
  if (!(field in payload)) {
    return;
  }

  const rawValue = payload[field];

  if (typeof rawValue !== "string") {
    issues.push({ field, message: options.requiredMessage });
    return;
  }

  const normalizedValue = rawValue.trim();

  if (normalizedValue.length === 0) {
    issues.push({ field, message: options.requiredMessage });
    return;
  }

  if (options.maxLength !== undefined && normalizedValue.length > options.maxLength) {
    issues.push({
      field,
      message: `${humanizeFieldName(field)} must be ${options.maxLength} characters or fewer.`,
    });
    return;
  }

  if (options.validate && !options.validate(normalizedValue)) {
    issues.push({
      field,
      message: options.invalidMessage ?? `${humanizeFieldName(field)} is invalid.`,
    });
    return;
  }

  value[field] = normalizedValue;
}

function normalizeMaxDailySpendCents(value: unknown):
  | {
      ok: true;
      value: number;
    }
  | {
      ok: false;
      message: string;
    } {
  if (typeof value !== "number" && typeof value !== "string") {
    return { ok: false, message: "Max daily spend must be a dollar amount." };
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return { ok: false, message: "Max daily spend must be finite." };
  }

  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);

  if (!match) {
    return {
      ok: false,
      message: "Max daily spend must be a positive dollar amount with whole cents.",
    };
  }

  const dollars = Number(match[1]);
  const centsText = (match[2] ?? "").padEnd(2, "0");
  const cents = dollars * 100 + Number(centsText);

  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return { ok: false, message: "Max daily spend must be greater than zero." };
  }

  if (cents > MAX_DAILY_SPEND_CENTS) {
    return {
      ok: false,
      message: `Max daily spend must be ${formatMoney(MAX_DAILY_SPEND_CENTS)} or less.`,
    };
  }

  return { ok: true, value: cents };
}

function validateEffectiveSchedule(
  currentConfig: AgentConfigRow,
  input: UpdateAgentConfigInput,
):
  | {
      ok: true;
      scheduleMode: "manual" | "cron";
      scheduleCron: string | null;
    }
  | {
      ok: false;
      issues: UpdateAgentConfigValidationIssue[];
    } {
  const scheduleMode = input.scheduleMode ?? currentConfig.scheduleMode;
  let scheduleCron =
    "scheduleCron" in input ? (input.scheduleCron ?? null) : currentConfig.scheduleCron;

  if (scheduleMode === "manual") {
    if ("scheduleMode" in input && input.scheduleMode === "manual" && !("scheduleCron" in input)) {
      scheduleCron = null;
    }

    if (scheduleCron !== null) {
      return {
        ok: false,
        issues: [
          {
            field: "scheduleCron",
            message: "Manual schedule mode cannot persist a cron expression.",
          },
        ],
      };
    }

    return { ok: true, scheduleMode, scheduleCron };
  }

  if (typeof scheduleCron !== "string" || scheduleCron.trim().length === 0) {
    return {
      ok: false,
      issues: [{ field: "scheduleCron", message: "Schedule cron is required for cron mode." }],
    };
  }

  if (!isValidCronExpression(scheduleCron)) {
    return {
      ok: false,
      issues: [
        {
          field: "scheduleCron",
          message: "Schedule cron must be a valid 5-field cron expression.",
        },
      ],
    };
  }

  return { ok: true, scheduleMode, scheduleCron: scheduleCron.trim() };
}

function buildChangedFields(input: {
  currentAgent: ActiveAgentRow;
  currentConfig: AgentConfigRow;
  nextAgent: ActiveAgentRow;
  nextConfig: AgentConfigRow;
}): ConfigChangedField[] {
  const changedFields: ConfigChangedField[] = [];

  if (input.currentAgent.name !== input.nextAgent.name) {
    changedFields.push({
      field: "name",
      before: displayValue("name", input.currentAgent.name),
      after: displayValue("name", input.nextAgent.name),
    });
  }

  for (const configField of CONFIG_FIELDS) {
    if (input.currentConfig[configField] === input.nextConfig[configField]) {
      continue;
    }

    changedFields.push({
      field: configField === "maxDailySpendCents" ? "maxDailySpend" : configField,
      before: displayValue(configField, input.currentConfig[configField]),
      after: displayValue(configField, input.nextConfig[configField]),
    });
  }

  return changedFields;
}

function configChanged(currentConfig: AgentConfigRow, nextConfig: AgentConfigRow): boolean {
  return CONFIG_FIELDS.some((field) => currentConfig[field] !== nextConfig[field]);
}

async function recordDefaultConfigUpdatedEvent(
  tx: AgentTransaction,
  input: {
    agent: ActiveAgentRow;
    changedFields: ConfigChangedField[];
  },
): Promise<void> {
  await recordAgentEventInTransaction(tx, {
    agentId: input.agent.id,
    actorUserId: input.agent.userId,
    type: CONFIG_UPDATED_EVENT_TYPE,
    message: `${CONFIG_CHANGED_MESSAGE} Agent "${input.agent.name}" changed ${input.changedFields.length} field${input.changedFields.length === 1 ? "" : "s"}.`,
    metadata: {
      changedFields: input.changedFields,
    },
  });
}

function toUpdateAgentConfigSuccess(input: {
  agent: ActiveAgentRow;
  config: AgentConfigRow;
  changedFields: ConfigChangedField[];
  event: {
    type: typeof CONFIG_UPDATED_EVENT_TYPE;
  } | null;
}): UpdateAgentConfigSuccess {
  return {
    ok: true,
    noOp: input.event === null,
    agent: {
      id: input.agent.id,
      userId: input.agent.userId,
      name: input.agent.name,
      templateKey: input.agent.templateKey,
      status: input.agent.status,
      statusReason: input.agent.statusReason,
      createdAt: input.agent.createdAt.toISOString(),
      updatedAt: input.agent.updatedAt.toISOString(),
      deletedAt: null,
    },
    config: {
      systemPrompt: input.config.systemPrompt,
      modelProvider: input.config.modelProvider,
      modelName: input.config.modelName,
      maxDailySpendCents: input.config.maxDailySpendCents,
      scheduleMode: input.config.scheduleMode,
      scheduleCron: input.config.scheduleCron,
      timezone: input.config.timezone,
      updatedAt: input.config.updatedAt.toISOString(),
    },
    changedFields: input.changedFields,
    event: input.event,
  };
}

function findSecretLikeKey(value: unknown, seen = new WeakSet<object>()): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedSecretKey = findSecretLikeKey(item, seen);

      if (nestedSecretKey) {
        return nestedSecretKey;
      }
    }

    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      return key;
    }

    const nestedSecretKey = findSecretLikeKey(nestedValue, seen);

    if (nestedSecretKey) {
      return nestedSecretKey;
    }
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isValidCronExpression(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);

  if (fields.length !== CRON_FIELD_RANGES.length) {
    return false;
  }

  return fields.every((field, index) => {
    const range = CRON_FIELD_RANGES[index];

    if (!range) {
      return false;
    }

    return isValidCronField(field, range[0], range[1]);
  });
}

function isValidCronField(field: string, min: number, max: number): boolean {
  return field.split(",").every((part) => isValidCronFieldPart(part, min, max));
}

function isValidCronFieldPart(part: string, min: number, max: number): boolean {
  const [rangePart, stepPart] = part.split("/");

  if (!rangePart || (stepPart !== undefined && !isPositiveInteger(stepPart))) {
    return false;
  }

  if (rangePart === "*") {
    return true;
  }

  if (rangePart.includes("-")) {
    const [start, end] = rangePart.split("-");

    if (!start || !end || !isIntegerInRange(start, min, max) || !isIntegerInRange(end, min, max)) {
      return false;
    }

    return Number(start) <= Number(end);
  }

  return isIntegerInRange(rangePart, min, max);
}

function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0;
}

function isIntegerInRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }

  const numberValue = Number(value);

  return numberValue >= min && numberValue <= max;
}

function displayValue(field: string, value: unknown): string {
  if (field === "maxDailySpendCents" && typeof value === "number") {
    return formatMoney(value);
  }

  if (field === "systemPrompt" && typeof value === "string") {
    return `${value.length} characters`;
  }

  if (value === null || value === undefined) {
    return "none";
  }

  return truncateDisplayValue(String(value));
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function truncateDisplayValue(value: string): string {
  if (value.length <= DISPLAY_VALUE_MAX_LENGTH) {
    return value;
  }

  return `${value.slice(0, DISPLAY_VALUE_MAX_LENGTH - 1)}...`;
}

function humanizeFieldName(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (firstCharacter) => firstCharacter.toUpperCase());
}
