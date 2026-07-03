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
- [ ] Step 1 / issue #16: Add Milestone 1 agent persistence schema.
- [ ] Step 2 / issue #17: Create agents transactionally through the API.
- [ ] Step 3 / issue #18: Add database-backed agent create and list page.
- [ ] Step 4 / issue #19: Show persisted agents on dashboard and detail pages.
- [ ] Step 5 / issue #20: Cover the Milestone 1 agent flow with E2E tests and docs.

## Current Status

- Step 0 / issue #15 is checked and review-fix-ready for PR #27.
- Step 1 / issue #16 is blocked until issue #15 is merged.
- Steps 2 through 5 are blocked by the preceding Milestone 1 slices.
- No Milestone 1 product behavior, schema, API, UI implementation, forms, dashboard database reads, lifecycle controls, or tests have been added by issue #15.

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

## Next Step

Issue #15 is checked and review-fix-ready in PR #27. Begin Step 1 / issue #16 only after issue #15 merges.

## Update Log

- 2026-07-03: Recorded initial issue #15 implementation commit `f526b0f518f41ddd5a55d5a6d2d493832a16b99c`; prior review-fix commit `e120753cc20bc2b7dcfe71a4183eee4751e216e9` updated the next step after checker validation.
- 2026-07-03: Restored the progress tracker as a Milestone 1-only baseline for issue #15 and kept changelog updates reserved for future functional changes.
