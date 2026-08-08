import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("runner snapshot workflow", () => {
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
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("id-token: write");
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
    expect(workflow).toContain("preloadedImages");
    expect(workflow).toContain("removedPaths");
    expect(workflow).toContain("hostileMarkers");
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
    ]) {
      expect(await readFile(file, "utf8")).not.toContain("BRUNO_DIGITALOCEAN_TOKEN");
    }
  });

  it("build script retrieves builder evidence instead of consuming controller-local evidence", async () => {
    const script = await readFile("scripts/build-runner-snapshot.ts", "utf8");

    expect(script).toContain("ssh-keygen");
    expect(script).toContain("provider.createSshKey");
    expect(script.indexOf("builderSshKeyId = builderSshKey.value.id")).toBeLessThan(
      script.indexOf("const result = await buildRunnerSnapshot"),
    );
    expect(script).toContain("provider.deleteSshKey({ id: builderSshKeyId }");
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
      script.indexOf("provider.deleteSshKey({ id: builderSshKeyId }"),
    );
    expect(script).toContain("new AbortController()");
    expect(script).toContain("builderSshKeyId = null");
    expect(script).not.toContain("process.env.BRUNO_DIGITALOCEAN_TOKEN");
  });
});
