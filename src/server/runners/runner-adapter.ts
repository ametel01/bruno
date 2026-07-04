import type { AgentLogPage } from "@/src/server/logs/agent-logs";

export type RunnerLogStreamInput = {
  agentId: string;
  processId?: string;
  containerId?: string;
  after?: number;
  limit?: number;
};

export interface RunnerAdapter<TStartResult, TStopResult, TRestartResult, TStatusResult> {
  start(agentId: string): Promise<TStartResult>;
  stop(agentId: string): Promise<TStopResult>;
  restart(agentId: string): Promise<TRestartResult>;
  status(agentId: string): Promise<TStatusResult>;
  streamLogs(input: RunnerLogStreamInput): Promise<AgentLogPage>;
}
