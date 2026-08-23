import { describe, expect, it } from "vitest";
import { FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS } from "@/src/shared/founder-product-contract";
import { founderProductContractQualificationCohorts } from "../e2e/founder-product-contract-fixture";

describe("Founder Product Contract fixture cleanup", () => {
  it("targets only the exact run and its controlled browser-project cohorts", () => {
    const runId = "candidate-12";
    const cohorts = founderProductContractQualificationCohorts(runId);

    expect(cohorts).toEqual([
      `external-beta-contract:${runId}`,
      ...FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS.map(
        (project) => `external-beta-contract:${runId}:${project}`,
      ),
    ]);
    expect(new Set(cohorts).size).toBe(cohorts.length);
    expect(cohorts).not.toContain("external-beta-contract:candidate-1");
    expect(cohorts).not.toContain("external-beta-contract:candidate-123");
    expect(founderProductContractQualificationCohorts(runId)).toEqual(cohorts);
  });
});
