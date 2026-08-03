import type { PublicAgentDeployment } from "@/src/shared/agent-deployment-presentation";

export type AgentUiLifecycleStatus =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "stopped"
  | "error"
  | "deleting";

export type ListedAgentUi = {
  id: string;
  name: string;
  templateKey: string;
  templateVersion: string;
  templateLabel: string;
  status: AgentUiLifecycleStatus;
  desiredStatus: "stopped" | "running";
  latestDeployment: PublicAgentDeployment | null;
  assignedRunnerKind?: string | null;
  assignedRunnerStatus?: string | null;
  assignedRunnerProvisioningStatus?: string | null;
  href: string;
  createdAt: string;
};

export type AgentDetailConfigUi = {
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  maxDailySpendCents: number;
  scheduleMode: "manual" | "cron";
  scheduleCron: string | null;
  timezone: string;
  updatedAt: string;
};
