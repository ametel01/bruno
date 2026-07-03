"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";

type StopAgentButtonProps = {
  agentId: string;
  status: AgentLifecycleStatus;
};

type StopState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "completed"; message: string }
  | { status: "error"; message: string };

export function StopAgentButton({ agentId, status }: StopAgentButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<StopState>({ status: "idle" });

  async function handleStop() {
    if (status !== "running") {
      return;
    }

    setState({ status: "requesting" });

    try {
      const response = await fetch(`/api/agents/${agentId}/actions/stop`, {
        method: "POST",
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "completed", message: "Agent stopped." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Agent could not be stopped." });
    }
  }

  const disabled = status !== "running" || state.status === "requesting";

  return (
    <div className="start-agent-action">
      <button className="secondary-button" type="button" disabled={disabled} onClick={handleStop}>
        {state.status === "requesting" ? "Stopping" : "Stop"}
      </button>
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
