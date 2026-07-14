import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_HERMES_IMAGE,
  HERMES_AMD64_MANIFEST_DIGEST,
  HERMES_RUNTIME_UID_GID,
  HERMES_UPSTREAM_IMAGE,
  HERMES_UPSTREAM_INDEX_DIGEST,
  HERMES_VERSION_FRAGMENT,
} from "@/scripts/smoke-hermes-agent-image";

describe("Hermes agent workload image", () => {
  it("pins the workload Dockerfile to the verified upstream release and digest", async () => {
    const dockerfile = await readFile(join(process.cwd(), "Dockerfile.agent"), "utf8");

    expect(dockerfile).toContain(`FROM ${HERMES_UPSTREAM_IMAGE}@${HERMES_UPSTREAM_INDEX_DIGEST}`);
    expect(dockerfile).toContain(
      `io.agentbay.hermes.amd64-manifest="${HERMES_AMD64_MANIFEST_DIGEST}"`,
    );
    expect(dockerfile).toContain('io.agentbay.hermes.version="v0.18.2"');
    expect(dockerfile).not.toMatch(/^\s*(COPY|ADD)\s/im);
    expect(dockerfile).not.toContain(".env");
    expect(dockerfile).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(dockerfile).not.toContain("OPENROUTER_API_KEY");
  });

  it("documents a local smoke that checks version, ownership, writeability, startup, and history", async () => {
    const smokeScript = await readFile(
      join(process.cwd(), "scripts/smoke-hermes-agent-image.ts"),
      "utf8",
    );
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(DEFAULT_LOCAL_HERMES_IMAGE).toBe("agentbay-hermes:local");
    expect(HERMES_VERSION_FRAGMENT).toBe("Hermes Agent v0.18.2 (2026.7.7.2)");
    expect(HERMES_RUNTIME_UID_GID).toBe("10000:10000");
    expect(packageJson.scripts["agent:image:smoke"]).toBe(
      "bun scripts/smoke-hermes-agent-image.ts",
    );
    expect(smokeScript).toContain("/opt/hermes/bin/hermes --version");
    expect(smokeScript).toContain("10000:10000 700 /opt/data");
    expect(smokeScript).toContain("--user");
    expect(smokeScript).toContain("gateway");
    expect(smokeScript).toContain("history");
  });

  it("publishes the workload image through a separate scanned GHCR workflow", async () => {
    const workflow = await readFile(
      join(process.cwd(), ".github/workflows/publish-agent-image.yml"),
      "utf8",
    );

    expect(workflow).toContain("Publish Hermes workload image");
    expect(workflow).toContain("file: Dockerfile.agent");
    expect(workflow).toContain("ghcr.io");
    expect(workflow).toContain("ametel01/agentbay-hermes");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("aquasecurity/trivy-action");
    expect(workflow).toContain("severity: CRITICAL");
    expect(workflow).toContain("Digest verification");
    expect(workflow).not.toContain("Dockerfile.runner");
    expect(workflow).not.toContain("agentbay-runner");
  });
});
