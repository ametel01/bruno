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
    ).toBeLessThan(workflow.indexOf("AGENTBAY_DIGITALOCEAN_TOKEN"));
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("runner-snapshot-manifest.json");
    expect(workflow).not.toContain("on:\n  push");
    expect(workflow).not.toContain("pull_request");

    for (const file of [
      ".github/workflows/ci.yml",
      ".github/workflows/publish-agent-image.yml",
      ".github/workflows/deploy-production.yml",
    ]) {
      expect(await readFile(file, "utf8")).not.toContain("AGENTBAY_DIGITALOCEAN_TOKEN");
    }
  });
});
