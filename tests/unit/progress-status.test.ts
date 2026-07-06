import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Milestone 13 progress status", () => {
  it("does not mark Step 9 or Milestone 13 complete before the UI provisioning flow is verified", async () => {
    const progress = await readFile(join(process.cwd(), "PROGRESS.md"), "utf8");

    expect(progress).toContain(
      "- [ ] Step 9: End-to-End Cloud Provisioning Smoke and Operator Docs",
    );
    expect(progress).toContain("Milestone 13 is not complete");
    expect(progress).toContain("UI flow creates or reuses a DigitalOcean runner");
    expect(progress).not.toContain("- [x] Step 9: End-to-End Cloud Provisioning Smoke");
  });
});
