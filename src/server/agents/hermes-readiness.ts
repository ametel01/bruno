import type { AgentSecretStatus } from "@/src/server/agents/agent-secrets";
import type { AssignedManualRunnerStatusSummary } from "@/src/server/runners/manual-runner-status";
import type { AgentDetailConfigUi } from "@/src/shared/agent-ui-types";
import type {
  HermesReadinessRequirement,
  HermesSetupReadiness,
} from "@/src/shared/hermes-readiness-types";

const REQUIRED_SECRET_LABELS = { api_server_key: "Agent API server key" } as const;
const REQUIRED_SECRET_KINDS = ["api_server_key"] as const;

export function buildHermesSetupReadiness(input: {
  config: AgentDetailConfigUi;
  secretStatuses: AgentSecretStatus[];
  assignedRunner: AssignedManualRunnerStatusSummary | null;
}): HermesSetupReadiness {
  const requirements: HermesReadinessRequirement[] = [
    ...secretRequirements(input.secretStatuses),
    runnerRequirement(input.assignedRunner),
  ];
  const configurationReady = requirements
    .filter((requirement) => requirement.id !== "runner")
    .every((requirement) => requirement.status === "ready");
  const runnerReady =
    requirements.find((requirement) => requirement.id === "runner")?.status !== "blocked";
  const startReady = configurationReady && runnerReady;
  const firstBlocker = requirements.find((requirement) => requirement.status !== "ready");

  return {
    requiresHermesSetup: true,
    configurationReady,
    runnerReady,
    startReady,
    startDisabledReason: startReady
      ? null
      : (firstBlocker?.message ?? "Run Hermes setup before starting this agent."),
    requirements,
  };
}

export function hermesConfigurationBlocker(input: {
  modelProvider: string;
  modelName: string;
  secretKinds: Set<string>;
}): string | null {
  for (const kind of REQUIRED_SECRET_KINDS) {
    if (!input.secretKinds.has(kind)) {
      return "Run Hermes setup before starting this agent.";
    }
  }

  return null;
}

function secretRequirements(secretStatuses: AgentSecretStatus[]): HermesReadinessRequirement[] {
  const statuses = new Map(secretStatuses.map((secret) => [secret.kind, secret]));

  return REQUIRED_SECRET_KINDS.map((kind) => {
    const secret = statuses.get(kind);
    const configured = secret?.configured === true && secret.status === "active";

    return {
      id: kind,
      label: REQUIRED_SECRET_LABELS[kind],
      status: configured ? "ready" : "missing",
      message: configured
        ? `${REQUIRED_SECRET_LABELS[kind]} is configured.`
        : "Run Hermes setup before starting this agent.",
      updatedAt: configured ? (secret.updatedAt ?? null) : null,
    };
  });
}

function runnerRequirement(
  runner: AssignedManualRunnerStatusSummary | null,
): HermesReadinessRequirement {
  if (!runner) {
    return {
      id: "runner",
      label: "Runner",
      status: "ready",
      message: "No runner is assigned yet; plingpling will select an eligible runner on start.",
      updatedAt: null,
    };
  }

  const ready =
    runner.status === "online" &&
    (runner.kind !== "digitalocean" || runner.provisioningStatus === "ready") &&
    runner.capacity.blocker === null;

  return {
    id: "runner",
    label: "Runner",
    status: ready ? "ready" : "blocked",
    message: ready ? "Assigned runner is ready." : "Assigned runner is not fully ready yet.",
    updatedAt: runner.lastSeenAt ?? runner.updatedAt,
  };
}
