import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runner = readFileSync("scripts/run-founder-product-contract.ts", "utf8");
const browserConfig = readFileSync("playwright.founder-contract.config.ts", "utf8");
const lifecycleConfig = readFileSync("playwright.founder-contract-lifecycle.config.ts", "utf8");
const browserSpec = readFileSync("tests/e2e/founder-product-contract.spec.ts", "utf8");
const lifecycleSpec = readFileSync("tests/e2e/founder-product-contract-lifecycle.spec.ts", "utf8");
const failureSpec = readFileSync("tests/e2e/founder-product-contract-failure.spec.ts", "utf8");

describe("Founder Product Contract runner topology", () => {
  it("runs one lifecycle producer before the five-project browser-only matrix", () => {
    expect(lifecycleConfig).toContain('name: "lifecycle-producer"');
    expect(browserConfig).toContain('testMatch: ["founder-product-contract.spec.ts"]');
    expect(runner.match(/founder-product-contract-lifecycle\.spec\.ts/g)).toHaveLength(1);
    expect(runner.indexOf("founder-product-contract-lifecycle.spec.ts")).toBeLessThan(
      runner.indexOf("founder-product-contract.spec.ts"),
    );
    expect(browserSpec).not.toContain("runFounderProductContractScenario");
    expect(browserSpec).not.toContain("/api/operator/founder-product-contract/lifecycle");
    expect(lifecycleSpec).toContain("retainScenarioExecutions: true");
  });

  it("runs public provider-failure proof under an isolated identity and retains its receipt", () => {
    expect(runner).toContain("BRUNO_FOUNDER_CONTRACT_RUN_ID: providerFailureRunId");
    expect(runner.match(/founder-product-contract-failure\.spec\.ts/g)).toHaveLength(1);
    expect(failureSpec).toContain('providerFailure: "archive.create"');
    expect(failureSpec).toContain('providerFailure: "archive.corrupt"');
    expect(failureSpec).toContain("retainScenarioExecutions: true");
    expect(failureSpec).toContain("exact candidate contains a failed lifecycle scenario");
  });

  it("binds the exact runtime and consumes only the sanitized external provider summary", () => {
    expect(runner).toContain('requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION")');
    expect(runner).toContain("parseFounderProductionProviderQualificationSummary(");
    expect(runner).toContain(
      "process.env.BRUNO_FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_SUMMARY_JSON",
    );
    expect(runner).not.toMatch(/CLERK_(SECRET|PUBLISHABLE)_KEY/);
    expect(runner).not.toMatch(/LEMON_SQUEEZY_(API_KEY|WEBHOOK_SECRET)/);
  });
});
