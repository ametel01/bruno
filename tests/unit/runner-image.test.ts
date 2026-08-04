import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runner image", () => {
  it("packages the runner service runtime imports", async () => {
    const dockerfile = await readFile(join(process.cwd(), "Dockerfile.runner"), "utf8");

    expect(dockerfile).toContain("COPY src/runner-service ./src/runner-service");
    expect(dockerfile).toContain(
      "COPY src/server/agents/agent-launch-spec.ts ./src/server/agents/agent-launch-spec.ts",
    );
    expect(dockerfile).toContain(
      "COPY src/shared/secret-redaction.ts ./src/shared/secret-redaction.ts",
    );
    expect(dockerfile).toContain("org.opencontainers.image.source");
    expect(dockerfile).toContain("org.opencontainers.image.revision");
    expect(dockerfile).toContain("org.opencontainers.image.version");
  });

  it("publishes immutable amd64 images with supply-chain evidence and a returned digest", async () => {
    const workflow = await readFile(
      join(process.cwd(), ".github/workflows/publish-runner-image.yml"),
      "utf8",
    );
    const githubSha = "$" + "{{ github.sha }}";
    const registry = "$" + "{{ env.REGISTRY }}";
    const imageName = "$" + "{{ env.IMAGE_NAME }}";
    const pushedDigest = "$" + "{{ steps.push.outputs.digest }}";

    expect(workflow).toContain("platforms: linux/amd64");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain(`org.opencontainers.image.revision=${githubSha}`);
    expect(workflow).toContain(`org.opencontainers.image.version=${githubSha}`);
    expect(workflow).toContain(`${registry}/${imageName}:${githubSha}`);
    expect(workflow).not.toContain(`${registry}/${imageName}:main`);
    expect(workflow).toContain(`digest: ${pushedDigest}`);
    expect(workflow).toContain("immutable-image:");
    expect(workflow).toContain("docker buildx imagetools inspect");
    expect(workflow).toContain(
      "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0",
    );
    expect(workflow).toContain("needs: publish");
    expect(workflow).toContain("runner:release:smoke");
  });
});
