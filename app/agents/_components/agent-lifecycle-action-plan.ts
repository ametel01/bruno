import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";
import type {
  DeploymentPresentation,
  PublicAgentDesiredStatus,
} from "@/src/shared/agent-deployment-presentation";
import type { PublicAgentRuntimePresentation } from "@/src/shared/agent-runtime-presentation";

type AgentLifecycleActionPlan = {
  showDelete: boolean;
  showRestart: boolean;
  showRetryDetail: boolean;
  showStart: boolean;
  showStop: boolean;
  showStopSetup: boolean;
  startBusyLabel: "Starting" | "Resuming";
  startLabel: "Start" | "Resume";
  startRequestedMessage: "Start requested." | "Resume requested.";
};

const SETUP_CANCELLABLE_STATUSES = new Set<AgentLifecycleStatus>([
  "starting",
  "running",
  "restarting",
]);

export function buildAgentLifecycleActionPlan(input: {
  desiredStatus?: PublicAgentDesiredStatus;
  hasDeployment: boolean;
  presentation: DeploymentPresentation;
  runtime?: PublicAgentRuntimePresentation | null;
  status: AgentLifecycleStatus;
}): AgentLifecycleActionPlan {
  const { desiredStatus = "stopped", hasDeployment, presentation, runtime = null, status } = input;
  const resume = presentation.kind === "stopped" && hasDeployment;
  const base = {
    showDelete: status !== "deleting",
    showRestart: false,
    showRetryDetail: false,
    showStart: false,
    showStop: false,
    showStopSetup: false,
    startBusyLabel: resume ? ("Resuming" as const) : ("Starting" as const),
    startLabel: resume ? ("Resume" as const) : ("Start" as const),
    startRequestedMessage: resume ? ("Resume requested." as const) : ("Start requested." as const),
  };

  if (status === "deleting") {
    return base;
  }

  if (runtime !== null) {
    switch (runtime.kind) {
      case "healthy":
        return { ...base, showRestart: true, showStop: true };
      case "recovering":
        return { ...base, showStop: true };
      case "stopping":
        return base;
      case "intentionally_stopped":
        return {
          ...base,
          showStart: true,
          startBusyLabel: "Resuming",
          startLabel: "Resume",
          startRequestedMessage: "Resume requested.",
        };
      case "attention_required":
        return { ...base, showRestart: true, showStop: true };
      case "unavailable":
        return desiredStatus === "running" ? { ...base, showStop: true } : base;
    }
  }

  if (
    presentation.kind === "progress" ||
    presentation.kind === "recovery" ||
    presentation.kind === "updating"
  ) {
    return {
      ...base,
      showStopSetup:
        SETUP_CANCELLABLE_STATUSES.has(status) ||
        ((presentation.kind === "progress" || presentation.kind === "recovery") &&
          status === "stopped"),
    };
  }

  if (presentation.kind === "failed" && presentation.canRetry) {
    return { ...base, showRetryDetail: true, showStop: true };
  }

  if (presentation.kind === "ready") {
    return { ...base, showRestart: true, showStop: true };
  }

  if (presentation.kind === "stopped" || presentation.kind === "manual") {
    return { ...base, showStart: true };
  }

  return base;
}
