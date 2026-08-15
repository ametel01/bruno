import "server-only";

import { createHash, sign, verify } from "node:crypto";
import { desc, sql } from "drizzle-orm";
import {
  type AgentDeploymentApiAcceptanceSummary,
  buildAgentDeploymentApiAcceptanceSummary,
} from "@/src/server/agents/agent-deployment-api-acceptance";
import {
  type AgentDeploymentLatencyReport,
  buildAgentDeploymentLatencyReportForDatabase,
} from "@/src/server/agents/agent-deployment-latency";
import {
  COLD_DEPLOYMENT_SLO_OBJECTIVE_MS,
  COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS,
  COLD_DEPLOYMENT_SLO_READY_REQUIRED,
  COLD_DEPLOYMENT_SLO_SAMPLE_SIZE,
} from "@/src/server/agents/cold-deployment-slo-objective";
import type { DatabaseConnection } from "@/src/server/db/client";
import { coldDeploymentSloEvaluations } from "@/src/server/db/schema";

export const COLD_DEPLOYMENT_SLO_EVALUATION_SCHEMA_VERSION =
  "bruno.cold-deployment-slo-evaluation.v2" as const;

export type ColdDeploymentSloEvaluationArtifact = {
  schemaVersion: typeof COLD_DEPLOYMENT_SLO_EVALUATION_SCHEMA_VERSION;
  generatedAt: string;
  criteria: {
    sampleSize: typeof COLD_DEPLOYMENT_SLO_SAMPLE_SIZE;
    requiredReadyWithinObjective: typeof COLD_DEPLOYMENT_SLO_READY_REQUIRED;
    objectiveSeconds: typeof COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS;
  };
  outcome: {
    eligibleCount: number;
    readyWithinObjective: number;
    misses: number;
    pending: number;
    proven: boolean;
  };
  rolloutConfigurationGenerations: number[];
  apiAcceptance: AgentDeploymentApiAcceptanceSummary;
  report: AgentDeploymentLatencyReport;
};

export type ColdDeploymentSloEvaluation = {
  reportDigest: string;
  signature: string;
  signingKeyId: string;
  objectiveSeconds: typeof COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS;
  eligibleCount: number;
  readyWithinObjective: number;
  pendingCount: number;
  proven: boolean;
  incidentOpened: boolean;
  apiAcceptance: AgentDeploymentApiAcceptanceSummary;
};

export async function evaluateColdDeploymentSloForDatabase(
  connection: DatabaseConnection,
  input: { signing: { keyId: string; privateKeyPem: string }; generatedAt?: Date },
): Promise<ColdDeploymentSloEvaluation> {
  const report = await buildAgentDeploymentLatencyReportForDatabase(connection, {
    limit: 100,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  });
  const apiAcceptance = await buildAgentDeploymentApiAcceptanceSummary(connection, {
    generatedAt: input.generatedAt ?? new Date(report.generatedAt),
    limit: 100,
  });
  return await recordColdDeploymentSloEvaluation(connection, {
    report,
    apiAcceptance,
    signing: input.signing,
  });
}

export async function recordColdDeploymentSloEvaluation(
  connection: DatabaseConnection,
  input: {
    report: AgentDeploymentLatencyReport;
    apiAcceptance?: AgentDeploymentApiAcceptanceSummary;
    signing: { keyId: string; privateKeyPem: string };
  },
): Promise<ColdDeploymentSloEvaluation> {
  assertSigningKeyId(input.signing.keyId);
  const apiAcceptance =
    input.apiAcceptance ??
    (await buildAgentDeploymentApiAcceptanceSummary(connection, {
      generatedAt: new Date(input.report.generatedAt),
      limit: 100,
    }));
  const artifact = buildArtifact(input.report, apiAcceptance);
  const reportBytes = canonicalJson(artifact);
  const reportDigest = digestBytes(reportBytes);
  const signature = sign(null, Buffer.from(reportBytes), input.signing.privateKeyPem).toString(
    "base64url",
  );

  return await connection.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(285, 301)`);
    const [previous] = await tx
      .select()
      .from(coldDeploymentSloEvaluations)
      .orderBy(desc(coldDeploymentSloEvaluations.createdAt), desc(coldDeploymentSloEvaluations.id))
      .limit(1);
    const incidentOpened = previous?.proven === true && !artifact.outcome.proven;
    const [inserted] = await tx
      .insert(coldDeploymentSloEvaluations)
      .values({
        generatedAt: new Date(artifact.generatedAt),
        reportBytes,
        reportDigest,
        signingKeyId: input.signing.keyId,
        signature,
        objectiveSeconds: artifact.criteria.objectiveSeconds,
        eligibleCount: artifact.outcome.eligibleCount,
        readyWithinObjective: artifact.outcome.readyWithinObjective,
        pendingCount: artifact.outcome.pending,
        proven: artifact.outcome.proven,
        incidentOpened,
        rolloutConfigurationGenerations: artifact.rolloutConfigurationGenerations,
        previousReportDigest: previous?.reportDigest ?? null,
      })
      .returning();
    if (!inserted) throw new Error("Cold-Deployment SLO evaluation was not retained.");
    return {
      reportDigest: inserted.reportDigest,
      signature: inserted.signature,
      signingKeyId: inserted.signingKeyId,
      objectiveSeconds: COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS,
      eligibleCount: inserted.eligibleCount,
      readyWithinObjective: inserted.readyWithinObjective,
      pendingCount: inserted.pendingCount,
      proven: inserted.proven,
      incidentOpened: inserted.incidentOpened,
      apiAcceptance: artifact.apiAcceptance,
    };
  });
}

export function verifyColdDeploymentSloEvaluation(input: {
  reportBytes: string;
  reportDigest: string;
  signature: string;
  publicKeyPem: string;
}): boolean {
  if (digestBytes(input.reportBytes) !== input.reportDigest) return false;
  try {
    const parsed = JSON.parse(input.reportBytes) as unknown;
    if (!isRecord(parsed) || canonicalJson(parsed) !== input.reportBytes) return false;
    const artifact = parsed as ColdDeploymentSloEvaluationArtifact;
    if (
      artifact.schemaVersion !== COLD_DEPLOYMENT_SLO_EVALUATION_SCHEMA_VERSION ||
      !isRecord(artifact.report) ||
      canonicalJson(
        buildArtifact(artifact.report as AgentDeploymentLatencyReport, artifact.apiAcceptance),
      ) !== input.reportBytes
    ) {
      return false;
    }
    return verify(
      null,
      Buffer.from(input.reportBytes),
      input.publicKeyPem,
      Buffer.from(input.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function buildArtifact(
  report: AgentDeploymentLatencyReport,
  apiAcceptance: AgentDeploymentApiAcceptanceSummary,
): ColdDeploymentSloEvaluationArtifact {
  if (
    report.version !== 5 ||
    report.slo.objectiveSeconds !== COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS ||
    report.slo.sampleSize > COLD_DEPLOYMENT_SLO_SAMPLE_SIZE ||
    !Array.isArray(report.runs)
  ) {
    throw new Error("Cold-Deployment SLO report is incompatible.");
  }
  const generatedAt = timestampMs(report.generatedAt);
  if (generatedAt === null) {
    throw new Error("Cold-Deployment SLO report timestamp is invalid.");
  }
  if (report.runs.some((run) => hasEvidenceAfter(run, generatedAt))) {
    throw new Error("Cold-Deployment SLO report contains evidence after its point-in-time.");
  }
  const derivedRuns = report.runs.map((run) => ({
    run,
    derived: deriveImmutableRunSlo(run, report.generatedAt),
  }));
  if (
    derivedRuns.some(
      ({ run, derived }) => run.eligible !== derived.eligible || run.sloStatus !== derived.status,
    )
  ) {
    throw new Error("Cold-Deployment SLO run flags disagree with immutable identity and timing.");
  }
  const selectedRuns = derivedRuns
    .filter(({ derived }) => derived.eligible && derived.status !== "diagnostic")
    .sort(
      (left, right) =>
        String(right.run.acceptedAt).localeCompare(String(left.run.acceptedAt)) ||
        right.run.deploymentId.localeCompare(left.run.deploymentId),
    )
    .slice(0, COLD_DEPLOYMENT_SLO_SAMPLE_SIZE);
  const readyWithinObjective = selectedRuns.filter(
    ({ derived }) => derived.status === "pass",
  ).length;
  const misses = selectedRuns.filter(({ derived }) => derived.status === "miss").length;
  const pending = selectedRuns.filter(({ derived }) => derived.status === "pending").length;
  const outcome = {
    eligibleCount: selectedRuns.length,
    readyWithinObjective,
    misses,
    pending,
    proven:
      selectedRuns.length === COLD_DEPLOYMENT_SLO_SAMPLE_SIZE &&
      pending === 0 &&
      readyWithinObjective >= COLD_DEPLOYMENT_SLO_READY_REQUIRED,
  };
  if (
    report.slo.eligible !== outcome.eligibleCount ||
    report.slo.sampleSize !== outcome.eligibleCount ||
    report.slo.readyWithinObjective !== outcome.readyWithinObjective ||
    report.slo.misses !== outcome.misses ||
    report.slo.pending !== outcome.pending ||
    report.slo.passesGate !== outcome.proven
  ) {
    throw new Error("Cold-Deployment SLO report summary disagrees with its immutable runs.");
  }
  assertApiAcceptance(apiAcceptance);
  const generations = [
    ...new Set(
      selectedRuns
        .map(({ run }) => run.rolloutConfigurationGeneration)
        .filter((generation): generation is number => generation !== null),
    ),
  ].sort((left, right) => left - right);
  return {
    schemaVersion: COLD_DEPLOYMENT_SLO_EVALUATION_SCHEMA_VERSION,
    generatedAt: report.generatedAt,
    criteria: {
      sampleSize: COLD_DEPLOYMENT_SLO_SAMPLE_SIZE,
      requiredReadyWithinObjective: COLD_DEPLOYMENT_SLO_READY_REQUIRED,
      objectiveSeconds: COLD_DEPLOYMENT_SLO_OBJECTIVE_SECONDS,
    },
    outcome,
    rolloutConfigurationGenerations: generations,
    apiAcceptance,
    report,
  };
}

function hasEvidenceAfter(run: AgentDeploymentLatencyReport["runs"][number], generatedAt: number) {
  return (
    [run.createdAt, run.acceptedAt, run.ownerCancelledAt, run.terminalAt].some((value) => {
      const timestamp = timestampMs(value);
      return timestamp !== null && timestamp > generatedAt;
    }) ||
    run.stages.some((stage) =>
      [stage.startedAt, stage.completedAt].some((value) => {
        const timestamp = timestampMs(value);
        return timestamp !== null && timestamp > generatedAt;
      }),
    )
  );
}

function deriveImmutableRunSlo(
  run: AgentDeploymentLatencyReport["runs"][number],
  generatedAtValue: string,
): { eligible: boolean; status: "pass" | "miss" | "pending" | "diagnostic" } {
  const acceptedAt = timestampMs(run.acceptedAt);
  const createdAt = timestampMs(run.createdAt);
  const generatedAt = timestampMs(generatedAtValue);
  const cancelledAt = run.ownerCancelledAt === null ? null : timestampMs(run.ownerCancelledAt);
  const terminalAt = run.terminalAt === null ? null : timestampMs(run.terminalAt);
  if (
    acceptedAt === null ||
    createdAt === null ||
    generatedAt === null ||
    acceptedAt < createdAt ||
    generatedAt < acceptedAt ||
    (run.ownerCancelledAt !== null && cancelledAt === null) ||
    (cancelledAt !== null && cancelledAt < acceptedAt) ||
    ((run.outcome === "ready" || run.outcome === "failed") &&
      (terminalAt === null || terminalAt < acceptedAt)) ||
    (run.outcome === "incomplete" && terminalAt !== null)
  ) {
    return { eligible: false, status: "diagnostic" };
  }
  const status =
    run.outcome === "ready"
      ? terminalAt !== null && terminalAt - acceptedAt <= COLD_DEPLOYMENT_SLO_OBJECTIVE_MS
        ? "pass"
        : "miss"
      : run.outcome === "failed" || generatedAt - acceptedAt >= COLD_DEPLOYMENT_SLO_OBJECTIVE_MS
        ? "miss"
        : "pending";
  const eligible =
    run.origin === "owner_request" &&
    run.deploymentEnvironment === "production" &&
    run.cohort === "cold_deployment" &&
    Number.isInteger(run.rolloutConfigurationGeneration) &&
    Number(run.rolloutConfigurationGeneration) >= 1 &&
    !(cancelledAt !== null && cancelledAt - acceptedAt < COLD_DEPLOYMENT_SLO_OBJECTIVE_MS);
  return {
    eligible,
    status,
  };
}

function timestampMs(value: string | null): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertApiAcceptance(value: AgentDeploymentApiAcceptanceSummary): void {
  if (
    Object.keys(value).sort().join("\0") !==
      ["accepted", "availability", "outcomeUnknown", "pending", "rejected", "sampleSize"]
        .sort()
        .join("\0") ||
    !Number.isInteger(value.sampleSize) ||
    value.sampleSize < 0 ||
    value.sampleSize > 100 ||
    ![value.accepted, value.rejected, value.outcomeUnknown, value.pending].every(
      (count) => Number.isInteger(count) && count >= 0,
    ) ||
    value.accepted + value.rejected + value.outcomeUnknown + value.pending !== value.sampleSize ||
    value.availability !== (value.sampleSize === 0 ? 0 : value.accepted / value.sampleSize)
  ) {
    throw new Error("Cold-Deployment API-acceptance summary is invalid.");
  }
}

function assertSigningKeyId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Cold-Deployment SLO signing key ID is invalid.");
  }
}

function digestBytes(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
