import "server-only";

export const AGENT_DEPLOYMENT_STAGES = [
  "pending",
  "provisioning_runner",
  "configuring_hermes",
  "starting_gateway",
  "verifying_model",
  "connecting_telegram",
  "ready",
  "failed",
] as const;

export type AgentDeploymentStage = (typeof AGENT_DEPLOYMENT_STAGES)[number];

export const TERMINAL_AGENT_DEPLOYMENT_STAGES = ["ready", "failed"] as const;

export const MAX_DEPLOYMENT_LEASE_MS = 5 * 60 * 1000;
export const MAX_DEPLOYMENT_ERROR_DETAIL_LENGTH = 500;

const DEPLOYMENT_STAGE_SET = new Set<string>(AGENT_DEPLOYMENT_STAGES);
const TERMINAL_DEPLOYMENT_STAGE_SET = new Set<string>(TERMINAL_AGENT_DEPLOYMENT_STAGES);
const CONFIG_REVISION_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const RECONCILE_LEASE_OWNER_PATTERN =
  /^reconcile:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_FORWARD_TRANSITIONS: Record<AgentDeploymentStage, readonly AgentDeploymentStage[]> = {
  pending: ["provisioning_runner", "configuring_hermes", "failed"],
  provisioning_runner: ["configuring_hermes", "failed"],
  configuring_hermes: ["starting_gateway", "failed"],
  starting_gateway: ["verifying_model", "failed"],
  verifying_model: ["connecting_telegram", "failed"],
  connecting_telegram: ["ready", "failed"],
  ready: [],
  failed: [],
};

export type DeploymentTransitionCheck =
  | {
      ok: true;
      kind: "same_stage" | "transition";
    }
  | {
      ok: false;
      reason: "terminal_deployment" | "invalid_transition";
    };

export function parseAgentDeploymentStage(value: unknown):
  | {
      ok: true;
      value: AgentDeploymentStage;
    }
  | {
      ok: false;
    } {
  if (typeof value !== "string" || !DEPLOYMENT_STAGE_SET.has(value)) {
    return { ok: false };
  }

  return {
    ok: true,
    value: value as AgentDeploymentStage,
  };
}

export function isTerminalAgentDeploymentStage(stage: AgentDeploymentStage): boolean {
  return TERMINAL_DEPLOYMENT_STAGE_SET.has(stage);
}

export function checkAgentDeploymentTransition(
  currentStage: AgentDeploymentStage,
  nextStage: AgentDeploymentStage,
): DeploymentTransitionCheck {
  if (isTerminalAgentDeploymentStage(currentStage)) {
    return {
      ok: false,
      reason: "terminal_deployment",
    };
  }

  if (currentStage === nextStage) {
    return {
      ok: true,
      kind: "same_stage",
    };
  }

  if (ALLOWED_FORWARD_TRANSITIONS[currentStage].includes(nextStage)) {
    return {
      ok: true,
      kind: "transition",
    };
  }

  return {
    ok: false,
    reason: "invalid_transition",
  };
}

export function normalizeDeploymentIdempotencyKey(value: string):
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      reason: "invalid_idempotency_key";
    } {
  const normalized = value.trim();

  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    return { ok: false, reason: "invalid_idempotency_key" };
  }

  return {
    ok: true,
    value: normalized,
  };
}

export function validateDeploymentConfigRevision(value: string): boolean {
  return value.trim() === value && CONFIG_REVISION_PATTERN.test(value);
}

export function validateDeploymentLeaseOwner(value: string): boolean {
  return RECONCILE_LEASE_OWNER_PATTERN.test(value);
}

export function validateDeploymentLeaseDurationMs(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_DEPLOYMENT_LEASE_MS;
}

export function validateDeploymentErrorCode(value: string): boolean {
  return ERROR_CODE_PATTERN.test(value);
}

export function normalizeDeploymentErrorDetail(value: string | null | undefined):
  | {
      ok: true;
      value: string | null;
    }
  | {
      ok: false;
      reason: "invalid_error_detail";
    } {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > MAX_DEPLOYMENT_ERROR_DETAIL_LENGTH) {
    return { ok: false, reason: "invalid_error_detail" };
  }

  return {
    ok: true,
    value: normalized,
  };
}
