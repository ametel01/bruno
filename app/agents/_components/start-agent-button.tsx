"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";
import {
  acquireAgentActionRequestLatch,
  releaseAgentActionRequestLatch,
} from "./agent-action-request-latch";

type StartAgentButtonProps = {
  agentId: string;
  status: AgentLifecycleStatus;
  allowRuntimeStart?: boolean;
  label?: string;
  busyLabel?: string;
  requestedMessage?: string;
  failureMessage?: string;
  invalidStatusMessage?: string;
  disabledReason?: string | null;
};

type StartState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "polling"; message: string }
  | { status: "error"; message: string };

const STARTABLE_STATUSES = new Set<AgentLifecycleStatus>(["idle", "stopped", "error"]);

export function StartAgentButton(props: StartAgentButtonProps) {
  const resetKey = props.status === "running" && !props.allowRuntimeStart ? "complete" : "active";

  return <StartAgentButtonStateful key={`${props.agentId}:${resetKey}`} {...props} />;
}

function StartAgentButtonStateful({
  agentId,
  status,
  allowRuntimeStart = false,
  label = "Start",
  busyLabel = "Starting",
  requestedMessage = "Start requested.",
  failureMessage = "Agent could not be started.",
  invalidStatusMessage = "Agent cannot be started from its current status.",
  disabledReason = null,
}: StartAgentButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<StartState>({ status: "idle" });
  const requestLatchRef = useRef(false);

  useEffect(() => {
    if (state.status !== "polling" && status !== "starting") {
      return;
    }

    const refreshInterval = window.setInterval(() => {
      router.refresh();
    }, 350);

    return () => {
      window.clearInterval(refreshInterval);
    };
  }, [router, state.status, status]);

  async function handleStart() {
    if ((!STARTABLE_STATUSES.has(status) && !allowRuntimeStart) || requestLatchRef.current) {
      return;
    }

    if (!acquireAgentActionRequestLatch(requestLatchRef)) {
      return;
    }

    requestLatchRef.current = true;
    setState({ status: "requesting" });

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/actions/start`, {
        credentials: "same-origin",
        method: "POST",
      });

      if (!response.ok) {
        releaseAgentActionRequestLatch(requestLatchRef);
        setState({
          status: "error",
          message: await safeFailureMessage(response, invalidStatusMessage, failureMessage),
        });
        return;
      }

      setState({ status: "polling", message: requestedMessage });
      router.refresh();
    } catch {
      releaseAgentActionRequestLatch(requestLatchRef);
      setState({ status: "error", message: failureMessage });
    }
  }

  const startable = STARTABLE_STATUSES.has(status) || allowRuntimeStart;
  const busy = state.status === "requesting" || state.status === "polling" || status === "starting";
  const disabled = Boolean(disabledReason) || !startable || busy;
  const buttonLabel = getButtonLabel(
    allowRuntimeStart && status === "running" ? "stopped" : status,
    state.status,
    label,
    busyLabel,
  );

  return (
    <div className="start-agent-action">
      <button
        aria-busy={busy}
        className="secondary-button"
        type="button"
        disabled={disabled}
        onClick={handleStart}
      >
        {buttonLabel}
      </button>
      {state.status === "polling" || state.status === "error" ? (
        <span className={`action-message ${state.status}`} role="status">
          {state.message}
        </span>
      ) : disabledReason ? (
        <span className="action-message" role="status">
          {disabledReason}
        </span>
      ) : null}
    </div>
  );
}

function getButtonLabel(
  status: AgentLifecycleStatus,
  state: StartState["status"],
  label: string,
  busyLabel: string,
): string {
  if (state === "requesting" || state === "polling" || status === "starting") {
    return busyLabel;
  }

  if (status === "running") {
    return "Running";
  }

  return label;
}

async function safeFailureMessage(
  response: Response,
  invalidStatusMessage: string,
  fallbackMessage: string,
): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: unknown;
      };
    };

    if (body.error?.code === "hermes_setup_incomplete") {
      return "Complete Hermes setup before starting this agent.";
    }

    if (body.error?.code === "invalid_agent_status") {
      return invalidStatusMessage;
    }

    if (body.error?.code === "agent_not_found") {
      return "Agent could not be found.";
    }

    if (body.error?.code === "no_online_runner") {
      return "No online runner is available yet.";
    }

    if (body.error?.code === "runner_capacity_reached") {
      return "Runner capacity reached.";
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe JSON.
  }

  return fallbackMessage;
}
