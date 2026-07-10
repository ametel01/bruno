import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("milestone 16 progress status", () => {
  it("records merged cost foundations and honest in-progress UI evidence", async () => {
    const progress = await readFile(join(process.cwd(), "PROGRESS.md"), "utf8");

    expect(progress).toContain("Milestone 16: Cost Tracking is the active implementation plan.");
    expect(progress).toContain("- [x] Step 0: Progress and Changelog Tracking Setup");
    expect(progress).toContain("- [x] Step 1: Add Provider Price Metadata");
    expect(progress).toContain("- [x] Step 2: Persist Agent Usage Periods");
    expect(progress).toContain("- [x] Step 3: Build Daily and Monthly Cost Estimate Service");
    expect(progress).toContain(
      "- [x] Step 4: Add Dashboard Cost Summary and Views (implemented and reviewed; merge pending)",
    );
    expect(progress).toContain("- [ ] Step 6: Final Acceptance and Milestone Closeout");
    expect(progress).toContain("No changelog entry was added for Step 0");
    expect(progress).toContain("Step 1 is complete for issue #222");
    expect(progress).toContain("Step 2 is complete for issue #223");
    expect(progress).toContain("Step 3 is complete for issue #224 on current `origin/main`");
    expect(progress).toContain(
      "| 3 | #224 | #243 | `ebea027` | Daily/monthly infrastructure cost estimates, allocation, and unavailable-price coverage merged. |",
    );
    expect(progress).not.toContain("Next implementation work should proceed on Step 3");
    expect(progress).toContain("PR #246 has been reviewed; merge");
    expect(progress).not.toContain("draft PR #246");
    expect(progress).not.toContain("no pull request or merge evidence exists yet");
  });
});
