import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPreparedDataDirOwnershipRestoreArgs,
  DEFAULT_LOCAL_HERMES_IMAGE,
  HERMES_AMD64_MANIFEST_DIGEST,
  HERMES_RUNTIME_UID_GID,
  HERMES_UPSTREAM_IMAGE,
  HERMES_UPSTREAM_INDEX_DIGEST,
  HERMES_VERSION_FRAGMENT,
  removePreparedDataDir,
} from "@/scripts/smoke-hermes-agent-image";

describe("Hermes agent workload image", () => {
  it("pins the workload Dockerfile to the verified upstream release and digest", async () => {
    const dockerfile = await readFile(join(process.cwd(), "Dockerfile.agent"), "utf8");

    expect(dockerfile).toContain(`FROM ${HERMES_UPSTREAM_IMAGE}@${HERMES_UPSTREAM_INDEX_DIGEST}`);
    expect(dockerfile).toContain(
      `io.bruno.hermes.amd64-manifest="${HERMES_AMD64_MANIFEST_DIGEST}"`,
    );
    expect(dockerfile).toContain('io.bruno.hermes.version="v0.18.2"');
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

    expect(DEFAULT_LOCAL_HERMES_IMAGE).toBe("bruno-hermes:local");
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

  it("removes only managed Hermes bind-mount directories with the system cleanup command", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bruno-hermes-data-"));
    const nestedDir = join(dataDir, "gateway");
    await mkdir(nestedDir);
    await writeFile(join(nestedDir, "state.json"), "{}");

    await removePreparedDataDir(dataDir);

    await expect(access(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removePreparedDataDir(tmpdir())).rejects.toThrow(
      "Refusing to remove unmanaged Hermes data directory",
    );
  });

  it("restores bind-mount ownership through the tested image before host cleanup", () => {
    const dataDir = join(tmpdir(), "bruno-hermes-data-owned-by-container");

    expect(
      buildPreparedDataDirOwnershipRestoreArgs("bruno-hermes:ci", dataDir, 1001, 1002),
    ).toEqual([
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--user",
      "0:0",
      "--entrypoint",
      "/bin/chown",
      "-v",
      `${dataDir}:/opt/data`,
      "bruno-hermes:ci",
      "-R",
      "--no-dereference",
      "1001:1002",
      "/opt/data",
    ]);
    expect(() =>
      buildPreparedDataDirOwnershipRestoreArgs("bruno-hermes:ci", tmpdir(), 1001, 1002),
    ).toThrow("unmanaged Hermes data directory");
  });

  it("publishes the workload image through a separate scanned GHCR workflow", async () => {
    const workflow = await readFile(
      join(process.cwd(), ".github/workflows/publish-agent-image.yml"),
      "utf8",
    );

    expect(workflow).toContain("Publish Hermes workload image");
    expect(workflow).toContain("file: Dockerfile.agent");
    expect(workflow).toContain("ghcr.io");
    expect(workflow).toContain("ametel01/bruno-hermes");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("aquasecurity/trivy-action");
    expect(workflow).toContain("severity: CRITICAL");
    expect(workflow).toContain("id: scan_legacy");
    expect(workflow).toContain("id: scan_optimized");
    expect(workflow).toContain("id: scan_optimized_published");
    expect(workflow).toContain(
      "if: $" + "{{ always() && steps.scan_legacy.outcome != 'skipped' }}",
    );
    expect(workflow).toContain(
      "if: $" + "{{ always() && steps.scan_optimized.outcome != 'skipped' }}",
    );
    expect(workflow).toContain(
      "if: $" + "{{ always() && steps.scan_optimized_published.outcome != 'skipped' }}",
    );
    expect(workflow).toContain("Digest verification");
    expect(workflow).toContain("oven-sh/setup-bun@v2");
    expect(workflow).toContain("bun-version-file: .bun-version");
    expect(workflow.indexOf("Set up Bun")).toBeLessThan(
      workflow.indexOf("Smoke local workload image"),
    );
    expect(workflow).not.toContain("Dockerfile.runner");
    expect(workflow).not.toContain("bruno-runner");
  });

  it("keeps the legacy image stable while publishing a size-bounded optimized candidate", async () => {
    const optimizedDockerfile = await readFile(
      join(process.cwd(), "Dockerfile.agent.optimized"),
      "utf8",
    );
    const optimizedSmoke = await readFile(
      join(process.cwd(), "scripts/smoke-hermes-agent-optimized-image.ts"),
      "utf8",
    );
    const sharedSmoke = await readFile(
      join(process.cwd(), "scripts/smoke-hermes-agent-image.ts"),
      "utf8",
    );
    const workflow = await readFile(
      join(process.cwd(), ".github/workflows/publish-agent-image.yml"),
      "utf8",
    );
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(DEFAULT_LOCAL_HERMES_IMAGE).toBe("bruno-hermes:local");
    expect(optimizedDockerfile).toContain(
      "https://github.com/NousResearch/hermes-agent/archive/refs/tags/v2026.8.3.zip",
    );
    expect(optimizedDockerfile).toContain(
      "47e0874a68d428882c0c3aeb7769a7ef330275485926745a9ea48050b00a6453",
    );
    expect(optimizedDockerfile).toMatch(/--extra anthropic\s+\\\s+--extra messaging/);
    expect(optimizedDockerfile).not.toContain("playwright");
    expect(optimizedDockerfile).not.toContain("docker-cli");
    expect(optimizedDockerfile).not.toContain("ffmpeg");
    expect(optimizedSmoke).toContain("OPTIMIZED_HERMES_IMAGE_CONTRACT");
    expect(sharedSmoke).toContain("assertImageSizeBudget");
    expect(sharedSmoke).not.toContain('platformManifestDigest: "custom-linux-amd64"');
    expect(sharedSmoke).toContain('"image", "inspect", "--format", "{{.Size}}"');
    expect(packageJson.scripts["agent:image:optimized:smoke"]).toBe(
      "bun scripts/smoke-hermes-agent-optimized-image.ts",
    );
    expect(workflow).toContain("file: Dockerfile.agent.optimized");
    expect(workflow).toContain("optimized-$" + "{{ github.sha }}");
    expect(workflow).toContain("Smoke local optimized workload image");
    expect(workflow).toContain("Smoke published optimized digest");
    expect(workflow).toMatch(
      /BRUNO_HERMES_IMAGE="\$\{REGISTRY\}\/\$\{IMAGE_NAME\}@\$\{OPTIMIZED_DIGEST\}"/,
    );
    expect(workflow.indexOf("Optimized digest verification")).toBeLessThan(
      workflow.indexOf("Smoke published optimized digest"),
    );
    expect(workflow).toContain("Scan published optimized digest");
    expect(workflow).toContain("optimized_amd64_manifest_digest=");
    expect(workflow).toContain("- .dockerignore");
  });
});
