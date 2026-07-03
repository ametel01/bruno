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
- [ ] Step 2 / issue #17: Create agents transactionally through the API.
- [ ] Step 3 / issue #18: Add database-backed agent create and list page.
- [ ] Step 4 / issue #19: Show persisted agents on dashboard and detail pages.
- [ ] Step 5 / issue #20: Cover the Milestone 1 agent flow with E2E tests and docs.

## Current Status

- Step 0 / issue #15 was completed by PR #27 and merged as `5550b152275ad0c8986fae57add5992e4f49e632`.
- Step 1 / issue #16 is implemented on branch `fix/issue-16-agent-persistence-schema` and ready for independent checker validation.
- Step 2 / issue #17 is the next Milestone 1 slice after issue #16 checker and maintainer review.
- Steps 3 through 5 remain blocked by the preceding Milestone 1 slices.
- Issue #16 adds schema and migration support only. It does not add create-agent API behavior, UI behavior, dashboard database reads, lifecycle controls, runtime behavior, seed data, auth, billing, Hermes, Telegram, logs, approvals, or runner behavior.

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
- Commit reference: pending until this issue #16 branch is committed; avoid recording the current head hash inside the same commit.
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

## Next Step

Hand issue #16 to checker-agent for independent validation. After issue #16 is checked, reviewed, and merged, begin Step 2 / issue #17 to create agents transactionally through the API.

## Update Log

- 2026-07-03: Recorded initial issue #15 implementation commit `f526b0f518f41ddd5a55d5a6d2d493832a16b99c`; prior review-fix commit `e120753cc20bc2b7dcfe71a4183eee4751e216e9` updated the next step after checker validation.
- 2026-07-03: Restored the progress tracker as a Milestone 1-only baseline for issue #15 and kept changelog updates reserved for future functional changes.
- 2026-07-03: Implemented issue #16 schema-only persistence foundation and validated the generated migration against isolated local Postgres on port `54330`.
