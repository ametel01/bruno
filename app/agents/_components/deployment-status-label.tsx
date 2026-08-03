import {
  buildDeploymentPresentation,
  type PublicAgentDeployment,
  type PublicAgentDesiredStatus,
  type PublicAgentLifecycleStatus,
} from "@/src/shared/agent-deployment-presentation";

type DeploymentStatusLabelProps = {
  deployment: PublicAgentDeployment | null;
  desiredStatus: PublicAgentDesiredStatus;
  observedStatus: PublicAgentLifecycleStatus;
  href?: string;
};

export function DeploymentStatusLabel({
  deployment,
  desiredStatus,
  observedStatus,
  href,
}: DeploymentStatusLabelProps) {
  const presentation = buildDeploymentPresentation({
    deployment,
    desiredStatus,
    observedStatus,
  });

  const content = (
    <>
      <span className="deployment-status-label" data-tone={presentation.tone}>
        {presentation.label}
      </span>
      {presentation.deployment ? (
        <small className="deployment-status-stage">
          {presentation.deployment.stage === "failed" ? "Terminal operation" : "Latest operation"}
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
