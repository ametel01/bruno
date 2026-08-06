"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildDeploymentPresentation,
  compareDeploymentCreatedAt,
  deploymentExperienceStageLabel,
  deploymentExperienceStageState,
  deploymentStageLabel,
  isTerminalPublicDeploymentStage,
  PUBLIC_AGENT_EXPERIENCE_STAGES,
  type PublicAgentDeployment,
  type PublicAgentDeploymentStage,
  type PublicAgentDesiredStatus,
  type PublicAgentLifecycleStatus,
  parseSafeDeploymentGetBody,
  parseSafeRetry202Body,
} from "@/src/shared/agent-deployment-presentation";
import {
  type ForegroundPollingWindow,
  foregroundPollingElapsedMs,
  pauseForegroundPollingWindow,
  resumeForegroundPollingWindow,
  startForegroundPollingWindow,
} from "@/src/shared/deployment-polling-state";

type AgentDeploymentProgressProps = {
  agentId: string;
  desiredStatus: PublicAgentDesiredStatus;
  observedStatus: PublicAgentLifecycleStatus;
  initialDeployment: PublicAgentDeployment | null;
};

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

export function AgentDeploymentProgress(props: AgentDeploymentProgressProps) {
  return (
    <AgentDeploymentProgressState
      key={JSON.stringify([props.agentId, props.initialDeployment])}
      {...props}
    />
  );
}

function AgentDeploymentProgressState(props: AgentDeploymentProgressProps) {
  const progress = useAgentDeploymentProgress(props);

  return <DeploymentProgressView {...progress} />;
}

function useAgentDeploymentProgress({
  agentId,
  desiredStatus,
  observedStatus,
  initialDeployment,
}: AgentDeploymentProgressProps) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const terminalAlertRef = useRef<HTMLDivElement | null>(null);
  const generationRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const pollDeploymentRef = useRef<() => void>(() => {});
  const initialForegroundWindow = useMemo(() => startForegroundPollingWindow(Date.now()), []);
  const foregroundWindowRef = useRef<ForegroundPollingWindow>(initialForegroundWindow);
  const refreshLatchRef = useRef(false);
  const refreshedTerminalRef = useRef(false);
  const initialRetryLatch = useMemo(createDeploymentRetryLatch, []);
  const retryLatchRef = useRef<DeploymentRetryLatch>(initialRetryLatch);
  const retryLatch = retryLatchRef.current;
  const deploymentRef = useRef(initialDeployment);
  const [deployment, setDeployment] = useState(initialDeployment);
  const [lastObservedStage, setLastObservedStage] = useState<Exclude<
    PublicAgentDeploymentStage,
    "ready" | "failed"
  > | null>(() => toNonterminalStage(initialDeployment?.stage ?? null));
  const [liveMessage, setLiveMessage] = useState("");
  const [observation, setObservation] = useState<ObservationState>({
    status: "idle",
    consecutiveFailures: 0,
  });
  const [retry, setRetry] = useState<RetryState>({ status: "idle" });

  const presentation = useMemo(
    () =>
      buildDeploymentPresentation({
        deployment,
        desiredStatus,
        lastObservedStage,
        observedStatus,
      }),
    [deployment, desiredStatus, lastObservedStage, observedStatus],
  );

  const shouldPoll =
    desiredStatus === "running" &&
    deployment !== null &&
    !isTerminalPublicDeploymentStage(deployment.stage) &&
    observation.status !== "auth" &&
    observation.status !== "unavailable" &&
    observation.status !== "paused";

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const markObservationFailure = useCallback(() => {
    setObservation((current) => {
      return nextObservationFailureState(current);
    });
  }, []);

  const currentForegroundElapsedMs = useCallback((): number => {
    return foregroundPollingElapsedMs(foregroundWindowRef.current, Date.now());
  }, []);

  const pauseForegroundTracking = useCallback(() => {
    foregroundWindowRef.current = pauseForegroundPollingWindow(
      foregroundWindowRef.current,
      Date.now(),
    );
  }, []);

  const resumeForegroundTracking = useCallback(({ reset }: { reset: boolean }) => {
    foregroundWindowRef.current = resumeForegroundPollingWindow(
      foregroundWindowRef.current,
      Date.now(),
      {
        reset,
      },
    );
  }, []);

  const scheduleNextPoll = useCallback(() => {
    clearTimer();

    if (!shouldPoll || document.hidden || !navigator.onLine) {
      return;
    }

    const trackedMs = currentForegroundElapsedMs();

    if (trackedMs >= POLL_FOREGROUND_LIMIT_MS) {
      setObservation({
        status: "paused",
        message: "Automatic progress updates paused",
      });
      return;
    }

    const delay = deploymentPollDelayMs(trackedMs);
    timerRef.current = window.setTimeout(() => {
      pollDeploymentRef.current();
    }, delay);
  }, [clearTimer, currentForegroundElapsedMs, shouldPoll]);

  const pollDeployment = useCallback(async () => {
    clearTimer();

    if (!shouldPoll || document.hidden || !navigator.onLine || inFlightRef.current) {
      return;
    }

    const generation = generationRef.current;
    const controller = new AbortController();
    inFlightRef.current = controller;

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/deployment`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (generation !== generationRef.current) {
        return;
      }

      const terminalObservation = observationStateForPollStatus(response.status);

      if (terminalObservation !== null) {
        setObservation(terminalObservation);
        return;
      }

      if (!response.ok) {
        markObservationFailure();
        return;
      }

      let body: unknown;

      try {
        body = await response.json();
      } catch {
        markObservationFailure();
        return;
      }

      const parsed = parseSafeDeploymentGetBody(body, agentId);

      if (!parsed.ok) {
        markObservationFailure();
        return;
      }

      if (parsed.deployment === null) {
        setObservation({
          status: "degraded",
          consecutiveFailures: 3,
          message: "Progress unavailable",
        });
        return;
      }
      const nextDeployment = parsed.deployment;
      const currentDeployment = deploymentRef.current;

      if (!shouldAcceptDeploymentUpdate(currentDeployment, nextDeployment)) {
        return;
      }

      setObservation({ status: "idle", consecutiveFailures: 0 });
      deploymentRef.current = nextDeployment;
      setDeployment(nextDeployment);

      if (
        currentDeployment === null ||
        nextDeployment.stage !== currentDeployment.stage ||
        nextDeployment.id !== currentDeployment.id
      ) {
        setLiveMessage(deploymentStageLabel(nextDeployment.stage));
      }

      const nonterminalStage = toNonterminalStage(nextDeployment.stage);

      if (nonterminalStage) {
        setLastObservedStage(nonterminalStage);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        markObservationFailure();
      }
    } finally {
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
      }

      if (generation === generationRef.current) {
        scheduleNextPoll();
      }
    }
  }, [agentId, clearTimer, markObservationFailure, scheduleNextPoll, shouldPoll]);

  useEffect(() => {
    pollDeploymentRef.current = () => {
      void pollDeployment();
    };
  }, [pollDeployment]);

  useEffect(() => {
    if (!shouldPoll) {
      clearTimer();
      inFlightRef.current?.abort();
      inFlightRef.current = null;
      return;
    }

    void pollDeployment();

    return () => {
      clearTimer();
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, [clearTimer, pollDeployment, shouldPoll]);

  useEffect(() => {
    const resume = () => {
      if (!document.hidden && navigator.onLine && shouldPoll) {
        resumeForegroundTracking({ reset: false });
        void pollDeployment();
      } else {
        pauseForegroundTracking();
        clearTimer();
      }
    };

    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);

    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
    };
  }, [clearTimer, pauseForegroundTracking, pollDeployment, resumeForegroundTracking, shouldPoll]);

  useEffect(() => {
    if (
      shouldRefreshTerminalOnce({
        deployment,
        refreshedTerminal: refreshedTerminalRef.current,
      })
    ) {
      refreshedTerminalRef.current = true;
      router.refresh();
    }
  }, [deployment, router]);

  useEffect(() => {
    if (presentation.kind === "failed") {
      terminalAlertRef.current?.focus();
    }
  }, [presentation.kind]);

  async function handleRetry() {
    if (!deployment || presentation.kind !== "failed" || retry.status === "requesting") {
      return;
    }

    const acquired = acquireDeploymentRetryAttempt({
      createIdempotencyKey: () => crypto.randomUUID().toLowerCase(),
      latch: retryLatch,
      retry,
    });

    if (!acquired.ok) {
      return;
    }

    const { idempotencyKey } = acquired;
    setRetry({ status: "requesting" });

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/deployment/retry`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey }),
      });

      if (!response.ok) {
        if (retryConflictRequiresForcedRead(response.status)) {
          setRetry({
            status: "error",
            idempotencyKey,
            message: "Refresh status before retrying.",
          });
          await refreshDeploymentOnce();
          return;
        }

        setRetry({
          status: "error",
          idempotencyKey,
          message: await retryFailureMessage(response),
        });
        return;
      }

      let body: unknown;

      try {
        body = await response.json();
      } catch {
        setRetry({
          status: "ambiguous",
          idempotencyKey,
          message: "Retry response was interrupted. Retry the same request.",
        });
        return;
      }

      const parsed = parseSafeRetry202Body(body, agentId);

      if (
        !parsed.ok ||
        !retryReplacementIsSafe({ current: deployment, replacement: parsed.deployment })
      ) {
        setRetry({
          status: "ambiguous",
          idempotencyKey,
          message: "Retry response was interrupted. Retry the same request.",
        });
        return;
      }

      generationRef.current += 1;
      resumeForegroundTracking({ reset: true });
      refreshedTerminalRef.current = false;
      resetDeploymentRetryAttempt(retryLatch);
      deploymentRef.current = parsed.deployment;
      setDeployment(parsed.deployment);
      setLastObservedStage(toNonterminalStage(parsed.deployment.stage));
      setRetry({ status: "idle" });
      setObservation({ status: "idle", consecutiveFailures: 0 });
      setLiveMessage("Retrying");
      headingRef.current?.focus();
    } catch {
      setRetry({
        status: "ambiguous",
        idempotencyKey,
        message: "Retry response was interrupted. Retry the same request.",
      });
    } finally {
      releaseDeploymentRetryAttempt(retryLatch);
    }
  }

  async function refreshDeploymentOnce() {
    if (refreshLatchRef.current) {
      return;
    }

    refreshLatchRef.current = true;
    generationRef.current += 1;
    clearTimer();
    inFlightRef.current?.abort();
    inFlightRef.current = null;

    try {
      await forceReadDeploymentOnce();
      router.refresh();
    } finally {
      refreshLatchRef.current = false;
    }
  }

  function resumeUpdates() {
    setObservation({ status: "idle", consecutiveFailures: 0 });
    resumeForegroundTracking({ reset: true });
    void pollDeployment();
  }

  async function forceReadDeploymentOnce() {
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/deployment`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        markObservationFailure();
        return;
      }

      const parsed = parseSafeDeploymentGetBody(await response.json(), agentId);

      if (!parsed.ok || parsed.deployment === null) {
        markObservationFailure();
        return;
      }

      const nextDeployment = parsed.deployment;
      const currentDeployment = deploymentRef.current;

      if (!shouldAcceptDeploymentUpdate(currentDeployment, nextDeployment)) {
        return;
      }

      setObservation({ status: "idle", consecutiveFailures: 0 });
      deploymentRef.current = nextDeployment;
      setDeployment(nextDeployment);

      const nonterminalStage = toNonterminalStage(nextDeployment.stage);

      if (nonterminalStage) {
        setLastObservedStage(nonterminalStage);
      }
    } catch {
      markObservationFailure();
    }
  }

  const busy = retry.status === "requesting";

  return {
    busy,
    handleRetry,
    headingRef,
    liveMessage,
    observation,
    presentation,
    refreshDeploymentOnce,
    resumeUpdates,
    retry,
    shouldPoll,
    terminalAlertRef,
  };
}

function DeploymentProgressView({
  busy,
  handleRetry,
  headingRef,
  liveMessage,
  observation,
  presentation,
  refreshDeploymentOnce,
  resumeUpdates,
  retry,
  shouldPoll,
  terminalAlertRef,
}: ReturnType<typeof useAgentDeploymentProgress>) {
  return (
    <section
      className="agent-deployment-progress-card"
      data-tone={presentation.tone}
      aria-busy={busy || shouldPoll}
      aria-labelledby="deployment-progress-title"
    >
      <div className="agent-deployment-progress-header">
        <div>
          <p>Automatic setup</p>
          <h2 id="deployment-progress-title" ref={headingRef} tabIndex={-1}>
            {presentation.heading}
          </h2>
        </div>
        <span className="deployment-status-label" data-tone={presentation.tone}>
          {presentation.label}
        </span>
      </div>
      <p>{presentation.description}</p>
      <ol className="deployment-stage-list" aria-label="Automatic setup progress">
        {PUBLIC_AGENT_EXPERIENCE_STAGES.map((stage) => {
          const state = deploymentExperienceStageState(presentation, stage);
          return (
            <li
              key={stage}
              data-stage-status={state}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span aria-hidden="true" />
              <strong>{deploymentExperienceStageLabel(stage)}</strong>
            </li>
          );
        })}
      </ol>
      <div className="deployment-progress-actions">
        {presentation.canRetry ? (
          <button className="primary-button" type="button" disabled={busy} onClick={handleRetry}>
            {busy ? "Retrying" : "Retry"}
          </button>
        ) : null}
        {observation.status === "degraded" ? (
          <button className="secondary-button" type="button" onClick={refreshDeploymentOnce}>
            Check again
          </button>
        ) : null}
        {observation.status === "paused" ? (
          <button className="secondary-button" type="button" onClick={resumeUpdates}>
            Resume updates
          </button>
        ) : null}
      </div>
      {presentation.kind === "failed" ? (
        <div className="safe-error" role="alert" tabIndex={-1} ref={terminalAlertRef}>
          Automatic setup could not recover. Try again or stop this agent.
        </div>
      ) : null}
      {observation.status !== "idle" ? (
        <p
          className={`form-message ${
            observation.status === "auth" || observation.status === "unavailable" ? "error" : ""
          }`}
          role={
            observation.status === "auth" || observation.status === "unavailable"
              ? "alert"
              : "status"
          }
        >
          {observation.message}
        </p>
      ) : null}
      {retry.status === "ambiguous" || retry.status === "error" ? (
        <p className={`form-message ${retry.status === "error" ? "error" : ""}`} role="status">
          {retry.message}
        </p>
      ) : null}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </div>
    </section>
  );
}

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
  return toNonterminalStage(stage);
}

export async function retryFailureMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const code = isRecord(body) && isRecord(body.error) ? body.error.code : null;

    if (response.status === 400) {
      return "Retry request was invalid.";
    }

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

function toNonterminalStage(
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
