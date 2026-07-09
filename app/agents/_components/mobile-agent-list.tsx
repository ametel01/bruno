import Link from "next/link";
import type { ListedAgent } from "@/src/server/agents/list-agents";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";
import { listedAgentStartDisabledReason } from "./agent-start-readiness";
import { StartAgentButton } from "./start-agent-button";
import { StopAgentButton } from "./stop-agent-button";

type MobileAgentListProps = {
  agents: ListedAgent[];
};

const RESUMABLE_STATUSES = new Set<AgentLifecycleStatus>(["idle", "stopped", "error"]);

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
          <MobileAgentActions
            agentId={agent.id}
            startDisabledReason={listedAgentStartDisabledReason(agent)}
            status={agent.status}
          />
        </li>
      ))}
    </ol>
  );
}

function MobileAgentActions({
  agentId,
  startDisabledReason,
  status,
}: {
  agentId: string;
  startDisabledReason: string | null;
  status: AgentLifecycleStatus;
}) {
  if (RESUMABLE_STATUSES.has(status)) {
    return (
      <div className="mobile-agent-actions">
        <StartAgentButton
          agentId={agentId}
          busyLabel="Resuming"
          disabledReason={startDisabledReason}
          failureMessage="Agent could not be resumed."
          invalidStatusMessage="Agent cannot be resumed from its current status."
          label="Resume"
          requestedMessage="Resume requested."
          status={status}
        />
      </div>
    );
  }

  if (status === "running") {
    return (
      <div className="mobile-agent-actions">
        <StopAgentButton agentId={agentId} requireConfirmation={true} status={status} />
      </div>
    );
  }

  return <p className="mobile-agent-muted-action">No quick action for {status}.</p>;
}
