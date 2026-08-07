import {
  compareDeploymentCreatedAt,
  isTerminalPublicDeploymentStage,
  type PublicAgentDeployment,
  type PublicAgentDeploymentStage,
} from "@/src/shared/agent-deployment-presentation";

export type ObservationState =
  | { status: "idle"; consecutiveFailures: number }
  | { status: "degraded"; consecutiveFailures: number; message: string }
  | { status: "auth"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "paused"; message: string };

export type RetryState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "ambiguous"; message: string; idempotencyKey: string }
  | { status: "error"; message: string; idempotencyKey: string | null };

export const POLL_FOREGROUND_LIMIT_MS = 30 * 60 * 1000;

export function deploymentPollDelayMs(elapsedMs: number): 2_000 | 5_000 | 15_000 {
  return elapsedMs < 30_000 ? 2_000 : elapsedMs < 5 * 60_000 ? 5_000 : 15_000;
}

export function nextObservationFailureState(current: ObservationState): ObservationState {
  const consecutiveFailures =
    current.status === "idle" || current.status === "degraded"
      ? current.consecutiveFailures + 1
      : 1;

  if (consecutiveFailures >= 3) {
    return {
      status: "degraded",
      consecutiveFailures,
      message: "Progress updates are temporarily unavailable",
    };
  }

  return { status: "idle", consecutiveFailures };
}

export function observationStateForPollStatus(
  status: number,
): Extract<ObservationState, { status: "auth" | "unavailable" }> | null {
  if (status === 401 || status === 403) {
    return { status: "auth", message: "Sign in again, then reload progress." };
  }

  if (status === 404) {
    return { status: "unavailable", message: "Agent is unavailable." };
  }

  return null;
}

export function shouldAcceptDeploymentUpdate(
  current: PublicAgentDeployment | null,
  nextDeployment: PublicAgentDeployment,
): boolean {
  if (current === null) {
    return true;
  }

  if (nextDeployment.id === current.id) {
    return true;
  }

  return compareDeploymentCreatedAt(nextDeployment, current) >= 0;
}

export function isPollResponseCurrent(input: {
  currentGeneration: number;
  responseAgentId: string;
  responseGeneration: number;
  routeAgentId: string;
}): boolean {
  return (
    input.responseGeneration === input.currentGeneration &&
    input.responseAgentId === input.routeAgentId
  );
}

export function shouldRefreshTerminalOnce(input: {
  deployment: PublicAgentDeployment | null;
  refreshedTerminal: boolean;
}): boolean {
  return (
    input.deployment !== null &&
    isTerminalPublicDeploymentStage(input.deployment.stage) &&
    !input.refreshedTerminal
  );
}

export function retryConflictRequiresForcedRead(status: number): boolean {
  return status === 409;
}

export function retryReplacementIsSafe(input: {
  current: PublicAgentDeployment;
  replacement: PublicAgentDeployment;
}): boolean {
  return (
    input.replacement.stage === "pending" &&
    compareDeploymentCreatedAt(input.replacement, input.current) > 0
  );
}

export type DeploymentRetryLatch = {
  inFlight: boolean;
  idempotencyKey: string | null;
};

export function createDeploymentRetryLatch(): DeploymentRetryLatch {
  return { inFlight: false, idempotencyKey: null };
}

export function acquireDeploymentRetryAttempt(input: {
  createIdempotencyKey: () => string;
  latch: DeploymentRetryLatch;
  retry: RetryState;
}): { ok: true; idempotencyKey: string } | { ok: false } {
  if (input.latch.inFlight) {
    return { ok: false };
  }

  input.latch.inFlight = true;

  const existingStateKey =
    input.retry.status === "ambiguous" || input.retry.status === "error"
      ? input.retry.idempotencyKey
      : null;
  const idempotencyKey =
    existingStateKey ?? input.latch.idempotencyKey ?? input.createIdempotencyKey().toLowerCase();

  if (idempotencyKey.length === 0) {
    input.latch.inFlight = false;
    return { ok: false };
  }

  input.latch.idempotencyKey = idempotencyKey;

  return { ok: true, idempotencyKey };
}

export function releaseDeploymentRetryAttempt(latch: DeploymentRetryLatch): void {
  latch.inFlight = false;
}

export function resetDeploymentRetryAttempt(latch: DeploymentRetryLatch): void {
  latch.inFlight = false;
  latch.idempotencyKey = null;
}

export function publicNonterminalDeploymentStage(
  stage: PublicAgentDeploymentStage | null,
): Exclude<PublicAgentDeploymentStage, "ready" | "failed"> | null {
  switch (stage) {
    case "pending":
    case "provisioning_runner":
    case "configuring_hermes":
    case "starting_gateway":
    case "verifying_model":
    case "connecting_telegram":
      return stage;
    default:
      return null;
  }
}

export async function retryFailureMessage(response: Response): Promise<string> {
  if (response.status === 400) {
    return "Retry request was invalid.";
  }

  try {
    const body: unknown = await response.json();
    const code = isRecord(body) && isRecord(body.error) ? body.error.code : null;

    if (response.status === 404 || code === "agent_not_found") {
      return "Agent is unavailable.";
    }

    if (code === "deployment_not_retryable") {
      return "Refresh status before retrying.";
    }
  } catch {
    // Keep retry errors generic when JSON is absent or malformed.
  }

  return "Automatic setup could not recover. Try again or stop this agent.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
