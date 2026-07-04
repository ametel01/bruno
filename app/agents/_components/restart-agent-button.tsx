"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";

type RestartAgentButtonProps = {
  agentId: string;
  status: AgentLifecycleStatus;
};

type RestartState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "polling"; message: string }
  | { status: "error"; message: string };

const RESTART_SETTLE_FALLBACK_MS = 500;

export function RestartAgentButton({ agentId, status }: RestartAgentButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<RestartState>({ status: "idle" });
  const observedRestartingRef = useRef(false);
  const requestedAtRef = useRef(0);

  useEffect(() => {
    if (status === "restarting") {
      observedRestartingRef.current = true;
    }

    const restartHasHadTimeToSettle =
      requestedAtRef.current > 0 &&
      Date.now() - requestedAtRef.current >= RESTART_SETTLE_FALLBACK_MS;

    if (
      status === "running" &&
      state.status === "polling" &&
      (observedRestartingRef.current || restartHasHadTimeToSettle)
    ) {
      observedRestartingRef.current = false;
      requestedAtRef.current = 0;
      setState({ status: "idle" });
      return;
    }

    if (state.status !== "polling" && status !== "restarting") {
      return;
    }

    const refreshInterval = window.setInterval(() => {
      router.refresh();
    }, 350);

    return () => {
      window.clearInterval(refreshInterval);
    };
  }, [router, state.status, status]);

  async function handleRestart() {
    if (status !== "running") {
      return;
    }

    setState({ status: "requesting" });
    observedRestartingRef.current = false;
    requestedAtRef.current = Date.now();

    try {
      const response = await fetch(`/api/agents/${agentId}/actions/restart`, {
        method: "POST",
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "polling", message: "Restart requested." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Agent could not be restarted." });
    }
  }

  const busy =
    state.status === "requesting" || state.status === "polling" || status === "restarting";

  if (status !== "running" && !busy && state.status !== "error") {
    return null;
  }

  return (
    <div className="start-agent-action">
      {status === "running" || status === "restarting" ? (
        <button className="secondary-button" type="button" disabled={busy} onClick={handleRestart}>
          {busy ? "Restarting" : "Restart"}
        </button>
      ) : null}
      {state.status === "polling" || state.status === "error" ? (
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
      return "Agent cannot be restarted from its current status.";
    }

    if (body.error?.code === "agent_not_found") {
      return "Agent could not be found.";
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe JSON.
  }

  return "Agent could not be restarted.";
}
