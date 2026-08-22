import { createFounderProductContractClock, type FounderProductContractClock } from "./clock";
import type { FounderProductContractApplication } from "./application";
import {
  createFounderProductContractProviderDoubles,
  type FounderProductContractProviderDoubles,
} from "./providers";
import type { FounderProductContractHarness, FounderProductContractScenarioResult } from "./types";

export function createFounderProductContractHarness(input: {
  application: FounderProductContractApplication;
  clock?: FounderProductContractClock;
  providers?: FounderProductContractProviderDoubles;
  sourceRevision?: string;
}): FounderProductContractHarness {
  const clock = input.clock ?? createFounderProductContractClock();
  const providers = input.providers ?? createFounderProductContractProviderDoubles({ clock });
  const scenarioResults: FounderProductContractScenarioResult[] = [];
  let requestCount = 0;
  const application: FounderProductContractApplication = {
    request: (request, context = { clock, providers }) => {
      requestCount += 1;
      return input.application.request(request, context);
    },
  };
  return Object.freeze({
    application,
    clock,
    providers,
    scenarioResults,
    get requestCount() {
      return requestCount;
    },
    ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
  });
}
