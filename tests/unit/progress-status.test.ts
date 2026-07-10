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
    expect(progress).toContain("- [x] Step 4: Add Dashboard Cost Summary and Views");
    expect(progress).toContain(
      "- [x] Step 5: Add Runner Detail Cost Context (implemented; review and merge pending)",
    );
    expect(progress).toContain("- [ ] Step 6: Final Acceptance and Milestone Closeout");
    expect(progress).toContain("No changelog entry was added for Step 0");
    expect(progress).toContain("Step 1 is complete for issue #222");
    expect(progress).toContain("Step 2 is complete for issue #223");
    expect(progress).toContain("Step 3 is complete for issue #224 on current `origin/main`");
    expect(progress).toContain(
      "| 3 | #224 | #243 | `ebea027` | Daily/monthly infrastructure cost estimates, allocation, and unavailable-price coverage merged. |",
    );
    expect(progress).toContain(
      "| 4 | #225 | #246 | `833bd0c` | Dashboard daily/monthly estimates, allocation, unavailable/zero-agent states, and safe failure handling merged. |",
    );
    expect(progress).not.toContain("Next implementation work should proceed on Step 3");
    expect(progress).toContain("Step 5 is implemented for issue #226");
    expect(progress).toContain("Review and merge remain pending.");
    expect(progress).not.toContain("draft PR #246");
    expect(progress).not.toContain("no pull request or merge evidence exists yet");
    expect(progress).not.toContain("Step 5 is merged");
  });
});

describe("authentication progress status", () => {
  it("records merged foundations and open downstream authentication work", async () => {
    const progress = await readFile(join(process.cwd(), "PROGRESS.md"), "utf8");
    const lines = progress.split("\n");
    const getStepRow = (step: number) => lines.find((line) => line.startsWith(`| ${step}. `)) ?? "";
    const step2Row = getStepRow(2);
    const step3Row = getStepRow(3);
    const step4Row = getStepRow(4);
    const step5Row = getStepRow(5);
    const step6Row = getStepRow(6);
    const step7Row = getStepRow(7);

    expect(step2Row).toContain("| #233 | Merged | None | PR #244 (merged) | `711ee48` |");
    expect(step3Row).toContain("| #234 | Merged | None | PR #247 (merged) | `e5b09fb` |");

    for (const [row, issue] of [
      [step4Row, 235],
      [step5Row, 236],
      [step6Row, 237],
    ] as const) {
      expect(row).toContain(`| #${issue} | Open; prerequisites merged |`);
      expect(row).toContain("merged #233/PR #244 and #234/PR #247");
      expect(row).toContain(`Issue #${issue} is open with prerequisites merged`);
      expect(row).not.toContain("Dependency-blocked");
      expect(row.toLowerCase()).not.toContain("after both dependencies merge");
    }

    expect(step7Row).toContain("Implemented; PR open; cycle-5 tracker/recheck gate pending");
    expect(step7Row).toContain("merged #233/PR #244 and #234/PR #247");
    expect(step7Row).toContain("PR #251 (open)");
    expect(step7Row).toContain("Implementation `d077a83`; prior tracker head `88c058f`");
    expect(step7Row).toContain("9 focused files / 143 tests");
    expect(step7Row).toContain("73 files / 669 unit tests");
    expect(step7Row).toContain("CI run 29082905252");
    expect(step7Row).toContain("PR #251 is open and not merged");
    expect(step7Row).not.toContain("Not opened");
    expect(step7Row).not.toContain("8f47126");
    expect(step7Row).not.toContain("8 files, 120 tests");
    expect(step7Row).not.toContain("72 files, 642 tests");
    expect(step7Row).not.toContain("checker pending");

    for (const row of [step2Row, step3Row, step4Row, step5Row, step6Row, step7Row]) {
      expect(row).not.toBe("");
      expect(row).not.toContain("checker pending");
      expect(row).not.toContain("Draft PR #244");
      expect(row).not.toContain("re-review pending");
    }

    expect(progress).toContain(
      "Steps 2 and 3 are merged: #233 through PR #244 and #234 through PR #247.",
    );
    expect(progress).not.toContain(
      "Step 2 is implemented on its isolated builder branch and awaits checker evidence",
    );
    expect(progress).not.toContain(
      "Steps 4-7 wait for the merged routing/session contract from Step 2",
    );
  });
});
