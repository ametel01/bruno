export type HermesReadinessRequirementStatus = "ready" | "missing" | "blocked";

export type HermesReadinessRequirement = {
  id: "api_server_key" | "runner";
  label: string;
  status: HermesReadinessRequirementStatus;
  message: string;
  updatedAt: string | null;
};

export type HermesSetupReadiness = {
  requiresHermesSetup: boolean;
  configurationReady: boolean;
  runnerReady: boolean;
  startReady: boolean;
  startDisabledReason: string | null;
  requirements: HermesReadinessRequirement[];
};
