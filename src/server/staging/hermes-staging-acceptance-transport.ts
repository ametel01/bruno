import "server-only";

import {
  type HermesStagingAcceptanceErrorCode,
  type HermesStagingAcceptancePhase,
  parseHermesStagingAcceptanceErrorCode,
  parseHermesStagingAcceptancePhase,
} from "@/src/server/staging/hermes-staging-acceptance-state";

export const HERMES_STAGING_ACCEPTANCE_REQUEST_MAX_BYTES = 2 * 1024;

export type HermesStagingAcceptanceCommand =
  | { command: "begin" }
  | {
      command: "attest_telegram_reply";
      runId: string;
      challengeId: string;
      attestationToken: string;
    }
  | { command: "request_cleanup"; runId: string }
  | { command: "advance"; runId: string }
  | { command: "read"; runId: string };

type AutomaticNextAction = {
  kind: "automatic";
  retryAt: string | null;
};

type OperatorTelegramNextAction = {
  kind: "operator_telegram";
  challengeId: string;
  text: string;
  purpose: "initial" | "post_restart";
  expiresAt: string;
};

type NoNextAction = { kind: "none" };

export type HermesStagingAcceptanceSafeProjection = {
  runId: string;
  phase: HermesStagingAcceptancePhase;
  desiredOutcome: "acceptance" | "cleanup";
  nextAction: AutomaticNextAction | OperatorTelegramNextAction | NoNextAction;
  checks: {
    imageAttested: boolean;
    deploymentStagesObserved: boolean;
    initialReplyAttested: boolean;
    restartReady: boolean;
    restartImageAttested: boolean;
    postRestartReplyAttested: boolean;
    diagnosticsRedacted: boolean;
    intentionalStopStable: boolean;
    rollbackVerified: boolean;
  };
  cleanup: {
    agent: "not_created" | "present" | "absent";
    workload: "not_created" | "present" | "absent";
    firewall: "not_created" | "present" | "absent";
    droplet: "not_created" | "present" | "absent";
    runner: "not_created" | "present" | "deleted";
    secretsRevoked: boolean;
  };
  errorCode: HermesStagingAcceptanceErrorCode | null;
  nextAttemptAt: string | null;
  completedAt: string | null;
};

export type HermesStagingAcceptanceReconcileProjection = {
  processed: 0 | 1;
  outcome: "idle" | "advanced" | "waiting" | "cleanup_pending" | "complete";
  run: HermesStagingAcceptanceSafeProjection | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ATTESTATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const RECONCILE_OUTCOMES = new Set(["idle", "advanced", "waiting", "cleanup_pending", "complete"]);

export function parseHermesStagingAcceptanceCommand(
  value: unknown,
): HermesStagingAcceptanceCommand | null {
  if (!isPlainRecord(value) || typeof value.command !== "string") {
    return null;
  }

  switch (value.command) {
    case "begin":
      return hasExactKeys(value, ["command"]) ? { command: "begin" } : null;
    case "attest_telegram_reply":
      return hasExactKeys(value, ["command", "runId", "challengeId", "attestationToken"]) &&
        isUuid(value.runId) &&
        isUuid(value.challengeId) &&
        typeof value.attestationToken === "string" &&
        ATTESTATION_TOKEN_PATTERN.test(value.attestationToken)
        ? {
            command: "attest_telegram_reply",
            runId: value.runId,
            challengeId: value.challengeId,
            attestationToken: value.attestationToken,
          }
        : null;
    case "request_cleanup":
    case "advance":
    case "read":
      return hasExactKeys(value, ["command", "runId"]) && isUuid(value.runId)
        ? { command: value.command, runId: value.runId }
        : null;
    default:
      return null;
  }
}

export function parseHermesStagingAcceptanceSafeProjection(
  value: unknown,
): HermesStagingAcceptanceSafeProjection | null {
  if (!isPlainRecord(value) || !isUuid(value.runId)) {
    return null;
  }

  const phase = parseHermesStagingAcceptancePhase(value.phase);
  const errorCode =
    value.errorCode === null ? null : parseHermesStagingAcceptanceErrorCode(value.errorCode);
  const desiredOutcome =
    value.desiredOutcome === "acceptance" || value.desiredOutcome === "cleanup"
      ? value.desiredOutcome
      : null;
  const nextAction = parseNextAction(value.nextAction);
  const checks = parseChecks(value.checks);
  const cleanup = parseCleanup(value.cleanup);
  const nextAttemptAt = parseNullableTimestamp(value.nextAttemptAt);
  const completedAt = parseNullableTimestamp(value.completedAt);

  if (
    !phase ||
    !desiredOutcome ||
    !nextAction ||
    !checks ||
    !cleanup ||
    (value.errorCode !== null && !errorCode) ||
    nextAttemptAt === undefined ||
    completedAt === undefined
  ) {
    return null;
  }

  return {
    runId: value.runId,
    phase,
    desiredOutcome,
    nextAction,
    checks,
    cleanup,
    errorCode,
    nextAttemptAt,
    completedAt,
  };
}

export function parseHermesStagingAcceptanceReconcileProjection(
  value: unknown,
): HermesStagingAcceptanceReconcileProjection | null {
  if (
    !isPlainRecord(value) ||
    (value.processed !== 0 && value.processed !== 1) ||
    typeof value.outcome !== "string" ||
    !RECONCILE_OUTCOMES.has(value.outcome)
  ) {
    return null;
  }

  const run = value.run === null ? null : parseHermesStagingAcceptanceSafeProjection(value.run);

  if ((value.run !== null && !run) || (value.processed === 0 && run !== null)) {
    return null;
  }

  return {
    processed: value.processed,
    outcome: value.outcome as HermesStagingAcceptanceReconcileProjection["outcome"],
    run,
  };
}

function parseNextAction(
  value: unknown,
): HermesStagingAcceptanceSafeProjection["nextAction"] | null {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    return null;
  }

  if (value.kind === "none" && hasExactKeys(value, ["kind"])) {
    return { kind: "none" };
  }

  if (value.kind === "automatic" && hasExactKeys(value, ["kind", "retryAt"])) {
    const retryAt = parseNullableTimestamp(value.retryAt);
    return retryAt === undefined ? null : { kind: "automatic", retryAt };
  }

  if (
    value.kind === "operator_telegram" &&
    hasExactKeys(value, ["kind", "challengeId", "text", "purpose", "expiresAt"]) &&
    isUuid(value.challengeId) &&
    typeof value.text === "string" &&
    value.text.length >= 1 &&
    value.text.length <= 512 &&
    hasOnlyPrintableCharacters(value.text) &&
    (value.purpose === "initial" || value.purpose === "post_restart")
  ) {
    const expiresAt = parseTimestamp(value.expiresAt);
    return expiresAt
      ? {
          kind: "operator_telegram",
          challengeId: value.challengeId,
          text: value.text,
          purpose: value.purpose,
          expiresAt,
        }
      : null;
  }

  return null;
}

function parseChecks(value: unknown): HermesStagingAcceptanceSafeProjection["checks"] | null {
  const keys = [
    "imageAttested",
    "deploymentStagesObserved",
    "initialReplyAttested",
    "restartReady",
    "restartImageAttested",
    "postRestartReplyAttested",
    "diagnosticsRedacted",
    "intentionalStopStable",
    "rollbackVerified",
  ] as const;

  if (!isPlainRecord(value) || !hasExactKeys(value, keys)) {
    return null;
  }

  if (keys.some((key) => typeof value[key] !== "boolean")) {
    return null;
  }

  return Object.fromEntries(
    keys.map((key) => [key, value[key]]),
  ) as HermesStagingAcceptanceSafeProjection["checks"];
}

function parseCleanup(value: unknown): HermesStagingAcceptanceSafeProjection["cleanup"] | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "agent",
      "workload",
      "firewall",
      "droplet",
      "runner",
      "secretsRevoked",
    ]) ||
    !isResourceState(value.agent) ||
    !isResourceState(value.workload) ||
    !isResourceState(value.firewall) ||
    !isResourceState(value.droplet) ||
    (value.runner !== "not_created" && value.runner !== "present" && value.runner !== "deleted") ||
    typeof value.secretsRevoked !== "boolean"
  ) {
    return null;
  }

  return {
    agent: value.agent,
    workload: value.workload,
    firewall: value.firewall,
    droplet: value.droplet,
    runner: value.runner,
    secretsRevoked: value.secretsRevoked,
  };
}

function isResourceState(value: unknown): value is "not_created" | "present" | "absent" {
  return value === "not_created" || value === "present" || value === "absent";
}

function hasOnlyPrintableCharacters(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
  });
}

function parseNullableTimestamp(value: unknown): string | null | undefined {
  return value === null ? null : (parseTimestamp(value) ?? undefined);
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();

  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
