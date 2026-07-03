# AgentBay Milestone 1 Progress

This tracker is scoped to Milestone 1 only: persistent agent records with no execution behavior. Milestone 1 starts after the completed Milestone 0 product skeleton and must not add lifecycle controls, runners, logs, approvals, billing, Hermes integration, cloud provisioning, or Milestone 2 fake runtime behavior.

Source documents:

- `MILESTONES.md`: Milestone 1 product and technical expectations.
- `PLAN.md`: prior milestone planning and tracking conventions.
- GitHub issues #15 through #20: implementation sequence for Milestone 1.

## Milestone 1 Scope

Milestone 1 establishes durable agent model work only. The target outcome is that users can create persistent agent records, see them after refresh, load detail pages from the database, and record an `agent.created` event transactionally. Execution, lifecycle state transitions, start/stop/restart/delete controls, runner behavior, and fake runtime state are explicitly out of scope for this milestone.

## Issue Sequence

- [x] Step 0 / issue #15: Create or restore this Milestone 1 progress tracker and preserve the Keep a Changelog baseline.
- [x] Step 1 / issue #16: Add Milestone 1 agent persistence schema.
- [x] Step 2 / issue #17: Create agents transactionally through the API.
- [x] Step 3 / issue #18: Add database-backed agent create and list page.
- [x] Step 4 / issue #19: Show persisted agents on dashboard and detail pages.
- [x] Step 5 / issue #20: Cover the Milestone 1 agent flow with E2E tests and docs.

## Current Status

- Step 0 / issue #15 was completed by PR #27 and merged as `5550b152275ad0c8986fae57add5992e4f49e632`.
- Step 1 / issue #16 was completed by PR #28 and merged as `eff2c4fd880d6bca9dd1a61eb834b152639bf90f`.
- Step 2 / issue #17 was completed by PR #29 and merged as `11949b76c2aac7d5f1f31afb4a4deff1f37218b8`.
- Step 3 / issue #18 was completed by PR #30 and merged as `77c0d04d23ec19f42f25378dfcdbe2f7cb949d17`.
- Step 4 / issue #19 was completed by PR #31 and merged as `c0a60fa41ddd4e1d5c3453433022d26cd23149bf`.
- Step 5 / issue #20 is implemented on branch `fix/issue-20-m1-e2e-docs` and builder-validated.
- Issue #17 adds transactional create-agent API behavior only. It does not add `/agents` UI behavior, dashboard database reads, detail reads, `GET /api/agents`, lifecycle controls, runtime behavior, seed data, auth, billing, Hermes, Telegram, logs, approvals, or runner behavior.
- Issue #18 adds `/agents` create/list UI behavior only. It does not add dashboard database reads, detail reads, lifecycle controls, runtime behavior, seed data, auth, billing, Hermes, Telegram, logs, approvals, runner behavior, or soft-delete controls.
- Issue #19 adds dashboard and detail read surfaces only. It does not add lifecycle controls, delete controls, logs, approvals, config editor, activity feeds, auth, billing, runner behavior, Hermes, Telegram, seed data, or fake runtime behavior.
- Issue #20 strengthens final Milestone 1 browser coverage, scoped E2E cleanup, README documentation, and stale copy cleanup only. It does not add product behavior, schema changes, lifecycle controls, delete controls, logs, approvals, config editor, activity feeds, auth, billing, runner behavior, Hermes, Telegram, seed data, or fake runtime behavior.

## Update Rules

- Update this file after each completed Milestone 1 issue.
- Each completed issue update must record the issue number, summary, validation results, commit reference if available, current status, and next step.
- Keep the checklist limited to Milestone 1 until issue #20 is complete.
- Update `CHANGELOG.md` under `## [Unreleased]` only when a validated issue ships observable functional behavior. Do not add changelog entries for tracking-only, docs-only, test-only, or validation-only work.

## Validation Evidence

Step 0 / issue #15 validation:

- Initial issue #15 implementation commit: `f526b0f518f41ddd5a55d5a6d2d493832a16b99c`.
- `test -f PROGRESS.md`: passed.
- `test -f CHANGELOG.md`: passed.
- `rg -n "Milestone 1|Step 0|Step 1" PROGRESS.md`: passed.
- `rg -n "# Changelog|## \\[Unreleased\\]" CHANGELOG.md`: passed.
- `git diff --check`: passed.

Step 1 / issue #16 validation:

- Completion summary: added the Drizzle `users`, `agents`, `agent_events`, and `agent_status` schema definitions plus generated migration `drizzle/0001_optimal_texas_twister.sql`; preserved `app_metadata` and existing health/migration behavior.
- Implementation commit: `77d68e8e2a1a9560d6869147dab542c4f9c8b0a1`.
- `bun test tests/unit/agent-schema.test.ts`: passed, 4 tests.
- `bun run format:check`: passed after applying `bun run format` to new/edited files.
- `bun run lint`: passed.
- `bun run typecheck`: passed.
- `bun run test`: passed, 5 files / 15 tests.
- `docker compose up -d postgres`: blocked locally because port `54329` was already allocated by unrelated container `agentbay-issue-5-postgres-1`.
- `docker run --rm -d --name agentbay-issue-16-postgres-alt ... -p 54330:5432 postgres:17-alpine`: passed as an isolated fallback database.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54330/agentbay bun run db:migrate`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54330/agentbay bun run db:health`: passed.
- Migrated database inspection found `agent_events`, `agents`, `app_metadata`, `users`, and `agent_status`.
- `bun run build`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54330/agentbay bun run test:e2e`: passed, 14 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54330/agentbay bun run verify`: passed.

Step 2 / issue #17 validation:

- Completion summary: added `POST /api/agents` with safe validation responses, stable template keys, deterministic local development user reuse through `app_metadata`, transactional `agents` and `agent_events` inserts, and rollback coverage for event-write failure.
- Implementation commit: `1aefe6d3ee11d935dc5a1e24f60352467258ff24`.
- Default Postgres port `54329` was occupied by unrelated stale container `agentbay-issue-5-postgres-1`; validation used isolated Postgres container `agentbay-issue-17-postgres` on port `54333`.
- `bun run format:check`: passed.
- `bun run lint`: passed.
- `bun run typecheck`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54333/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test`: passed, 8 files / 23 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54333/agentbay bun run db:migrate`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54333/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54333/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54333/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3017 bun run test:e2e`: passed, 14 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54333/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3017 bun run verify`: passed.

Step 3 / issue #18 validation:

- Completion summary: replaced the `/agents` placeholder with a database-backed create/list workflow using the existing `POST /api/agents` create contract, supported template keys, stopped persisted rows, stable `/agents/:agentId` links, active-row filtering, and safe user-facing validation/persistence feedback.
- Implementation commit: `da9eb2922824278babd59e5f65fd3e5e3f8492b5`.
- Default Postgres port `54329` was occupied by unrelated stale container `agentbay-issue-5-postgres-1`; validation used isolated Postgres container `agentbay-issue-18-postgres` (`c088c3d6a4caa6f4f6bd56bfa339bae49b53e0d0d5e5d55e57af06459d5c7856`) on port `54335`.
- `bun run format:check`: passed.
- `bun run lint`: passed.
- `bun run typecheck`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54335/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test`: passed, 8 files / 26 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54335/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54335/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54335/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54335/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3018 bun run test:e2e`: passed, 18 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54335/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3018 bun run verify`: passed.
- `git diff --check`: passed.

Step 4 / issue #19 validation:

- Completion summary: added database-backed dashboard reads for active persisted agents, preserved the empty state, replaced arbitrary detail placeholders with active persisted record lookups, rendered name/status/template/timestamps/status reason when present, and routed missing, malformed, or soft-deleted detail IDs to the Next not-found state.
- Implementation commit: `d0259648b27c29a63483d7e49ffdefc17c770efc`.
- Default Postgres port `54329` was occupied by unrelated stale container `agentbay-issue-5-postgres-1`; validation used isolated Postgres container `agentbay-issue-19-postgres` (`d081c0435689ff918f8a85bc204e7fc7db3950d516b8b6cb0077035b7f0d32e1`) on port `54336`.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay bun run db:migrate`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/root-page.test.tsx`: passed, 10 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test -- tests/unit/create-agent-db.test.ts`: passed, 5 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run format:check`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run lint`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run typecheck`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test`: passed, 8 files / 31 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: passed; rerun only emitted existing Drizzle schema/table notices.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3019 bun run test:e2e`: passed, 18 tests. Browser coverage included creating an agent, refreshing `/agents`, visiting and refreshing `/dashboard`, opening and refreshing the persisted detail route, and missing/malformed/soft-deleted detail not-found assertions.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54336/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3020 bun run verify`: passed.
- Tracking-doc freshness check: `PROGRESS.md` and `CHANGELOG.md` were updated after validation with issue #19 status, validation evidence, current next step, and changelog behavior summary.
- `git diff --check`: passed after tracking-doc updates.

Step 5 / issue #20 validation:

- Completion summary: strengthened the final Milestone 1 Playwright smoke path to create exactly named `Research Agent`, select `research_agent`, verify stopped persisted visibility on `/agents`, `/dashboard`, and the generated detail link after refresh, preserve missing/malformed/soft-deleted not-found coverage, add ID-scoped E2E cleanup for test-created agent rows/events, refresh README Milestone 1 local DB/API/UI docs, and remove stale Milestone 0-only copy.
- Implementation commit: `52f08a87ac092e36d0ad9fe18be66132907c016e`.
- Default Postgres port `54329` was occupied by unrelated stale container `agentbay-issue-5-postgres-1`; validation used isolated Postgres container `agentbay-issue-20-postgres` (`e1a621e2a29588c2dab89408382a5110541d17078427ce8a5a5d3ff07ac31fee`) on port `54338`.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54338/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run format:check`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54338/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run lint`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54338/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run typecheck`: passed.
- Initial clean-DB `bun run test` before migration failed because `agent_events` did not exist; reran after migration as required.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54338/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:migrate`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54338/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test`: passed, 8 files / 31 tests.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54338/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run db:health`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54338/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run build`: passed.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54338/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3021 bun run test:e2e`: passed, 17 passed / 1 skipped. The skipped case is the duplicate mobile run of the exact-name `Research Agent` smoke path; desktop covers the exact-name create/refresh/detail flow and both projects keep not-found coverage.
- `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54338/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 PORT=3022 bun run verify`: passed, including 8 files / 31 unit tests and 17 passed / 1 skipped E2E tests.
- E2E cleanup inspection for `Research Agent`, `Soft Deleted Agent chromium-desktop`, and `Soft Deleted Agent chromium-mobile`: passed with zero remaining matching rows in `agents`.
- Tracking-doc freshness check: `PROGRESS.md` records issue #19 merged, issue #20 current status, validation evidence, next checker handoff, changelog freshness, and `git diff --check` evidence.
- `git diff --check origin/main..HEAD`: passed.

## Next Step

Issue #20 is implemented and builder-validated. Hand off to checker-agent for independent gate rerun and review-readiness checks.

## Update Log

- 2026-07-03: Recorded initial issue #15 implementation commit `f526b0f518f41ddd5a55d5a6d2d493832a16b99c`; prior review-fix commit `e120753cc20bc2b7dcfe71a4183eee4751e216e9` updated the next step after checker validation.
- 2026-07-03: Restored the progress tracker as a Milestone 1-only baseline for issue #15 and kept changelog updates reserved for future functional changes.
- 2026-07-03: Implemented issue #16 schema-only persistence foundation and validated the generated migration against isolated local Postgres on port `54330`.
- 2026-07-03: Implemented issue #17 transactional create-agent API and validated it against isolated local Postgres on port `54333`.
- 2026-07-03: Implemented issue #18 database-backed `/agents` create/list workflow and validated it against isolated local Postgres on port `54335`.
- 2026-07-03: Implemented issue #19 database-backed dashboard/detail read surfaces and validated them against isolated local Postgres on port `54336`.
- 2026-07-03: Implemented issue #20 final Milestone 1 E2E/docs validation and validated it against isolated local Postgres on port `54338`.
