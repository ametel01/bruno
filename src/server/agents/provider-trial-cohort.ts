import "server-only";

import { createHash, randomUUID, sign, verify } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import { agentDeployments, providerTrialCohorts, providerTrialSlots } from "@/src/server/db/schema";

export const PROVIDER_TRIAL_SLOT_COUNT = 30;
export const PROVIDER_TRIAL_REPORT_SCHEMA_VERSION = "bruno.provider-trial-cohort.v1";
export const PROVIDER_TRIAL_READY_WITHIN_MS = 60_000;

const SAFE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,127}$/;
const SAFE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SAFE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_TRIAL_SAFE_CODES = [
  "deployment_failed",
  "ready_timeout",
  "request_failed",
  "request_outcome_unknown",
  "request_rejected",
  "request_validation_failed",
  "safety_failure",
] as const;
const PROVIDER_TRIAL_SAFE_CODE_SET: ReadonlySet<string> = new Set(PROVIDER_TRIAL_SAFE_CODES);

export type ProviderTrialRequestOutcome = "committed" | "pre_commit_failure";
export type ProviderTrialSafeCode = (typeof PROVIDER_TRIAL_SAFE_CODES)[number];
export type ProviderTrialTerminalOutcome =
  | "pre_commit_failure"
  | "ready_within_60"
  | "ready_after_60"
  | "deployment_failed"
  | "timed_out"
  | "safety_failure";

export type ProviderTrialSlotAttempt = {
  cohortId: string;
  slotId: string;
  slotNumber: number;
  requestAttemptId: string;
  requestStartedAt: string;
};

export type ProviderTrialCohortReport = {
  schemaVersion: typeof PROVIDER_TRIAL_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  cohort: {
    cohortKey: string;
    region: string;
    runnerSizeSlug: string;
    rolloutConfigurationGeneration: number;
    slotCount: typeof PROVIDER_TRIAL_SLOT_COUNT;
    startedAt: string | null;
  };
  apiAcceptance: {
    totalSlots: typeof PROVIDER_TRIAL_SLOT_COUNT;
    committed: number;
    preCommitFailures: number;
    pending: number;
    availability: number;
  };
  readiness: {
    totalSlots: typeof PROVIDER_TRIAL_SLOT_COUNT;
    committed: number;
    readyWithin60: number;
    allSlotMisses: number;
    pending: number;
    committedPassRate: number;
    passesGate: boolean;
  };
  slots: Array<{
    slotNumber: number;
    requestOutcome: ProviderTrialRequestOutcome | null;
    requestSafeCode: ProviderTrialSafeCode | null;
    deploymentId: string | null;
    terminalOutcome: ProviderTrialTerminalOutcome | null;
    terminalSafeCode: ProviderTrialSafeCode | null;
  }>;
};

export type SignedProviderTrialCohortReport = {
  canonicalBytes: string;
  digest: string;
  keyId: string;
  signature: string;
};

export function providerTrialDeploymentIdempotencyKey(requestAttemptId: string): string {
  assertUuid(requestAttemptId, "requestAttemptId");
  return `provider-trial:${requestAttemptId.toLowerCase()}`;
}

export async function createProviderTrialCohort(
  connection: DatabaseConnection,
  input: {
    cohortKey: string;
    region: string;
    runnerSizeSlug: string;
    rolloutConfigurationGeneration: number;
  },
) {
  assertSafeCohortInput(input);

  return await connection.db.transaction(async (tx) => {
    const [cohort] = await tx.insert(providerTrialCohorts).values(input).returning();

    if (!cohort) {
      throw new Error("Provider Trial Cohort insert returned no row.");
    }

    await tx.insert(providerTrialSlots).values(
      Array.from({ length: PROVIDER_TRIAL_SLOT_COUNT }, (_, index) => ({
        cohortId: cohort.id,
        slotNumber: index + 1,
      })),
    );

    return cohort;
  });
}

export async function beginProviderTrialSlot(
  connection: DatabaseConnection,
  input: { cohortId: string; slotNumber: number },
): Promise<ProviderTrialSlotAttempt> {
  assertUuid(input.cohortId, "cohortId");
  assertSlotNumber(input.slotNumber);
  const requestAttemptId = randomUUID();

  return await connection.db.transaction(async (tx) => {
    const cohorts = await tx.execute<{ id: string }>(sql`
      update ${providerTrialCohorts}
      set started_at = coalesce(started_at, clock_timestamp())
      where ${providerTrialCohorts.id} = ${input.cohortId}
      returning ${providerTrialCohorts.id} as id
    `);

    if (!cohorts[0]) {
      throw new Error("Provider Trial Cohort was not found.");
    }

    const rows = await tx.execute<{
      cohortId: string;
      slotId: string;
      slotNumber: number;
      requestAttemptId: string;
      requestStartedAt: Date | string;
    }>(sql`
      update ${providerTrialSlots}
      set request_attempt_id = ${requestAttemptId},
          request_started_at = clock_timestamp()
      where ${providerTrialSlots.cohortId} = ${input.cohortId}
        and ${providerTrialSlots.slotNumber} = ${input.slotNumber}
        and ${providerTrialSlots.requestAttemptId} is null
      returning
        ${providerTrialSlots.cohortId} as "cohortId",
        ${providerTrialSlots.id} as "slotId",
        ${providerTrialSlots.slotNumber} as "slotNumber",
        ${providerTrialSlots.requestAttemptId} as "requestAttemptId",
        ${providerTrialSlots.requestStartedAt} as "requestStartedAt"
    `);
    const row = rows[0];

    if (!row) {
      throw new Error(`Provider Trial slot ${input.slotNumber} has already started.`);
    }

    return {
      ...row,
      requestStartedAt: toIso(row.requestStartedAt),
    };
  });
}

export async function recordProviderTrialRequestOutcome(
  connection: DatabaseConnection,
  input:
    | (ProviderTrialSlotAttempt & {
        outcome: "pre_commit_failure";
        safeCode: ProviderTrialSafeCode;
      })
    | (ProviderTrialSlotAttempt & {
        outcome: "committed";
        deploymentId: string;
      }),
) {
  assertAttempt(input);
  if (input.outcome === "pre_commit_failure") {
    assertSafeCode(input.safeCode);
  } else {
    assertUuid(input.deploymentId, "deploymentId");
  }

  const rows = await connection.db.execute<ProviderTrialOutcomeRow>(sql`
    update ${providerTrialSlots}
    set request_outcome = ${input.outcome},
        request_safe_code = ${input.outcome === "pre_commit_failure" ? input.safeCode : null},
        request_outcome_recorded_at = clock_timestamp(),
        deployment_id = ${input.outcome === "committed" ? input.deploymentId : null},
        terminal_outcome = ${input.outcome === "pre_commit_failure" ? "pre_commit_failure" : null},
        terminal_safe_code = ${input.outcome === "pre_commit_failure" ? input.safeCode : null},
        terminal_recorded_at = ${
          input.outcome === "pre_commit_failure" ? sql`clock_timestamp()` : null
        }
    where ${providerTrialSlots.id} = ${input.slotId}
      and ${providerTrialSlots.cohortId} = ${input.cohortId}
      and ${providerTrialSlots.slotNumber} = ${input.slotNumber}
      and ${providerTrialSlots.requestAttemptId} = ${input.requestAttemptId}
      and ${providerTrialSlots.requestOutcome} is null
    returning ${OUTCOME_RETURNING_SQL}
  `);
  const row = rows[0];

  if (!row) {
    throw new Error(
      `Provider Trial slot ${input.slotNumber} request outcome has already been recorded.`,
    );
  }

  return mapOutcomeRow(row);
}

export async function recordProviderTrialTerminalOutcome(
  connection: DatabaseConnection,
  input: ProviderTrialSlotAttempt &
    ({ outcome: "observe_deployment" } | { outcome: "timed_out" | "safety_failure" }),
) {
  assertAttempt(input);

  return await connection.db.transaction(async (tx) => {
    const [evidence] = await tx.execute<{
      acceptedAt: Date | string;
      completedAt: Date | string | null;
      errorCode: string | null;
      failedAt: Date | string | null;
      observedAt: Date | string;
      stage: string;
    }>(sql`
      select
        d.accepted_at as "acceptedAt",
        d.completed_at as "completedAt",
        d.error_code as "errorCode",
        d.failed_at as "failedAt",
        clock_timestamp() as "observedAt",
        d.stage::text as stage
      from ${providerTrialSlots} s
      inner join ${agentDeployments} d on d.id = s.deployment_id
      where s.id = ${input.slotId}
        and s.cohort_id = ${input.cohortId}
        and s.slot_number = ${input.slotNumber}
        and s.request_attempt_id = ${input.requestAttemptId}
        and s.request_outcome = 'committed'
        and s.terminal_outcome is null
      for update of s
    `);

    if (!evidence) {
      throw new Error(
        `Provider Trial slot ${input.slotNumber} is not committed or its terminal outcome has already been recorded.`,
      );
    }

    const terminal = deriveTerminalOutcome(input.outcome, evidence);
    const rows = await tx.execute<ProviderTrialOutcomeRow>(sql`
      update ${providerTrialSlots}
      set terminal_outcome = ${terminal.outcome},
          terminal_safe_code = ${terminal.safeCode},
          terminal_recorded_at = clock_timestamp()
      where ${providerTrialSlots.id} = ${input.slotId}
        and ${providerTrialSlots.terminalOutcome} is null
      returning ${OUTCOME_RETURNING_SQL}
    `);
    const row = rows[0];

    if (!row) {
      throw new Error(`Provider Trial slot ${input.slotNumber} terminal outcome was not recorded.`);
    }

    return mapOutcomeRow(row);
  });
}

export async function buildProviderTrialCohortReport(
  connection: DatabaseConnection,
  cohortId: string,
  options: { generatedAt?: Date } = {},
): Promise<ProviderTrialCohortReport> {
  assertUuid(cohortId, "cohortId");
  const [cohort] = await connection.db
    .select()
    .from(providerTrialCohorts)
    .where(eq(providerTrialCohorts.id, cohortId))
    .limit(1);

  if (!cohort) {
    throw new Error("Provider Trial Cohort was not found.");
  }

  const rows = await connection.db
    .select({
      slotNumber: providerTrialSlots.slotNumber,
      requestOutcome: providerTrialSlots.requestOutcome,
      requestSafeCode: providerTrialSlots.requestSafeCode,
      deploymentId: providerTrialSlots.deploymentId,
      terminalOutcome: providerTrialSlots.terminalOutcome,
      terminalSafeCode: providerTrialSlots.terminalSafeCode,
    })
    .from(providerTrialSlots)
    .where(eq(providerTrialSlots.cohortId, cohortId))
    .orderBy(asc(providerTrialSlots.slotNumber));

  if (
    rows.length !== PROVIDER_TRIAL_SLOT_COUNT ||
    rows.some((row, index) => row.slotNumber !== index + 1)
  ) {
    throw new Error("Provider Trial Cohort membership is incomplete or non-deterministic.");
  }

  const slots = rows.map((row) => ({
    slotNumber: row.slotNumber,
    requestOutcome: asRequestOutcome(row.requestOutcome),
    requestSafeCode: asSafeCode(row.requestSafeCode),
    deploymentId: row.deploymentId,
    terminalOutcome: asTerminalOutcome(row.terminalOutcome),
    terminalSafeCode: asSafeCode(row.terminalSafeCode),
  }));
  const summaries = summarizeProviderTrialSlots(slots);

  return {
    schemaVersion: PROVIDER_TRIAL_REPORT_SCHEMA_VERSION,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    cohort: {
      cohortKey: cohort.cohortKey,
      region: cohort.region,
      runnerSizeSlug: cohort.runnerSizeSlug,
      rolloutConfigurationGeneration: cohort.rolloutConfigurationGeneration,
      slotCount: PROVIDER_TRIAL_SLOT_COUNT,
      startedAt: cohort.startedAt?.toISOString() ?? null,
    },
    ...summaries,
    slots,
  };
}

export function createSignedProviderTrialCohortReport(input: {
  report: ProviderTrialCohortReport;
  keyId: string;
  privateKeyPem: string;
}): SignedProviderTrialCohortReport {
  if (!SAFE_KEY_ID_PATTERN.test(input.keyId)) {
    throw new Error("Provider Trial report keyId is invalid.");
  }
  assertValidReport(input.report);
  const canonicalBytes = canonicalJson(input.report);

  return {
    canonicalBytes,
    digest: digest(canonicalBytes),
    keyId: input.keyId,
    signature: sign(null, Buffer.from(canonicalBytes), input.privateKeyPem).toString("base64url"),
  };
}

export function verifySignedProviderTrialCohortReport(
  input: SignedProviderTrialCohortReport & { publicKeyPem: string },
):
  | { ok: true; report: ProviderTrialCohortReport; digest: string; keyId: string }
  | { ok: false; reason: "report_invalid" | "report_signature_invalid" } {
  if (!SAFE_KEY_ID_PATTERN.test(input.keyId) || input.digest !== digest(input.canonicalBytes)) {
    return { ok: false, reason: "report_invalid" };
  }

  if (
    !verify(
      null,
      Buffer.from(input.canonicalBytes),
      input.publicKeyPem,
      Buffer.from(input.signature, "base64url"),
    )
  ) {
    return { ok: false, reason: "report_signature_invalid" };
  }

  try {
    const report = JSON.parse(input.canonicalBytes) as unknown;
    assertValidReport(report);
    if (canonicalJson(report) !== input.canonicalBytes) {
      return { ok: false, reason: "report_invalid" };
    }
    return { ok: true, report, digest: input.digest, keyId: input.keyId };
  } catch {
    return { ok: false, reason: "report_invalid" };
  }
}

type ProviderTrialOutcomeRow = {
  requestOutcome: string | null;
  deploymentId: string | null;
  terminalOutcome: string | null;
};

function deriveTerminalOutcome(
  requested: "observe_deployment" | "timed_out" | "safety_failure",
  evidence: {
    acceptedAt: Date | string;
    completedAt: Date | string | null;
    errorCode: string | null;
    failedAt: Date | string | null;
    observedAt: Date | string;
    stage: string;
  },
): {
  outcome: Exclude<ProviderTrialTerminalOutcome, "pre_commit_failure">;
  safeCode: ProviderTrialSafeCode | null;
} {
  if (requested === "safety_failure") {
    return { outcome: requested, safeCode: "safety_failure" };
  }

  const acceptedAt = new Date(evidence.acceptedAt).getTime();
  if (!Number.isFinite(acceptedAt)) {
    throw new Error("Provider Trial deployment has no valid durable acceptance boundary.");
  }

  if (evidence.stage === "ready" && evidence.completedAt) {
    const completedAt = new Date(evidence.completedAt).getTime();
    if (!Number.isFinite(completedAt) || completedAt < acceptedAt) {
      throw new Error("Provider Trial deployment readiness evidence is invalid.");
    }
    return {
      outcome:
        completedAt - acceptedAt <= PROVIDER_TRIAL_READY_WITHIN_MS
          ? "ready_within_60"
          : "ready_after_60",
      safeCode: null,
    };
  }

  if (evidence.stage === "failed" && evidence.failedAt && evidence.errorCode) {
    return { outcome: "deployment_failed", safeCode: "deployment_failed" };
  }

  if (requested === "timed_out") {
    const observedAt = new Date(evidence.observedAt).getTime();
    if (observedAt - acceptedAt < PROVIDER_TRIAL_READY_WITHIN_MS) {
      throw new Error("Provider Trial deployment cannot time out before the 60-second boundary.");
    }
    return { outcome: requested, safeCode: "ready_timeout" };
  }

  throw new Error("Provider Trial deployment has no durable terminal outcome to observe.");
}

const OUTCOME_RETURNING_SQL = sql`
  ${providerTrialSlots.requestOutcome} as "requestOutcome",
  ${providerTrialSlots.deploymentId} as "deploymentId",
  ${providerTrialSlots.terminalOutcome} as "terminalOutcome"
`;

function mapOutcomeRow(row: ProviderTrialOutcomeRow) {
  return {
    requestOutcome: asRequestOutcome(row.requestOutcome),
    deploymentId: row.deploymentId,
    terminalOutcome: asTerminalOutcome(row.terminalOutcome),
  };
}

function assertSafeCohortInput(input: {
  cohortKey: string;
  region: string;
  runnerSizeSlug: string;
  rolloutConfigurationGeneration: number;
}): void {
  if (
    !SAFE_KEY_PATTERN.test(input.cohortKey) ||
    !SAFE_SLUG_PATTERN.test(input.region) ||
    !SAFE_SLUG_PATTERN.test(input.runnerSizeSlug) ||
    !Number.isInteger(input.rolloutConfigurationGeneration) ||
    input.rolloutConfigurationGeneration < 1
  ) {
    throw new Error("Provider Trial Cohort identity is invalid.");
  }
}

function assertAttempt(input: ProviderTrialSlotAttempt): void {
  assertUuid(input.cohortId, "cohortId");
  assertUuid(input.slotId, "slotId");
  assertUuid(input.requestAttemptId, "requestAttemptId");
  assertSlotNumber(input.slotNumber);
}

function assertSlotNumber(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > PROVIDER_TRIAL_SLOT_COUNT) {
    throw new Error(
      `Provider Trial slot number must be between 1 and ${PROVIDER_TRIAL_SLOT_COUNT}.`,
    );
  }
}

function assertSafeCode(value: string): asserts value is ProviderTrialSafeCode {
  if (!isSafeCode(value)) {
    throw new Error("Provider Trial safe outcome code is invalid.");
  }
}

function asSafeCode(value: string | null): ProviderTrialSafeCode | null {
  if (value === null || isSafeCode(value)) return value;
  throw new Error("Provider Trial safe outcome code is invalid.");
}

function isSafeCode(value: unknown): value is ProviderTrialSafeCode {
  return typeof value === "string" && PROVIDER_TRIAL_SAFE_CODE_SET.has(value);
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Provider Trial ${label} is invalid.`);
  }
}

function asRequestOutcome(value: string | null): ProviderTrialRequestOutcome | null {
  if (value === null || value === "committed" || value === "pre_commit_failure") return value;
  throw new Error("Provider Trial request outcome is invalid.");
}

function asTerminalOutcome(value: string | null): ProviderTrialTerminalOutcome | null {
  if (
    value === null ||
    value === "pre_commit_failure" ||
    value === "ready_within_60" ||
    value === "ready_after_60" ||
    value === "deployment_failed" ||
    value === "timed_out" ||
    value === "safety_failure"
  ) {
    return value;
  }
  throw new Error("Provider Trial terminal outcome is invalid.");
}

function assertValidReport(value: unknown): asserts value is ProviderTrialCohortReport {
  if (!isRecord(value) || !hasOnlyKeys(value, REPORT_KEYS)) throw new Error("report_invalid");
  if (
    value.schemaVersion !== PROVIDER_TRIAL_REPORT_SCHEMA_VERSION ||
    !isIso(value.generatedAt) ||
    !isValidCohort(value.cohort) ||
    !isValidApiAcceptance(value.apiAcceptance) ||
    !isValidReadiness(value.readiness) ||
    !Array.isArray(value.slots) ||
    value.slots.length !== PROVIDER_TRIAL_SLOT_COUNT ||
    !value.slots.every((slot, index) => isValidReportSlot(slot, index + 1)) ||
    !hasConsistentSummaries(value as ProviderTrialCohortReport)
  ) {
    throw new Error("report_invalid");
  }
}

function hasConsistentSummaries(report: ProviderTrialCohortReport): boolean {
  const expected = summarizeProviderTrialSlots(report.slots);
  return (
    canonicalJson({
      apiAcceptance: report.apiAcceptance,
      readiness: report.readiness,
    }) === canonicalJson(expected)
  );
}

function summarizeProviderTrialSlots(
  slots: ProviderTrialCohortReport["slots"],
): Pick<ProviderTrialCohortReport, "apiAcceptance" | "readiness"> {
  const committed = slots.filter((slot) => slot.requestOutcome === "committed").length;
  const preCommitFailures = slots.filter(
    (slot) => slot.requestOutcome === "pre_commit_failure",
  ).length;
  const readyWithin60 = slots.filter((slot) => slot.terminalOutcome === "ready_within_60").length;
  const allSlotMisses = slots.filter(
    (slot) => slot.terminalOutcome !== null && slot.terminalOutcome !== "ready_within_60",
  ).length;
  const pending = slots.filter((slot) => slot.terminalOutcome === null).length;

  return {
    apiAcceptance: {
      totalSlots: PROVIDER_TRIAL_SLOT_COUNT,
      committed,
      preCommitFailures,
      pending: PROVIDER_TRIAL_SLOT_COUNT - committed - preCommitFailures,
      availability: committed / PROVIDER_TRIAL_SLOT_COUNT,
    },
    readiness: {
      totalSlots: PROVIDER_TRIAL_SLOT_COUNT,
      committed,
      readyWithin60,
      allSlotMisses,
      pending,
      committedPassRate: committed === 0 ? 0 : readyWithin60 / committed,
      passesGate:
        pending === 0 &&
        committed >= 29 &&
        readyWithin60 >= 29 &&
        readyWithin60 / committed >= 0.95,
    },
  };
}

function isValidCohort(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, COHORT_KEYS) &&
    typeof value.cohortKey === "string" &&
    SAFE_KEY_PATTERN.test(value.cohortKey) &&
    typeof value.region === "string" &&
    SAFE_SLUG_PATTERN.test(value.region) &&
    typeof value.runnerSizeSlug === "string" &&
    SAFE_SLUG_PATTERN.test(value.runnerSizeSlug) &&
    Number.isInteger(value.rolloutConfigurationGeneration) &&
    Number(value.rolloutConfigurationGeneration) >= 1 &&
    value.slotCount === PROVIDER_TRIAL_SLOT_COUNT &&
    (value.startedAt === null || isIso(value.startedAt))
  );
}

function isValidApiAcceptance(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, API_KEYS) &&
    value.totalSlots === PROVIDER_TRIAL_SLOT_COUNT &&
    areCounts([value.committed, value.preCommitFailures, value.pending]) &&
    Number(value.committed) + Number(value.preCommitFailures) + Number(value.pending) ===
      PROVIDER_TRIAL_SLOT_COUNT &&
    value.availability === Number(value.committed) / PROVIDER_TRIAL_SLOT_COUNT
  );
}

function isValidReadiness(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, READINESS_KEYS) &&
    value.totalSlots === PROVIDER_TRIAL_SLOT_COUNT &&
    areCounts([value.committed, value.readyWithin60, value.allSlotMisses, value.pending]) &&
    typeof value.committedPassRate === "number" &&
    value.committedPassRate >= 0 &&
    value.committedPassRate <= 1 &&
    typeof value.passesGate === "boolean"
  );
}

function isValidReportSlot(value: unknown, expectedNumber: number): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, SLOT_KEYS) || value.slotNumber !== expectedNumber) {
    return false;
  }
  try {
    asRequestOutcome(
      typeof value.requestOutcome === "string"
        ? value.requestOutcome
        : nullValue(value.requestOutcome),
    );
    asTerminalOutcome(
      typeof value.terminalOutcome === "string"
        ? value.terminalOutcome
        : nullValue(value.terminalOutcome),
    );
  } catch {
    return false;
  }
  if (
    !isNullableSafeCode(value.requestSafeCode) ||
    !isNullableSafeCode(value.terminalSafeCode) ||
    !(
      value.deploymentId === null ||
      (typeof value.deploymentId === "string" && UUID_PATTERN.test(value.deploymentId))
    )
  ) {
    return false;
  }

  if (value.requestOutcome === null) {
    return (
      value.requestSafeCode === null &&
      value.deploymentId === null &&
      value.terminalOutcome === null &&
      value.terminalSafeCode === null
    );
  }

  if (value.requestOutcome === "pre_commit_failure") {
    return (
      typeof value.requestSafeCode === "string" &&
      value.deploymentId === null &&
      value.terminalOutcome === "pre_commit_failure" &&
      value.terminalSafeCode === value.requestSafeCode
    );
  }

  if (value.requestSafeCode !== null || typeof value.deploymentId !== "string") return false;
  if (value.terminalOutcome === null) return value.terminalSafeCode === null;
  if (value.terminalOutcome === "ready_within_60" || value.terminalOutcome === "ready_after_60") {
    return value.terminalSafeCode === null;
  }
  return (
    (value.terminalOutcome === "deployment_failed" ||
      value.terminalOutcome === "timed_out" ||
      value.terminalOutcome === "safety_failure") &&
    typeof value.terminalSafeCode === "string"
  );
}

function nullValue(value: unknown): null {
  if (value !== null) throw new Error("not_null");
  return null;
}

function isNullableSafeCode(value: unknown): boolean {
  return value === null || isSafeCode(value);
}

function areCounts(values: unknown[]): boolean {
  return values.every((value) => Number.isInteger(value) && Number(value) >= 0);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && new Date(value).toISOString() === value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

function toCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCanonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, toCanonicalValue(nested)]),
  );
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const REPORT_KEYS = [
  "schemaVersion",
  "generatedAt",
  "cohort",
  "apiAcceptance",
  "readiness",
  "slots",
] as const;
const COHORT_KEYS = [
  "cohortKey",
  "region",
  "runnerSizeSlug",
  "rolloutConfigurationGeneration",
  "slotCount",
  "startedAt",
] as const;
const API_KEYS = [
  "totalSlots",
  "committed",
  "preCommitFailures",
  "pending",
  "availability",
] as const;
const READINESS_KEYS = [
  "totalSlots",
  "committed",
  "readyWithin60",
  "allSlotMisses",
  "pending",
  "committedPassRate",
  "passesGate",
] as const;
const SLOT_KEYS = [
  "slotNumber",
  "requestOutcome",
  "requestSafeCode",
  "deploymentId",
  "terminalOutcome",
  "terminalSafeCode",
] as const;
