import type { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";
import type { FounderProductContractApplication } from "./application";
import type { FounderProductContractClock } from "./clock";
import type { FounderProductContractProviderDoubles } from "./providers";

export { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";

export type FounderProductContractLifecycleScenario =
  (typeof FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS)[number];

export type FounderProductContractCleanupOutcome = {
  status: "passed" | "failed";
  verified: boolean;
  resourcesBefore: number;
  resourcesAfter: number;
  observedAt: string;
};

export type FounderProductContractScenarioResult = {
  id: FounderProductContractLifecycleScenario;
  status: "passed" | "failed" | "skipped";
  attempts: number;
  sourceRevision: string | null;
  observedAt: string;
  cleanup: FounderProductContractCleanupOutcome;
};

export type FounderProductContractScenario = (
  harness: FounderProductContractHarness,
) => Promise<FounderProductContractCleanupOutcome> | FounderProductContractCleanupOutcome;

export type FounderProductContractHarness = {
  readonly clock: FounderProductContractClock;
  readonly providers: FounderProductContractProviderDoubles;
  readonly application: FounderProductContractApplication;
  readonly scenarioResults: FounderProductContractScenarioResult[];
  readonly requestCount: number;
  readonly sourceRevision?: string;
};
