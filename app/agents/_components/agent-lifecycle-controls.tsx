import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";
import { DeleteAgentButton } from "./delete-agent-button";
import { RestartAgentButton } from "./restart-agent-button";
import { SimulateErrorAgentButton } from "./simulate-error-agent-button";
import { StartAgentButton } from "./start-agent-button";
import { StopAgentButton } from "./stop-agent-button";

type AgentLifecycleControlsProps = {
  agentId: string;
  status: AgentLifecycleStatus;
};

export function AgentLifecycleControls({ agentId, status }: AgentLifecycleControlsProps) {
  return (
    <div className="agent-lifecycle-actions">
      <StartAgentButton agentId={agentId} status={status} />
      {status === "running" ? <StopAgentButton agentId={agentId} status={status} /> : null}
      <RestartAgentButton agentId={agentId} status={status} />
      {process.env.NODE_ENV !== "production" ? (
        <SimulateErrorAgentButton agentId={agentId} status={status} />
      ) : null}
      <DeleteAgentButton agentId={agentId} status={status} />
    </div>
  );
}
