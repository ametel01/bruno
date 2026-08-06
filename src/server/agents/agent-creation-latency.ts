import "server-only";

import { sql } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import { createAppLogger } from "@/src/server/logging/logger";

export const AGENT_CREATION_LATENCY_REPORT_VERSION = 1;

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

const terminalLogger = createAppLogger("agent.creation.latency");

export type AgentCreationLatencyBoundary = "started" | "completed" | "failed";

export type AgentCreationLatencyDeploymentStageEvent = {
  fromStage: string | null;
  toStage: string | null;
  createdAt: Date | string;
};

export type AgentCreationLatencyRunnerEvent = {
  phase: string;
  status: AgentCreationLatencyBoundary;
  createdAt: Date | string;
  metadata?: Record<string, unknown>;
};

export type AgentCreationLatencyDeploymentEvidence = {
  id: string;
  runnerId: string | null;
  requiresRunnerEvidence?: boolean;
  createdAt: Date | string;
  completedAt: Date | string | null;
  failedAt: Date | string | null;
  agentStageEvents: readonly AgentCreationLatencyDeploymentStageEvent[];
  runnerEvents: readonly AgentCreationLatencyRunnerEvent[];
};

export type AgentCreationLatencyIssue =
  | "missing_started"
  | "missing_terminal"
  | "duplicate_started"
  | "duplicate_terminal"
  | "reversed_timestamp"
  | "non_positive_duration"
  | "invalid_timestamp"
  | "ambiguous_terminal"
  | "unknown_terminal";

export type AgentCreationLatencyStageTiming = {
  name: string;
  source: "agent_event" | "runner_provisioning_event";
  status: "complete" | "failed" | "missing" | "invalid";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  issues: AgentCreationLatencyIssue[];
};

export type AgentCreationLatencyRunOutcome = "ready" | "failed" | "incomplete";

export type AgentCreationLatencyRun = {
  deploymentId: string;
  runnerId: string | null;
  outcome: AgentCreationLatencyRunOutcome;
  evidenceStatus: "valid" | "invalid";
  createdAt: string;
  terminalAt: string | null;
  totalDurationMs: number | null;
  stages: AgentCreationLatencyStageTiming[];
  issueCounts: Partial<Record<AgentCreationLatencyIssue, number>>;
};

export type AgentCreationLatencyStageSummary = {
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

export type AgentCreationLatencyReport = {
  version: typeof AGENT_CREATION_LATENCY_REPORT_VERSION;
  generatedAt: string;
  boundary: {
    start: "agent_deployments.created_at";
    ready: "agent_deployments.completed_at";
    failed: "agent_deployments.failed_at";
  };
  percentileRule: "nearest_rank";
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
  runs: AgentCreationLatencyRun[];
  stageSummaries: AgentCreationLatencyStageSummary[];
};

type BuildReportInput = {
  deployments: readonly AgentCreationLatencyDeploymentEvidence[];
  generatedAt?: Date | string;
};

type BoundaryEvent = {
  name: string;
  source: "runner_provisioning_event";
  status: AgentCreationLatencyBoundary;
  at: string | null;
};

export type AgentCreationRunnerCorrelationInput = {
  runnerOperationId: string | null;
  operationRunnerId: string | null;
  assignedRunnerId: string | null;
};

export type AgentCreationRunnerCorrelation = {
  reportRunnerId: string | null;
  eventRunnerId: string | null;
  eventRunnerOperationId: string | null;
  mode: "operation_key" | "assigned_runner_legacy_fallback" | "none";
};

export function buildAgentCreationLatencyReport(
  input: BuildReportInput,
): AgentCreationLatencyReport {
  const runs = [...input.deployments]
    .sort(
      (left, right) =>
        compareIso(toIso(left.createdAt), toIso(right.createdAt)) ||
        left.id.localeCompare(right.id),
    )
    .map(toLatencyRun);
  const readyDurations = runs
    .filter((run) => run.outcome === "ready" && run.totalDurationMs !== null)
    .map((run) => run.totalDurationMs as number);
  const failedDurations = runs
    .filter((run) => run.outcome === "failed" && run.totalDurationMs !== null)
    .map((run) => run.totalDurationMs as number);
  const ready = runs.filter((run) => run.outcome === "ready").length;
  const failed = runs.filter((run) => run.outcome === "failed").length;
  const incomplete = runs.filter((run) => run.outcome === "incomplete").length;

  return {
    version: AGENT_CREATION_LATENCY_REPORT_VERSION,
    generatedAt: toIso(input.generatedAt ?? new Date()) ?? new Date(0).toISOString(),
    boundary: {
      start: "agent_deployments.created_at",
      ready: "agent_deployments.completed_at",
      failed: "agent_deployments.failed_at",
    },
    percentileRule: "nearest_rank",
    summary: {
      total: runs.length,
      ready,
      failed,
      incomplete,
      successRate: runs.length === 0 ? 0 : ready / runs.length,
      readyLatency: summarizeDurations(readyDurations),
      failedTerminalLatency: summarizeDurations(failedDurations),
    },
    runs,
    stageSummaries: summarizeStages(runs),
  };
}

export async function buildAgentCreationLatencyReportForDatabase(
  connection: DatabaseConnection,
  options: {
    deploymentId?: string;
    limit?: number;
    generatedAt?: Date;
  } = {},
): Promise<AgentCreationLatencyReport> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_REPORT_LIMIT, 1), MAX_REPORT_LIMIT);
  const deployments = await readDeploymentEvidence(connection, options.deploymentId, limit);

  return buildAgentCreationLatencyReport({
    deployments,
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
  });
}

export async function logAgentCreationTerminalCompletion(
  connection: DatabaseConnection,
  deploymentId: string,
): Promise<void> {
  const report = await buildAgentCreationLatencyReportForDatabase(connection, {
    deploymentId,
    limit: 1,
  });
  const run = report.runs[0];

  if (run?.outcome !== "ready" || run.totalDurationMs === null) return;

  terminalLogger.info("terminal_completion", {
    deploymentId: run.deploymentId,
    runnerId: run.runnerId,
    outcome: run.outcome,
    totalDurationMs: run.totalDurationMs,
    evidenceStatus: run.evidenceStatus,
    stages: run.stages.slice(0, MAX_LOG_STAGE_COUNT).map((stage) => ({
      name: stage.name,
      status: stage.status,
      durationMs: stage.durationMs,
      issues: stage.issues,
    })),
  });
}

export function resolveAgentCreationRunnerCorrelation(
  input: AgentCreationRunnerCorrelationInput,
): AgentCreationRunnerCorrelation {
  if (input.runnerOperationId) {
    return {
      reportRunnerId: input.operationRunnerId,
      eventRunnerId: input.operationRunnerId,
      eventRunnerOperationId: input.runnerOperationId,
      mode: "operation_key",
    };
  }

  if (input.assignedRunnerId) {
    // Legacy deployments that predate runner_operation_id have no immutable operation key.
    // Only those rows may fall back to the current assigned runner; operation-backed rows
    // above never OR assigned-runner evidence into the authoritative operation correlation.
    return {
      reportRunnerId: input.assignedRunnerId,
      eventRunnerId: input.assignedRunnerId,
      eventRunnerOperationId: null,
      mode: "assigned_runner_legacy_fallback",
    };
  }

  return {
    reportRunnerId: null,
    eventRunnerId: null,
    eventRunnerOperationId: null,
    mode: "none",
  };
}

function toLatencyRun(input: AgentCreationLatencyDeploymentEvidence): AgentCreationLatencyRun {
  const createdAt = toIso(input.createdAt);
  const completedAt = toIso(input.completedAt);
  const failedAt = toIso(input.failedAt);
  const terminal = selectTerminal(createdAt, completedAt, failedAt);
  const stages = [
    ...buildAgentStageTimings(createdAt, input.agentStageEvents),
    ...buildRunnerStageTimings(
      input.runnerEvents,
      input.requiresRunnerEvidence === true ||
        input.runnerId !== null ||
        input.runnerEvents.length > 0,
    ),
  ].sort(
    (left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source),
  );
  const issueCounts = countIssues(stages, terminal.issues);
  const totalDurationMs =
    createdAt && terminal.at && terminal.issues.length === 0
      ? durationMs(createdAt, terminal.at)
      : null;
  const evidenceStatus =
    totalDurationMs !== null &&
    Object.values(issueCounts).every((count) => count === 0) &&
    terminal.outcome !== "incomplete"
      ? "valid"
      : "invalid";

  return {
    deploymentId: input.id,
    runnerId: input.runnerId,
    outcome: terminal.outcome,
    evidenceStatus,
    createdAt: createdAt ?? "invalid",
    terminalAt: terminal.at,
    totalDurationMs,
    stages,
    issueCounts,
  };
}

function selectTerminal(
  createdAt: string | null,
  completedAt: string | null,
  failedAt: string | null,
): {
  outcome: AgentCreationLatencyRunOutcome;
  at: string | null;
  issues: AgentCreationLatencyIssue[];
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
  events: readonly AgentCreationLatencyDeploymentStageEvent[],
): AgentCreationLatencyStageTiming[] {
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
  const timings: AgentCreationLatencyStageTiming[] = [];
  let cursor = createdAt;

  for (const event of ordered) {
    if (!event.fromStage) continue;
    const name = `agent:${event.fromStage}`;
    const issues: AgentCreationLatencyIssue[] = [];

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
  events: readonly AgentCreationLatencyRunnerEvent[],
  requireExpectedStages: boolean,
): AgentCreationLatencyStageTiming[] {
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
    const issues: AgentCreationLatencyIssue[] = [];

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

function toBoundaryEvents(event: AgentCreationLatencyRunnerEvent): BoundaryEvent[] {
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

function summarizeStages(
  runs: readonly AgentCreationLatencyRun[],
): AgentCreationLatencyStageSummary[] {
  const byName = new Map<string, AgentCreationLatencyStageTiming[]>();

  for (const stage of runs.flatMap((run) => run.stages)) {
    const list = byName.get(stageKey(stage)) ?? [];
    list.push(stage);
    byName.set(stageKey(stage), list);
  }

  return [...byName.values()]
    .map((stages) => {
      const first = stages[0] as AgentCreationLatencyStageTiming;
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
  stages: readonly AgentCreationLatencyStageTiming[],
  terminalIssues: readonly AgentCreationLatencyIssue[],
): Partial<Record<AgentCreationLatencyIssue, number>> {
  const counts: Partial<Record<AgentCreationLatencyIssue, number>> = {};
  for (const issue of [...terminalIssues, ...stages.flatMap((stage) => stage.issues)]) {
    counts[issue] = (counts[issue] ?? 0) + 1;
  }
  return counts;
}

function stageKey(stage: AgentCreationLatencyStageTiming): string {
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
): Promise<AgentCreationLatencyDeploymentEvidence[]> {
  const deploymentFilter = deploymentId ? sql`d.id = ${deploymentId}::uuid` : sql`true`;
  const rows = await connection.db.execute<{
    id: string;
    operationRunnerId: string | null;
    assignedRunnerId: string | null;
    userId: string;
    provisioningOperationId: string;
    createdAt: Date;
    completedAt: Date | null;
    failedAt: Date | null;
  }>(sql`
    select
      d.id,
      operation_runner.id as "operationRunnerId",
      a.runner_id as "assignedRunnerId",
      d.user_id as "userId",
      d.id as "provisioningOperationId",
      d.created_at as "createdAt",
      d.completed_at as "completedAt",
      d.failed_at as "failedAt"
    from agent_deployments d
    inner join agents a
      on a.id = d.agent_id
     and a.user_id = d.user_id
    left join runners operation_runner
      on operation_runner.user_id = d.user_id
     and operation_runner.provisioning_operation_key = concat('agentbay-deploy-', replace(d.id::text, '-', ''))
    where ${deploymentFilter}
    order by d.created_at desc, d.id desc
    limit ${limit}
  `);

  return await Promise.all(
    rows.map(async (row) => {
      const correlation = resolveAgentCreationRunnerCorrelation({
        runnerOperationId: row.provisioningOperationId,
        operationRunnerId: row.operationRunnerId,
        assignedRunnerId: row.assignedRunnerId,
      });

      return {
        id: row.id,
        runnerId: correlation.reportRunnerId,
        requiresRunnerEvidence: correlation.mode !== "none",
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        failedAt: row.failedAt,
        agentStageEvents: await readAgentStageEvents(connection, row.id),
        runnerEvents: await readRunnerEvents(connection, {
          userId: row.userId,
          runnerId: correlation.eventRunnerId,
          runnerOperationId: correlation.eventRunnerOperationId,
        }),
      };
    }),
  );
}

async function readAgentStageEvents(
  connection: DatabaseConnection,
  deploymentId: string,
): Promise<AgentCreationLatencyDeploymentStageEvent[]> {
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
  },
): Promise<AgentCreationLatencyRunnerEvent[]> {
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
    status: AgentCreationLatencyBoundary;
    createdAt: Date;
    metadata: Record<string, unknown>;
  }>(sql`
    select events.phase, events.status, events.created_at as "createdAt", events.metadata
    from runner_provisioning_events events
    inner join runners runner
      on runner.id = events.runner_id
     and runner.user_id = ${input.userId}::uuid
    where ${correlationFilter}
    order by events.created_at asc, events.id asc
  `);

  return rows;
}

function toProvisioningOperationKey(operationId: string): string {
  return `agentbay-deploy-${operationId.replaceAll("-", "")}`;
}
