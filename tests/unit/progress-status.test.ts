import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("milestone 16 progress status", () => {
  it("records the complete milestone acceptance ledger without stale pending claims", async () => {
    const progress = await readFile(join(process.cwd(), "PROGRESS.md"), "utf8");
    const milestone16 = progress.split("## Clerk Authentication and User Isolation Rollout")[0];

    expect(milestone16).toContain("Milestone 16: Cost Tracking is complete");
    expect(milestone16).toContain("- [x] Step 0: Progress and Changelog Tracking Setup");
    expect(milestone16).toContain("- [x] Step 1: Add Provider Price Metadata");
    expect(milestone16).toContain("- [x] Step 2: Persist Agent Usage Periods");
    expect(milestone16).toContain("- [x] Step 3: Build Daily and Monthly Cost Estimate Service");
    expect(milestone16).toContain("- [x] Step 4: Add Dashboard Cost Summary and Views");
    expect(milestone16).toContain("- [x] Step 5: Add Runner Detail Cost Context");
    expect(milestone16).toContain("- [x] Step 6: Final Acceptance and Milestone Closeout");
    expect(milestone16).toContain("No changelog entry was added for Step 0");
    expect(milestone16).toContain("Step 1 is complete for issue #222");
    expect(milestone16).toContain("Step 2 is complete for issue #223");
    expect(milestone16).toContain("Step 3 is complete for issue #224 on current `origin/main`");
    expect(milestone16).toContain(
      "| 3 | #224 | #243 | `ebea027` | Daily/monthly infrastructure cost estimates, allocation, and unavailable-price coverage merged. |",
    );
    expect(milestone16).toContain(
      "| 4 | #225 | #246 | `833bd0c` | Dashboard daily/monthly estimates, allocation, unavailable/zero-agent states, and safe failure handling merged. |",
    );
    expect(milestone16).toContain(
      "| 5 | #226 | #250 | `29cc588` | Runner-detail and settings cost context, active-agent allocation, unavailable/failure states, and secret redaction merged. |",
    );
    expect(milestone16).toContain("### Final Acceptance Evidence");
    expect(milestone16).toContain("Acceptance: dashboard displays runner monthly cost.");
    expect(milestone16).toContain(
      "Acceptance: dashboard displays estimated cost per running agent.",
    );
    expect(milestone16).toContain("Acceptance: daily and monthly views exist.");
    expect(milestone16).toContain("Acceptance: start and stop times affect estimates.");
    expect(milestone16).toContain(
      "Acceptance: users can understand why a plan costs more than raw compute.",
    );
    expect(milestone16).toContain("Test: cost calculations cover uptime and multiple agents.");
    expect(milestone16).toContain("Test: UI covers the cost summary.");
    expect(milestone16).toContain(
      "Test: edge cases cover stopped agents, partial days, and missing stop events.",
    );
    expect(milestone16).not.toContain("Next implementation work should proceed on Step 3");
    expect(milestone16).not.toContain("Step 5 is implemented for issue #226");
    expect(milestone16).not.toContain("review and merge pending");
    expect(milestone16).not.toContain("isolated branch");
    expect(milestone16).not.toContain("b67ca44");
    expect(milestone16).not.toContain("draft PR #246");
    expect(milestone16).not.toContain("no pull request or merge evidence exists yet");
    expect(milestone16).not.toContain("Milestone 17");
    expect(milestone16).not.toContain("Stripe");
    expect(milestone16).not.toContain("subscription");
    expect(milestone16).not.toContain("plan enforcement");
  });
});

describe("authentication progress status", () => {
  it("records merged foundations and remaining downstream authentication work", async () => {
    const progress = await readFile(join(process.cwd(), "PROGRESS.md"), "utf8");
    const lines = progress.split("\n");
    const getStepRow = (step: number) => lines.find((line) => line.startsWith(`| ${step}. `)) ?? "";
    const step1Row = getStepRow(1);
    const step2Row = getStepRow(2);
    const step3Row = getStepRow(3);
    const step4Row = getStepRow(4);
    const step5Row = getStepRow(5);
    const step6Row = getStepRow(6);
    const step7Row = getStepRow(7);
    const step8Row = getStepRow(8);

    expect(step1Row).toContain("| #232 | Approved; host-auth-blocked | None |");
    expect(step1Row).toContain("de322ae8-c258-440e-a679-b74bafb61048");
    expect(step1Row).toContain("ignored local `.env.local`");
    expect(step1Row).toContain("no external success is claimed");
    expect(step1Row).toContain("expired Clerk CLI session");

    expect(step2Row).toContain("| #233 | Merged | None | PR #244 (merged) | `711ee48` |");
    expect(step3Row).toContain("| #234 | Merged | None | PR #247 (merged) | `e5b09fb` |");

    for (const [row, issue, pullRequest, commit] of [
      [step4Row, 235, 255, "b93a70f"],
      [step5Row, 236, 254, "ecc1d57"],
      [step6Row, 237, 253, "4a9b70a"],
    ] as const) {
      expect(row).toContain(`| #${issue} | Merged |`);
      expect(row).toContain("merged #233/PR #244 and #234/PR #247");
      expect(row).toContain(`PR #${pullRequest} (merged)`);
      expect(row).toContain(`\`${commit}\``);
      expect(row).toContain(`Complete through merged PR #${pullRequest}`);
    }

    expect(step7Row).toContain("| #238 | Merged |");
    expect(step7Row).toContain("merged #233/PR #244 and #234/PR #247");
    expect(step7Row).toContain("PR #251 (merged)");
    expect(step7Row).toContain("| `3317b9d` |");
    expect(step7Row).toContain("Final PR head `9441cc2`");
    expect(step7Row).toContain("reviewed implementation head `d077a83`");
    expect(step7Row).toContain("9 focused files / 143 tests");
    expect(step7Row).toContain("73 files / 669 unit tests");
    expect(step7Row).toContain("CI run 29084008081");
    expect(step7Row).toContain("Complete through merged PR #251");
    expect(step7Row).toContain("clerk_auth_not_configured");
    expect(step7Row).toContain("no hosted Clerk/protected-preview/provider success is claimed");
    expect(step7Row).not.toContain("Not opened");
    expect(step7Row).not.toContain("PR #251 (open)");
    expect(step7Row).not.toContain("PR #251 is open and not merged");
    expect(step7Row).not.toContain("tracker/recheck gate pending");
    expect(step7Row).not.toContain("8f47126");
    expect(step7Row).not.toContain("88c058f");
    expect(step7Row).not.toContain("8 files, 120 tests");
    expect(step7Row).not.toContain("72 files, 642 tests");
    expect(step7Row).not.toContain("checker pending");

    expect(step8Row).toContain("| #239 | Repository proof merged; hosted acceptance blocked |");
    expect(step8Row).toContain("PR #256 (merged, non-closing)");
    expect(step8Row).toContain("| `10c246d` |");
    expect(step8Row).toContain("776 unit and 14 E2E tests");
    expect(step8Row).toContain("Issue #239 remains open");

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
    expect(progress).toContain("Step 7 is complete through #238/PR #251 at `3317b9d`");
    expect(progress).toContain("Step 8's credential-free repository slice is complete");
    expect(progress).toContain("Hosted provider acceptance waits for Step 1");
    expect(progress).not.toContain("Steps 4-7 no longer wait on those prerequisites");
  });
});
