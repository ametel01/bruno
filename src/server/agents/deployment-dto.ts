import "server-only";

import {
  type AgentDeploymentStage,
  isTerminalAgentDeploymentStage,
  normalizeDeploymentErrorDetail,
  parseAgentDeploymentStage,
  validateDeploymentConfigRevision,
  validateDeploymentErrorCode,
} from "@/src/server/agents/deployment-state";

export type AgentDeploymentRowForDto = {
  id: string;
  agentId: string;
  stage: string;
  configRevision: string;
  attemptCount: number;
  errorCode: string | null;
  errorDetail: string | null;
  nextAttemptAt: Date | string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  failedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type AgentDeploymentDto = {
  id: string;
  agentId: string;
  stage: AgentDeploymentStage;
  configRevision: string;
  attemptCount: number;
  error: {
    code: string;
    detail: string | null;
  } | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class AgentDeploymentDtoError extends Error {
  constructor() {
    super("Persisted deployment row could not be mapped safely.");
    this.name = "AgentDeploymentDtoError";
  }
}

export function mapAgentDeploymentRowToDto(row: AgentDeploymentRowForDto): AgentDeploymentDto {
  const parsedStage = parseAgentDeploymentStage(row.stage);

  if (
    !parsedStage.ok ||
    !Number.isInteger(row.attemptCount) ||
    row.attemptCount < 0 ||
    !validateDeploymentConfigRevision(row.configRevision)
  ) {
    throw new AgentDeploymentDtoError();
  }

  validatePersistedDeploymentInvariants(row, parsedStage.value);

  return {
    id: row.id,
    agentId: row.agentId,
    stage: parsedStage.value,
    configRevision: row.configRevision,
    attemptCount: row.attemptCount,
    error:
      row.errorCode === null
        ? null
        : {
            code: row.errorCode,
            detail: row.errorDetail,
          },
    nextAttemptAt: timestampToIso(row.nextAttemptAt),
    startedAt: timestampToIso(row.startedAt),
    completedAt: timestampToIso(row.completedAt),
    failedAt: timestampToIso(row.failedAt),
    createdAt: timestampToIso(row.createdAt) ?? unreachableTimestamp(),
    updatedAt: timestampToIso(row.updatedAt) ?? unreachableTimestamp(),
  };
}

function validatePersistedDeploymentInvariants(
  row: AgentDeploymentRowForDto,
  stage: AgentDeploymentStage,
): void {
  const hasCompletedAt = row.completedAt !== null;
  const hasFailedAt = row.failedAt !== null;

  if (stage === "ready") {
    if (!hasCompletedAt || hasFailedAt || row.errorCode !== null || row.errorDetail !== null) {
      throw new AgentDeploymentDtoError();
    }
  } else if (hasCompletedAt) {
    throw new AgentDeploymentDtoError();
  }

  if (stage === "failed") {
    if (!hasFailedAt || row.errorCode === null || !validateDeploymentErrorCode(row.errorCode)) {
      throw new AgentDeploymentDtoError();
    }
  } else if (hasFailedAt) {
    throw new AgentDeploymentDtoError();
  }

  if (row.errorCode !== null && !validateDeploymentErrorCode(row.errorCode)) {
    throw new AgentDeploymentDtoError();
  }

  if (row.errorDetail !== null) {
    const detail = normalizeDeploymentErrorDetail(row.errorDetail);

    if (!detail.ok || row.errorCode === null) {
      throw new AgentDeploymentDtoError();
    }
  }

  if (isTerminalAgentDeploymentStage(stage) && row.nextAttemptAt !== null) {
    throw new AgentDeploymentDtoError();
  }

  const startedAt = timestampToIso(row.startedAt);
  const completedAt = timestampToIso(row.completedAt);
  const failedAt = timestampToIso(row.failedAt);

  if (startedAt !== null && completedAt !== null && completedAt < startedAt) {
    throw new AgentDeploymentDtoError();
  }

  if (startedAt !== null && failedAt !== null && failedAt < startedAt) {
    throw new AgentDeploymentDtoError();
  }
}

function timestampToIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new AgentDeploymentDtoError();
  }

  return date.toISOString();
}

function unreachableTimestamp(): never {
  throw new AgentDeploymentDtoError();
}
