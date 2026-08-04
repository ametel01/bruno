import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = new URL("../../.github/workflows/publish-runner-image.yml", import.meta.url);
const workflowSource = readFileSync(workflowPath, "utf8");
const vercelConfigPath = new URL("../../vercel.json", import.meta.url);
const vercelConfig = JSON.parse(readFileSync(vercelConfigPath, "utf8")) as {
  ignoreCommand?: string;
};

describe("runner release workflow contract", () => {
  it("is valid YAML with explicit publish, canary, deploy, and rollback boundaries", () => {
    const workflow = parse(workflowSource) as Record<string, unknown>;
    expect(workflow).toBeTypeOf("object");
    expect(workflowSource).toContain("workflow_dispatch:");
    expect(workflowSource).toContain("environment: runner-release-canary");
    expect(workflowSource).toContain("environment: production");
    expect(workflowSource).toContain("needs:\n      - publish\n      - canary");
    expect(workflowSource).toContain(
      "concurrency:\n  group: runner-release\n  cancel-in-progress: false",
    );
  });

  it("builds once, pushes only the Git-SHA tag, verifies the digest, and scans it", () => {
    expect(workflowSource.match(/docker\/build-push-action@v6/g)).toHaveLength(1);
    expect(workflowSource).toContain(
      "tags: $" + "{{ env.REGISTRY }}/$" + "{{ env.IMAGE_NAME }}:$" + "{{ github.sha }}",
    );
    expect(workflowSource).not.toContain("$" + "{{ env.IMAGE_NAME }}:main");
    expect(workflowSource).toContain("docker buildx imagetools inspect");
    expect(workflowSource).toContain("aquasecurity/trivy-action@0.28.0");
    expect(workflowSource).toContain("severity: CRITICAL");
    expect(workflowSource).toContain("provenance: mode=max");
    expect(workflowSource).toContain("sbom: true");
  });

  it("gates promotion on disposable smoke and deploys the exact tested digest at batch one", () => {
    expect(workflowSource).toContain("bun run runner:release:smoke -- --image");
    expect(workflowSource).toContain("billable_canary_authorization:");
    expect(workflowSource).toContain(
      "BILLABLE_CANARY_AUTHORIZATION: $" + "{{ inputs.billable_canary_authorization }}",
    );
    expect(workflowSource).toMatch(
      /test "\$\{BILLABLE_CANARY_AUTHORIZATION\}" = "authorize-disposable-runner-release-smoke"/,
    );
    expect(workflowSource).toContain(
      "AGENTBAY_RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION: $" +
        "{{ inputs.billable_canary_authorization }}",
    );
    expect(workflowSource).toContain("AGENTBAY_RUNNER_IMAGE=$" + "{IMMUTABLE_IMAGE}");
    expect(workflowSource).toContain("AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE=1");
    expect(workflowSource).toContain("/api/internal/runner-release/required");
    expect(workflowSource).toContain("/health");
    expect(workflowSource).not.toMatch(/cloud-init.*GITHUB_STEP_SUMMARY/i);
  });

  it("skips automatic production builds while allowing verified releases and previews", () => {
    expect(vercelConfig.ignoreCommand).toBeTypeOf("string");
    const ignoreCommand = vercelConfig.ignoreCommand ?? "exit 99";
    const runIgnoreCommand = (env: Record<string, string>) =>
      spawnSync("/bin/sh", ["-c", ignoreCommand], {
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
      }).status;

    expect(runIgnoreCommand({ VERCEL_ENV: "production" })).toBe(0);
    expect(
      runIgnoreCommand({
        VERCEL_ENV: "production",
        AGENTBAY_CANARY_VERIFIED_DEPLOY: "true",
      }),
    ).toBe(1);
    expect(runIgnoreCommand({ VERCEL_ENV: "preview" })).toBe(1);
    expect(workflowSource.match(/AGENTBAY_CANARY_VERIFIED_DEPLOY=true/g)).toHaveLength(2);
  });

  it("allows only artifact-backed immutable rollback and halts rollout", () => {
    expect(workflowSource).toContain("verified-runner-release");
    expect(workflowSource).toContain("run-id: $" + "{{ inputs.rollback_run_id }}");
    expect(workflowSource).toContain("previously verified image");
    expect(workflowSource).toContain("AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE=0");
    expect(workflowSource).not.toContain("rollback_image: main");
  });
});
