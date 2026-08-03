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

    expect(step1Row).toContain("| #232 | Closed; development setup complete | None |");
    expect(step1Row).toContain("PR #257 (merged, non-closing)");
    expect(step1Row).toContain("| `d518f0b` |");
    expect(step1Row).toContain("dedicated app/link/provider configuration passed");
    expect(step1Row).not.toContain("Not opened");
    expect(step1Row).not.toContain("Not collected");
    expect(step1Row).toContain("merged");
    expect(step1Row).toContain("de322ae8-c258-440e-a679-b74bafb61048");
    expect(step1Row).toContain("ignored local `.env.local`");
    expect(step1Row).toContain("sanitized `clerk doctor --json` gate green");
    expect(step1Row).toContain("not hosted browser email-code");

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
    expect(step8Row).toContain("completed development setup Step 1");
    expect(step8Row).toContain("PR #256 (merged, non-closing)");
    expect(step8Row).toContain("| `10c246d` |");
    expect(step8Row).toContain("776 unit and 14 E2E tests");
    expect(step8Row).toContain("sanitized doctor gate from #232 are complete");
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
    expect(progress).toContain("Hosted browser/provider smoke still waits");
    expect(progress).toContain("safely isolated runner-backed");
    expect(progress).not.toContain("Steps 4-7 no longer wait on those prerequisites");
  });
});

describe("automatic Hermes Telegram progress status", () => {
  it("records the automatic-ready ledger without rewriting historical progress", async () => {
    const progress = await readFile(join(process.cwd(), "PROGRESS.md"), "utf8");
    const automaticLedger =
      progress.split("## Automatic Ready Hermes + Telegram Creation")[1] ?? "";
    const changelog = await readFile(join(process.cwd(), "CHANGELOG.md"), "utf8");

    expect(automaticLedger).toContain("Source plan: `PLAN.md`");
    expect(automaticLedger).toContain(
      "supersedes the earlier native-only Milestone 18 product decision",
    );
    expect(automaticLedger).toContain("OpenRouter is the first supported provider");
    expect(automaticLedger).toContain("dedicated staging Telegram bot/user");
    expect(automaticLedger).toContain(
      "Step 9 is independently accepted after checker cycle 1 at `b41e969`",
    );
    expect(automaticLedger).toContain("- [x] Step 0: Progress and Changelog Tracking Setup");
    expect(automaticLedger).toContain("- [x] Step 1: Quality Gates Setup and Baseline Evidence");
    expect(automaticLedger).toContain(
      "- [x] Step 2: Align Readiness With the Pinned Hermes Contract",
    );
    expect(automaticLedger).toContain(
      "- [x] Step 3: Persist Desired State and Deployment Operations",
    );
    expect(automaticLedger).toContain(
      "- [x] Step 4: Add Managed Creation Configuration and Encrypted Credentials",
    );
    expect(automaticLedger).toContain(
      "- [x] Step 5: Project a Complete Managed Hermes Configuration",
    );
    expect(automaticLedger).toContain(
      "- [x] Step 6: Split Runner Launch Acceptance From Observed Readiness",
    );
    expect(automaticLedger).toContain("- [x] Step 7: Reconcile Creation Through Ready");
    expect(automaticLedger).toContain(
      "- [x] Step 8: Add One-Click Creation and Persisted Progress UI",
    );
    expect(automaticLedger).toContain("- [x] Step 9: Make Desired-Running Gateways Durable");
    expect(automaticLedger).toContain(
      "- [ ] Step 10: Final Acceptance, Documentation, and Controlled Rollout",
    );
    expect(automaticLedger).toContain("| 0. Progress and Changelog Tracking Setup | Complete |");
    expect(automaticLedger).toContain(
      "| 1. Quality Gates Setup and Baseline Evidence | Complete |",
    );
    expect(automaticLedger).toContain(
      "| 2. Align Readiness With the Pinned Hermes Contract | Complete |",
    );
    expect(automaticLedger).toContain(
      "| 3. Persist Desired State and Deployment Operations | Complete |",
    );
    expect(automaticLedger).toContain(
      "| 4. Add Managed Creation Configuration and Encrypted Credentials | Complete |",
    );
    expect(automaticLedger).toContain(
      "| 5. Project a Complete Managed Hermes Configuration | Complete and independently accepted after cycle 3 |",
    );
    expect(automaticLedger).toContain(
      "| 6. Split Runner Launch Acceptance From Observed Readiness | Complete and independently accepted after cycle 2 |",
    );
    expect(automaticLedger).toContain(
      "| 7. Reconcile Creation Through Ready | Complete and independently accepted after cycle 1 |",
    );
    expect(automaticLedger).toContain(
      "| 8. Add One-Click Creation and Persisted Progress UI | Complete and independently accepted after cycle 2 |",
    );
    expect(automaticLedger).toContain(
      "| 9. Make Desired-Running Gateways Durable | Complete and independently accepted after cycle 1 |",
    );
    expect(automaticLedger).toContain("launch-spec v3 parsing/redaction/serialization");
    expect(automaticLedger).toContain("explicit/custom YAML tags and anchors");
    expect(automaticLedger).toContain("secret-like null/map/array/boolean/number values");
    expect(automaticLedger).toContain("Docker inspect Telegram allowlist leaks");
    expect(automaticLedger).toContain("safe YAML scalar punctuation");
    expect(automaticLedger).toContain("injected filesystem transaction seam");
    expect(automaticLedger).toContain("write/chmod/chown/fsync/rename failures");
    expect(automaticLedger).toContain("nonregular FIFO/socket projected targets");
    expect(automaticLedger).toContain("Independent acceptance passed 17 files / 102 focused tests");
    expect(automaticLedger).toContain("107 files / 961 tests");
    expect(automaticLedger).toContain('`telegramBoundary: "local-fake-platform-state"`');
    expect(automaticLedger).toContain("`drizzle/0017_ambitious_tyrannus.sql`");
    expect(automaticLedger).toContain("three nullable Telegram secret metadata columns");
    expect(automaticLedger).toContain("Focused Step 4 tests passed");
    expect(automaticLedger).toContain("credential-free `bun run verify:hermes:staging`");
    expect(automaticLedger).toContain("one request-scoped 30-second launch budget");
    expect(automaticLedger).toContain(
      "Initial combined focused coverage passed 11 files / 216 tests",
    );
    expect(automaticLedger).toContain("108 files / 996 full tests");
    expect(automaticLedger).toContain("`bun run verify:hermes:staging` exited nonzero");
    expect(automaticLedger).toContain("fail-closed one-open-usage uniqueness");
    expect(automaticLedger).toContain("Focused Step 7 gates passed 22 files / 311 tests");
    expect(automaticLedger).toContain("116 files / 1,065 tests");
    expect(automaticLedger).toContain("`bun run local:cloud:smoke` passed");
    expect(automaticLedger).toContain("simultaneous create-kick/heartbeat/cron/manual triggers");
    expect(automaticLedger).toContain("local pinned-image behavior");
    expect(automaticLedger).toContain('`telegramBoundary: "local-smoke-disabled"`');
    expect(automaticLedger).toContain("`drizzle/0016_motionless_fantastic_four.sql`");
    expect(automaticLedger).toContain("7 files / 72 tests");
    expect(automaticLedger).toContain("103 files / 905 tests");
    expect(automaticLedger).toContain("Full gates passed");
    expect(automaticLedger).toContain("Step validation commands and results.");
    expect(automaticLedger).toContain("Safe blocker codes, missing capabilities, and next action.");
    expect(automaticLedger).toContain("Step 9 is independently accepted at `b41e969`");
    expect(automaticLedger).toContain("17 files / 209 focused runtime");
    expect(automaticLedger).toContain("137 files / 1,297 full tests");
    expect(automaticLedger).toContain("26 desktop/mobile CI E2E tests");
    expect(automaticLedger).toContain("restart/Stop smoke");
    expect(automaticLedger).toContain("No live or provider-backed action is authorized yet");
    expect(automaticLedger).not.toContain("No blocker remains for Step 3.");
    expect(automaticLedger).not.toContain("Step 4 should add managed creation configuration");
    expect(changelog).toContain("# Changelog");
    expect(changelog).toContain("Keep a Changelog");
    expect(changelog).toContain("## [Unreleased]");
    expect(changelog).toContain(
      "owners can read the latest deployment operation through `GET /api/agents/:agentId/deployment`",
    );
    expect(changelog).toContain(
      "Automatic ready-mode deployments now reconcile durably from creation to verified running state",
    );
    expect(changelog).toContain("Credential-complete one-click ready agent creation");
    expect(changelog).toContain("manual Hermes setup is secondary advanced recovery");
    expect(changelog).toContain("Managed desired-running Hermes gateways now recover");
    expect(changelog).toContain("Intentional Stop now remains authoritative");
  });
});
