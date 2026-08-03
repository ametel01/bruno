"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseSafeRuntimeGetBody,
  runtimePollDelayMs,
  type PublicAgentRuntimePresentation,
} from "@/src/shared/agent-runtime-presentation";
import {
  foregroundPollingElapsedMs,
  pauseForegroundPollingWindow,
  resumeForegroundPollingWindow,
  startForegroundPollingWindow,
  type ForegroundPollingWindow,
} from "@/src/shared/deployment-polling-state";

type AgentRuntimeStatusProps = {
  agentId: string;
  initialRuntime: PublicAgentRuntimePresentation;
};

type RuntimeObservation =
  | { kind: "current"; failures: number }
  | { kind: "degraded"; failures: number }
  | { kind: "paused"; failures: number };

export const RUNTIME_POLL_FOREGROUND_LIMIT_MS = 30 * 60_000;

const SAFE_UNAVAILABLE_RUNTIME: PublicAgentRuntimePresentation = {
  kind: "unavailable",
  action: "wait",
  label: "Unavailable",
  message: "Runtime state could not be verified safely.",
};

export function AgentRuntimeStatus({ agentId, initialRuntime }: AgentRuntimeStatusProps) {
  const router = useRouter();
  const [runtime, setRuntime] = useState(initialRuntime);
  const [observation, setObservation] = useState<RuntimeObservation>({
    kind: "current",
    failures: 0,
  });
  const [liveMessage, setLiveMessage] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const runtimeRef = useRef(initialRuntime);
  const failureCountRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestEpochRef = useRef(0);
  const pollRef = useRef<() => void>(() => {});
  const foregroundRef = useRef<ForegroundPollingWindow>(startForegroundPollingWindow(Date.now()));

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pauseForeground = useCallback(() => {
    foregroundRef.current = pauseForegroundPollingWindow(foregroundRef.current, Date.now());
  }, []);

  const resumeForeground = useCallback((reset: boolean) => {
    foregroundRef.current = resumeForegroundPollingWindow(foregroundRef.current, Date.now(), {
      reset,
    });
  }, []);

  const schedule = useCallback(() => {
    clearTimer();

    if (document.hidden || !navigator.onLine) {
      return;
    }

    const elapsed = foregroundPollingElapsedMs(foregroundRef.current, Date.now());
    if (elapsed >= RUNTIME_POLL_FOREGROUND_LIMIT_MS) {
      setObservation((current) => ({ kind: "paused", failures: current.failures }));
      return;
    }

    timerRef.current = window.setTimeout(() => pollRef.current(), runtimePollDelayMs(elapsed));
  }, [clearTimer]);

  const recordFailure = useCallback(() => {
    const failures = failureCountRef.current + 1;
    failureCountRef.current = failures;
    if (failures >= 3) {
      runtimeRef.current = SAFE_UNAVAILABLE_RUNTIME;
      setRuntime(SAFE_UNAVAILABLE_RUNTIME);
      setLiveMessage(SAFE_UNAVAILABLE_RUNTIME.label);
      setObservation({ kind: "degraded", failures });
      return;
    }
    setObservation({ kind: "current", failures });
  }, []);

  const poll = useCallback(async () => {
    clearTimer();

    if (document.hidden || !navigator.onLine || requestRef.current !== null) {
      return;
    }

    const requestEpoch = requestEpochRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    setIsFetching(true);

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/runtime`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (requestEpoch !== requestEpochRef.current) {
        return;
      }

      if (!response.ok) {
        if ([401, 403, 404, 503].includes(response.status)) {
          runtimeRef.current = SAFE_UNAVAILABLE_RUNTIME;
          failureCountRef.current = 3;
          setRuntime(SAFE_UNAVAILABLE_RUNTIME);
          setObservation({ kind: "degraded", failures: 3 });
          setLiveMessage(SAFE_UNAVAILABLE_RUNTIME.label);
          return;
        }
        recordFailure();
        return;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        recordFailure();
        return;
      }

      const parsed = parseSafeRuntimeGetBody(body);
      if (!parsed.ok || parsed.runtime === null) {
        runtimeRef.current = SAFE_UNAVAILABLE_RUNTIME;
        failureCountRef.current = 3;
        setRuntime(SAFE_UNAVAILABLE_RUNTIME);
        setObservation({ kind: "degraded", failures: 3 });
        setLiveMessage(SAFE_UNAVAILABLE_RUNTIME.label);
        return;
      }

      const previous = runtimeRef.current;
      const changed = !sameRuntimePresentation(previous, parsed.runtime);
      runtimeRef.current = parsed.runtime;
      failureCountRef.current = 0;
      setRuntime(parsed.runtime);
      setObservation({ kind: "current", failures: 0 });
      if (changed) {
        setLiveMessage(parsed.runtime.label);
        router.refresh();
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        recordFailure();
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
      }
      if (requestEpoch === requestEpochRef.current) {
        setIsFetching(false);
        schedule();
      }
    }
  }, [agentId, clearTimer, recordFailure, router, schedule]);

  useEffect(() => {
    pollRef.current = () => void poll();
  }, [poll]);

  useEffect(() => {
    requestEpochRef.current += 1;
    runtimeRef.current = initialRuntime;
    failureCountRef.current = 0;
    setRuntime(initialRuntime);
    setObservation({ kind: "current", failures: 0 });
    resumeForeground(true);
  }, [initialRuntime, resumeForeground]);

  useEffect(() => {
    void poll();
    return () => {
      requestEpochRef.current += 1;
      clearTimer();
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [clearTimer, poll]);

  useEffect(() => {
    const resume = () => {
      if (!document.hidden && navigator.onLine) {
        resumeForeground(false);
        void poll();
      } else {
        pauseForeground();
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
  }, [clearTimer, pauseForeground, poll, resumeForeground]);

  return (
    <section
      className="agent-runtime-status-card"
      aria-labelledby="runtime-status-title"
      aria-busy={isFetching}
      data-runtime-kind={runtime.kind}
    >
      <div className="agent-runtime-status-header">
        <div>
          <p>Current managed runtime</p>
          <h2 id="runtime-status-title">{runtime.label}</h2>
        </div>
        <span className="runtime-status-pill" data-kind={runtime.kind}>
          {runtime.label}
        </span>
      </div>
      <p>{runtime.message}</p>
      {observation.kind === "degraded" ? (
        <p className="safe-error" role="status">
          Runtime updates are temporarily unavailable. Showing a conservative status.
        </p>
      ) : observation.kind === "paused" ? (
        <p className="action-message" role="status">
          Automatic runtime updates paused. Refresh to check again.
        </p>
      ) : null}
      <span className="visually-hidden" aria-atomic="true" aria-live="polite">
        {liveMessage}
      </span>
    </section>
  );
}

function sameRuntimePresentation(
  left: PublicAgentRuntimePresentation,
  right: PublicAgentRuntimePresentation,
): boolean {
  return (
    left.kind === right.kind &&
    left.action === right.action &&
    left.label === right.label &&
    left.message === right.message
  );
}
