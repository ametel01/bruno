import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import {
  parseAgentRuntimeErrorCode,
  parseAgentRuntimeState,
  runtimePublicPresentation,
  type RuntimePolicyState,
} from "@/src/server/agents/agent-runtime-state";
import { validateDeploymentConfigRevision } from "@/src/server/agents/deployment-state";
import type { DatabaseConnection } from "@/src/server/db/client";
import { agentDeployments, agentRuntimeReconciliations, agents } from "@/src/server/db/schema";
import type { PublicAgentDeploymentStage } from "@/src/shared/agent-deployment-presentation";
import type { PublicAgentRuntimePresentation } from "@/src/shared/agent-runtime-presentation";

export type RuntimePresentationRow = {
  state: unknown;
  configRevision: unknown;
  operationId: unknown;
  generation: unknown;
  attemptCount: unknown;
  recoveryCount: unknown;
  recoveryWindowStartedAt: Date | string | null;
  stableSince: Date | string | null;
  telegramNonConnectedSince: Date | string | null;
  lastRestartCount: unknown;
  lastObservedAt: Date | string | null;
  lastReadyAt: Date | string | null;
  errorCode: unknown;
  circuitOpenedAt: Date | string | null;
};

export type AgentRuntimeReadResult =
  | { ok: true; runtime: PublicAgentRuntimePresentation | null }
  | { ok: false; reason: "agent_not_found" };

export class AgentRuntimeReadPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Agent runtime status failed.");
    this.name = "AgentRuntimeReadPersistenceError";
    this.cause = cause;
  }
}

const RUNTIME_UNAVAILABLE: PublicAgentRuntimePresentation = {
  kind: "unavailable",
  action: "wait",
  label: "Unavailable",
  message: "Runtime state could not be verified safely.",
};

export async function getAgentRuntimePresentationForUser(input: {
  db: DatabaseConnection["db"];
  userId: string;
  agentId: string;
}): Promise<AgentRuntimeReadResult> {
  try {
    const [agent] = await input.db
      .select({ desiredStatus: agents.desiredStatus })
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.userId, input.userId),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);

    if (!agent) {
      return { ok: false, reason: "agent_not_found" };
    }

    const [deployment] = await input.db
      .select({ stage: agentDeployments.stage })
      .from(agentDeployments)
      .where(
        and(eq(agentDeployments.agentId, input.agentId), eq(agentDeployments.userId, input.userId)),
      )
      .orderBy(desc(agentDeployments.createdAt), desc(agentDeployments.id))
      .limit(1);

    if (deployment?.stage !== "ready") {
      return { ok: true, runtime: null };
    }

    const [runtime] = await input.db
      .select(runtimePresentationSelection)
      .from(agentRuntimeReconciliations)
      .where(
        and(
          eq(agentRuntimeReconciliations.agentId, input.agentId),
          eq(agentRuntimeReconciliations.userId, input.userId),
        ),
      )
      .limit(1);

    return {
      ok: true,
      runtime: buildSafeRuntimePresentation({
        desiredStatus: agent.desiredStatus,
        latestDeploymentStage: deployment.stage,
        runtime: runtime ?? null,
      }),
    };
  } catch (error) {
    throw new AgentRuntimeReadPersistenceError(error);
  }
}

export function buildSafeRuntimePresentation(input: {
  desiredStatus: "running" | "stopped";
  latestDeploymentStage: PublicAgentDeploymentStage | null;
  runtime: RuntimePresentationRow | null;
}): PublicAgentRuntimePresentation | null {
  if (input.latestDeploymentStage !== "ready") {
    return null;
  }

  const policy = toPolicy(input.runtime);

  if (policy === null) {
    return RUNTIME_UNAVAILABLE;
  }

  if (
    (input.desiredStatus === "running" &&
      (policy.state === "stopped" ||
        (policy.state === "stopping" && policy.circuitOpenedAtMs === null))) ||
    (input.desiredStatus === "stopped" && policy.state !== "stopped" && policy.state !== "stopping")
  ) {
    return RUNTIME_UNAVAILABLE;
  }

  const presentation = runtimePublicPresentation({
    policy,
    desiredStatus: input.desiredStatus,
  });

  return {
    kind: presentation.state,
    action: presentation.action,
    label: presentation.label,
    message: presentation.message,
  };
}

export const runtimePresentationSelection = {
  state: agentRuntimeReconciliations.state,
  configRevision: agentRuntimeReconciliations.configRevision,
  operationId: agentRuntimeReconciliations.operationId,
  generation: agentRuntimeReconciliations.generation,
  attemptCount: agentRuntimeReconciliations.attemptCount,
  recoveryCount: agentRuntimeReconciliations.recoveryCount,
  recoveryWindowStartedAt: agentRuntimeReconciliations.recoveryWindowStartedAt,
  stableSince: agentRuntimeReconciliations.stableSince,
  telegramNonConnectedSince: agentRuntimeReconciliations.telegramNonConnectedSince,
  lastRestartCount: agentRuntimeReconciliations.lastRestartCount,
  lastObservedAt: agentRuntimeReconciliations.lastObservedAt,
  lastReadyAt: agentRuntimeReconciliations.lastReadyAt,
  errorCode: agentRuntimeReconciliations.errorCode,
  circuitOpenedAt: agentRuntimeReconciliations.circuitOpenedAt,
};

function toPolicy(row: RuntimePresentationRow | null): RuntimePolicyState | null {
  if (!row) {
    return null;
  }

  const state = parseAgentRuntimeState(row.state);
  const configRevision =
    typeof row.configRevision === "string" && validateDeploymentConfigRevision(row.configRevision)
      ? row.configRevision
      : null;
  const generation = parseCounter(row.generation);
  const attemptCount = parseCounter(row.attemptCount);
  const recoveryCount = parseCounter(row.recoveryCount);
  const lastRestartCount =
    row.lastRestartCount === null ? null : parseCounter(row.lastRestartCount);
  const errorCode = row.errorCode === null ? null : parseAgentRuntimeErrorCode(row.errorCode);
  const operationId =
    typeof row.operationId === "string" && isUuid(row.operationId) ? row.operationId : null;
  const lastObservedAtMs = toTimestamp(row.lastObservedAt);
  const lastReadyAtMs = toTimestamp(row.lastReadyAt);

  if (
    state === null ||
    configRevision === null ||
    generation === null ||
    attemptCount === null ||
    recoveryCount === null ||
    (row.lastRestartCount !== null && lastRestartCount === null) ||
    (row.errorCode !== null && errorCode === null) ||
    ((state === "observing" || state === "verifying") && operationId === null) ||
    (state === "observing" &&
      (lastObservedAtMs === null || lastReadyAtMs === null || lastReadyAtMs > lastObservedAtMs)) ||
    (state === "circuit_open" && (errorCode === null || row.circuitOpenedAt === null)) ||
    (state === "stopped" && (errorCode !== null || row.circuitOpenedAt !== null)) ||
    hasMalformedTimestamp(row.recoveryWindowStartedAt) ||
    hasMalformedTimestamp(row.stableSince) ||
    hasMalformedTimestamp(row.telegramNonConnectedSince) ||
    hasMalformedTimestamp(row.lastObservedAt) ||
    hasMalformedTimestamp(row.lastReadyAt) ||
    hasMalformedTimestamp(row.circuitOpenedAt)
  ) {
    return null;
  }

  return {
    state,
    generation,
    attemptCount,
    recoveryCount,
    recoveryWindowStartedAtMs: toTimestamp(row.recoveryWindowStartedAt),
    stableSinceMs: toTimestamp(row.stableSince),
    telegramNonConnectedSinceMs: toTimestamp(row.telegramNonConnectedSince),
    lastRestartCount,
    errorCode,
    circuitOpenedAtMs: toTimestamp(row.circuitOpenedAt),
  };
}

function parseCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function toTimestamp(value: Date | string | null): number | null {
  if (value === null) {
    return null;
  }

  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasMalformedTimestamp(value: Date | string | null): boolean {
  return value !== null && toTimestamp(value) === null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
