import { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";
import { parseFounderProductContractInstant, type FounderProductContractClock } from "./clock";
import type {
  FounderProductContractCleanupOutcome,
  FounderProductContractHarness,
  FounderProductContractLifecycleScenario,
  FounderProductContractScenarioResult,
} from "./types";

export const FOUNDER_PRODUCT_CONTRACT_DEFAULT_SCENARIO_MAX_AGE_MILLISECONDS = 15 * 60 * 1000;

export async function runFounderProductContractScenario<T>(
  harness: FounderProductContractHarness,
  scenario: (harness: FounderProductContractHarness) => Promise<T> | T,
): Promise<T>;

export async function runFounderProductContractScenario(
  harness: FounderProductContractHarness,
  id: FounderProductContractLifecycleScenario,
  scenario: (
    harness: FounderProductContractHarness,
  ) => Promise<FounderProductContractCleanupOutcome> | FounderProductContractCleanupOutcome,
): Promise<FounderProductContractScenarioResult>;

export async function runFounderProductContractScenario<T>(
  harness: FounderProductContractHarness,
  idOrScenario:
    | FounderProductContractLifecycleScenario
    | ((harness: FounderProductContractHarness) => Promise<T> | T),
  recordedScenario?: (
    harness: FounderProductContractHarness,
  ) => Promise<FounderProductContractCleanupOutcome> | FounderProductContractCleanupOutcome,
): Promise<T | FounderProductContractScenarioResult> {
  if (typeof idOrScenario !== "function") {
    if (!recordedScenario) {
      throw new Error("A Founder Product Contract scenario callback is required.");
    }
    return runRecordedFounderProductContractScenario(harness, idOrScenario, recordedScenario);
  }
  return idOrScenario(harness);
}

export async function runRecordedFounderProductContractScenario(
  harness: FounderProductContractHarness,
  id: FounderProductContractLifecycleScenario,
  scenario: (
    harness: FounderProductContractHarness,
  ) => Promise<FounderProductContractCleanupOutcome> | FounderProductContractCleanupOutcome,
): Promise<FounderProductContractScenarioResult> {
  if (!FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.includes(id)) {
    throw new Error("Founder Product Contract scenario ID is invalid.");
  }
  const requestCount = harness.requestCount;
  const result: FounderProductContractScenarioResult = {
    id,
    status: "failed",
    attempts: 1,
    sourceRevision: harness.sourceRevision ?? null,
    observedAt: harness.clock.now().toISOString(),
    cleanup: failedCleanup(harness.clock),
  };
  try {
    const cleanup = await scenario(harness);
    if (harness.requestCount === requestCount) {
      throw new Error(
        `Founder Product Contract scenario ${id} made no public application request.`,
      );
    }
    result.cleanup = validateCleanupOutcome(cleanup);
    result.status = "passed";
  } catch (error) {
    harness.scenarioResults.push(result);
    throw error;
  }
  harness.scenarioResults.push(result);
  return result;
}

export function validateFounderProductContractScenarios(input: {
  required: readonly FounderProductContractLifecycleScenario[];
  results: readonly FounderProductContractScenarioResult[];
  sourceRevision: string;
  observedAt: string;
  maxAgeMilliseconds?: number;
}): void {
  const expectedAt = parseFounderProductContractInstant(input.observedAt).getTime();
  const maxAge =
    input.maxAgeMilliseconds ?? FOUNDER_PRODUCT_CONTRACT_DEFAULT_SCENARIO_MAX_AGE_MILLISECONDS;
  if (!Number.isFinite(maxAge) || maxAge < 0) {
    throw new Error("Founder Product Contract scenario max age must be non-negative.");
  }
  const required = new Set(input.required);
  if (
    required.size !== input.required.length ||
    required.size !== FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.length ||
    FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.some((id) => !required.has(id))
  ) {
    throw new Error("Founder Product Contract scenario requirements must be canonical and unique.");
  }
  if (input.results.length > FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.length) {
    throw new Error("Founder Product Contract lifecycle scenarios contain unexpected results.");
  }
  const resultsById = new Map<string, FounderProductContractScenarioResult>();
  for (const result of input.results) {
    if (!FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.includes(result.id)) {
      throw new Error(`Founder Product Contract scenario ${result.id} is not canonical.`);
    }
    if (resultsById.has(result.id)) {
      throw new Error(`Founder Product Contract scenario ${result.id} was retried.`);
    }
    if (result.status !== "passed") {
      throw new Error(`Founder Product Contract scenario ${result.id} did not pass.`);
    }
    if (result.attempts !== 1) {
      throw new Error(`Founder Product Contract scenario ${result.id} was retried.`);
    }
    validateCleanupOutcome(result.cleanup);
    if (result.sourceRevision !== input.sourceRevision) {
      throw new Error(`Founder Product Contract scenario ${result.id} has a revision mismatch.`);
    }
    const observedAt = parseFounderProductContractInstant(result.observedAt).getTime();
    if (observedAt > expectedAt || expectedAt - observedAt > maxAge) {
      throw new Error(`Founder Product Contract scenario ${result.id} is stale.`);
    }
    resultsById.set(result.id, result);
  }
  for (const id of required) {
    if (!resultsById.has(id)) {
      throw new Error(`Required Founder Product Contract scenario ${id} was not present.`);
    }
  }
}

function failedCleanup(clock: FounderProductContractClock): FounderProductContractCleanupOutcome {
  return {
    status: "failed",
    verified: false,
    resourcesBefore: 0,
    resourcesAfter: 0,
    observedAt: clock.now().toISOString(),
  };
}

function validateCleanupOutcome(
  cleanup: FounderProductContractCleanupOutcome,
): FounderProductContractCleanupOutcome {
  const observedAt = new Date(cleanup.observedAt);
  if (
    cleanup.status !== "passed" ||
    !cleanup.verified ||
    !Number.isSafeInteger(cleanup.resourcesBefore) ||
    cleanup.resourcesBefore < 0 ||
    !Number.isSafeInteger(cleanup.resourcesAfter) ||
    cleanup.resourcesAfter !== 0 ||
    Number.isNaN(observedAt.valueOf()) ||
    observedAt.toISOString() !== cleanup.observedAt
  ) {
    throw new Error("Founder Product Contract cleanup was not verified.");
  }
  return cleanup;
}
