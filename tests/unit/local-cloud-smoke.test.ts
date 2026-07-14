import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("local cloud smoke script", () => {
  it("accepts the Hermes setup gate as a safe local-cloud control-flow result", async () => {
    const smokeScript = await readFile(join(process.cwd(), "scripts/smoke-local-cloud.ts"), "utf8");

    expect(smokeScript).toContain("local_cloud_smoke_runner_service_ready");
    expect(smokeScript).toContain("hermes_setup_incomplete");
    expect(smokeScript).toContain("local_cloud_smoke_agent_start_blocked_by_hermes_setup");
    expect(smokeScript).toContain('"blocked_by_hermes_setup"');
  });
});
