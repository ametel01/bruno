# Agent Team Status

## Active Work

- plan: `PLAN.md` Step 6 — Split Runner Launch Acceptance From Observed Readiness
  owner: coordinator
  branch: `main`
  worktree: `/Users/alexmetelli/source/plingpling`
  phase: cycle-2 FIFO repair validated; committing for independent recheck
  cycle: 2/5
  contract: `STATUS.archive.md` → `Step 6 Completion Contract (pre-spec)`
  blocker: none in implementation; independent checker cycle 2 is required.
  next-action: Commit the FIFO repair separately, then recheck exact HEAD before Step 7.

## Completion Contract

- outcome: Make runner start/restart return bounded HTTP 202 launch acceptance without readiness polling, converge retries to exactly one selected container, and expose a truthful redacted status snapshot for later reconciliation.
- acceptance criteria: Exact launch/status v2 DTOs, operation labels, one 30-second acceptance budget, per-agent serialization, deterministic reuse/replacement, one-shot authenticated private readiness observation, canary caching, safe cancellation, and no premature control-plane `running` transition are in the archived Step 6 contract.
- non-goals: No deployment reconciler or leases, create-progress UI, restart policy/reboot recovery, live Telegram reply, infrastructure provisioning, hosted-secret mutation, image publication, or Step 7+ behavior.
- required gates: focused runner/Docker/status/probe/canary/manual-adapter/lifecycle/auth/redaction tests; local contract smoke; full format/lint/typecheck/test/build/E2E, fail-closed staging, and diff check.
- risks: duplicate containers, unbounded Vercel waits, stale reuse, cross-agent mutation, unsafe status leakage, canary replay/cost, stop/start races, and false `running` transitions.
- do-not-touch: Accepted Step 0–5 semantics; deployment reconciler/UI/restart policy; external resources; prior changelog/progress entries.

## Dependency Graph

- Step 0 → Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6 → Step 7 → Step 8 → Step 9 → Step 10.
- Steps 6–10 pre-specs are complete in `STATUS.archive.md`; Step 6 is unblocked by independently accepted Step 5.

## Current Handoff

- from: step6-runtime-repair
  to: coordinator
  timestamp: 2026-08-03
  request: Integrate and commit the nonblocking no-follow FIFO repair, then hand exact HEAD to checker cycle 2.
  evidence: Pre/post file identity validation and nonblocking open added; FIFO status/canary remain under one second with safe typed outcomes, zero probe calls, repeated bounded status, and regular-file recovery; focused Step 5/6 tests passed 4 files / 61 tests; full tests passed 108 files / 996 tests; local smoke, build, 14 E2E tests, lint, typecheck, fail-closed staging, and diff-check passed.
  stop-condition: Stop before Step 7 reconciliation/database-stage progression or any real provider/Telegram/infrastructure effect.

## Gates

- Step 0 `807e401`: independently green — 98 files / 863 tests, build, 14 E2E.
- Step 1 `23a1817`: checker cycle 2 green after exact GHCR boundary fix — 99 files / 870 tests, build, 14 E2E; fail-closed staging command exits nonzero with no effects.
- Step 2 `897e28f`: independently green — focused 6 files / 43 tests, pinned-image contract smoke, 99 files / 879 tests, build, 14 E2E.
- Step 3 `7024bc2`: independently green — focused 7 files / 72 tests, clean/upgrade loopback migration fixtures, 103 files / 905 tests, build, 14 E2E; evidence recorded in `ba8c969`.
- Step 4 `546b9df`: independently green after cycle 2 — focused 12 files / 111 tests, migrations, 107 files / 939 tests, build, 14 E2E, and fail-closed staging with no effects.
- Step 5 `fe13ab9`: builder green but checker cycle 1 found YAML/env/filesystem/Docker inspect gaps.
- Step 5 `d50cc4e`: cycle 2 builder green but checker cycle 2 found safe YAML punctuation and filesystem matrix gaps.
- Step 5 `4f8312d`: independently green after cycle 3 — 17 files / 102 focused tests, local Hermes contract smoke with fake model and fake Telegram boundary, 107 files / 961 tests, build, 14 E2E, and fail-closed staging with no effects.
- Step 6 `4e2897a` plus pending cycle-2 repair: FIFO `.env` credential reads are now nonblocking and identity-checked; focused 4 files / 61 tests pass, with checker revalidation pending.

## Worktrees

- `/Users/alexmetelli/source/plingpling` — branch `main`; sole active worktree; Step 6 validated and pending checker review after commit; no stashes. Archived Steps 7–10 contracts are committed and external actions remain prohibited.

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
- Step 6 — `4e2897a` plus pending cycle-2 repair commit — asynchronous runner launch/status/canary behavior and FIFO credential-read hardening are implemented; checker cycle 2 remains.
