# Milestone 16 Cost Tracking Progress

Source plan: `/Users/alexmetelli/source/agentbay/PLAN.md`

Source roadmap: `/Users/alexmetelli/source/agentbay/docs/MILESTONES.md`

GitHub issue wave:

- #221: Progress and changelog tracking setup
- #222: Provider price metadata
- #223: Agent usage periods
- #224: Daily and monthly cost estimate service
- #225: Dashboard cost summary and views
- #226: Runner detail cost context
- #227: Final acceptance and milestone closeout

## Current Status

Milestone 16: Cost Tracking is the active implementation plan.

Step 0 is complete for issue #221. The tracker lists every Milestone 16 incremental step before feature work starts, records the functional-change-only changelog rule, and confirms the existing changelog structure remains valid.

Step 1 is complete for issue #222 on current `origin/main`. The repo now has server-only deterministic DigitalOcean runner price metadata and targeted unit tests for supported and unavailable runner sizes.

Step 2 is complete for issue #223 on branch `codex/issue-223-usage-periods`. Successful starts open durable `agent_usage_periods` rows, successful stops close only the latest open row, successful restarts preserve one continuous running usage period, and missing stops remain calculable as open intervals.

Next implementation work should proceed on Step 3 after #222 price metadata and #223 usage periods are both available on the target branch. Do not start #224+ estimate services or UI work from this branch.

## Changelog Status

`CHANGELOG.md` already exists and includes the Keep a Changelog structure required by the plan: `# Changelog`, the standard preamble, and `## [Unreleased]`.

No changelog entry was added for Step 0 because progress tracking setup, planning confirmation, test-guard alignment, and validation-only work are not functional product changes. Future Milestone 16 changelog entries should be added only for user-facing or operator-facing cost-tracking behavior.

Step 2 adds a functional `Added` entry for durable infrastructure usage tracking. The entry intentionally does not mention pricing calculations, estimate services, dashboard UI, runner detail UI, billing, Stripe, hosted resources, or plan enforcement.

## Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Add Provider Price Metadata
- [x] Step 2: Persist Agent Usage Periods
- [ ] Step 3: Build Daily and Monthly Cost Estimate Service
- [ ] Step 4: Add Dashboard Cost Summary and Views
- [ ] Step 5: Add Runner Detail Cost Context
- [ ] Step 6: Final Acceptance and Milestone Closeout

## Step Notes

### Step 0: Progress and Changelog Tracking Setup

Status: complete.

Completed for issue #221:

- Replaced the previous completed rollout tracker with the active Milestone 16 Cost Tracking tracker.
- Listed every incremental step from `PLAN.md`, Step 0 through Step 6.
- Recorded the active issue wave and identified #222 and #223 as the next parallel implementation work after tracking setup.
- Confirmed `CHANGELOG.md` already has the required Keep a Changelog structure.
- Left `CHANGELOG.md` unchanged because this setup-only issue does not ship functional cost-tracking behavior.
- Kept this tracker free of provider credentials, runner credentials, endpoint tokens, bearer tokens, secret values, and raw credential-bearing service URLs.

Validation:

- `test -f PROGRESS.md` passed.
- `test -f CHANGELOG.md` passed.
- `rg "Milestone 16|Cost Tracking|Step 0|Step 1|Step 2|Step 3|Step 4|Step 5|Step 6" PROGRESS.md` passed.
- `rg "# Changelog|## \\[Unreleased\\]" CHANGELOG.md` passed.
- `git diff --check` passed.
- `bun run test tests/unit/progress-status.test.ts` passed with local test environment variables supplied.

Commit reference: PR #228 merge commit `147b220`.

### Step 1: Add Provider Price Metadata

Status: complete.

Completed for issue #222:

- Added server-only deterministic DigitalOcean runner price metadata in `src/server/costs/provider-prices.ts`.
- Added targeted coverage in `tests/unit/cost-prices.test.ts` for supported sizes, derived daily/hourly estimates, unavailable fallback, display DTOs, and no secret-looking serialized output.
- Kept runtime provider pricing APIs, usage-period persistence, dashboard UI, runner detail UI, billing, Stripe, and provisioning behavior out of this slice.

Validation:

- `bun run format:check` passed.
- `bun run lint` passed.
- `bun run typecheck` passed.
- `bun run test tests/unit/cost-prices.test.ts` passed.
- `git diff --check` passed.

Commit reference: PR #229 merge commit `bffe8ff`.

### Step 2: Persist Agent Usage Periods

Status: complete.

Completed for issue #223:

- Added Drizzle schema and migration `drizzle/0013_mighty_firestar.sql` for `agent_usage_periods`.
- Persisted `agent_id`, nullable `runner_id`, `started_at`, nullable `stopped_at`, `source`, and created/updated timestamps without secret-bearing metadata.
- Added indexes for agent/time, runner/time, and agent/stop lookup plus a constraint rejecting stop-before-start intervals.
- Opened usage periods only inside the final successful start transaction after the runner adapter reports success.
- Closed only the latest open usage period inside the final successful stop transaction after the runner adapter reports success.
- Documented restart behavior in tests as one continuous running interval: successful restart keeps the existing open usage period instead of closing/reopening.
- Kept missing stops represented as open intervals with `stopped_at = null`.
- Preserved #221 Step 0 tracker intent and #222 provider price metadata files/tests while rebasing onto current `origin/main`.

Validation:

- Rebased `codex/issue-223-usage-periods` onto current `origin/main` after PR #228 and PR #229 merged.
- `git diff --check` passed after conflict resolution.
- `bun run test tests/unit/progress-status.test.ts tests/unit/cost-prices.test.ts` passed after tracker and price-metadata reconciliation.
- `bun run test tests/unit/agent-schema.test.ts tests/unit/create-agent-db.test.ts` passed after schema/lifecycle reconciliation.

Commit reference: pending post-rebase commit.

Next step: Step 3 can consume #222 price metadata and #223 usage periods after #223 is merged.

## Update Log

- 2026-07-09: Step 0 completed in branch `codex/issue-221-cost-progress` for issue #221. `PROGRESS.md` now tracks Milestone 16 Cost Tracking, `CHANGELOG.md` structure was confirmed without adding setup-only entries, and the progress guard was aligned to the new active tracker.
- 2026-07-09: Step 1 completed via PR #229. Current `origin/main` includes server-only DigitalOcean runner price metadata and `tests/unit/cost-prices.test.ts`.
- 2026-07-09: Step 2 completed in branch `codex/issue-223-usage-periods` for issue #223 and rebased after PR #228/#229 so Step 0 tracker intent and Step 1 price metadata remain present.
