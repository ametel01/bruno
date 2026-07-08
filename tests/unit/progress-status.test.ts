import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runner image rollout progress status", () => {
  it("does not mark hosted runner verification complete before the hosted flow is verified", async () => {
    const progress = await readFile(join(process.cwd(), "PROGRESS.md"), "utf8");

    expect(progress).toContain("- [ ] Step 5: Verify Hosted Runner Registration End to End");
    expect(progress).toContain("Status: pending downstream implementation.");
    expect(progress).toContain("verify a fresh hosted cloud runner registers");
    expect(progress).not.toContain("- [x] Step 5: Verify Hosted Runner Registration End to End");
  });
});
