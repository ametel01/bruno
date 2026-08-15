import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = new URL(
  "../../.github/workflows/audit-cold-deployment-slo.yml",
  import.meta.url,
);
const workflowSource = readFileSync(workflowPath, "utf8");

describe("production Cold-Deployment SLO audit workflow", () => {
  it("runs only through a protected manual production audit", () => {
    const workflow = parse(workflowSource) as Record<string, unknown>;

    expect(workflow).toBeTypeOf("object");
    expect(workflow.name).toBe("Audit production Cold-Deployment SLO");
    expect(workflowSource).toContain("workflow_dispatch:");
    expect(workflowSource).toContain("environment: Production");
    expect(workflowSource).toContain("PRODUCTION_URL: $" + "{{ vars.PRODUCTION_URL }}");
    expect(workflowSource).toContain("CRON_SECRET: $" + "{{ secrets.CRON_SECRET }}");
    expect(workflowSource).not.toContain("pull_request:");
    expect(workflowSource).not.toContain("push:");
  });

  it("allowlists the sanitized evaluator schema and retains the evidence", () => {
    expect(workflowSource).toContain("/api/internal/cold-deployment-slo/evaluate");
    expect(workflowSource).toContain("(.evaluation | keys | sort)");
    expect(workflowSource).toContain('test("^sha256:[0-9a-f]{64}$")');
    expect(workflowSource).toContain(".evaluation.objectiveSeconds == 300");
    expect(workflowSource).toContain(".evaluation.eligibleCount <= 100");
    expect(workflowSource).toContain(
      ".evaluation.readyWithinObjective <= .evaluation.eligibleCount",
    );
    expect(workflowSource).toContain('(.evaluation.proven | type) == "boolean"');
    expect(workflowSource).toContain("cold-deployment-slo-evaluation.json");
    expect(workflowSource).toContain("uses: actions/upload-artifact@v4");
    expect(workflowSource).toContain("if-no-files-found: error");
    expect(workflowSource).toContain("retention-days: 90");
  });

  it("does not expose or weaken the production bearer boundary", () => {
    expect(workflowSource).toContain('-H "Authorization: Bearer $' + '{CRON_SECRET}"');
    expect(workflowSource).not.toContain('echo "$' + '{CRON_SECRET}"');
    expect(workflowSource).not.toContain("set -x");
    expect(workflowSource).not.toContain("continue-on-error");
  });
});
