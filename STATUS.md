# Agent Team Status

## Active Work

- plan: `PLAN.md` Step 5 — Build the Hermes Managed Launch Spec and Safe Config Projection
  owner: builder-step-5
  branch: `main`
  worktree: `/Users/alexmetelli/source/plingpling`
  phase: validated; pending commit
  cycle: 1/5
  contract: `STATUS.archive.md` → `Step 5 Completion Contract (pre-spec)`
  blocker: none; Step 4 is committed and independently accepted at `546b9df`.
  next-action: Builder commits the prescribed Step 5 change; checker independently verifies Step 5 before Step 6 starts.

## Completion Contract

- outcome: Build versioned managed Hermes launch spec v3 and atomically project the complete approved OpenRouter, Telegram, allowlist, private API, prompt, workspace, and revision configuration without leaking credentials or regressing v2/native/manual agents.
- acceptance criteria: Exact v3 DTO and revision source, pinned strict YAML 1.2 parser, decrypted server-only secret sourcing, no-follow/path-escape defenses, marker-last atomic projection, file modes/ownership, fresh-managed setup bypass, restored/native compatibility, and secret-free serialization are in the archived Step 5 contract.
- non-goals: No asynchronous launch-acceptance split, deployment reconciler, progress UI, restart policy, live Telegram reply, infrastructure provisioning, hosted-secret mutation, image publication, or Step 6+ behavior.
- required gates: focused launch-spec/parser/projection/path/permission/backup/setup tests; pinned-image semantic and local smoke evidence; full format/lint/typecheck/test/build/E2E, fail-closed staging gate, and diff check.
- risks: YAML parser ambiguity, prototype/tag/alias attacks, symlink/path escape, partial projection, unsafe file modes/ownership, secret serialization, revision drift, and setup bypass regressions.
- do-not-touch: Accepted Step 0–3 behavior; runner/readiness; UI; external resources; prior changelog/progress entries.

## Dependency Graph

- Step 0 → Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6 → Step 7 → Step 8 → Step 9 → Step 10.
- Steps 6–10 pre-specs are complete in `STATUS.archive.md`; Step 6 remains blocked until Step 5 commits and independently checks.

## Current Handoff

- from: coordinator
  to: builder-step-5
  timestamp: 2026-08-03
  request: Implement the archived Step 5 contract only; add strict launch spec v3 and safe managed config projection, validate locally, update changelog/progress, and commit the prescribed change.
  evidence: Step 4 implementation `d942270` plus repair `546b9df`; checker cycle 2 independently green at 12 files / 111 focused tests, 107 files / 939 full tests, build, 14 E2E, migrations, and fail-closed staging.
  stop-condition: Stop before Step 6 async launch acceptance/reconciler behavior or any real provider/Telegram/infrastructure effect.

## Gates

- Step 0 `807e401`: independently green — 98 files / 863 tests, build, 14 E2E.
- Step 1 `23a1817`: checker cycle 2 green after exact GHCR boundary fix — 99 files / 870 tests, build, 14 E2E; fail-closed staging command exits nonzero with no effects.
- Step 2 `897e28f`: independently green — focused 6 files / 43 tests, pinned-image contract smoke, 99 files / 879 tests, build, 14 E2E.
- Step 3 `7024bc2`: independently green — focused 7 files / 72 tests, clean/upgrade loopback migration fixtures, 103 files / 905 tests, build, 14 E2E; evidence recorded in `ba8c969`.
- Step 4 `546b9df`: independently green after cycle 2 — focused 12 files / 111 tests, migrations, 107 files / 939 tests, build, 14 E2E, and fail-closed staging with no effects.
- Step 5 this commit: builder green — focused 4 files / 38 tests plus broader 12 files / 46 tests, local Hermes contract smoke with fake model and fake Telegram boundary, 107 files / 947 tests, build, 14 E2E, and fail-closed staging with no effects.

## Worktrees

- `/Users/alexmetelli/source/plingpling` — branch `main`; sole active worktree; Step 5 validated pending commit; no stashes. Archived Steps 5–9 contracts are committed through `368c4da`; the Step 10 pre-spec is append-only and out of the builder's scope.

## Decisions And Lessons

- 2026-08-03: Automatic-ready uses the PLAN-approved opt-in OpenRouter BYOK path; native Hermes OAuth/setup remains advanced/recovery compatibility.
- 2026-08-03: Live or billable work remains prohibited until Step 10 prerequisites and explicit authorization are present.
- 2026-08-03: Telegram token uniqueness requires a stable server-only digest; preserve the existing encryption-version-dependent fingerprint only for compatibility.
- 2026-08-03: Keep `STATUS.md` under 200 lines. Full contracts, checker logs, historical handoffs, and completed evidence live in `STATUS.archive.md`.

## Completed

- Step 0 — `807e401` — progress/changelog tracking initialized.
- Step 1 — `23a1817` — fail-closed Hermes staging gate and baseline evidence.
- Step 2 — `897e28f` — pinned Hermes readiness contract and failed-launch cleanup.
- Step 3 — `7024bc2` — desired state, durable deployment operations, leases, migration, and concealed read API; checker evidence `ba8c969`.
- Step 4 — `d942270` + `546b9df` — ready-mode encrypted creation, bounded Telegram validation, active-bot uniqueness/backfill, atomic deployment persistence, and independently accepted security/concurrency gates.
- Step 5 this commit — managed Hermes launch-spec v3, owner-scoped secret launch building, strict YAML/env projection, v2/manual compatibility, and fake-provider/Telegram local smoke coverage.
