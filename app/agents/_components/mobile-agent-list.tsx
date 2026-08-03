import Link from "next/link";
import type { ListedAgentUi } from "@/src/shared/agent-ui-types";
import { AgentLifecycleControls } from "./agent-lifecycle-controls";
import { listedAgentStartDisabledReason } from "./agent-start-readiness";
import { DeploymentStatusLabel } from "./deployment-status-label";

type MobileAgentListProps = {
  agents: ListedAgentUi[];
};

export function MobileAgentList({ agents }: MobileAgentListProps) {
  return (
    <ol className="mobile-agent-list" aria-label="Mobile agent status controls">
      {agents.map((agent) => (
        <li className="mobile-agent-card" key={agent.id}>
          <div className="mobile-agent-card-header">
            <div className="mobile-agent-title-group">
              <Link href={agent.href}>{agent.name}</Link>
              <span className="mobile-agent-template">{agent.templateLabel}</span>
            </div>
            <span className="status-pill">{agent.status}</span>
          </div>
          <DeploymentStatusLabel
            deployment={agent.latestDeployment}
            desiredStatus={agent.desiredStatus}
            href={`${agent.href}#deployment-progress-title`}
            observedStatus={agent.status}
          />
          <dl className="mobile-agent-metadata">
            <div>
              <dt>Template key</dt>
              <dd>{agent.templateKey}</dd>
            </div>
            <div>
              <dt>ID</dt>
              <dd>
                <code>{agent.id}</code>
              </dd>
            </div>
          </dl>
          <Link
            className="secondary-button agent-config-link"
            href={`${agent.href}#configuration-title`}
          >
            Configure
          </Link>
          <MobileAgentActions agent={agent} />
        </li>
      ))}
    </ol>
  );
}

function MobileAgentActions({ agent }: { agent: ListedAgentUi }) {
  return (
    <div className="mobile-agent-actions">
      <AgentLifecycleControls
        agentId={agent.id}
        deployment={agent.latestDeployment}
        detailHref={`${agent.href}#deployment-progress-title`}
        desiredStatus={agent.desiredStatus}
        startDisabledReason={listedAgentStartDisabledReason(agent)}
        status={agent.status}
      />
    </div>
  );
}
