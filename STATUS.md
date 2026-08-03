# Agent Team Status

## Active Work

- plan: `PLAN.md` Step 9 — Make Desired-Running Gateways Durable
  owner: coordinator with staged Step 9 builder streams
  branch: `main`
  worktree: `/Users/alexmetelli/source/plingpling`
  phase: Step 8 independently accepted; Step 9 persistence and runner-boundary implementation ready to start
  cycle: builder 1/5
  contract: `STATUS.archive.md` → `Step 9 Completion Contract (pre-spec)`
  blocker: no Step 9 repository blocker; external/live capabilities remain prohibited and unnecessary.
  next-action: Build the additive runtime ledger/state machine and strict runner durability evidence in parallel, then integrate lifecycle/triggers/presentation/smokes.

## Completion Contract

- outcome: Keep managed-v3 latest-ready desired-running agents converged to one exact ready Hermes workload across runner/Docker restarts while explicit Stop remains authoritative.
- acceptance criteria: Separate durable runtime ledger; exact `unless-stopped` policy/restart evidence; one-effect leased reconciliation; DB-first lifecycle intent; bounded recovery/circuit and Telegram diagnostics; exact usage segmentation; safe runtime UI; local reboot smokes.
- non-goals: No terminal deployment reopening, repeated canary, automatic provisioning/reassignment, HA/replicas, browser reconciliation, webhook deletion/getUpdates/send, token rotation, or Step 10 live/provider work.
- required gates: generated migration plus clean/upgrade fixtures; focused concurrency/runner/runtime/lifecycle/Telegram/usage/UI/redaction tests; both local smokes; full format/lint/typecheck/test/build/CI E2E; fail-closed staging; diff check.
- risks: stale work resurrecting stopped agents, wrong-policy reuse, restart loops, Telegram polling conflicts, usage overlap/backdating, runtime evidence leakage, and adapter rolling mismatch.
- do-not-touch: Accepted Step 4–8 create/encryption/projection/launch/deployment/UI contracts; immutable terminal deployments; manual/native compatibility; infrastructure runner `--restart always`; Step 10 external resources.

## Dependency Graph

- Step 0 → Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6 → Step 7 → Step 8 → Step 9 → Step 10.
- Step 9 is unblocked by independently accepted Steps 4–8; Step 10 remains blocked on Step 9 plus explicit external prerequisites.

## Current Handoff

- from: Step 8 checker cycle 2
  to: Step 9 persistence/controller and runner-boundary builders
  timestamp: 2026-08-03
  request: Implement the Step 9 foundations without weakening immutable deployment, desired-state, runner, Telegram, usage, or UI authority boundaries.
  evidence: Step 8 checker cycle 2 accepted `ef9b7fc` + `bc38dd0`: 4 focused files / 66 tests, 123 files / 1,144 full tests, migration, format, lint, typecheck, build, 24 CI E2E, and fail-closed staging.
  stop-condition: Return with migration/state and runner-contract focused gates green; no lifecycle integration before durable helpers exist, no external request, no tracker/changelog edit, and no commit.

## Gates

- Step 0 `807e401`: independently green — 98 files / 863 tests, build, 14 E2E.
- Step 1 `23a1817`: checker cycle 2 green after exact GHCR boundary fix — 99 files / 870 tests, build, 14 E2E; fail-closed staging command exits nonzero with no effects.
- Step 2 `897e28f`: independently green — focused 6 files / 43 tests, pinned-image contract smoke, 99 files / 879 tests, build, 14 E2E.
- Step 3 `7024bc2`: independently green — focused 7 files / 72 tests, clean/upgrade loopback migration fixtures, 103 files / 905 tests, build, 14 E2E; evidence recorded in `ba8c969`.
- Step 4 `546b9df`: independently green after cycle 2 — focused 12 files / 111 tests, migrations, 107 files / 939 tests, build, 14 E2E, and fail-closed staging with no effects.
- Step 5 `fe13ab9`: builder green but checker cycle 1 found YAML/env/filesystem/Docker inspect gaps.
- Step 5 `d50cc4e`: cycle 2 builder green but checker cycle 2 found safe YAML punctuation and filesystem matrix gaps.
- Step 5 `4f8312d`: independently green after cycle 3 — 17 files / 102 focused tests, local Hermes contract smoke with fake model and fake Telegram boundary, 107 files / 961 tests, build, 14 E2E, and fail-closed staging with no effects.
- Step 6 `4e2897a` + `fa677fb`: independently green after cycle 2 — credential-file matrix, focused 4 files / 77 tests, local fake-boundary smoke, 108 files / 996 tests, build, 14 E2E, and fail-closed staging with no effects.
- Step 7 `798cbf3`: independently green after checker cycle 1 — `db:generate` no drift, `db:migrate` twice, focused changed-unit 21 files / 306 tests, full 116 files / 1,065 tests, local duplicate-trigger cloud smoke through ready, real local Hermes controller smoke, build, 14 CI E2E, and fail-closed staging with no effects.
- Step 8 candidate: builder/coordinator gates green — focused create/poll/presentation 34 tests, lifecycle/routes 31, server/UI 107, responsive/accessibility 22, full 123 files / 1,142 tests, production build, 24/24 fake-only desktop/mobile CI E2E with exact 320px layout, redaction, and zero external requests, plus fail-closed staging with `sideEffectsAttempted: false`; independent checker pending.
- Step 8 `ef9b7fc`: checker cycle 1 reproduced every automated gate but found one semantic Retry latch race in the progress card. The cycle 2 repair adds a pre-UUID/pre-fetch synchronous latch plus same-turn regression; 44 focused tests, 123 files / 1,144 full tests, build, 24/24 CI E2E, and fail-closed staging are green.
- Step 8 `ef9b7fc` + `bc38dd0`: independently green after checker cycle 2 — 4 focused files / 66 tests, 123 files / 1,144 full tests, migration, build, 24/24 desktop/mobile CI E2E, and fail-closed staging with no side effects.

## Worktrees

- `/Users/alexmetelli/source/plingpling` — branch `main`; shared Step 9 implementation tree; `STATUS.md` is coordinator-owned; external actions remain prohibited.

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
- Step 5 — `fe13ab9` + `d50cc4e` + `4f8312d` — independently accepted managed launch-spec v3, owner-scoped secret launch building, hardened strict YAML/env/filesystem projection, v2/manual compatibility, and fake-provider/Telegram local smoke coverage.
- Step 6 — `4e2897a` + `fa677fb` — independently accepted asynchronous runner launch/status/canary behavior, cancellation, lifecycle evidence, and nonblocking credential reads.
- Step 7 — `798cbf3` — independently accepted durable automatic create-to-ready reconciliation, safe retry/cron/triggers, provider idempotency, one canary, final ready/usage boundary, and local-only smoke coverage.
- Step 8 — `ef9b7fc` + `bc38dd0` — independently accepted credential-complete one-click ready creation, persisted progress, safe lifecycle/read projections, fake-only desktop/mobile acceptance, and synchronous retry latching.
