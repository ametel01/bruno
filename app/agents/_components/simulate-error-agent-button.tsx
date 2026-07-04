"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";

type SimulateErrorAgentButtonProps = {
  agentId: string;
  status: AgentLifecycleStatus;
};

type SimulateErrorState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "completed"; message: string }
  | { status: "error"; message: string };

const SIMULATE_ERROR_STATUSES = new Set<AgentLifecycleStatus>([
  "idle",
  "stopped",
  "starting",
  "running",
  "restarting",
]);

export function SimulateErrorAgentButton({ agentId, status }: SimulateErrorAgentButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<SimulateErrorState>({ status: "idle" });

  async function handleSimulateError() {
    if (!SIMULATE_ERROR_STATUSES.has(status)) {
      return;
    }

    setState({ status: "requesting" });

    try {
      const response = await fetch(`/api/agents/${agentId}/actions/simulate-error`, {
        method: "POST",
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "completed", message: "Simulated error recorded." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Agent error could not be simulated." });
    }
  }

  if (!SIMULATE_ERROR_STATUSES.has(status) && state.status !== "error") {
    return null;
  }

  return (
    <div className="start-agent-action">
      {SIMULATE_ERROR_STATUSES.has(status) ? (
        <button
          className="secondary-button danger-button"
          type="button"
          disabled={state.status === "requesting"}
          onClick={handleSimulateError}
        >
          {state.status === "requesting" ? "Simulating" : "Simulate error"}
        </button>
      ) : null}
      {state.status === "completed" || state.status === "error" ? (
        <span className={`action-message ${state.status}`} role="status">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

async function safeFailureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: unknown;
      };
    };

    if (body.error?.code === "development_only_action") {
      return "Simulated errors are unavailable in production.";
    }

    if (body.error?.code === "invalid_agent_status") {
      return "Agent cannot simulate an error from its current status.";
    }

    if (body.error?.code === "agent_not_found") {
      return "Agent could not be found.";
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe JSON.
  }

  return "Agent error could not be simulated.";
}
