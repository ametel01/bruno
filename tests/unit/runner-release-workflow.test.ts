import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = new URL("../../.github/workflows/deploy-production.yml", import.meta.url);
const workflowSource = readFileSync(workflowPath, "utf8");
const agentWorkflowPath = new URL(
  "../../.github/workflows/publish-agent-image.yml",
  import.meta.url,
);
const agentWorkflowSource = readFileSync(agentWorkflowPath, "utf8");
const vercelConfigPath = new URL("../../vercel.json", import.meta.url);
const vercelConfig = JSON.parse(readFileSync(vercelConfigPath, "utf8")) as {
  ignoreCommand?: string;
};
const packageJsonPath = new URL("../../package.json", import.meta.url);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  scripts: Record<string, string>;
};
const readmePath = new URL("../../README.md", import.meta.url);
const readme = readFileSync(readmePath, "utf8");

describe("runner release workflow contract", () => {
  it("is valid YAML with publish, staging, Verified Release, deploy, and rollback boundaries", () => {
    const workflow = parse(workflowSource) as Record<string, unknown>;
    expect(workflow).toBeTypeOf("object");
    expect(workflow.name).toBe("Deploy production application");
    expect(workflowSource).toContain("workflow_dispatch:");
    expect(workflowSource).toContain("\n  canary:");
    expect(workflowSource).toContain("environment: runner-release-canary");
    expect(workflowSource).toContain("environment: production");
    expect(workflowSource).toContain("needs:\n      - publish\n      - stage-control-plane");
    expect(workflowSource).toContain(
      "needs:\n      - publish\n      - stage-control-plane\n      - canary",
    );
    expect(workflowSource).toContain(
      "concurrency:\n  group: production-application-deploy\n  cancel-in-progress: false",
    );
  });

  it("builds once, pushes only the Git-SHA tag, verifies the digest, and scans it", () => {
    expect(workflowSource.match(/docker\/build-push-action@v6/g)).toHaveLength(1);
    expect(workflowSource).toContain(
      "tags: $" + "{{ env.REGISTRY }}/$" + "{{ env.IMAGE_NAME }}:$" + "{{ github.sha }}",
    );
    expect(workflowSource).not.toContain("$" + "{{ env.IMAGE_NAME }}:main");
    expect(workflowSource).toContain("docker buildx imagetools inspect");
    const pinnedTrivyAction =
      "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0";
    expect(workflowSource).toContain(pinnedTrivyAction);
    expect(agentWorkflowSource).toContain(pinnedTrivyAction);
    expect(workflowSource).not.toMatch(/aquasecurity\/trivy-action@v?\d/);
    expect(agentWorkflowSource).not.toMatch(/aquasecurity\/trivy-action@v?\d/);
    expect(workflowSource).toContain("severity: CRITICAL");
    expect(workflowSource).toContain("provenance: mode=max");
    expect(workflowSource).toContain("sbom: true");
  });

  it("gates only on critical fixable vulnerabilities and retains scan reports without code scanning", () => {
    for (const source of [workflowSource, agentWorkflowSource]) {
      expect(source).toContain("scanners: vuln");
      expect(source).toContain("limit-severities-for-sarif: true");
      expect(source).toContain("actions/upload-artifact@v4");
      expect(source).toContain("if-no-files-found: error");
      expect(source).not.toContain("github/codeql-action/upload-sarif");
      expect(source).not.toContain("security-events: write");
    }
    expect(workflowSource).toContain("name: trivy-runner-image-$" + "{{ github.sha }}");
    expect(workflowSource).toContain("path: trivy-runner-image.sarif");
    expect(agentWorkflowSource).toContain("name: trivy-agent-image-$" + "{{ github.sha }}");
    expect(agentWorkflowSource).toContain("path: trivy-agent-image.sarif");
  });

  it("gates promotion on a zero-cloud full fixture and deploys the exact tested digest at batch one", () => {
    expect(workflowSource).toContain("bun run runner:release:smoke -- --image");
    expect(workflowSource).toContain("--provider local_docker");
    expect(workflowSource).not.toContain("BRUNO_DIGITALOCEAN_TOKEN");
    expect(workflowSource).toContain("BRUNO_DIGITALOCEAN_PROVIDER_MODE: local_docker");
    expect(workflowSource).toContain(
      "BRUNO_LOCAL_CLOUD_RUNNER_ENDPOINT_URL: http://127.0.0.1:3045",
    );
    expect(workflowSource).not.toContain("RUNNER_RELEASE_DIGITALOCEAN_TOKEN");
    expect(workflowSource).not.toContain("billable_canary_authorization");
    expect(workflowSource).not.toContain("authorize-disposable-runner-release-smoke");
    expect(workflowSource).toContain("BRUNO_RUNNER_IMAGE=$" + "{IMMUTABLE_IMAGE}");
    expect(workflowSource).toContain("BRUNO_RUNNER_ROLLOUT_BATCH_SIZE=1");
    expect(workflowSource).toContain("/api/internal/runner-release/required");
    expect(workflowSource).toContain("/health");
    expect(workflowSource).not.toMatch(/cloud-init.*GITHUB_STEP_SUMMARY/i);
  });

  it("stages a compatible candidate and promotes it only after release verification", () => {
    expect(workflowSource).toContain("stage-control-plane:");
    expect(workflowSource).toContain("outputs:\n      deployment-url:");
    expect(workflowSource).toContain("deploy --prod --skip-domain --yes");
    expect(workflowSource).toContain("NEXT_PUBLIC_APP_URL: http://host.docker.internal:3000");
    expect(workflowSource).toContain("bun run start --hostname 0.0.0.0");
    expect(workflowSource).toContain(
      "CANDIDATE_DEPLOYMENT_URL: $" + "{{ needs.stage-control-plane.outputs.deployment-url }}",
    );
    expect(workflowSource).toContain(
      "vercel@$" + '{VERCEL_CLI_VERSION} promote "$' + '{CANDIDATE_DEPLOYMENT_URL}"',
    );
    expect(workflowSource).not.toContain("RUNNER_RELEASE_CONTROL_PLANE_URL");
    expect(workflowSource.match(/BRUNO_AUTH_MODE=operator/g)).toHaveLength(4);
    expect(workflowSource).not.toContain("BRUNO_AUTH_MODE=clerk");
  });

  it("publishes a signed digest-addressed Verified Release joined to the Approved Snapshot", () => {
    expect(workflowSource).toContain("BRUNO_RELEASE_APPROVED_SNAPSHOT_OCI_REFERENCE");
    expect(workflowSource).toContain("BRUNO_RELEASE_APPROVED_SNAPSHOT_BUNDLE_DIGEST");
    expect(workflowSource).toContain("BRUNO_RELEASE_SIGNING_KEY_ID");
    expect(workflowSource).toContain("BRUNO_RELEASE_SIGNING_KEY_PEM");
    expect(workflowSource).toContain("bun run runner:release:bundle");
    expect(workflowSource).toContain("bun run runner:release:registry");
    expect(workflowSource).toContain("bruno-runner-release-bundles");
    expect(workflowSource).toContain("verified-runner-release");
    expect(workflowSource).toContain("runner-release-oci-publication.json");
    expect(workflowSource).toContain("oras pull");
    expect(workflowSource).toContain("oras manifest fetch");
    const snapshotVerification = workflowSource.indexOf("bun run runner:release:snapshot:verify");
    const imageExtraction = workflowSource.indexOf(
      "DEFAULT_AGENT_IMAGE=\"$(jq -r '.defaultAgentImage",
    );
    const fixtureExecution = workflowSource.indexOf("bun run runner:release:smoke -- --image");
    expect(snapshotVerification).toBeGreaterThan(-1);
    expect(imageExtraction).toBeGreaterThan(snapshotVerification);
    expect(fixtureExecution).toBeGreaterThan(imageExtraction);
    expect(workflowSource).not.toContain(".manifest.defaultAgentImage.reference");
  });

  it("never exposes a DigitalOcean credential to the release workflow", () => {
    expect(workflowSource).not.toContain("RUNNER_RELEASE_DIGITALOCEAN_TOKEN");
    expect(workflowSource).not.toContain("secrets.BRUNO_DIGITALOCEAN_TOKEN");
    expect(workflowSource).not.toContain("secrets.DIGITALOCEAN_TOKEN");
    expect(workflowSource).not.toContain("authorize-disposable-runner-release-smoke");
    expect(workflowSource).toContain("no DigitalOcean resource was requested");
    expect(workflowSource).not.toMatch(/booted (?:the )?provider snapshot/i);
  });

  it("targets the linked Vercel project with explicitly authorized CLI token authentication", () => {
    expect(workflowSource).toContain("VERCEL_ORG_ID: $" + "{{ secrets.VERCEL_ORG_ID }}");
    expect(workflowSource).toContain("VERCEL_PROJECT_ID: $" + "{{ secrets.VERCEL_PROJECT_ID }}");
    expect(workflowSource).toContain("VERCEL_TOKEN: $" + "{{ secrets.VERCEL_TOKEN }}");
    const tokenArgument = '--token="$' + '{VERCEL_TOKEN}"';
    expect(workflowSource.split(tokenArgument)).toHaveLength(6);
  });

  it("keeps dependency lifecycle code outside production secret scopes", () => {
    expect(workflowSource.match(/bun install --frozen-lockfile --ignore-scripts/g)).toHaveLength(3);
    expect(workflowSource).not.toMatch(/^ {6}[A-Z_]+: \$\{\{ secrets\./m);
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
        BRUNO_CANARY_VERIFIED_DEPLOY: "true",
      }),
    ).toBe(1);
    expect(runIgnoreCommand({ VERCEL_ENV: "preview" })).toBe(1);
    expect(workflowSource.match(/BRUNO_CANARY_VERIFIED_DEPLOY=true/g)).toHaveLength(2);
  });

  it("routes the documented production command through the protected release workflow", () => {
    expect(packageJson.scripts["deploy:prod"]).toBe(
      "gh workflow run deploy-production.yml --repo ametel01/bruno --ref main --raw-field action=release",
    );
    expect(packageJson.scripts["deploy:prod"]).not.toContain("vercel deploy --prod");
    expect(readme).toContain("Do not run `vercel deploy --prod` directly");
    expect(readme).toContain("Verified Release `BRUNO_RUNNER_IMAGE` digest");
  });

  it("allows only artifact-backed immutable rollback and halts rollout", () => {
    expect(workflowSource).toContain("verified-runner-release");
    expect(workflowSource).toContain("run-id: $" + "{{ inputs.rollback_run_id }}");
    expect(workflowSource).toContain("previously verified image");
    expect(workflowSource).toContain("BRUNO_RUNNER_ROLLOUT_BATCH_SIZE=0");
    expect(workflowSource).not.toContain("rollback_image: main");
  });
});
