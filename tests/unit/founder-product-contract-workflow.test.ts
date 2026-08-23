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
    expect(workflow).toContain("checks: write");
    expect(workflow).toContain("group: founder-product-contract-$" + "{{ github.sha }}");
    expect(workflow).not.toContain("group: founder-product-contract-$" + "{{ github.ref }}");
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
    expect(workflow).toContain(
      "BRUNO_FOUNDER_PROTECTED_RUNTIME_REVISION: $" +
        "{{ vars.BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION }}",
    );
    expect(workflow).not.toContain("|| 'founder-contract-v1'");
    expect(workflow).not.toContain("runtime_revision:");
    expect(workflow).not.toContain("inputs.runtime_revision");
    expect(workflow).toContain(
      "BRUNO_FOUNDER_EXPECTED_LIVE_STORE_DIGEST: $" +
        "{{ vars.BRUNO_FOUNDER_EXPECTED_LIVE_STORE_DIGEST }}",
    );
    expect(workflow).toContain(
      "BRUNO_FOUNDER_EXPECTED_LIVE_PRODUCT_DIGEST: $" +
        "{{ vars.BRUNO_FOUNDER_EXPECTED_LIVE_PRODUCT_DIGEST }}",
    );
    expect(workflow).toContain("name: Require the exact release runtime revision");
    expect(workflow).toContain("name: Bind the deterministic CI runtime revision");
    expect(workflow).toContain(
      'echo "BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION=$BRUNO_FOUNDER_PROTECTED_RUNTIME_REVISION" >> "$GITHUB_ENV"',
    );
    expect(workflow).toContain(
      'run: echo "BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION=founder-contract-v1" >> "$GITHUB_ENV"',
    );
    expect(workflow).toContain("name: Create the durable protected release candidate control");
    expect(workflow).toContain(
      "run: bun scripts/founder-product-contract-candidate-control.ts create",
    );
    expect(workflow).toContain("name: Finalize and enforce the durable release candidate control");
    expect(workflow).toContain("if: always() && inputs.mode == 'release'");
    expect(workflow).toContain(
      "BRUNO_FOUNDER_CANDIDATE_CHECK_RUN_ID: $" +
        "{{ steps.release_candidate_control.outputs.check_run_id }}",
    );
    expect(workflow).toContain(
      "run: bun scripts/founder-product-contract-candidate-control.ts finalize",
    );
    expect(workflow).not.toContain("founder-product-contract-candidate-release-");
    expect(workflow).not.toContain('runtime_digest="$(printf');
    expect(workflow).toContain(
      "BRUNO_FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_SUMMARY_JSON: $" +
        "{{ inputs.production_provider_qualification_summary_json }}",
    );
    expect(workflow).toContain("general_release_operational_summary_json:");
    expect(workflow).toContain(
      "BRUNO_FOUNDER_GENERAL_RELEASE_OPERATIONAL_SUMMARY_JSON: $" +
        "{{ inputs.general_release_operational_summary_json }}",
    );
    expect(workflow).not.toContain("BRUNO_INITIAL_GENERAL_RELEASE_DECISION:");
    expect(workflow).not.toContain("founder:release:import-decision");
    expect(workflow).not.toContain("LEMON_SQUEEZY_API_KEY");
    expect(workflow).not.toContain("CLERK_SECRET_KEY");
  });
});
