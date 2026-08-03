import Link from "next/link";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";
import {
  buildDeploymentPresentation,
  type DeploymentPresentation,
  type PublicAgentDeployment,
  type PublicAgentDesiredStatus,
} from "@/src/shared/agent-deployment-presentation";
import { DeleteAgentButton } from "./delete-agent-button";
import { RestartAgentButton } from "./restart-agent-button";
import { SimulateErrorAgentButton } from "./simulate-error-agent-button";
import { StartAgentButton } from "./start-agent-button";
import { StopAgentButton } from "./stop-agent-button";

type AgentLifecycleControlsProps = {
  agentId: string;
  status: AgentLifecycleStatus;
  desiredStatus?: PublicAgentDesiredStatus;
  deployment?: PublicAgentDeployment | null;
  detailHref?: string;
  startDisabledReason?: string | null;
  restartDisabledReason?: string | null;
};

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

export function AgentLifecycleControls({
  agentId,
  deployment = null,
  desiredStatus = "stopped",
  detailHref,
  status,
  startDisabledReason = null,
  restartDisabledReason = null,
}: AgentLifecycleControlsProps) {
  const presentation = buildDeploymentPresentation({
    deployment,
    desiredStatus,
    observedStatus: status,
  });
  const actions = buildAgentLifecycleActionPlan({
    hasDeployment: deployment !== null,
    presentation,
    status,
  });

  return (
    <div className="agent-lifecycle-actions">
      {actions.showStopSetup ? (
        <StopAgentButton
          agentId={agentId}
          allowSetupCancel={true}
          label="Stop setup"
          status={status}
        />
      ) : null}
      {actions.showRetryDetail ? (
        <Link
          className="secondary-button"
          href={detailHref ?? `/agents/${encodeURIComponent(agentId)}`}
        >
          Retry
        </Link>
      ) : null}
      {actions.showStart ? (
        <StartAgentButton
          agentId={agentId}
          busyLabel={actions.startBusyLabel}
          disabledReason={startDisabledReason}
          label={actions.startLabel}
          requestedMessage={actions.startRequestedMessage}
          status={status}
        />
      ) : null}
      {actions.showStop ? <StopAgentButton agentId={agentId} status={status} /> : null}
      {actions.showRestart ? (
        <RestartAgentButton
          agentId={agentId}
          disabledReason={restartDisabledReason}
          status={status}
        />
      ) : null}
      {process.env.NODE_ENV !== "production" ? (
        <SimulateErrorAgentButton agentId={agentId} status={status} />
      ) : null}
      {actions.showDelete ? <DeleteAgentButton agentId={agentId} status={status} /> : null}
    </div>
  );
}

export function buildAgentLifecycleActionPlan(input: {
  hasDeployment: boolean;
  presentation: DeploymentPresentation;
  status: AgentLifecycleStatus;
}): AgentLifecycleActionPlan {
  const { hasDeployment, presentation, status } = input;
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

  if (presentation.kind === "progress" || presentation.kind === "updating") {
    return {
      ...base,
      showStopSetup:
        SETUP_CANCELLABLE_STATUSES.has(status) ||
        (presentation.kind === "progress" && status === "stopped"),
    };
  }

  if (presentation.kind === "failed" && presentation.canRetry) {
    return { ...base, showRetryDetail: true };
  }

  if (presentation.kind === "ready") {
    return { ...base, showRestart: true, showStop: true };
  }

  if (presentation.kind === "stopped" || presentation.kind === "manual") {
    return { ...base, showStart: true };
  }

  return base;
}
