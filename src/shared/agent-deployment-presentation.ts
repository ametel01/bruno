export const PUBLIC_AGENT_DEPLOYMENT_STAGES = [
  "pending",
  "provisioning_runner",
  "configuring_hermes",
  "starting_gateway",
  "verifying_model",
  "connecting_telegram",
  "ready",
  "failed",
] as const;

export type PublicAgentDeploymentStage = (typeof PUBLIC_AGENT_DEPLOYMENT_STAGES)[number];
export type PublicAgentDesiredStatus = "stopped" | "running";
export type PublicAgentLifecycleStatus =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "stopped"
  | "error"
  | "deleting";

export type PublicAgentDeployment = {
  id: string;
  agentId: string;
  stage: PublicAgentDeploymentStage;
  configRevision: string;
  attemptCount: number;
  error: {
    code: string;
  } | null;
  recovery: {
    state: "preparing_capacity";
  } | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentPresentation =
  | {
      kind: "progress";
      heading: string;
      label: string;
      tone: "active";
      currentStage: Exclude<PublicAgentDeploymentStage, "ready" | "failed">;
      deployment: PublicAgentDeployment;
      terminal: false;
      canRetry: false;
      canStopSetup: true;
      description: string;
    }
  | {
      kind: "recovery";
      heading: "Preparing your agent";
      label: "Preparing your agent";
      tone: "active";
      currentStage: Exclude<PublicAgentDeploymentStage, "ready" | "failed">;
      deployment: PublicAgentDeployment;
      terminal: false;
      canRetry: false;
      canStopSetup: true;
      description: string;
    }
  | {
      kind: "ready";
      heading: "Ready";
      label: "Ready";
      tone: "ready";
      currentStage: "ready";
      deployment: PublicAgentDeployment;
      terminal: true;
      canRetry: false;
      canStopSetup: false;
      description: string;
    }
  | {
      kind: "failed";
      heading: "Automatic setup could not recover";
      label: "Automatic setup could not recover";
      tone: "failed";
      currentStage: "failed";
      lastObservedStage: Exclude<PublicAgentDeploymentStage, "ready" | "failed"> | null;
      deployment: PublicAgentDeployment;
      terminal: true;
      canRetry: boolean;
      canStopSetup: false;
      description: string;
    }
  | {
      kind: "stopped";
      heading: "Intentionally stopped";
      label: "Intentionally stopped";
      tone: "stopped";
      currentStage: null;
      deployment: PublicAgentDeployment | null;
      terminal: true;
      canRetry: false;
      canStopSetup: false;
      description: string;
    }
  | {
      kind: "manual";
      heading: "Manual setup";
      label: "Manual setup";
      tone: "neutral";
      currentStage: null;
      deployment: null;
      terminal: true;
      canRetry: false;
      canStopSetup: false;
      description: string;
    }
  | {
      kind: "unavailable";
      heading: "Progress unavailable";
      label: "Progress unavailable";
      tone: "unknown";
      currentStage: null;
      deployment: PublicAgentDeployment | null;
      terminal: false;
      canRetry: false;
      canStopSetup: false;
      description: string;
    }
  | {
      kind: "updating";
      heading: "Preparing your agent";
      label: "Preparing your agent";
      tone: "active";
      currentStage: "ready";
      deployment: PublicAgentDeployment;
      terminal: false;
      canRetry: false;
      canStopSetup: false;
      description: string;
    };

export type SafeDeploymentParseResult =
  | { ok: true; deployment: PublicAgentDeployment }
  | { ok: false };

export type SafeCreate202ParseResult =
  | {
      ok: true;
      agentId: string;
      deployment: PublicAgentDeployment;
    }
  | { ok: false };

export type SafeRetry202ParseResult =
  | {
      ok: true;
      deployment: PublicAgentDeployment;
    }
  | { ok: false };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIG_REVISION_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
const STAGE_SET = new Set<string>(PUBLIC_AGENT_DEPLOYMENT_STAGES);
const DESIRED_STATUS_SET = new Set<string>(["stopped", "running"]);
const LIFECYCLE_STATUS_SET = new Set<string>([
  "idle",
  "starting",
  "running",
  "restarting",
  "stopped",
  "error",
  "deleting",
]);

const STAGE_LABELS: Record<PublicAgentDeploymentStage, string> = {
  pending: "Preparing your agent",
  provisioning_runner: "Preparing your agent",
  configuring_hermes: "Preparing your agent",
  starting_gateway: "Preparing your agent",
  verifying_model: "Preparing your agent",
  connecting_telegram: "Connecting Telegram",
  ready: "Ready",
  failed: "Automatic setup could not recover",
};

const PROGRESS_DESCRIPTIONS: Record<
  Exclude<PublicAgentDeploymentStage, "ready" | "failed">,
  string
> = {
  pending: "bruno is preparing everything this agent needs.",
  provisioning_runner: "bruno is preparing everything this agent needs.",
  configuring_hermes: "bruno is preparing everything this agent needs.",
  starting_gateway: "bruno is preparing everything this agent needs.",
  verifying_model: "bruno is preparing everything this agent needs.",
  connecting_telegram: "bruno is connecting the dedicated Telegram bot.",
};

export const PUBLIC_AGENT_EXPERIENCE_STAGES = [
  "preparing",
  "connecting_telegram",
  "ready",
] as const;

export type PublicAgentExperienceStage = (typeof PUBLIC_AGENT_EXPERIENCE_STAGES)[number];

const EXPERIENCE_STAGE_LABELS: Record<PublicAgentExperienceStage, string> = {
  preparing: "Preparing your agent",
  connecting_telegram: "Connecting Telegram",
  ready: "Ready",
};

export function deploymentStageLabel(stage: PublicAgentDeploymentStage): string {
  return STAGE_LABELS[stage];
}

export function isPublicAgentDeploymentStage(value: unknown): value is PublicAgentDeploymentStage {
  return typeof value === "string" && STAGE_SET.has(value);
}

export function isTerminalPublicDeploymentStage(stage: PublicAgentDeploymentStage): boolean {
  return stage === "ready" || stage === "failed";
}

export function parseSafePublicDeployment(value: unknown): SafeDeploymentParseResult {
  if (!isRecord(value)) {
    return { ok: false };
  }

  if (
    !hasExactKeys(value, [
      "id",
      "agentId",
      "stage",
      "configRevision",
      "attemptCount",
      "error",
      "nextAttemptAt",
      "startedAt",
      "completedAt",
      "failedAt",
      "createdAt",
      "updatedAt",
    ])
  ) {
    return { ok: false };
  }

  if (
    !isUuid(value.id) ||
    !isUuid(value.agentId) ||
    !isPublicAgentDeploymentStage(value.stage) ||
    typeof value.configRevision !== "string" ||
    !CONFIG_REVISION_PATTERN.test(value.configRevision) ||
    !isSafeError(value.error) ||
    !isNullableIso(value.nextAttemptAt) ||
    !isNullableIso(value.startedAt) ||
    !isNullableIso(value.completedAt) ||
    !isNullableIso(value.failedAt) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    return { ok: false };
  }

  const attemptCount = value.attemptCount;

  if (!Number.isInteger(attemptCount) || typeof attemptCount !== "number" || attemptCount < 0) {
    return { ok: false };
  }

  if (value.stage === "ready") {
    if (value.completedAt === null || value.failedAt !== null || value.error !== null) {
      return { ok: false };
    }
  } else if (value.completedAt !== null) {
    return { ok: false };
  }

  if (value.stage === "failed") {
    if (value.failedAt === null || value.error === null) {
      return { ok: false };
    }
  } else if (value.failedAt !== null) {
    return { ok: false };
  }

  if (isTerminalPublicDeploymentStage(value.stage) && value.nextAttemptAt !== null) {
    return { ok: false };
  }

  return {
    ok: true,
    deployment: {
      id: value.id,
      agentId: value.agentId,
      stage: value.stage,
      configRevision: value.configRevision,
      attemptCount,
      error: value.error === null ? null : { code: value.error.code },
      recovery:
        value.error?.code === "runner_recovery_in_progress"
          ? { state: "preparing_capacity" }
          : null,
      nextAttemptAt: value.nextAttemptAt,
      startedAt: value.startedAt,
      completedAt: value.completedAt,
      failedAt: value.failedAt,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    },
  };
}

export function parseSafeCreate202Body(value: unknown): SafeCreate202ParseResult {
  if (!isRecord(value) || !isRecord(value.agent)) {
    return { ok: false };
  }

  if (!hasExactKeys(value, ["agent", "deployment"]) || !hasSafeAgentEnvelope(value.agent)) {
    return { ok: false };
  }

  const agentId = value.agent.id;
  const parsedDeployment = parseSafePublicDeployment(value.deployment);

  if (
    typeof agentId !== "string" ||
    !isUuid(agentId) ||
    !parsedDeployment.ok ||
    parsedDeployment.deployment.agentId !== agentId
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    agentId,
    deployment: parsedDeployment.deployment,
  };
}

export function parseSafeRetry202Body(value: unknown, agentId: string): SafeRetry202ParseResult {
  if (!isRecord(value) || !hasExactKeys(value, ["deployment"])) {
    return { ok: false };
  }

  const deploymentValue = isRecord(value) ? value.deployment : null;
  const parsedDeployment = parseSafePublicDeployment(deploymentValue);

  if (!isUuid(agentId) || !parsedDeployment.ok || parsedDeployment.deployment.agentId !== agentId) {
    return { ok: false };
  }

  return {
    ok: true,
    deployment: parsedDeployment.deployment,
  };
}

export function parseSafeDeploymentGetBody(
  value: unknown,
  agentId: string,
): { ok: true; deployment: PublicAgentDeployment | null } | { ok: false } {
  if (!isRecord(value) || !("deployment" in value)) {
    return { ok: false };
  }

  if (!hasExactKeys(value, ["deployment"])) {
    return { ok: false };
  }

  if (value.deployment === null) {
    return { ok: true, deployment: null };
  }

  const parsed = parseSafePublicDeployment(value.deployment);

  if (!parsed.ok || parsed.deployment.agentId !== agentId) {
    return { ok: false };
  }

  return { ok: true, deployment: parsed.deployment };
}

export function buildDeploymentPresentation(input: {
  deployment: PublicAgentDeployment | null;
  desiredStatus: PublicAgentDesiredStatus;
  observedStatus: PublicAgentLifecycleStatus;
  lastObservedStage?: Exclude<PublicAgentDeploymentStage, "ready" | "failed"> | null;
}): DeploymentPresentation {
  const { deployment, desiredStatus, observedStatus } = input;

  if (!isPublicAgentDesiredStatus(desiredStatus) || !isPublicAgentLifecycleStatus(observedStatus)) {
    return progressUnavailable(deployment);
  }

  if (!deployment) {
    if (
      desiredStatus === "stopped" &&
      (observedStatus === "stopped" || observedStatus === "idle" || observedStatus === "error")
    ) {
      return {
        kind: "manual",
        heading: "Manual setup",
        label: "Manual setup",
        tone: "neutral",
        currentStage: null,
        deployment: null,
        terminal: true,
        canRetry: false,
        canStopSetup: false,
        description: "No automatic deployment has been persisted for this agent.",
      };
    }

    return progressUnavailable(null);
  }

  if (desiredStatus === "stopped") {
    return {
      kind: "stopped",
      heading: "Intentionally stopped",
      label: "Intentionally stopped",
      tone: "stopped",
      currentStage: null,
      deployment,
      terminal: true,
      canRetry: false,
      canStopSetup: false,
      description: "The owner-requested state is stopped.",
    };
  }

  if (deployment.stage === "ready") {
    if (desiredStatus === "running" && observedStatus === "running") {
      return {
        kind: "ready",
        heading: "Ready",
        label: "Ready",
        tone: "ready",
        currentStage: "ready",
        deployment,
        terminal: true,
        canRetry: false,
        canStopSetup: false,
        description: "The persisted deployment is ready and the agent is running.",
      };
    }

    return {
      kind: "updating",
      heading: "Preparing your agent",
      label: "Preparing your agent",
      tone: "active",
      currentStage: "ready",
      deployment,
      terminal: false,
      canRetry: false,
      canStopSetup: false,
      description: "The persisted deployment is ready while lifecycle state catches up.",
    };
  }

  if (deployment.stage === "failed") {
    const lastObservedStage = input.lastObservedStage ?? null;

    return {
      kind: "failed",
      heading: "Automatic setup could not recover",
      label: "Automatic setup could not recover",
      tone: "failed",
      currentStage: "failed",
      lastObservedStage,
      deployment,
      terminal: true,
      canRetry: desiredStatus === "running",
      canStopSetup: false,
      description: "Try automatic setup again, or stop this agent.",
    };
  }

  if (deployment.recovery?.state === "preparing_capacity") {
    return {
      kind: "recovery",
      heading: "Preparing your agent",
      label: "Preparing your agent",
      tone: "active",
      currentStage: deployment.stage,
      deployment,
      terminal: false,
      canRetry: false,
      canStopSetup: true,
      description: "bruno is preparing replacement capacity automatically.",
    };
  }

  return {
    kind: "progress",
    heading: deploymentStageLabel(deployment.stage),
    label: deploymentStageLabel(deployment.stage),
    tone: "active",
    currentStage: deployment.stage,
    deployment,
    terminal: false,
    canRetry: false,
    canStopSetup: true,
    description: PROGRESS_DESCRIPTIONS[deployment.stage],
  };
}

export function deploymentExperienceStageLabel(stage: PublicAgentExperienceStage): string {
  return EXPERIENCE_STAGE_LABELS[stage];
}

export function deploymentExperienceStageState(
  presentation: DeploymentPresentation,
  stage: PublicAgentExperienceStage,
): "completed" | "current" | "pending" | "blocked" {
  const current = currentExperienceStage(presentation);
  if (presentation.kind === "failed") {
    return stage === current
      ? "blocked"
      : experienceStageOrder(stage) < experienceStageOrder(current)
        ? "completed"
        : "pending";
  }
  if (stage === current) return "current";
  return experienceStageOrder(stage) < experienceStageOrder(current) ? "completed" : "pending";
}

export function progressUnavailable(
  deployment: PublicAgentDeployment | null,
): DeploymentPresentation {
  return {
    kind: "unavailable",
    heading: "Progress unavailable",
    label: "Progress unavailable",
    tone: "unknown",
    currentStage: null,
    deployment,
    terminal: false,
    canRetry: false,
    canStopSetup: false,
    description: "The latest persisted progress cannot be represented safely.",
  };
}

export function deploymentStageListState(
  presentation: DeploymentPresentation,
  stage: Exclude<PublicAgentDeploymentStage, "failed">,
): "completed" | "current" | "pending" | "blocked" {
  if (!presentation.deployment) {
    return "pending";
  }

  if (presentation.kind === "unavailable") {
    return "blocked";
  }

  const currentStage = presentation.deployment.stage;

  if (presentation.kind === "failed") {
    if (presentation.lastObservedStage === null) {
      return "pending";
    }

    if (stage === presentation.lastObservedStage) {
      return "blocked";
    }

    return stageOrder(stage) < stageOrder(presentation.lastObservedStage) ? "completed" : "pending";
  }

  if (stage === currentStage) {
    return "current";
  }

  if (currentStage === "failed") {
    return "pending";
  }

  return stageOrder(stage) < stageOrder(currentStage) ? "completed" : "pending";
}

export function compareDeploymentCreatedAt(
  left: PublicAgentDeployment,
  right: PublicAgentDeployment,
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.id.localeCompare(right.id);
}

export function isPublicAgentDesiredStatus(value: unknown): value is PublicAgentDesiredStatus {
  return typeof value === "string" && DESIRED_STATUS_SET.has(value);
}

export function isPublicAgentLifecycleStatus(value: unknown): value is PublicAgentLifecycleStatus {
  return typeof value === "string" && LIFECYCLE_STATUS_SET.has(value);
}

function stageOrder(stage: Exclude<PublicAgentDeploymentStage, "failed">): number {
  return PUBLIC_AGENT_DEPLOYMENT_STAGES.indexOf(stage);
}

function currentExperienceStage(presentation: DeploymentPresentation): PublicAgentExperienceStage {
  if (!presentation.deployment) return "preparing";
  if (presentation.kind === "ready") return "ready";
  if (presentation.deployment.stage === "connecting_telegram") return "connecting_telegram";
  if (presentation.kind === "failed" && presentation.lastObservedStage === "connecting_telegram") {
    return "connecting_telegram";
  }
  return "preparing";
}

function experienceStageOrder(stage: PublicAgentExperienceStage): number {
  return PUBLIC_AGENT_EXPERIENCE_STAGES.indexOf(stage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isSafeError(value: unknown): value is PublicAgentDeployment["error"] {
  if (value === null) {
    return true;
  }

  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    ERROR_CODE_PATTERN.test(value.code) &&
    "detail" in value &&
    (value.detail === null || (typeof value.detail === "string" && value.detail.length <= 500)) &&
    hasExactKeys(value, ["code", "detail"])
  );
}

function hasSafeAgentEnvelope(value: Record<string, unknown>): boolean {
  if (!isUuid(value.id)) {
    return false;
  }

  const forbidden = [
    "secret",
    "secrets",
    "idempotencyKey",
    "leaseOwner",
    "leaseExpiresAt",
    "runnerOperationId",
    "canaryOutput",
    "errorDetail",
  ];

  return forbidden.every((field) => !(field in value));
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();

  if (keys.length !== expectedKeys.length) {
    return false;
  }

  return keys.every((key, index) => key === expectedKeys[index]);
}

function isNullableIso(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const time = Date.parse(value);

  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
