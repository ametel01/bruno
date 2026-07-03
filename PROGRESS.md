# AgentBay Milestone 2 Progress

This tracker is scoped to Milestone 2: fake lifecycle controls on top of the completed Milestone 1 persistence and read baseline. Milestone 2 starts only after the Milestone 1 baseline is verified. It must not add real runners, logs, approvals, config editing, billing, Hermes, Telegram, production auth, cloud provisioning, or schema work outside the fake lifecycle slice.

Source documents:

- `MILESTONES.md`: Milestone 2 product and technical expectations.
- `README.md`: current local database, Milestone 1 agent flow, and quality gate instructions.
- GitHub issues #21 through #26: implementation sequence for Milestone 2.
- GitHub PR #32: final Milestone 1 baseline, merged as `0576813be2272abcc919859f11f3710edd8dfd74`.

## Milestone 2 Scope

Milestone 2 adds fake lifecycle controls for existing persistent agents. The target outcome is that users can start, stop, restart, and soft-delete agents through deterministic fake state, with invalid transitions blocked and transition events recorded. This milestone builds from persisted stopped agent records and active read surfaces; it does not introduce real process execution or external integrations.

Out of scope for this tracker and its implementation issues:

- Real runner/provisioning behavior, delayed external workers, logs, approvals, config editing, billing, Hermes, Telegram, production auth, secrets, or cloud resources.
- Milestone 1 CRUD or persistence reimplementation.
- Schema or migration changes unless an accepted Milestone 2 issue explicitly requires them.

## Issue Checklist

- [x] Step 0 / issue #21: Set up Milestone 2 tracking and verify the Milestone 1 baseline guard.
- [x] Step 1 / issue #22: Start agents through fake lifecycle controls.
- [x] Step 2 / issue #23: Stop running agents through fake lifecycle controls.
- [ ] Step 3 / issue #24: Restart running agents through fake lifecycle controls.
- [ ] Step 4 / issue #25: Soft-delete agents from active lifecycle views.
- [ ] Step 5 / issue #26: Verify Milestone 2 lifecycle controls end to end.

## Current Status

- Milestone 1 is complete and available as the baseline for Milestone 2.
- Issue #20 was completed by PR #32. GitHub records implementation commit `52f08a801db9bf005e74087ea9ef1f22ef37b970`, validation commit `c10f5f01ee43111bd3a243f846528b54d1e27727`, and merge commit `0576813be2272abcc919859f11f3710edd8dfd74`.
- Issue #21 was completed by PR #33 and merged as `4839504064af730cdf30ca68509a16be6c7ff712`.
- Issue #22 was completed by PR #34 and merged as `63ce4eec6ad464bf8101b5ad2b9890877af8a17a`.
- Issue #23 Stop lifecycle implementation is complete on branch `fix/issue-23-stop-lifecycle`, passed independent checker validation, and is ready for maintainer review.
- `CHANGELOG.md` records observable Start and Stop lifecycle behavior under `## [Unreleased]`.

## Baseline Guard

Baseline result: present.

Milestone 1 persistence exists in:

- `src/server/db/schema.ts`: defines `users`, `agents`, `agent_events`, and `agent_status`.
- `drizzle/0001_optimal_texas_twister.sql`: creates the same Milestone 1 tables and enum.
- `tests/unit/agent-schema.test.ts`: asserts the schema and migration include the Milestone 1 persistence baseline.

Milestone 1 database-backed create/list/dashboard/detail behavior exists in:

- `src/server/agents/create-agent.ts`: creates stopped agents transactionally, reuses the local development user, and records `agent.created`.
- `app/api/agents/route.ts`: exposes validated `POST /api/agents` creation behavior.
- `src/server/agents/list-agents.ts`: lists active agents and loads active detail records from the database.
- `app/agents/page.tsx`: renders the database-backed create/list page.
- `app/dashboard/page.tsx`: renders persisted active agents on the dashboard.
- `app/agents/[agentId]/page.tsx`: loads active persisted detail records and returns not found for missing, malformed, or soft-deleted IDs.
- `tests/unit/create-agent-db.test.ts`: covers transactional create, rollback, list, detail, and soft-delete filtering behavior.
- `tests/e2e/root-route.spec.ts`: covers the browser create/refresh/dashboard/detail flow plus not-found cases.
- `README.md`: documents the Milestone 1 local database, API, UI flow, and quality gates.

If a future agent cannot verify this baseline, stop that issue, record the exact missing surface here, and do not rebuild Milestone 1 inside a Milestone 2 issue.

## Update Rules

- Update this file after each completed Milestone 2 issue.
- Keep the checklist limited to Milestone 2 until issue #26 is complete.
- Preserve source references when baseline or gate evidence changes.
- Record local database evidence with the exact `DATABASE_URL`, container name, and port used for validation.
- Verify every cited commit SHA with `gh pr view --json commits,mergeCommit` and `git cat-file -t <sha>` or equivalent before handoff.
- Update `CHANGELOG.md` under `## [Unreleased]` only when a validated issue ships observable functional behavior. Do not add changelog entries for tracking-only, docs-only, test-only, or validation-only work.

## Completed-Issue Recording Rules

Each completed issue entry must record:

- Issue number, PR number, branch, and merge commit when available.
- Implementation summary scoped to user-visible or system-visible behavior.
- Validation summary with required gates and exact database environment.
- Any skipped gate or pre-existing failure with exact evidence and next owner.
- Confirmation that lifecycle controls, schema, migrations, APIs, runner/log/approval/config/billing/Hermes/Telegram/auth scope did or did not change as intended.
- Current next step and downstream issue unblocked.

## Validation Evidence

Issue #21 baseline/tracking verification:

- Baseline code inspection: passed. Milestone 1 persistence and database-backed create/list/dashboard/detail surfaces are present in the files listed under `Baseline Guard`.
- PR #32 commit history check: passed. `gh pr view 32 --json commits,mergeCommit,state,mergedAt,headRefName,baseRefName,url,title` reports implementation commit `52f08a801db9bf005e74087ea9ef1f22ef37b970`, validation commit `c10f5f01ee43111bd3a243f846528b54d1e27727`, and merge commit `0576813be2272abcc919859f11f3710edd8dfd74`.
- Commit existence check: passed for `52f08a801db9bf005e74087ea9ef1f22ef37b970`, `c10f5f01ee43111bd3a243f846528b54d1e27727`, and `0576813be2272abcc919859f11f3710edd8dfd74`.
- Invalid prior issue #20 implementation SHA: confirmed missing during builder verification and replaced with verified commit `52f08a801db9bf005e74087ea9ef1f22ef37b970`.
- `docker compose up -d postgres`: blocked because default port `54329` is already allocated by stale local container `agentbay-issue-5-postgres-1`; compose created `agentbay-issue-21-postgres-1` but could not start it.
- Isolated Postgres fallback: passed with container `agentbay-issue-21-postgres` (`5d0fe21069e5`) on port `54340`.
- Validation database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54340/agentbay`.
- First `bun run db:migrate`: failed before dependency install because `drizzle-kit` was unavailable in the fresh worktree.
- `bun install --frozen-lockfile`: passed; installed dependencies from `bun.lock` without source changes.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54340/agentbay bun run db:migrate`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54340/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: passed with reachable database JSON.
- `bun run format:check`: passed.
- `bun run lint`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54340/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run typecheck`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54340/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test`: passed, 8 files / 31 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54340/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54340/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3023 bun run test:e2e`: passed, 17 passed / 1 skipped.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54340/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3024 bun run verify`: passed, including 8 files / 31 tests and 17 passed / 1 skipped E2E tests.
- `git diff --check`: passed.

Issue #22 Start lifecycle validation:

- `docker compose up -d postgres`: blocked because default port `54329` is already allocated by stale local container `agentbay-issue-5-postgres-1`; compose created `agentbay-issue-22-postgres-1` but could not start it.
- Isolated Postgres fallback: passed with container `agentbay-issue-22-postgres` (`75bf51e3ff1ba84aa62395a544cbf71e65ff0864ad562af29c88424654f3e3eb`) on port `54341`.
- Validation database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54341/agentbay`.
- `bun install --frozen-lockfile`: passed; installed dependencies from `bun.lock` without source changes after the fresh worktree lacked local binaries.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54341/agentbay bun run db:migrate`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54341/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: passed with reachable database JSON.
- `bun run format:check`: passed.
- `bun run lint`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54341/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run typecheck`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54341/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test`: passed, 9 files / 37 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54341/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54341/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3029 bun run test:e2e`: passed, 17 passed / 1 skipped.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54341/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3030 bun run verify`: passed, including 9 files / 37 tests and 17 passed / 1 skipped E2E tests.
- `git diff --check`: passed.

Issue #23 Stop lifecycle validation:

- Isolated Postgres: passed with container `agentbay-issue-23-postgres` (`ccd8c88fec835a3d5a0557ae73029b809e767edb377dd6ca1d4e8ca4cce3872d`) on port `54343`.
- Validation database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54343/agentbay`.
- `bun install --frozen-lockfile`: passed; installed dependencies from `bun.lock` without source or lockfile changes after the fresh worktree lacked local binaries.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54343/agentbay bun run db:migrate`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54343/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: passed with reachable database JSON.
- `bun run format:check`: passed.
- `bun run lint`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54343/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run typecheck`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54343/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test`: passed, 10 files / 44 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54343/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54343/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3031 bun run test:e2e`: passed, 17 passed / 1 skipped.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54343/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3032 bun run verify`: passed, including 10 files / 44 tests and 17 passed / 1 skipped E2E tests.
- `git diff --check`: passed after the final docs freshness pass.

## Current Next Step

Hand issue #23 to maintainer-reviewer for review against the Stop lifecycle contract on branch `fix/issue-23-stop-lifecycle`.

## Update Log

- 2026-07-03: Converted `PROGRESS.md` from a Milestone 1 tracker into the Milestone 2 execution tracker, verified the Milestone 1 baseline guard, and corrected the issue #20 implementation commit reference.
- 2026-07-03: Rolled current status forward from issue #21 merged to issue #22 Start lifecycle implementation and recorded the issue #22 fallback database environment.
- 2026-07-03: Rolled issue #22 forward from pre-review checker handoff to PR #34 post-review remediation and recheck for malformed percent-encoded Start route IDs.
- 2026-07-03: Rolled issue #22 forward again after checker revalidation and maintainer re-review found only stale tracker next-step wording.
- 2026-07-03: Rolled issue #22 to merged, recorded issue #23 Stop lifecycle implementation and checker validation, and set the next step to maintainer review.
