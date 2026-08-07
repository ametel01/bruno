import Link from "next/link";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";
import {
  buildDeploymentPresentation,
  type PublicAgentDeployment,
  type PublicAgentDesiredStatus,
} from "@/src/shared/agent-deployment-presentation";
import type { PublicAgentRuntimePresentation } from "@/src/shared/agent-runtime-presentation";
import { buildAgentLifecycleActionPlan } from "./agent-lifecycle-action-plan";
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
  runtime?: PublicAgentRuntimePresentation | null;
  detailHref?: string;
  startDisabledReason?: string | null;
  restartDisabledReason?: string | null;
};

export function AgentLifecycleControls({
  agentId,
  deployment = null,
  runtime = null,
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
    desiredStatus,
    hasDeployment: deployment !== null,
    presentation,
    runtime,
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
          allowRuntimeStart={runtime?.kind === "intentionally_stopped"}
          busyLabel={actions.startBusyLabel}
          disabledReason={startDisabledReason}
          label={actions.startLabel}
          requestedMessage={actions.startRequestedMessage}
          status={status}
        />
      ) : null}
      {actions.showStop ? (
        <StopAgentButton agentId={agentId} allowRuntimeStop={runtime !== null} status={status} />
      ) : null}
      {actions.showRestart ? (
        <RestartAgentButton
          agentId={agentId}
          allowRuntimeRestart={runtime !== null && actions.showRestart}
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
