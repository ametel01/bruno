"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";
import {
  acquireAgentActionRequestLatch,
  releaseAgentActionRequestLatch,
} from "./agent-action-request-latch";

type StopAgentButtonProps = {
  agentId: string;
  status: AgentLifecycleStatus;
  allowSetupCancel?: boolean;
  allowRuntimeStop?: boolean;
  label?: string;
  requireConfirmation?: boolean;
};

type StopState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "requesting" }
  | { status: "refreshing" }
  | { status: "error"; message: string };

const SETUP_CANCELLABLE_STATUSES = new Set<AgentLifecycleStatus>([
  "starting",
  "running",
  "restarting",
  "stopped",
]);

export function StopAgentButton({
  allowSetupCancel = false,
  allowRuntimeStop = false,
  agentId,
  label = "Stop",
  status,
  requireConfirmation = false,
}: StopAgentButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<StopState>({ status: "idle" });
  const requestLatchRef = useRef(false);
  const canStop =
    status === "running" ||
    (allowSetupCancel && SETUP_CANCELLABLE_STATUSES.has(status)) ||
    (allowRuntimeStop && status !== "deleting");

  async function handleStop() {
    if (!canStop) {
      return;
    }

    if (requireConfirmation && state.status !== "confirming") {
      setState({ status: "confirming" });
      return;
    }

    if (!acquireAgentActionRequestLatch(requestLatchRef)) {
      return;
    }

    setState({ status: "requesting" });

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/actions/stop`, {
        credentials: "same-origin",
        method: "POST",
      });

      if (!response.ok) {
        releaseAgentActionRequestLatch(requestLatchRef);
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "refreshing" });
      router.refresh();
    } catch {
      releaseAgentActionRequestLatch(requestLatchRef);
      setState({ status: "error", message: "Agent could not be stopped." });
    }
  }

  const busy = state.status === "requesting" || state.status === "refreshing";
  const disabled = !canStop || busy;
  const buttonLabel = getButtonLabel(state.status, requireConfirmation, label);

  return (
    <div className="start-agent-action">
      <button
        aria-busy={busy}
        className="secondary-button"
        type="button"
        disabled={disabled}
        onClick={handleStop}
      >
        {buttonLabel}
      </button>
      {state.status === "confirming" ? (
        <button
          className="secondary-button"
          type="button"
          onClick={() => {
            setState({ status: "idle" });
          }}
        >
          Cancel
        </button>
      ) : null}
      {state.status === "confirming" ? (
        <span className="action-message" role="status">
          Confirm to stop this running agent.
        </span>
      ) : null}
      {state.status === "refreshing" || state.status === "error" ? (
        <span className={`action-message ${state.status}`} role="status">
          {state.status === "refreshing" ? "Refreshing status." : state.message}
        </span>
      ) : null}
    </div>
  );
}

function getButtonLabel(
  state: StopState["status"],
  requireConfirmation: boolean,
  label: string,
): string {
  if (state === "requesting") {
    return "Stopping";
  }

  if (state === "refreshing") {
    return "Refreshing status";
  }

  if (requireConfirmation && state === "confirming") {
    return "Confirm stop";
  }

  return label;
}

async function safeFailureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: unknown;
      };
    };

    if (body.error?.code === "invalid_agent_status") {
      return "Agent cannot be stopped from its current status.";
    }

    if (body.error?.code === "agent_not_found") {
      return "Agent could not be found.";
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe JSON.
  }

  return "Agent could not be stopped.";
}
