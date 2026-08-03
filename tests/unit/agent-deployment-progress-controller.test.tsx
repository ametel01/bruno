import { describe, expect, it, vi } from "vitest";
import {
  deploymentPollDelayMs,
  isPollResponseCurrent,
  nextObservationFailureState,
  observationStateForPollStatus,
  POLL_FOREGROUND_LIMIT_MS,
  publicNonterminalDeploymentStage,
  retryConflictRequiresForcedRead,
  retryFailureMessage,
  retryReplacementIsSafe,
  shouldAcceptDeploymentUpdate,
  shouldRefreshTerminalOnce,
} from "@/app/agents/_components/agent-deployment-progress";
import type { PublicAgentDeployment } from "@/src/shared/agent-deployment-presentation";
import { parseSafeDeploymentGetBody } from "@/src/shared/agent-deployment-presentation";
import {
  foregroundPollingElapsedMs,
  pauseForegroundPollingWindow,
  resumeForegroundPollingWindow,
  startForegroundPollingWindow,
} from "@/src/shared/deployment-polling-state";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

const AGENT_ID = "00000000-0000-4000-8000-000000000401";

describe("agent deployment progress controller", () => {
  it("uses the contracted 2s, 5s, and 15s polling cadence", () => {
    expect(deploymentPollDelayMs(0)).toBe(2_000);
    expect(deploymentPollDelayMs(29_999)).toBe(2_000);
    expect(deploymentPollDelayMs(30_000)).toBe(5_000);
    expect(deploymentPollDelayMs(5 * 60_000 - 1)).toBe(5_000);
    expect(deploymentPollDelayMs(5 * 60_000)).toBe(15_000);
  });

  it("counts only accumulated visible and online time toward the 30 minute boundary", () => {
    let window = startForegroundPollingWindow(0);

    window = pauseForegroundPollingWindow(window, 15 * 60_000);
    expect(foregroundPollingElapsedMs(window, 20 * 60_000)).toBe(15 * 60_000);
    window = resumeForegroundPollingWindow(window, 20 * 60_000);
    expect(foregroundPollingElapsedMs(window, 35 * 60_000)).toBe(POLL_FOREGROUND_LIMIT_MS);
  });

  it("accumulates three failures before degraded state and recovers on success reset", () => {
    const once = nextObservationFailureState({ status: "idle", consecutiveFailures: 0 });
    const twice = nextObservationFailureState(once);
    const third = nextObservationFailureState(twice);

    expect(once).toEqual({ status: "idle", consecutiveFailures: 1 });
    expect(twice).toEqual({ status: "idle", consecutiveFailures: 2 });
    expect(third).toEqual({
      status: "degraded",
      consecutiveFailures: 3,
      message: "Progress updates are temporarily unavailable",
    });
    expect({ status: "idle", consecutiveFailures: 0 }).toEqual({
      status: "idle",
      consecutiveFailures: 0,
    });
  });

  it("classifies auth, unavailable, malformed, null, server, and network poll outcomes", () => {
    expect(observationStateForPollStatus(401)).toEqual({
      status: "auth",
      message: "Sign in again, then reload progress.",
    });
    expect(observationStateForPollStatus(403)?.status).toBe("auth");
    expect(observationStateForPollStatus(404)).toEqual({
      status: "unavailable",
      message: "Agent is unavailable.",
    });
    expect(observationStateForPollStatus(500)).toBeNull();
    expect(parseSafeDeploymentGetBody({ deployment: null }, AGENT_ID)).toEqual({
      ok: true,
      deployment: null,
    });
    expect(parseSafeDeploymentGetBody({ deployment: { id: "bad" } }, AGENT_ID).ok).toBe(false);
    expect(nextObservationFailureState({ status: "idle", consecutiveFailures: 2 }).status).toBe(
      "degraded",
    );
  });

  it("guards single-flight generation freshness and newer-operation tie-breaks", () => {
    expect(
      isPollResponseCurrent({
        currentGeneration: 3,
        responseAgentId: AGENT_ID,
        responseGeneration: 3,
        routeAgentId: AGENT_ID,
      }),
    ).toBe(true);
    expect(
      isPollResponseCurrent({
        currentGeneration: 4,
        responseAgentId: AGENT_ID,
        responseGeneration: 3,
        routeAgentId: AGENT_ID,
      }),
    ).toBe(false);
    expect(
      shouldAcceptDeploymentUpdate(
        deployment({ id: deploymentId(2) }),
        deployment({ id: deploymentId(1) }),
      ),
    ).toBe(false);
    expect(
      shouldAcceptDeploymentUpdate(
        deployment({ id: deploymentId(1) }),
        deployment({ id: deploymentId(2) }),
      ),
    ).toBe(true);
  });

  it("forces a read on retry conflict and only replaces failed deployments with newer pending operations", () => {
    const failed = deployment({
      createdAt: "2026-08-03T05:00:00.000Z",
      error: { code: "telegram_not_connected" },
      failedAt: "2026-08-03T05:01:00.000Z",
      stage: "failed",
    });

    expect(retryConflictRequiresForcedRead(409)).toBe(true);
    expect(retryConflictRequiresForcedRead(500)).toBe(false);
    expect(
      retryReplacementIsSafe({
        current: failed,
        replacement: deployment({
          createdAt: "2026-08-03T05:02:00.000Z",
          id: deploymentId(2),
          stage: "pending",
        }),
      }),
    ).toBe(true);
    expect(
      retryReplacementIsSafe({
        current: failed,
        replacement: deployment({
          createdAt: "2026-08-03T05:02:00.000Z",
          id: deploymentId(2),
          stage: "provisioning_runner",
        }),
      }),
    ).toBe(false);
  });

  it("refreshes terminal deployments once and preserves only nonterminal last-safe stages", () => {
    expect(
      shouldRefreshTerminalOnce({
        deployment: deployment({ completedAt: "2026-08-03T05:01:00.000Z", stage: "ready" }),
        refreshedTerminal: false,
      }),
    ).toBe(true);
    expect(
      shouldRefreshTerminalOnce({
        deployment: deployment({ completedAt: "2026-08-03T05:01:00.000Z", stage: "ready" }),
        refreshedTerminal: true,
      }),
    ).toBe(false);
    expect(publicNonterminalDeploymentStage("verifying_model")).toBe("verifying_model");
    expect(publicNonterminalDeploymentStage("ready")).toBeNull();
    expect(publicNonterminalDeploymentStage("failed")).toBeNull();
  });

  it("maps retry failures without exposing unsafe response bodies", async () => {
    await expect(retryFailureMessage(Response.json({}, { status: 400 }))).resolves.toBe(
      "Retry request was invalid.",
    );
    await expect(
      retryFailureMessage(Response.json({ error: { code: "agent_not_found" } }, { status: 404 })),
    ).resolves.toBe("Agent is unavailable.");
    await expect(
      retryFailureMessage(
        Response.json({ error: { code: "deployment_not_retryable" } }, { status: 409 }),
      ),
    ).resolves.toBe("Refresh status before retrying.");
    await expect(retryFailureMessage(new Response("not-json", { status: 500 }))).resolves.toBe(
      "Automatic setup could not finish. Retry or stop this agent.",
    );
  });
});

function deployment(overrides: Partial<PublicAgentDeployment> = {}): PublicAgentDeployment {
  return {
    agentId: AGENT_ID,
    attemptCount: 0,
    completedAt: null,
    configRevision: "cfg-1784000000000",
    createdAt: "2026-08-03T05:00:00.000Z",
    error: null,
    failedAt: null,
    id: deploymentId(1),
    nextAttemptAt: null,
    stage: "pending",
    startedAt: null,
    updatedAt: "2026-08-03T05:00:00.000Z",
    ...overrides,
  };
}

function deploymentId(index: number): string {
  return `00000000-0000-4000-8000-${String(400 + index).padStart(12, "0")}`;
}
