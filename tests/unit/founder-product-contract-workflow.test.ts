import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  name?: string;
  run?: string;
};

describe("Founder Product Contract workflow", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/founder-product-contract.yml", import.meta.url),
    "utf8",
  );

  it("binds ledger production to the exact run and keeps release signing isolated", () => {
    const steps = (parse(workflow) as { jobs: { contract: { steps: WorkflowStep[] } } }).jobs
      .contract.steps;
    const ciContractStep = steps.find(
      ({ name }) => name === "Run all-or-nothing Founder Product Contract (ci)",
    );

    expect(workflow).toContain("actions: read");
    expect(workflow).not.toContain("lifecycle_scenario_ledger_json:");
    expect(workflow).not.toContain("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_JSON:");
    expect(workflow).toContain(
      "BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH: founder-contract-artifacts/scenario-ledger.json",
    );
    expect(workflow).toContain("BRUNO_FOUNDER_CONTRACT_RUN_ID: github-$" + "{{ github.run_id }}");
    expect(workflow).not.toContain(
      "github-$" + "{{ github.run_id }}-$" + "{{ github.run_attempt }}",
    );
    expect(workflow).toContain(
      "BRUNO_FOUNDER_CONTRACT_RUN_ATTEMPT: $" + "{{ github.run_attempt }}",
    );
    expect(workflow).toContain("run: bun run founder:contract");
    expect(workflow).toContain(
      "run: bun scripts/check-founder-product-contract-candidate-history.ts",
    );
    expect(workflow).toContain("BRUNO_FOUNDER_CONTRACT_GITHUB_TOKEN: $" + "{{ github.token }}");
    expect(workflow).toContain("if: inputs.mode == 'release'");
    expect(workflow).toContain("if: inputs.mode != 'release'");
    expect(workflow).toContain(
      "BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET: $" +
        "{{ secrets.BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET }}",
    );
    expect(steps).not.toContainEqual(
      expect.objectContaining({ name: "Bind an ephemeral CI signing authority" }),
    );
    expect(ciContractStep?.run).toContain('ci_signing_secret="$(openssl rand -hex 32)"');
    expect(ciContractStep?.run).toContain('echo "::add-mask::$ci_signing_secret"');
    expect(ciContractStep?.run).toContain(
      'BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET="$ci_signing_secret" bun run founder:contract',
    );
    expect(ciContractStep?.run).not.toContain("GITHUB_ENV");
    expect(workflow).not.toContain(
      'BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET=$ci_signing_secret" >> "$GITHUB_ENV"',
    );
    expect(workflow).not.toContain("BRUNO_FOUNDER_CONTRACT_CI_SCENARIO_SIGNING_SECRET");
    expect(workflow).not.toContain(
      "secrets.BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET || secrets.BRUNO_FOUNDER_CONTRACT_CI_SCENARIO_SIGNING_SECRET",
    );
  });
});
