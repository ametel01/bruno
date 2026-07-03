"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";

type DeleteAgentButtonProps = {
  agentId: string;
  status: AgentLifecycleStatus;
};

type DeleteState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "error"; message: string };

const DELETABLE_STATUSES = new Set<AgentLifecycleStatus>(["idle", "running", "stopped", "error"]);

export function DeleteAgentButton({ agentId, status }: DeleteAgentButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<DeleteState>({ status: "idle" });

  async function handleDelete() {
    if (!DELETABLE_STATUSES.has(status)) {
      return;
    }

    setState({ status: "requesting" });

    try {
      const response = await fetch(`/api/agents/${agentId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      router.push("/agents");
      router.refresh();
    } catch {
      setState({ status: "error", message: "Agent could not be deleted." });
    }
  }

  if (!DELETABLE_STATUSES.has(status) && state.status !== "error") {
    return null;
  }

  return (
    <div className="start-agent-action">
      {DELETABLE_STATUSES.has(status) ? (
        <button
          className="secondary-button danger-button"
          type="button"
          disabled={state.status === "requesting"}
          onClick={handleDelete}
        >
          {state.status === "requesting" ? "Deleting" : "Delete"}
        </button>
      ) : null}
      {state.status === "error" ? (
        <span className="action-message error" role="status">
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
      return "Agent cannot be deleted from its current status.";
    }

    if (body.error?.code === "agent_not_found") {
      return "Agent could not be found.";
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe JSON.
  }

  return "Agent could not be deleted.";
}
