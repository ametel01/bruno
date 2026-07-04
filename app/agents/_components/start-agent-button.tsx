"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";

type StartAgentButtonProps = {
  agentId: string;
  status: AgentLifecycleStatus;
};

type StartState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "polling"; message: string }
  | { status: "error"; message: string };

const STARTABLE_STATUSES = new Set<AgentLifecycleStatus>(["idle", "stopped", "error"]);

export function StartAgentButton({ agentId, status }: StartAgentButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<StartState>({ status: "idle" });

  useEffect(() => {
    if (status === "running") {
      setState({ status: "idle" });
      return;
    }

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
    if (!STARTABLE_STATUSES.has(status)) {
      return;
    }

    setState({ status: "requesting" });

    try {
      const response = await fetch(`/api/agents/${agentId}/actions/start`, {
        method: "POST",
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "polling", message: "Start requested." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Agent could not be started." });
    }
  }

  const startable = STARTABLE_STATUSES.has(status);
  const busy = state.status === "requesting" || state.status === "polling" || status === "starting";
  const disabled = !startable || busy;
  const label = getButtonLabel(status, state.status);

  return (
    <div className="start-agent-action">
      <button className="secondary-button" type="button" disabled={disabled} onClick={handleStart}>
        {label}
      </button>
      {state.status === "polling" || state.status === "error" ? (
        <span className={`action-message ${state.status}`} role="status">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

function getButtonLabel(status: AgentLifecycleStatus, state: StartState["status"]): string {
  if (state === "requesting" || state === "polling" || status === "starting") {
    return "Starting";
  }

  if (status === "running") {
    return "Running";
  }

  return "Start";
}

async function safeFailureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: unknown;
      };
    };

    if (body.error?.code === "invalid_agent_status") {
      return "Agent cannot be started from its current status.";
    }

    if (body.error?.code === "agent_not_found") {
      return "Agent could not be found.";
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe JSON.
  }

  return "Agent could not be started.";
}
