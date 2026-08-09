import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("runner snapshot workflow", () => {
  it("reserves enough job time for every bounded cleanup phase and evidence upload", async () => {
    const workflow = await readFile(".github/workflows/build-runner-snapshot.yml", "utf8");
    const script = await readFile("scripts/build-runner-snapshot.ts", "utf8");
    const buildJobTimeoutMinutes = Number(
      workflow.match(/name: Build protected runner snapshot[\s\S]*?timeout-minutes: (\d+)/)?.[1],
    );
    const mainWorkDeadlineMinutes = Number(
      script.match(/setTimeout\(\(\) => controller\.abort\(\), (\d+) \* 60 \* 1000\)/)?.[1],
    );

    expect(buildJobTimeoutMinutes).toBe(75);
    expect(mainWorkDeadlineMinutes).toBe(55);
    expect(buildJobTimeoutMinutes - mainWorkDeadlineMinutes).toBeGreaterThanOrEqual(20);
  });

  it("is protected, manually dispatched only, and keeps provider secrets out of ordinary CI", async () => {
    const workflow = await readFile(".github/workflows/build-runner-snapshot.yml", "utf8");
    const parsed = parse(workflow) as Record<string, unknown>;

    expect(parsed.on).toEqual({
      workflow_dispatch: expect.any(Object),
    });
    expect(workflow).toContain("environment: snapshot-build");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("permissions:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("actions: write");
    expect(workflow).toContain("Validate authorization and static inputs before secrets");
    expect(
      workflow.indexOf("Validate authorization and static inputs before secrets"),
    ).toBeLessThan(workflow.indexOf("BRUNO_DIGITALOCEAN_TOKEN"));
    expect(workflow).toContain("Resolve controller SSH CIDR before provider effects");
    expect(workflow.indexOf("Resolve controller SSH CIDR before provider effects")).toBeLessThan(
      workflow.indexOf("BRUNO_DIGITALOCEAN_TOKEN"),
    );
    expect(workflow).toContain("BRUNO_SNAPSHOT_CONTROLLER_CIDR");
    expect(workflow).toContain('--controller-cidr "$BRUNO_SNAPSHOT_CONTROLLER_CIDR"');
    expect(workflow).toContain("/32");
    expect(workflow).toContain("/128");
    expect(workflow).not.toContain("0.0.0.0/0");
    expect(workflow).not.toContain("::/0");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("Build signed snapshot bundle");
    expect(workflow).toContain("Verify Snapshot Attestation v2 contracts before provider effects");
    expect(workflow).toContain("tests/unit/runner-snapshot-manifest.test.ts");
    expect(workflow).toContain("tests/unit/runner-snapshot-build.test.ts");
    expect(
      workflow.indexOf("Verify Snapshot Attestation v2 contracts before provider effects"),
    ).toBeLessThan(workflow.indexOf("BRUNO_DIGITALOCEAN_TOKEN"));
    expect(workflow).toContain("BRUNO_SNAPSHOT_SIGNING_KEY_ID");
    expect(workflow).toContain('--signing-key-id "$BRUNO_SNAPSHOT_SIGNING_KEY_ID"');
    expect(workflow).toContain("Validate retrieved builder evidence");
    expect(workflow.indexOf("Build signed snapshot bundle")).toBeLessThan(
      workflow.indexOf("Validate retrieved builder evidence"),
    );
    expect(workflow.indexOf("--boot-result-out snapshot-artifacts/boot-result.json")).toBeLessThan(
      workflow.indexOf("Validate retrieved builder evidence"),
    );
    expect(
      workflow.indexOf("--sanitation-result-out snapshot-artifacts/sanitation-result.json"),
    ).toBeLessThan(workflow.indexOf("Validate retrieved builder evidence"));
    expect(
      workflow.indexOf("--cleanup-result-out snapshot-artifacts/cleanup-result.json"),
    ).toBeLessThan(workflow.indexOf("Validate retrieved builder evidence"));
    expect(workflow).toContain("preloadedImages");
    expect(workflow).toContain("hermesFixture");
    expect(workflow).toContain("removedPaths");
    expect(workflow).toContain("hostileMarkers");
    expect(workflow).toContain("cleanup-result.json");
    expect(workflow).not.toContain("--boot-result snapshot-artifacts/boot-result.json");
    expect(workflow).not.toContain("--sanitation-result snapshot-artifacts/sanitation-result.json");
    expect(workflow).not.toContain("bun run runner:release:smoke -- --image");
    expect(workflow).not.toContain('"ok": true');
    expect(workflow).toContain("actions/attest-build-provenance@v2");
    expect(workflow.indexOf("Attest allowlisted bundle artifacts")).toBeLessThan(
      workflow.indexOf("Upload allowlisted bundle artifacts"),
    );
    expect(workflow).toContain("runner-snapshot-bundle.json");
    expect(workflow).not.toContain("runner-snapshot-manifest.sig");
    expect(workflow).not.toContain("on:\n  push");
    expect(workflow).not.toContain("pull_request");

    for (const file of [
      ".github/workflows/ci.yml",
      ".github/workflows/publish-agent-image.yml",
      ".github/workflows/deploy-production.yml",
      ".github/workflows/react-doctor.yml",
    ]) {
      expect(await readFile(file, "utf8")).not.toContain("BRUNO_DIGITALOCEAN_TOKEN");
    }
  });

  it("publishes and retrieves the exact signed bundle as a digest-addressed GHCR artifact", async () => {
    const workflow = await readFile(".github/workflows/build-runner-snapshot.yml", "utf8");
    const parsed = parse(workflow) as {
      jobs: Record<string, { needs?: string; permissions?: Record<string, string> }>;
    };
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(parsed.jobs.build?.permissions).toEqual({ contents: "read" });
    expect(parsed.jobs.publish?.needs).toBe("build");
    expect(parsed.jobs.publish?.permissions).toEqual({
      contents: "read",
      packages: "write",
      attestations: "write",
      "id-token": "write",
    });
    expect(workflow).toContain("oras-project/setup-oras@22ce207df3b08e061f537244349aac6ae1d214f6");
    expect(workflow).toContain("version: 1.3.3");
    expect(workflow).toContain("docker/login-action@v3");
    expect(workflow).toContain("registry: ghcr.io");
    expect(workflow).toContain("password: $" + "{{ github.token }}");
    expect(workflow).toContain(
      "ghcr.io/$" + "{{ github.repository_owner }}/bruno-runner-snapshot-bundles",
    );
    expect(workflow).toContain("Publish and re-verify digest-addressed snapshot bundle");
    expect(workflow).toContain("bun run runner:snapshot:registry -- publish");
    expect(workflow).toContain("runner-snapshot-oci-publication.json");
    expect(workflow.indexOf("Validate retrieved builder evidence")).toBeLessThan(
      workflow.indexOf("Publish and re-verify digest-addressed snapshot bundle"),
    );
    expect(workflow).toContain("Upload signed snapshot publication input");
    expect(workflow).toContain("Download signed snapshot publication input");
    expect(packageJson.scripts["runner:snapshot:registry"]).toContain(
      "scripts/publish-runner-snapshot-bundle.ts",
    );
  });

  it("keeps active and previous approval candidates independently verifiable", async () => {
    const workflow = await readFile(".github/workflows/build-runner-snapshot.yml", "utf8");

    expect(workflow).toContain("BRUNO_SNAPSHOT_TRUST_SET");
    expect(workflow).toContain("BRUNO_SNAPSHOT_PREVIOUS_OCI_REFERENCE");
    expect(workflow).toContain("BRUNO_SNAPSHOT_PREVIOUS_BUNDLE_DIGEST");
    expect(workflow).toContain("runner-snapshot-signing-key.pem");
    expect(workflow).toContain("runner-snapshot-oci-publication.json");
    expect(workflow).toContain("Retain terminal cleanup evidence");
    expect(workflow).toContain("name: runner-snapshot-cleanup-");
    expect(workflow).toContain("retention-days: 30");
    expect(workflow).not.toContain("delete-package-version");
    expect(workflow).not.toContain("oras manifest delete");
  });

  it("does not let ordinary CI or credential-free release workflows dispatch provider work", async () => {
    for (const file of [
      ".github/workflows/ci.yml",
      ".github/workflows/publish-agent-image.yml",
      ".github/workflows/deploy-production.yml",
      ".github/workflows/react-doctor.yml",
    ]) {
      const workflow = await readFile(file, "utf8");
      expect(workflow).not.toContain("actions: write");
      expect(workflow).not.toContain("build-runner-snapshot.yml");
      expect(workflow).not.toContain("runner:snapshot:build");
      expect(workflow).not.toContain("runner:snapshot:registry");
    }
  });

  it("build script retrieves builder evidence instead of consuming controller-local evidence", async () => {
    const script = await readFile("scripts/build-runner-snapshot.ts", "utf8");

    expect(script).toContain("ssh-keygen");
    expect(script.indexOf("validateSigningKey(privateKeyPem)")).toBeLessThan(
      script.indexOf("provider.createSshKey"),
    );
    expect(script).toContain("provider.createSshKey");
    expect(script.indexOf("builderSshKeyId = builderSshKey.value.id")).toBeLessThan(
      script.indexOf("const result = await buildRunnerSnapshot"),
    );
    expect(script).toContain("await provider.deleteSshKey(");
    expect(script).toContain("await provider.verifySshKeyAbsent(");
    expect(script).toContain("builderSshKeyId");
    expect(script).toContain("builderSshPrivateKeyPath");
    expect(script).toContain("controllerCidr");
    expect(script).toContain("signingKeyId");
    expect(script).toContain('requiredArg(parsed, "signing-key-id")');
    expect(script).toContain("bundleOut");
    expect(script).toContain('requiredArg(parsed, "controller-cidr")');
    expect(script).toContain("isExplicitControllerCidr");
    expect(script).toContain("bootResultOut");
    expect(script).toContain("sanitationResultOut");
    expect(script).toContain("cleanupResultOut");
    expect(script).toContain('requiredArg(parsed, "cleanup-result-out")');
    expect(script).not.toContain("bootResultPath");
    expect(script).not.toContain("sanitationResultPath");
    expect(script).not.toContain('requiredArg(parsed, "boot-result")');
    expect(script).not.toContain('requiredArg(parsed, "sanitation-result")');
  });

  it("build script cleans up a provider SSH key if the controller fails after creation", async () => {
    const script = await readFile("scripts/build-runner-snapshot.ts", "utf8");

    expect(script.indexOf("let builderSshKeyId: string | null = null")).toBeLessThan(
      script.indexOf("provider.createSshKey"),
    );
    expect(script.indexOf("builderSshKeyId = builderSshKey.value.id")).toBeLessThan(
      script.indexOf("const result = await buildRunnerSnapshot"),
    );
    expect(script.indexOf("} finally {")).toBeLessThan(
      script.indexOf("await provider.deleteSshKey("),
    );
    expect(script).toContain("new AbortController()");
    expect(script).toContain("builderSshKeyId = null");
    expect(script).not.toContain("process.env.BRUNO_DIGITALOCEAN_TOKEN");
  });
});
