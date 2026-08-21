import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";
import type {
  FounderProductContractCleanupOutcome,
  FounderProductContractLifecycleScenario,
  FounderProductContractScenarioResult,
} from "./types";

export const FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_SCHEMA_VERSION =
  "bruno.founder-product-contract.scenario-ledger.v1" as const;
export const FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_PRODUCER =
  "bruno.persisted-founder-application" as const;
export const FOUNDER_PRODUCT_CONTRACT_SCENARIO_SIGNING_SECRET_ENV =
  "BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET" as const;

export type FounderProductContractScenarioLedger = {
  schemaVersion: typeof FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_SCHEMA_VERSION;
  producer: typeof FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_PRODUCER;
  sourceRevision: string;
  runId: string;
  observedAt: string;
  results: readonly FounderProductContractScenarioResult[];
  resultsDigest: string;
  signature: string;
};

type ScenarioLedgerPayload = Omit<
  FounderProductContractScenarioLedger,
  "resultsDigest" | "signature"
>;

export function createFounderProductContractScenarioLedger(input: {
  sourceRevision: string;
  runId: string;
  observedAt: string;
  results: readonly FounderProductContractScenarioResult[];
  signingSecret: string;
}): FounderProductContractScenarioLedger {
  const payload = buildScenarioLedgerPayload(input);
  const canonicalPayload = canonicalizeScenarioLedgerPayload(payload);
  return {
    ...payload,
    resultsDigest: `sha256:${createHash("sha256").update(canonicalPayload).digest("hex")}`,
    signature: sign(canonicalPayload, input.signingSecret),
  };
}

export function verifyFounderProductContractScenarioLedger(input: {
  ledger: FounderProductContractScenarioLedger;
  sourceRevision: string;
  runId: string;
  observedAt: string;
  signingSecret: string;
}): FounderProductContractScenarioLedger {
  const { ledger } = input;
  if (
    ledger.schemaVersion !== FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_SCHEMA_VERSION ||
    ledger.producer !== FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_PRODUCER ||
    ledger.sourceRevision !== input.sourceRevision ||
    ledger.runId !== input.runId ||
    ledger.observedAt !== input.observedAt
  ) {
    throw new Error("Founder Product Contract lifecycle ledger identity is invalid.");
  }
  const payload = buildScenarioLedgerPayload(ledger);
  const canonicalPayload = canonicalizeScenarioLedgerPayload(payload);
  const expectedDigest = `sha256:${createHash("sha256").update(canonicalPayload).digest("hex")}`;
  if (ledger.resultsDigest !== expectedDigest) {
    throw new Error("Founder Product Contract lifecycle ledger digest is invalid.");
  }
  if (!safeEqual(ledger.signature, sign(canonicalPayload, input.signingSecret))) {
    throw new Error("Founder Product Contract lifecycle ledger signature is invalid.");
  }
  return {
    ...payload,
    resultsDigest: ledger.resultsDigest,
    signature: ledger.signature,
  };
}

export function sanitizeFounderProductContractScenarioResult(
  result: FounderProductContractScenarioResult,
): FounderProductContractScenarioResult {
  return {
    id: result.id,
    status: result.status,
    attempts: result.attempts,
    sourceRevision: result.sourceRevision,
    observedAt: result.observedAt,
    cleanup: sanitizeCleanupOutcome(result.cleanup),
  };
}

export function parseFounderProductContractScenarioLedger(input: {
  value: string;
  sourceRevision: string;
  runId: string;
  observedAt: string;
  signingSecret: string;
}): FounderProductContractScenarioLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.value);
  } catch {
    throw new Error("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_JSON is invalid.");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "schemaVersion",
      "producer",
      "sourceRevision",
      "runId",
      "observedAt",
      "results",
      "resultsDigest",
      "signature",
    ])
  ) {
    throw new Error("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_JSON is invalid.");
  }
  if (
    parsed.schemaVersion !== FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_SCHEMA_VERSION ||
    parsed.producer !== FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_PRODUCER ||
    parsed.sourceRevision !== input.sourceRevision ||
    parsed.runId !== input.runId ||
    parsed.observedAt !== input.observedAt ||
    !Array.isArray(parsed.results) ||
    typeof parsed.resultsDigest !== "string" ||
    typeof parsed.signature !== "string"
  ) {
    throw new Error("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_JSON is invalid.");
  }
  const ledger: FounderProductContractScenarioLedger = {
    schemaVersion: parsed.schemaVersion,
    producer: parsed.producer,
    sourceRevision: parsed.sourceRevision,
    runId: parsed.runId,
    observedAt: parsed.observedAt,
    results: parsed.results.map(parseScenarioResult),
    resultsDigest: parsed.resultsDigest,
    signature: parsed.signature,
  };
  return verifyFounderProductContractScenarioLedger({ ...input, ledger });
}

function parseScenarioResult(value: unknown): FounderProductContractScenarioResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "status", "attempts", "sourceRevision", "observedAt", "cleanup"]) ||
    !isLifecycleScenario(value.id) ||
    !isScenarioStatus(value.status) ||
    !Number.isSafeInteger(value.attempts) ||
    (typeof value.sourceRevision !== "string" && value.sourceRevision !== null) ||
    typeof value.observedAt !== "string"
  ) {
    throw new Error("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_JSON is invalid.");
  }
  return {
    id: value.id,
    status: value.status,
    attempts: value.attempts as number,
    sourceRevision: value.sourceRevision,
    observedAt: value.observedAt,
    cleanup: parseCleanupOutcome(value.cleanup),
  };
}

function parseCleanupOutcome(value: unknown): FounderProductContractCleanupOutcome {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "status",
      "verified",
      "resourcesBefore",
      "resourcesAfter",
      "observedAt",
    ]) ||
    !["passed", "failed"].includes(String(value.status)) ||
    typeof value.verified !== "boolean" ||
    !Number.isSafeInteger(value.resourcesBefore) ||
    !Number.isSafeInteger(value.resourcesAfter) ||
    typeof value.observedAt !== "string"
  ) {
    throw new Error("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_JSON is invalid.");
  }
  return {
    status: value.status as FounderProductContractCleanupOutcome["status"],
    verified: value.verified,
    resourcesBefore: value.resourcesBefore as number,
    resourcesAfter: value.resourcesAfter as number,
    observedAt: value.observedAt,
  };
}

function sanitizeScenarioResults(
  results: readonly FounderProductContractScenarioResult[],
): FounderProductContractScenarioResult[] {
  return results.map(sanitizeFounderProductContractScenarioResult);
}

function sanitizeCleanupOutcome(
  cleanup: FounderProductContractCleanupOutcome,
): FounderProductContractCleanupOutcome {
  return {
    status: cleanup.status,
    verified: cleanup.verified,
    resourcesBefore: cleanup.resourcesBefore,
    resourcesAfter: cleanup.resourcesAfter,
    observedAt: cleanup.observedAt,
  };
}

function buildScenarioLedgerPayload(input: {
  sourceRevision: string;
  runId: string;
  observedAt: string;
  results: readonly FounderProductContractScenarioResult[];
}): ScenarioLedgerPayload {
  return {
    schemaVersion: FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_SCHEMA_VERSION,
    producer: FOUNDER_PRODUCT_CONTRACT_SCENARIO_LEDGER_PRODUCER,
    sourceRevision: input.sourceRevision,
    runId: input.runId,
    observedAt: input.observedAt,
    results: sanitizeScenarioResults(input.results),
  };
}

function canonicalizeScenarioLedgerPayload(payload: ScenarioLedgerPayload): string {
  return JSON.stringify(payload);
}

function sign(value: string, secret: string): string {
  if (!secret) throw new Error("Founder Product Contract scenario signing secret is required.");
  return `hmac-sha256:${createHmac("sha256", secret).update(value).digest("hex")}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isLifecycleScenario(value: unknown): value is FounderProductContractLifecycleScenario {
  return (
    typeof value === "string" &&
    (FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS as readonly string[]).includes(value)
  );
}

function isScenarioStatus(value: unknown): value is FounderProductContractScenarioResult["status"] {
  return value === "passed" || value === "failed" || value === "skipped";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
