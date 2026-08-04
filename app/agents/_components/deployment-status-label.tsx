import {
  buildDeploymentPresentation,
  type PublicAgentDeployment,
  type PublicAgentDesiredStatus,
  type PublicAgentLifecycleStatus,
} from "@/src/shared/agent-deployment-presentation";
import type { PublicAgentRuntimePresentation } from "@/src/shared/agent-runtime-presentation";

type DeploymentStatusLabelProps = {
  deployment: PublicAgentDeployment | null;
  desiredStatus: PublicAgentDesiredStatus;
  observedStatus: PublicAgentLifecycleStatus;
  runtime?: PublicAgentRuntimePresentation | null;
  href?: string;
};

export function DeploymentStatusLabel({
  deployment,
  desiredStatus,
  observedStatus,
  runtime = null,
  href,
}: DeploymentStatusLabelProps) {
  const presentation = buildDeploymentPresentation({
    deployment,
    desiredStatus,
    observedStatus,
  });

  const currentRuntime = deployment?.stage === "ready" ? runtime : null;
  const content = currentRuntime ? (
    <>
      <span className="deployment-status-label" data-tone={runtimeTone(currentRuntime.kind)}>
        {currentRuntime.label}
      </span>
      <small className="deployment-status-stage">Current runtime</small>
    </>
  ) : (
    <>
      <span className="deployment-status-label" data-tone={presentation.tone}>
        {presentation.label}
      </span>
      {presentation.deployment ? (
        <small className="deployment-status-stage">
          {presentation.kind === "recovery"
            ? "Automatic recovery"
            : presentation.deployment.stage === "failed"
              ? "Terminal operation"
              : "Latest operation"}
        </small>
      ) : null}
    </>
  );

  if (!href) {
    return <span className="deployment-status-summary">{content}</span>;
  }

  return (
    <a className="deployment-status-summary deployment-status-link" href={href}>
      {content}
    </a>
  );
}

function runtimeTone(
  kind: PublicAgentRuntimePresentation["kind"],
): "active" | "ready" | "failed" | "stopped" | "unknown" {
  switch (kind) {
    case "healthy":
      return "ready";
    case "recovering":
    case "stopping":
      return "active";
    case "attention_required":
      return "failed";
    case "intentionally_stopped":
      return "stopped";
    case "unavailable":
      return "unknown";
  }
}
