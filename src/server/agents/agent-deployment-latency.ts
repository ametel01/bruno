import "server-only";

import { sql } from "drizzle-orm";
import type {
  AgentDeploymentEnvironment,
  AgentDeploymentOrigin,
} from "@/src/server/agents/deployment-slo-identity";
import { isRolloutConfigurationGeneration } from "@/src/server/agents/deployment-slo-identity";
import {
  COLD_DEPLOYMENT_SLO_OBJECTIVE_MS,
  COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS,
  COLD_DEPLOYMENT_SLO_READY_REQUIRED,
  COLD_DEPLOYMENT_SLO_SAMPLE_SIZE,
} from "@/src/server/agents/cold-deployment-slo-objective";
import type { DatabaseConnection } from "@/src/server/db/client";
import { createAppLogger } from "@/src/server/logging/logger";

export const AGENT_DEPLOYMENT_LATENCY_REPORT_VERSION = 5;

const DEFAULT_REPORT_LIMIT = 100;
const MAX_REPORT_LIMIT = 1_000;
const NEAREST_RANK_P95 = 95;
const NEAREST_RANK_P50 = 50;
const MAX_LOG_STAGE_COUNT = 20;
const REQUIRED_RUNNER_STAGE_NAMES = [
  "runner:creating",
  "runner:tagging",
  "runner:firewall_configuring",
  "runner:bootstrapping",
  "runner:waiting_for_runner",
  "runner:ready",
];
const REQUIRED_BOOTSTRAP_STAGE_NAMES = [
  "bootstrap:bootstrap_started",
  "bootstrap:package_install",
  "bootstrap:docker_pull",
  "bootstrap:agent_image_pull",
  "bootstrap:hermes_image_pull",
  "bootstrap:runner_container_start",
  "bootstrap:runner_registration",
  "bootstrap:boot_validation",
  "bootstrap:authenticated_readiness",
];
const BOOTSTRAP_STEP_LABELS = new Set([
  "agent_image_pull",
  "authenticated_readiness",
  "boot_validation",
  "bootstrap_started",
  "docker_package_install",
  "docker_pull",
  "docker_apt_repository",
  "docker_container_started",
  "hermes_image_pull",
  "package_install",
  "runner_container_start",
  "runner_registration",
]);

const terminalLogger = createAppLogger("agent.deployment.latency");

export type AgentDeploymentLatencyBoundary = "started" | "completed" | "failed";
export type AgentDeploymentLatencyCohort = "cold_deployment" | "same_owner_reuse" | "unknown";

export type AgentDeploymentLatencyDeploymentStageEvent = {
  fromStage: string | null;
  toStage: string | null;
  createdAt: Date | string;
};

export type AgentDeploymentLatencyRunnerEvent = {
  phase: string;
  status: AgentDeploymentLatencyBoundary;
  createdAt: Date | string;
  metadata?: Record<string, unknown>;
};

export type AgentDeploymentLatencyDeploymentEvidence = {
  id: string;
  runnerId: string | null;
  cohort?: AgentDeploymentLatencyCohort;
  origin?: AgentDeploymentOrigin | null;
  deploymentEnvironment?: AgentDeploymentEnvironment | null;
  ownerCancelledAt?: Date | string | null;
  rolloutConfigurationGeneration?: number | null;
  requiresRunnerEvidence?: boolean;
  acceptedAt?: Date | string | null | undefined;
  createdAt: Date | string;
  completedAt: Date | string | null;
  failedAt: Date | string | null;
  agentStageEvents: readonly AgentDeploymentLatencyDeploymentStageEvent[];
  runnerEvents: readonly AgentDeploymentLatencyRunnerEvent[];
};

export type AgentDeploymentLatencyIssue =
  | "missing_started"
  | "missing_terminal"
  | "duplicate_started"
  | "duplicate_terminal"
  | "reversed_timestamp"
  | "non_positive_duration"
  | "invalid_timestamp"
  | "ambiguous_terminal"
  | "unknown_terminal"
  | "unknown_latency_cohort"
  | "unknown_rollout_configuration"
  | "invalid_owner_cancellation_order";

export type AgentDeploymentLatencyStageTiming = {
  name: string;
  source: "agent_event" | "runner_provisioning_event";
  status: "complete" | "failed" | "missing" | "invalid";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  issues: AgentDeploymentLatencyIssue[];
};

export type AgentDeploymentLatencyRunOutcome = "ready" | "failed" | "incomplete";
export type AgentDeploymentLatencySloClassification =
  | "ready_within_objective"
  | "slo_miss"
  | "pending"
  | "missing_boundary"
  | "legacy_boundary"
  | "invalid_event_ordering";

export type AgentDeploymentLatencySloSummary = {
  objectiveSeconds: typeof COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS;
  sampleSize: number;
  requiredSampleSize: typeof COLD_DEPLOYMENT_SLO_SAMPLE_SIZE;
  requiredReadyWithinObjective: typeof COLD_DEPLOYMENT_SLO_READY_REQUIRED;
  eligible: number;
  readyWithinObjective: number;
  misses: number;
  pending: number;
  passRate: number;
  passesGate: boolean;
};

export type AgentDeploymentLatencyRun = {
  deploymentId: string;
  runnerId: string | null;
  cohort: AgentDeploymentLatencyCohort;
  origin: AgentDeploymentOrigin | null;
  deploymentEnvironment: AgentDeploymentEnvironment | null;
  rolloutConfigurationGeneration: number | null;
  eligible: boolean;
  eligibilityReason:
    | "eligible"
    | "legacy_identity"
    | "non_production"
    | "operator_trial"
    | "runner_replacement"
    | "not_cold_deployment"
    | "owner_cancelled_before_boundary"
    | "contradictory_cancellation_evidence"
    | "unknown_rollout_configuration"
    | "diagnostic_evidence";
  outcome: AgentDeploymentLatencyRunOutcome;
  evidenceStatus: "valid" | "invalid";
  acceptedAt: string | null;
  ownerCancelledAt: string | null;
  createdAt: string;
  terminalAt: string | null;
  totalDurationMs: number | null;
  durationBoundary: "accepted_at" | "legacy_created_at" | null;
  sloClassification: AgentDeploymentLatencySloClassification;
  sloMissCause: "slow_ready" | "terminal_failure" | "not_ready_at_boundary" | null;
  sloStatus: "pass" | "miss" | "pending" | "diagnostic";
  stages: AgentDeploymentLatencyStageTiming[];
  issueCounts: Partial<Record<AgentDeploymentLatencyIssue, number>>;
};

export type AgentDeploymentLatencyStageSummary = {
  name: string;
  source: "agent_event" | "runner_provisioning_event";
  sampleCount: number;
  missingCount: number;
  invalidCount: number;
  duplicateEvidenceCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export type AgentDeploymentLatencyCohortSummary = {
  total: number;
  ready: number;
  failed: number;
  incomplete: number;
  invalidEvidence: number;
  successRate: number;
  slo: AgentDeploymentLatencySloSummary;
  readyLatency: {
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  failedTerminalLatency: {
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  stageSummaries: AgentDeploymentLatencyStageSummary[];
};

export type AgentDeploymentLatencyReport = {
  version: typeof AGENT_DEPLOYMENT_LATENCY_REPORT_VERSION;
  generatedAt: string;
  boundary: {
    sloStart: "agent_deployments.accepted_at";
    legacyDiagnosticStart: "agent_deployments.created_at";
    ready: "agent_deployments.completed_at";
    failed: "agent_deployments.failed_at";
  };
  percentileRule: "nearest_rank";
  slo: AgentDeploymentLatencySloSummary;
  summary: {
    total: number;
    ready: number;
    failed: number;
    incomplete: number;
    successRate: number;
    readyLatency: {
      p50Ms: number | null;
      p95Ms: number | null;
      maxMs: number | null;
    };
    failedTerminalLatency: {
      p50Ms: number | null;
      p95Ms: number | null;
      maxMs: number | null;
    };
  };
  cohorts: Record<AgentDeploymentLatencyCohort, AgentDeploymentLatencyCohortSummary>;
  runs: AgentDeploymentLatencyRun[];
  stageSummaries: AgentDeploymentLatencyStageSummary[];
};

type BuildReportInput = {
  deployments: readonly AgentDeploymentLatencyDeploymentEvidence[];
  generatedAt?: Date | string;
};

type BoundaryEvent = {
  name: string;
  source: "runner_provisioning_event";
  status: AgentDeploymentLatencyBoundary;
  at: string | null;
};

export type AgentDeploymentRunnerCorrelationInput = {
  cohort: AgentDeploymentLatencyCohort;
  runnerOperationId: string | null;
  operationRunnerId: string | null;
  assignedRunnerId: string | null;
};

export type AgentDeploymentRunnerCorrelation = {
  reportRunnerId: string | null;
  eventRunnerId: string | null;
  eventRunnerOperationId: string | null;
  mode: "operation_key" | "same_owner_reuse" | "none";
};

export function buildAgentDeploymentLatencyReport(
  input: BuildReportInput,
): AgentDeploymentLatencyReport {
  const generatedAt = toIso(input.generatedAt ?? new Date()) ?? new Date(0).toISOString();
  const runs = [...input.deployments]
    .sort(
      (left, right) =>
        compareIso(toIso(left.createdAt), toIso(right.createdAt)) ||
        left.id.localeCompare(right.id),
    )
    .map((deployment) => toLatencyRun(deployment, generatedAt));
  const readyDurations = runs
    .filter((run) => run.outcome === "ready" && run.totalDurationMs !== null)
    .map((run) => run.totalDurationMs as number);
  const failedDurations = runs
    .filter((run) => run.outcome === "failed" && run.totalDurationMs !== null)
    .map((run) => run.totalDurationMs as number);
  const ready = runs.filter((run) => run.outcome === "ready").length;
  const failed = runs.filter((run) => run.outcome === "failed").length;
  const incomplete = runs.filter((run) => run.outcome === "incomplete").length;
  const cohorts = summarizeCohorts(runs);

  return {
    version: AGENT_DEPLOYMENT_LATENCY_REPORT_VERSION,
    generatedAt,
    boundary: {
      sloStart: "agent_deployments.accepted_at",
      legacyDiagnosticStart: "agent_deployments.created_at",
      ready: "agent_deployments.completed_at",
      failed: "agent_deployments.failed_at",
    },
    percentileRule: "nearest_rank",
    slo: summarizeSlo(runs.filter((run) => run.cohort === "cold_deployment")),
    summary: {
      total: runs.length,
      ready,
      failed,
      incomplete,
      successRate: runs.length === 0 ? 0 : ready / runs.length,
      readyLatency: summarizeDurations(readyDurations),
      failedTerminalLatency: summarizeDurations(failedDurations),
    },
    cohorts,
    runs,
    stageSummaries: summarizeAgentDeploymentLatencyStages(runs),
  };
}

export async function buildAgentDeploymentLatencyReportForDatabase(
  connection: DatabaseConnection,
  options: {
    deploymentId?: string;
    limit?: number;
    generatedAt?: Date;
  } = {},
): Promise<AgentDeploymentLatencyReport> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_REPORT_LIMIT, 1), MAX_REPORT_LIMIT);
  const generatedAt = options.generatedAt ?? new Date();
  const deployments = await readDeploymentEvidence(
    connection,
    options.deploymentId,
    limit,
    generatedAt,
  );

  return buildAgentDeploymentLatencyReport({
    deployments,
    generatedAt,
  });
}

export async function logAgentDeploymentTerminalCompletion(
  connection: DatabaseConnection,
  deploymentId: string,
): Promise<void> {
  const report = await buildAgentDeploymentLatencyReportForDatabase(connection, {
    deploymentId,
    limit: 1,
  });
  const run = report.runs[0];

  if (run?.outcome !== "ready" || run.totalDurationMs === null) return;

  terminalLogger.info("terminal_completion", {
    deploymentId: run.deploymentId,
    runnerId: run.runnerId,
    cohort: run.cohort,
    outcome: run.outcome,
    acceptedAt: run.acceptedAt,
    totalDurationMs: run.totalDurationMs,
    durationBoundary: run.durationBoundary,
    sloClassification: run.sloClassification,
    sloMissCause: run.sloMissCause,
    sloStatus: run.sloStatus,
    eligible: run.eligible,
    eligibilityReason: run.eligibilityReason,
    evidenceStatus: run.evidenceStatus,
    stages: run.stages.slice(0, MAX_LOG_STAGE_COUNT).map((stage) => ({
      name: stage.name,
      status: stage.status,
      durationMs: stage.durationMs,
      issues: stage.issues,
    })),
  });
}

export function resolveAgentDeploymentRunnerCorrelation(
  input: AgentDeploymentRunnerCorrelationInput,
): AgentDeploymentRunnerCorrelation {
  if (input.cohort === "cold_deployment" && input.runnerOperationId && input.operationRunnerId) {
    return {
      reportRunnerId: input.operationRunnerId,
      eventRunnerId: input.operationRunnerId,
      eventRunnerOperationId: input.runnerOperationId,
      mode: "operation_key",
    };
  }

  if (input.cohort === "same_owner_reuse" && input.assignedRunnerId) {
    return {
      reportRunnerId: input.assignedRunnerId,
      eventRunnerId: null,
      eventRunnerOperationId: null,
      mode: "same_owner_reuse",
    };
  }

  return {
    reportRunnerId: null,
    eventRunnerId: null,
    eventRunnerOperationId: null,
    mode: "none",
  };
}

function toLatencyRun(
  input: AgentDeploymentLatencyDeploymentEvidence,
  generatedAt: string,
): AgentDeploymentLatencyRun {
  const cohort = input.cohort ?? "unknown";
  const createdAt = toIso(input.createdAt);
  const acceptedAt = toIso(input.acceptedAt);
  const completedAt = toIso(input.completedAt);
  const failedAt = toIso(input.failedAt);
  const ownerCancelledAt = toIso(input.ownerCancelledAt);
  const acceptedBoundaryMissing =
    Object.hasOwn(input, "acceptedAt") && input.acceptedAt === undefined;
  const terminal = selectTerminal(createdAt, completedAt, failedAt);
  const stages = [
    ...buildAgentStageTimings(createdAt, input.agentStageEvents),
    ...buildRunnerStageTimings(
      input.runnerEvents,
      input.requiresRunnerEvidence === true ||
        (cohort === "cold_deployment" && input.runnerId !== null) ||
        input.runnerEvents.length > 0,
    ),
  ].sort(
    (left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source),
  );
  const cohortIssues: AgentDeploymentLatencyIssue[] =
    cohort === "unknown" ? ["unknown_latency_cohort"] : [];
  const identityIssues: AgentDeploymentLatencyIssue[] = [...cohortIssues];
  if (
    input.origin &&
    input.deploymentEnvironment &&
    !isRolloutConfigurationGeneration(input.rolloutConfigurationGeneration)
  ) {
    identityIssues.push("unknown_rollout_configuration");
  }
  const cancellationOrderInvalid = Boolean(
    acceptedAt && ownerCancelledAt && compareIso(ownerCancelledAt, acceptedAt) < 0,
  );
  if (cancellationOrderInvalid) identityIssues.push("invalid_owner_cancellation_order");
  const issueCounts = countIssues(stages, [...terminal.issues, ...identityIssues]);
  const boundary = selectDurationBoundary(
    input.acceptedAt,
    acceptedBoundaryMissing,
    acceptedAt,
    createdAt,
  );
  const boundaryOrderInvalid = Boolean(
    acceptedAt &&
      createdAt &&
      (compareIso(acceptedAt, createdAt) < 0 ||
        (terminal.at && compareIso(terminal.at, acceptedAt) < 0)),
  );
  const totalDurationMs =
    boundary.at && terminal.at && terminal.issues.length === 0 && !boundaryOrderInvalid
      ? durationMs(boundary.at, terminal.at)
      : null;
  const slo = classifySlo({
    acceptedInput: input.acceptedAt,
    acceptedBoundaryMissing,
    acceptedAt,
    createdAt,
    terminal,
    generatedAt,
    boundaryOrderInvalid,
  });
  const eligibilityReason = classifyEligibility({
    origin: input.origin,
    deploymentEnvironment: input.deploymentEnvironment,
    rolloutConfigurationGeneration: input.rolloutConfigurationGeneration,
    cohort,
    ownerCancelledAt,
    acceptedAt,
    sloStatus: slo.status,
    cancellationOrderInvalid,
  });
  const evidenceStatus =
    totalDurationMs !== null &&
    Object.values(issueCounts).every((count) => count === 0) &&
    terminal.outcome !== "incomplete"
      ? "valid"
      : "invalid";

  return {
    deploymentId: input.id,
    runnerId: input.runnerId,
    cohort,
    origin: input.origin ?? null,
    deploymentEnvironment: input.deploymentEnvironment ?? null,
    rolloutConfigurationGeneration: isRolloutConfigurationGeneration(
      input.rolloutConfigurationGeneration,
    )
      ? input.rolloutConfigurationGeneration
      : null,
    eligible: eligibilityReason === "eligible",
    eligibilityReason,
    outcome: terminal.outcome,
    evidenceStatus,
    acceptedAt,
    ownerCancelledAt,
    createdAt: createdAt ?? "invalid",
    terminalAt: terminal.at,
    totalDurationMs,
    durationBoundary: boundary.kind,
    sloClassification: slo.classification,
    sloMissCause: slo.missCause,
    sloStatus: slo.status,
    stages,
    issueCounts,
  };
}

function selectDurationBoundary(
  acceptedInput: AgentDeploymentLatencyDeploymentEvidence["acceptedAt"],
  acceptedBoundaryMissing: boolean,
  acceptedAt: string | null,
  createdAt: string | null,
): {
  at: string | null;
  kind: AgentDeploymentLatencyRun["durationBoundary"];
} {
  if (acceptedAt) return { at: acceptedAt, kind: "accepted_at" };
  if (!acceptedBoundaryMissing && (acceptedInput === null || acceptedInput === undefined)) {
    return { at: createdAt, kind: "legacy_created_at" };
  }
  return { at: null, kind: null };
}

function classifySlo(input: {
  acceptedInput: AgentDeploymentLatencyDeploymentEvidence["acceptedAt"];
  acceptedBoundaryMissing: boolean;
  acceptedAt: string | null;
  createdAt: string | null;
  terminal: ReturnType<typeof selectTerminal>;
  generatedAt: string;
  boundaryOrderInvalid: boolean;
}): {
  classification: AgentDeploymentLatencySloClassification;
  status: AgentDeploymentLatencyRun["sloStatus"];
  missCause: AgentDeploymentLatencyRun["sloMissCause"];
} {
  if (input.acceptedBoundaryMissing || (input.acceptedInput !== null && !input.acceptedAt)) {
    return { classification: "missing_boundary", status: "diagnostic", missCause: null };
  }
  if (!input.acceptedAt) {
    return { classification: "legacy_boundary", status: "diagnostic", missCause: null };
  }
  const terminalOrderInvalid = input.terminal.issues.some((issue) => issue !== "unknown_terminal");
  if (!input.createdAt || input.boundaryOrderInvalid || terminalOrderInvalid) {
    return { classification: "invalid_event_ordering", status: "diagnostic", missCause: null };
  }
  if (input.terminal.outcome === "failed") {
    return { classification: "slo_miss", status: "miss", missCause: "terminal_failure" };
  }
  if (input.terminal.outcome === "ready" && input.terminal.at) {
    return durationMs(input.acceptedAt, input.terminal.at) <= COLD_DEPLOYMENT_SLO_OBJECTIVE_MS
      ? { classification: "ready_within_objective", status: "pass", missCause: null }
      : { classification: "slo_miss", status: "miss", missCause: "slow_ready" };
  }
  return durationMs(input.acceptedAt, input.generatedAt) >= COLD_DEPLOYMENT_SLO_OBJECTIVE_MS
    ? { classification: "slo_miss", status: "miss", missCause: "not_ready_at_boundary" }
    : { classification: "pending", status: "pending", missCause: null };
}

function classifyEligibility(input: {
  origin: AgentDeploymentOrigin | null | undefined;
  deploymentEnvironment: AgentDeploymentEnvironment | null | undefined;
  rolloutConfigurationGeneration: number | null | undefined;
  cohort: AgentDeploymentLatencyCohort;
  ownerCancelledAt: string | null;
  acceptedAt: string | null;
  sloStatus: AgentDeploymentLatencyRun["sloStatus"];
  cancellationOrderInvalid: boolean;
}): AgentDeploymentLatencyRun["eligibilityReason"] {
  if (!input.origin || !input.deploymentEnvironment) return "legacy_identity";
  if (!isRolloutConfigurationGeneration(input.rolloutConfigurationGeneration)) {
    return "unknown_rollout_configuration";
  }
  if (input.origin === "operator_trial") return "operator_trial";
  if (input.origin === "runner_replacement") return "runner_replacement";
  if (input.deploymentEnvironment !== "production") return "non_production";
  if (input.cohort !== "cold_deployment") return "not_cold_deployment";
  if (input.sloStatus === "diagnostic" || !input.acceptedAt) return "diagnostic_evidence";
  if (input.cancellationOrderInvalid) return "contradictory_cancellation_evidence";
  if (
    input.ownerCancelledAt &&
    durationMs(input.acceptedAt, input.ownerCancelledAt) < COLD_DEPLOYMENT_SLO_OBJECTIVE_MS
  ) {
    return "owner_cancelled_before_boundary";
  }
  return "eligible";
}

function selectTerminal(
  createdAt: string | null,
  completedAt: string | null,
  failedAt: string | null,
): {
  outcome: AgentDeploymentLatencyRunOutcome;
  at: string | null;
  issues: AgentDeploymentLatencyIssue[];
} {
  if (!createdAt) return { outcome: "incomplete", at: null, issues: ["invalid_timestamp"] };
  if (completedAt && failedAt)
    return { outcome: "failed", at: failedAt, issues: ["ambiguous_terminal"] };
  if (completedAt) {
    return {
      outcome: "ready",
      at: completedAt,
      issues: compareIso(completedAt, createdAt) < 0 ? ["reversed_timestamp"] : [],
    };
  }
  if (failedAt) {
    return {
      outcome: "failed",
      at: failedAt,
      issues: compareIso(failedAt, createdAt) < 0 ? ["reversed_timestamp"] : [],
    };
  }
  return { outcome: "incomplete", at: null, issues: ["unknown_terminal"] };
}

function buildAgentStageTimings(
  createdAt: string | null,
  events: readonly AgentDeploymentLatencyDeploymentStageEvent[],
): AgentDeploymentLatencyStageTiming[] {
  if (!createdAt) return [];

  const ordered = events
    .map((event) => ({
      fromStage: normalizeLabel(event.fromStage),
      toStage: normalizeLabel(event.toStage),
      at: toIso(event.createdAt),
    }))
    .filter((event) => event.toStage)
    .sort(
      (left, right) =>
        compareIso(left.at, right.at) ||
        (left.fromStage ?? "").localeCompare(right.fromStage ?? ""),
    );
  const seen = new Set<string>();
  const timings: AgentDeploymentLatencyStageTiming[] = [];
  let cursor = createdAt;

  for (const event of ordered) {
    if (!event.fromStage) continue;
    const name = `agent:${event.fromStage}`;
    const issues: AgentDeploymentLatencyIssue[] = [];

    if (seen.has(name)) issues.push("duplicate_terminal");
    if (!event.at) issues.push("invalid_timestamp");
    if (event.at && compareIso(event.at, cursor) < 0) issues.push("reversed_timestamp");
    seen.add(name);
    timings.push({
      name,
      source: "agent_event",
      status: issues.length > 0 ? "invalid" : "complete",
      startedAt: cursor,
      completedAt: event.at,
      durationMs: issues.length > 0 || !event.at ? null : durationMs(cursor, event.at),
      issues,
    });
    if (event.at) {
      cursor = event.at;
    }
  }

  return timings;
}

function buildRunnerStageTimings(
  events: readonly AgentDeploymentLatencyRunnerEvent[],
  requireExpectedStages: boolean,
): AgentDeploymentLatencyStageTiming[] {
  const boundaryEvents = events.flatMap(toBoundaryEvents);
  const byName = new Map<string, BoundaryEvent[]>();

  if (requireExpectedStages) {
    for (const name of [...REQUIRED_RUNNER_STAGE_NAMES, ...REQUIRED_BOOTSTRAP_STAGE_NAMES]) {
      byName.set(name, []);
    }
  }

  for (const event of boundaryEvents) {
    const list = byName.get(event.name) ?? [];
    list.push(event);
    byName.set(event.name, list);
  }

  return [...byName.entries()].map(([name, list]) => {
    const startedEvents = list.filter((event) => event.status === "started");
    const terminalEvents = list.filter(
      (event) => event.status === "completed" || event.status === "failed",
    );
    const validStarts = startedEvents.filter((event) => event.at);
    const validTerminals = terminalEvents.filter((event) => event.at);
    const issues: AgentDeploymentLatencyIssue[] = [];

    if (startedEvents.length === 0) issues.push("missing_started");
    if (startedEvents.length > 1) issues.push("duplicate_started");
    if (terminalEvents.length === 0) issues.push("missing_terminal");
    if (terminalEvents.length > 1) issues.push("duplicate_terminal");
    if ([...startedEvents, ...terminalEvents].some((event) => !event.at)) {
      issues.push("invalid_timestamp");
    }

    const startedAt = validStarts[0]?.at ?? null;
    const terminal = validTerminals[0] ?? null;
    const completedAt = terminal?.at ?? null;

    if (startedAt && completedAt) {
      const boundaryOrder = compareIso(completedAt, startedAt);
      if (boundaryOrder < 0) {
        issues.push("reversed_timestamp");
      } else if (boundaryOrder === 0) {
        issues.push("non_positive_duration");
      }
    }

    return {
      name,
      source: "runner_provisioning_event",
      status: issues.length > 0 ? "invalid" : terminal?.status === "failed" ? "failed" : "complete",
      startedAt,
      completedAt,
      durationMs:
        issues.length === 0 && startedAt && completedAt ? durationMs(startedAt, completedAt) : null,
      issues,
    };
  });
}

function toBoundaryEvents(event: AgentDeploymentLatencyRunnerEvent): BoundaryEvent[] {
  const at = toIso(event.createdAt);
  const phase = normalizeLabel(event.phase);
  const rawStep = normalizeLabel(event.metadata?.step);
  const step = rawStep && BOOTSTRAP_STEP_LABELS.has(rawStep) ? rawStep : null;

  if (rawStep && !step) {
    return at
      ? []
      : [
          {
            name: "bootstrap:unrecognized_step",
            source: "runner_provisioning_event",
            status: event.status,
            at,
          },
        ];
  }

  const emitRunnerPhase = Boolean(phase && !rawStep);
  const events: BoundaryEvent[] = emitRunnerPhase
    ? [{ name: `runner:${phase}`, source: "runner_provisioning_event", status: event.status, at }]
    : [];

  if (step && (phase === "bootstrapping" || phase === "waiting_for_runner" || phase === "ready")) {
    events.push({
      name: `bootstrap:${step}`,
      source: "runner_provisioning_event",
      status: event.status,
      at,
    });
  }

  return events;
}

function summarizeCohorts(
  runs: readonly AgentDeploymentLatencyRun[],
): Record<AgentDeploymentLatencyCohort, AgentDeploymentLatencyCohortSummary> {
  return {
    cold_deployment: summarizeCohort(runs, "cold_deployment"),
    same_owner_reuse: summarizeCohort(runs, "same_owner_reuse"),
    unknown: summarizeCohort(runs, "unknown"),
  };
}

function summarizeCohort(
  runs: readonly AgentDeploymentLatencyRun[],
  cohort: AgentDeploymentLatencyCohort,
): AgentDeploymentLatencyCohortSummary {
  const cohortRuns = runs.filter((run) => run.cohort === cohort);
  const ready = cohortRuns.filter((run) => run.outcome === "ready").length;
  const failed = cohortRuns.filter((run) => run.outcome === "failed").length;
  const incomplete = cohortRuns.filter((run) => run.outcome === "incomplete").length;
  const readyDurations = cohortRuns
    .filter((run) => run.outcome === "ready" && run.totalDurationMs !== null)
    .map((run) => run.totalDurationMs as number);
  const failedDurations = cohortRuns
    .filter((run) => run.outcome === "failed" && run.totalDurationMs !== null)
    .map((run) => run.totalDurationMs as number);

  return {
    total: cohortRuns.length,
    ready,
    failed,
    incomplete,
    invalidEvidence: cohortRuns.filter((run) => run.evidenceStatus === "invalid").length,
    successRate: cohortRuns.length === 0 ? 0 : ready / cohortRuns.length,
    slo: summarizeSlo(cohortRuns),
    readyLatency: summarizeDurations(readyDurations),
    failedTerminalLatency: summarizeDurations(failedDurations),
    stageSummaries: summarizeAgentDeploymentLatencyStages(cohortRuns),
  };
}

function summarizeSlo(
  runs: readonly AgentDeploymentLatencyRun[],
): AgentDeploymentLatencySloSummary {
  const eligibleRuns = runs
    .filter((run) => run.eligible && run.sloStatus !== "diagnostic")
    .sort(
      (left, right) =>
        compareIso(right.acceptedAt, left.acceptedAt) ||
        right.deploymentId.localeCompare(left.deploymentId),
    )
    .slice(0, COLD_DEPLOYMENT_SLO_SAMPLE_SIZE);
  const readyWithinObjective = eligibleRuns.filter((run) => run.sloStatus === "pass").length;
  const misses = eligibleRuns.filter((run) => run.sloStatus === "miss").length;
  const pending = eligibleRuns.filter((run) => run.sloStatus === "pending").length;
  const decided = readyWithinObjective + misses;

  return {
    objectiveSeconds: COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS,
    sampleSize: eligibleRuns.length,
    requiredSampleSize: COLD_DEPLOYMENT_SLO_SAMPLE_SIZE,
    requiredReadyWithinObjective: COLD_DEPLOYMENT_SLO_READY_REQUIRED,
    eligible: eligibleRuns.length,
    readyWithinObjective,
    misses,
    pending,
    passRate: decided === 0 ? 0 : readyWithinObjective / decided,
    passesGate:
      eligibleRuns.length === COLD_DEPLOYMENT_SLO_SAMPLE_SIZE &&
      pending === 0 &&
      readyWithinObjective >= COLD_DEPLOYMENT_SLO_READY_REQUIRED,
  };
}

export function summarizeAgentDeploymentLatencyStages(
  runs: readonly AgentDeploymentLatencyRun[],
): AgentDeploymentLatencyStageSummary[] {
  const byName = new Map<string, AgentDeploymentLatencyStageTiming[]>();

  for (const stage of runs.flatMap((run) => run.stages)) {
    const list = byName.get(stageKey(stage)) ?? [];
    list.push(stage);
    byName.set(stageKey(stage), list);
  }

  return [...byName.values()]
    .map((stages) => {
      const first = stages[0] as AgentDeploymentLatencyStageTiming;
      const durations = stages
        .filter((stage) => stage.durationMs !== null)
        .map((stage) => stage.durationMs as number);

      return {
        name: first.name,
        source: first.source,
        sampleCount: durations.length,
        missingCount: stages.filter(
          (stage) =>
            stage.issues.includes("missing_started") || stage.issues.includes("missing_terminal"),
        ).length,
        invalidCount: stages.filter((stage) => stage.status === "invalid").length,
        duplicateEvidenceCount: stages.filter(
          (stage) =>
            stage.issues.includes("duplicate_started") ||
            stage.issues.includes("duplicate_terminal"),
        ).length,
        ...summarizeDurations(durations),
      };
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.source.localeCompare(right.source),
    );
}

function summarizeDurations(durations: readonly number[]): {
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
} {
  if (durations.length === 0) return { p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...durations].sort((left, right) => left - right);

  return {
    p50Ms: nearestRank(sorted, NEAREST_RANK_P50),
    p95Ms: nearestRank(sorted, NEAREST_RANK_P95),
    maxMs: sorted.at(-1) ?? null,
  };
}

function nearestRank(sortedDurations: readonly number[], percentile: number): number | null {
  if (sortedDurations.length === 0) return null;
  const index = Math.min(
    sortedDurations.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedDurations.length) - 1),
  );
  return sortedDurations[index] ?? null;
}

function countIssues(
  stages: readonly AgentDeploymentLatencyStageTiming[],
  terminalIssues: readonly AgentDeploymentLatencyIssue[],
): Partial<Record<AgentDeploymentLatencyIssue, number>> {
  const counts: Partial<Record<AgentDeploymentLatencyIssue, number>> = {};
  for (const issue of [...terminalIssues, ...stages.flatMap((stage) => stage.issues)]) {
    counts[issue] = (counts[issue] ?? 0) + 1;
  }
  return counts;
}

function stageKey(stage: AgentDeploymentLatencyStageTiming): string {
  return `${stage.source}:${stage.name}`;
}

function durationMs(startedAt: string, completedAt: string): number {
  return new Date(completedAt).getTime() - new Date(startedAt).getTime();
}

function compareIso(left: string | null, right: string | null): number {
  return (left ?? "").localeCompare(right ?? "");
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "_");
  return normalized.length > 0 ? normalized.slice(0, 80) : null;
}

async function readDeploymentEvidence(
  connection: DatabaseConnection,
  deploymentId: string | undefined,
  limit: number,
  generatedAt: Date,
): Promise<AgentDeploymentLatencyDeploymentEvidence[]> {
  const snapshotAt = generatedAt.toISOString();
  const eligibleFilter = sql`
    d.origin = 'owner_request'
    and d.initial_cohort = 'cold_deployment'
    and d.deployment_environment = 'production'
    and d.rollout_configuration_generation is not null
    and d.accepted_at is not null
    and d.accepted_at <= ${snapshotAt}
    and (
      d.owner_cancelled_at is null
      or d.owner_cancelled_at > ${snapshotAt}
      or d.owner_cancelled_at >= d.accepted_at + ${COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS} * interval '1 second'
    )
  `;
  const invalidIdentityFilter = sql`
    (
      d.accepted_at is null
      or (
        d.origin = 'owner_request'
        and d.deployment_environment = 'production'
        and d.accepted_at <= ${snapshotAt}
        and (
          d.initial_cohort = 'unknown'
          or (
            d.initial_cohort = 'cold_deployment'
            and (
              d.rollout_configuration_generation is null
              or d.owner_cancelled_at < d.accepted_at
            )
          )
        )
      )
    )
    and d.created_at <= ${snapshotAt}
  `;
  const deploymentFilter = deploymentId
    ? sql`
        d.id = ${deploymentId}::uuid
        and d.created_at <= ${snapshotAt}
        and (d.accepted_at is null or d.accepted_at <= ${snapshotAt})
      `
    : sql`
        d.id in (
          select ranked.id
          from (
            select
              d.id,
              row_number() over (
                partition by case when ${eligibleFilter} then 'eligible' else 'diagnostic' end
                order by d.accepted_at desc nulls last, d.created_at desc, d.id desc
              ) as report_rank
            from agent_deployments d
            where (${eligibleFilter}) or (${invalidIdentityFilter})
          ) ranked
          where ranked.report_rank <= ${limit}
        )
      `;
  const rows = await connection.db.execute<{
    id: string;
    operationRunnerId: string | null;
    assignedRunnerId: string | null;
    userId: string;
    provisioningOperationId: string;
    origin: AgentDeploymentOrigin | null;
    initialCohort: AgentDeploymentLatencyCohort | null;
    deploymentEnvironment: AgentDeploymentEnvironment | null;
    ownerCancelledAt: Date | null;
    rolloutConfigurationGeneration: number | null;
    createdAt: Date;
    acceptedAt: Date | null;
    completedAt: Date | null;
    failedAt: Date | null;
  }>(sql`
    select
      d.id,
      operation_runner.id as "operationRunnerId",
      a.runner_id as "assignedRunnerId",
      d.user_id as "userId",
      d.id as "provisioningOperationId",
      d.origin,
      d.initial_cohort as "initialCohort",
      d.deployment_environment as "deploymentEnvironment",
      case when d.owner_cancelled_at <= ${snapshotAt} then d.owner_cancelled_at end as "ownerCancelledAt",
      d.rollout_configuration_generation as "rolloutConfigurationGeneration",
      d.created_at as "createdAt",
      d.accepted_at as "acceptedAt",
      case when d.completed_at <= ${snapshotAt} then d.completed_at end as "completedAt",
      case when d.failed_at <= ${snapshotAt} then d.failed_at end as "failedAt"
    from agent_deployments d
    inner join agents a
      on a.id = d.agent_id
     and a.user_id = d.user_id
    left join runners operation_runner
      on operation_runner.user_id = d.user_id
     and operation_runner.provisioning_operation_key = concat('bruno-deploy-', replace(d.id::text, '-', ''))
    where ${deploymentFilter}
    order by d.accepted_at desc nulls last, d.id desc
  `);

  return await Promise.all(
    rows.map(async (row) => {
      const correlation = resolveAgentDeploymentRunnerCorrelation({
        cohort: row.initialCohort ?? "unknown",
        runnerOperationId: row.provisioningOperationId,
        operationRunnerId: row.operationRunnerId,
        assignedRunnerId: row.assignedRunnerId,
      });

      return {
        id: row.id,
        runnerId: correlation.reportRunnerId,
        cohort: row.initialCohort ?? "unknown",
        origin: row.origin,
        deploymentEnvironment: row.deploymentEnvironment,
        ownerCancelledAt: row.ownerCancelledAt,
        rolloutConfigurationGeneration: row.rolloutConfigurationGeneration,
        requiresRunnerEvidence: row.initialCohort === "cold_deployment",
        createdAt: row.createdAt,
        acceptedAt: row.acceptedAt,
        completedAt: row.completedAt,
        failedAt: row.failedAt,
        agentStageEvents: await readAgentStageEvents(connection, row.id, generatedAt),
        runnerEvents: await readRunnerEvents(connection, {
          userId: row.userId,
          runnerId: correlation.eventRunnerId,
          runnerOperationId: correlation.eventRunnerOperationId,
          generatedAt,
        }),
      };
    }),
  );
}

async function readAgentStageEvents(
  connection: DatabaseConnection,
  deploymentId: string,
  generatedAt: Date,
): Promise<AgentDeploymentLatencyDeploymentStageEvent[]> {
  const rows = await connection.db.execute<{
    fromStage: string | null;
    toStage: string | null;
    createdAt: Date;
  }>(sql`
    select
      metadata ->> 'fromStage' as "fromStage",
      metadata ->> 'toStage' as "toStage",
      created_at as "createdAt"
    from agent_events
    where type = 'agent.deployment_stage_changed'
      and metadata ->> 'deploymentId' = ${deploymentId}
      and created_at <= ${generatedAt.toISOString()}
    order by created_at asc, id asc
  `);

  return rows;
}

async function readRunnerEvents(
  connection: DatabaseConnection,
  input: {
    userId: string;
    runnerId: string | null;
    runnerOperationId: string | null;
    generatedAt: Date;
  },
): Promise<AgentDeploymentLatencyRunnerEvent[]> {
  const operationKey = input.runnerOperationId
    ? toProvisioningOperationKey(input.runnerOperationId)
    : null;
  const correlationFilter = input.runnerOperationId
    ? sql`runner.provisioning_operation_key = ${operationKey}`
    : input.runnerId
      ? sql`runner.id = ${input.runnerId}::uuid`
      : sql`false`;
  const rows = await connection.db.execute<{
    phase: string;
    status: AgentDeploymentLatencyBoundary;
    createdAt: Date;
    metadata: Record<string, unknown>;
  }>(sql`
    select events.phase, events.status, events.created_at as "createdAt", events.metadata
    from runner_provisioning_events events
    inner join runners runner
      on runner.id = events.runner_id
     and runner.user_id = ${input.userId}::uuid
    where ${correlationFilter}
      and events.created_at <= ${input.generatedAt.toISOString()}
    order by events.created_at asc, events.id asc
  `);

  return rows;
}

function toProvisioningOperationKey(operationId: string): string {
  return `bruno-deploy-${operationId.replaceAll("-", "")}`;
}
