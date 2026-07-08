import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runner image rollout progress status", () => {
  it("records hosted verification and final closeout evidence after the rollout smoke passes", async () => {
    const progress = await readFile(join(process.cwd(), "PROGRESS.md"), "utf8");

    expect(progress).toContain("- [x] Step 5: Verify Hosted Runner Registration End to End");
    expect(progress).toContain("- [x] Step 6: Close Out the Rollout");
    expect(progress).toContain("runner `4870df3d-6bad-439f-99f9-e8a4f8787c37`");
    expect(progress).toContain("verify a fresh hosted cloud runner registers");
    expect(progress).toContain("issue #193 evidence comment");
    expect(progress).toContain("Remaining operational actions");
  });
});
