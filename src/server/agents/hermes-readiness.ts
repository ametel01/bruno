import type { AgentDetailConfig } from "@/src/server/agents/list-agents";
import type { AgentSecretStatus } from "@/src/server/agents/agent-secrets";
import type { AssignedManualRunnerStatusSummary } from "@/src/server/runners/manual-runner-status";

export const OPENROUTER_MODEL_OPTIONS = [
  {
    value: "openai/gpt-4.1-mini",
    label: "OpenAI GPT-4.1 Mini",
    context: "1M context",
  },
  {
    value: "anthropic/claude-sonnet-4",
    label: "Claude Sonnet 4",
    context: "200K context",
  },
  {
    value: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    context: "1M context",
  },
] as const;

export type HermesReadinessRequirementStatus = "ready" | "missing" | "blocked";

export type HermesReadinessRequirement = {
  id:
    | "model_provider"
    | "model_name"
    | "openrouter_api_key"
    | "telegram_bot_token"
    | "telegram_allowed_users"
    | "api_server_key"
    | "runner";
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

const REQUIRED_SECRET_LABELS = {
  openrouter_api_key: "OpenRouter API key",
  telegram_bot_token: "Telegram bot token",
  telegram_allowed_users: "Telegram allowed users",
  api_server_key: "Agent API server key",
} as const;

const REQUIRED_SECRET_KINDS = [
  "openrouter_api_key",
  "telegram_bot_token",
  "telegram_allowed_users",
  "api_server_key",
] as const;

export function buildHermesSetupReadiness(input: {
  config: AgentDetailConfig;
  secretStatuses: AgentSecretStatus[];
  assignedRunner: AssignedManualRunnerStatusSummary | null;
}): HermesSetupReadiness {
  const requirements: HermesReadinessRequirement[] = [
    modelProviderRequirement(input.config),
    modelNameRequirement(input.config),
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
      : (firstBlocker?.message ?? "Complete Hermes setup before starting this agent."),
    requirements,
  };
}

export function hermesConfigurationBlocker(input: {
  modelProvider: string;
  modelName: string;
  secretKinds: Set<string>;
}): string | null {
  if (input.modelProvider !== "openrouter") {
    return "Select OpenRouter as the model provider before starting this Hermes agent.";
  }

  if (!isConfiguredModelName(input.modelName)) {
    return "Select an OpenRouter model before starting this Hermes agent.";
  }

  for (const kind of REQUIRED_SECRET_KINDS) {
    if (!input.secretKinds.has(kind)) {
      return `Configure ${REQUIRED_SECRET_LABELS[kind]} before starting this Hermes agent.`;
    }
  }

  return null;
}

function modelProviderRequirement(config: AgentDetailConfig): HermesReadinessRequirement {
  const ready = config.modelProvider === "openrouter";

  return {
    id: "model_provider",
    label: "Model provider",
    status: ready ? "ready" : "missing",
    message: ready
      ? "OpenRouter is selected."
      : "Select OpenRouter as the model provider before starting this Hermes agent.",
    updatedAt: config.updatedAt,
  };
}

function modelNameRequirement(config: AgentDetailConfig): HermesReadinessRequirement {
  const ready = isConfiguredModelName(config.modelName);

  return {
    id: "model_name",
    label: "OpenRouter model",
    status: ready ? "ready" : "missing",
    message: ready
      ? `Model ${config.modelName} is selected.`
      : "Select an OpenRouter model before starting this Hermes agent.",
    updatedAt: config.updatedAt,
  };
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
        : `Configure ${REQUIRED_SECRET_LABELS[kind]} before starting this Hermes agent.`,
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
      message: "No runner is assigned yet; AgentBay will select an eligible runner on start.",
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

function isConfiguredModelName(modelName: string): boolean {
  const normalized = modelName.trim();

  return normalized.length > 0 && normalized !== "not_configured";
}
