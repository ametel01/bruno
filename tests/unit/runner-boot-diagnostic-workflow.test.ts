import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = join(process.cwd(), ".github/workflows/diagnose-runner-boot.yml");

describe("runner boot diagnostic workflow", () => {
  it("accepts only the two digest-qualified project images", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain(
      "^ghcr\\.io/ametel01/bruno-runner:[a-f0-9]{40}@sha256:[a-f0-9]{64}$",
    );
    expect(workflow).toContain("^ghcr\\.io/ametel01/bruno-hermes@sha256:[a-f0-9]{64}$");
    expect(workflow).toContain("permissions:\n  contents: read");
  });

  it("retains bounded boot evidence and verifies cleanup even on failure", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("docker events");
    expect(workflow).toContain("boot-readiness.json");
    expect(workflow).toContain("runner.log");
    expect(workflow).toContain("nested-image-inspect.json");
    expect(workflow).toContain("nested-image-run.status");
    expect(workflow).toContain("timeout 15s docker exec");
    expect(workflow).toContain("--label bruno.boot.fixture=v1");
    expect(workflow).toContain("createDockerRunnerBootSelfTestExecutor");
    expect(workflow).toContain("replay-fixture.log");
    expect(workflow).toContain("await executor.cleanup(fixture, signal)");
    expect(workflow).toContain("if: always()\n        run: |");
    expect(workflow).toContain("--filter label=bruno.boot.fixture=v1");
    expect(workflow).toContain('test -z "$(docker ps --all --quiet');
    expect(workflow).toContain("retention-days: 30");
  });
});
