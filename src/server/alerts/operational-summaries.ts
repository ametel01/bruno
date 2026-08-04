import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";

const MAX_SUMMARY_LENGTH = 180;
const MAX_ALERTS = 6;
const DATABASE_URL_PATTERN = /\b(?:postgres|postgresql):\/\/\S+/gi;
const STACK_FRAME_PATTERN = /^\s*at\s+\S+|\s+\(.+:\d+:\d+\)$/;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|authorization|bearer|client[_-]?secret|password|secret|token)\b\s*[:=]/i;
const ALERT_RELEVANT_EVENT_PATTERN = /\b(error|failed|failure|denied)\b/i;

export type OperationalAlertSeverity = "critical" | "warning" | "info";

export type OperationalAlert = {
  id: string;
  severity: OperationalAlertSeverity;
  title: string;
  message: string;
  createdAt: string | null;
  source: "agent" | "approval" | "event" | "runner";
};

export type OperationalAlertAgent = {
  id: string;
  name: string;
  status: AgentLifecycleStatus | string;
  statusReason: string | null;
};

export type OperationalAlertApproval = {
  id: string;
  agentId: string;
  title: string;
  requestedBy: string;
  expiresAt: string | null;
};

export type OperationalAlertEvent = {
  id: string;
  agentId: string;
  type: string;
  message: string;
  createdAt: string;
};

export type OperationalRunnerState = {
  status: "offline" | "degraded" | "online";
  message?: string | null;
  updatedAt?: string | null;
};

export type BuildAgentOperationalAlertsInput = {
  agent: OperationalAlertAgent;
  automaticRecoveryActive?: boolean;
  approvals: readonly OperationalAlertApproval[];
  events: readonly OperationalAlertEvent[];
  now?: Date;
  runnerState?: OperationalRunnerState | null;
};

export type BuildAgentOperationalAlertsResult = {
  alerts: OperationalAlert[];
  runnerStateNotice: string | null;
};

export function buildAgentOperationalAlerts(
  input: BuildAgentOperationalAlertsInput,
): BuildAgentOperationalAlertsResult {
  const now = input.now ?? new Date();
  const alerts: OperationalAlert[] = [];

  if (input.agent.status === "error") {
    alerts.push({
      id: `agent:${input.agent.id}:status`,
      severity: "critical",
      title: "Agent is in error",
      message: summarizeOperationalText(
        input.agent.statusReason,
        `Agent "${input.agent.name}" is currently in error.`,
      ),
      createdAt: null,
      source: "agent",
    });
  }

  if (
    !input.automaticRecoveryActive &&
    (input.runnerState?.status === "offline" || input.runnerState?.status === "degraded")
  ) {
    alerts.push({
      id: `runner:${input.agent.id}:${input.runnerState.status}`,
      severity: input.runnerState.status === "offline" ? "critical" : "warning",
      title: input.runnerState.status === "offline" ? "Runner is offline" : "Runner is degraded",
      message: summarizeOperationalText(
        input.runnerState.message,
        "Runner state requires operator attention.",
      ),
      createdAt: input.runnerState.updatedAt ?? null,
      source: "runner",
    });
  }

  for (const approval of input.approvals) {
    if (approval.agentId !== input.agent.id) {
      continue;
    }

    const expiresAt = parseOptionalTimestamp(approval.expiresAt);
    const expired = Boolean(expiresAt && expiresAt <= now);

    alerts.push({
      id: `approval:${approval.id}`,
      severity: expired ? "critical" : "warning",
      title: expired ? "Approval expired" : "Pending approval blocks progress",
      message: `${summarizeOperationalText(approval.title, "Approval request")} requested by ${summarizeOperationalText(
        approval.requestedBy,
        "unknown requester",
      )}.`,
      createdAt: approval.expiresAt,
      source: "approval",
    });
  }

  for (const event of input.events) {
    if (event.agentId !== input.agent.id || !ALERT_RELEVANT_EVENT_PATTERN.test(event.type)) {
      continue;
    }

    alerts.push({
      id: `event:${event.id}`,
      severity: event.type.includes("error") ? "critical" : "warning",
      title: summarizeEventType(event.type),
      message: summarizeOperationalText(event.message, "Alert-relevant event recorded."),
      createdAt: event.createdAt,
      source: "event",
    });
  }

  return {
    alerts: alerts.slice(0, MAX_ALERTS),
    runnerStateNotice: input.automaticRecoveryActive
      ? null
      : input.runnerState
        ? null
        : "No assigned manual runner state is available for this agent.",
  };
}

export function summarizeOperationalText(
  value: string | null | undefined,
  fallback: string,
): string {
  const normalized = normalizeOperationalText(value);

  if (!normalized) {
    return fallback;
  }

  if (SENSITIVE_ASSIGNMENT_PATTERN.test(normalized)) {
    return "Sensitive details omitted.";
  }

  const redacted = normalized.replace(DATABASE_URL_PATTERN, "[redacted database URL]");

  if (looksLikeUnboundedJson(redacted)) {
    return "Structured details omitted.";
  }

  return truncateSummary(redacted);
}

function normalizeOperationalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !STACK_FRAME_PATTERN.test(line));
  const normalized = lines.join(" ").replace(/\s+/g, " ").trim();

  return normalized.length > 0 ? normalized : null;
}

function looksLikeUnboundedJson(value: string): boolean {
  if (value.length < 80) {
    return false;
  }

  return (
    (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))
  );
}

function truncateSummary(value: string): string {
  return value.length > MAX_SUMMARY_LENGTH ? `${value.slice(0, MAX_SUMMARY_LENGTH - 3)}...` : value;
}

function parseOptionalTimestamp(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value);

  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function summarizeEventType(type: string): string {
  return type
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}
