import type { AgentLogPage } from "@/src/server/logs/agent-logs";
import type { AgentLaunchSpec } from "@/src/server/agents/agent-launch-spec";

export type RunnerLogStreamInput = {
  agentId: string;
  processId?: string;
  containerId?: string;
  after?: number;
  limit?: number;
};

export interface RunnerAdapter<TStartResult, TStopResult, TRestartResult, TStatusResult> {
  start(agentId: string, launchSpec: AgentLaunchSpec | null): Promise<TStartResult>;
  stop(agentId: string): Promise<TStopResult>;
  restart(agentId: string, launchSpec: AgentLaunchSpec | null): Promise<TRestartResult>;
  status(agentId: string): Promise<TStatusResult>;
  streamLogs(input: RunnerLogStreamInput): Promise<AgentLogPage>;
}
