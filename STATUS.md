# Agent Team Status

Cold history: [`STATUS.archive.md`](STATUS.archive.md)

## Active Work

- issue: [#264](https://github.com/ametel01/plingpling/issues/264)
  owner: builder-agent (`issue_264_builder`)
  branch: `codex/issue-264-durable-wakeups`
  worktree: `/Users/alexmetelli/source/plingpling`
  pr: none
  phase: checker-ready
  cycle: 0/5
- issue: [#265](https://github.com/ametel01/plingpling/issues/265)
  owner: builder-agent (`issue_265_builder`)
  branch: `codex/issue-265-runner-sizing`
  worktree: `/Users/alexmetelli/source/plingpling-issue-265`
  pr: none
  phase: implementing authorization-independent scope
  cycle: 0/5
- issue: [#266](https://github.com/ametel01/plingpling/issues/266)
  owner: builder-agent (`issue_266_builder`)
  branch: `codex/issue-266-attested-snapshot`
  worktree: `/Users/alexmetelli/source/plingpling-issue-266`
  pr: none
  phase: implementing repository-only scope
  cycle: 0/5

## Goal Contract

- outcome: Execute `PLAN.md` through its Definition of Done, including 30 explicitly authorized
  clean cold DigitalOcean trials with at least 95% success and p95 committed-create-to-durable-ready
  latency at or below 60 seconds.
- current result: Step 1 evidence is merged. The latest zero-cloud cold simulation was 88.760
  seconds, so the SLO is not yet met.
- non-goals: No Droplets before a create request; no warm pools, ready capacity, onboarding or
  predictive provisioning, cross-user sharing, or SLO expansion beyond durable `ready`.
- authorization boundary: Do not spend provider resources, build provider snapshots, configure
  production secrets, deploy, or release without explicit authorization.
- do-not-touch: Preserve `/Users/alexmetelli/source/plingpling-step7-base`, unrelated PR #262, and
  existing changelog history.

## Dependency Graph

- completed: #263 / PR #272
- ready Wave 1: #264 durable wakeups; #265 runner sizing; #266 attested snapshot implementation
- blocked by #264: #267, #268
- blocked by #266: #269
- blocked by #265: #270
- blocked by #264-#270: #271 provider-backed SLO proof

## Next Assignment Contract

- #264, #265, and #266 are parallel-safe only in separate branches/worktrees with one owner each.
- Every checker must exercise a real producer-sequence-to-consumer semantic path, not only isolated
  consumer fixtures.
- Any stream touching provider/benchmark arguments must probe malformed counts and fail-closed
  provider mode.
- #266 may implement repository scripts/workflow and local tests, but actual DigitalOcean snapshot
  creation is authorization-gated.

## Completion Contract — #264

- readiness: `ready`. Required upstream issue #263 is closed by merged PR #272 at `7d1cb98`; #264
  has no comments, linked PR, unresolved review thread, or agent-actionable dependency blocker.
- outcome: Persist a generation-fenced PostgreSQL deployment wakeup in the same transaction as each
  due-time or terminal deployment mutation, publish due work through a signed delayed-QStash
  adapter, and retain the minute deployment cron as the authoritative recovery boundary.
- acceptance criteria:
  - Add a Drizzle migration/schema model for bounded wakeup/outbox state: deployment identity,
    generation, due time, state, publish attempt count, provider message ID, publish lease,
    allowlisted safe error code, and timestamps, with uniqueness, integrity, and due-work indexes.
  - All repo-local deployment writers that create, retry, reschedule, supersede, cancel, or
    terminalize work update the deployment and its authoritative wakeup generation atomically.
    A failed transaction exposes neither half; terminal or replacement work fences old deliveries.
  - Add a narrow dispatch interface with `cron` and `qstash` modes. PostgreSQL remains authoritative;
    post-commit `after()` publication is opportunistic, and an expired/unpublished row can be
    reclaimed and published by the protected cron sweep.
  - A fake delayed adapter demonstrates a persisted two-second retry being delivered near its due
    time without a minute tick. It must not publish before the persisted due time.
  - The QStash POST route bounds raw body size, verifies the unmodified body with the current/next
    signing-key rotation pair before JSON parsing, rejects malformed or unsigned input, and accepts
    only a bounded payload containing deployment ID plus generation/due-time fencing data.
  - Duplicate, stale, reordered, early, and retried deliveries cannot claim more than one action for
    a generation. Delivery only invokes targeted reconciliation after the wakeup and deployment
    fences are atomically claimed; the existing deployment lease remains the final execution fence.
  - Lost post-response publish, publish rejection, expired publish lease, and queue delivery loss
    are recoverable through the outbox sweep and existing deployment cron without losing due work.
  - `AGENTBAY_DEPLOYMENT_DISPATCH_MODE=cron|qstash`, `QSTASH_TOKEN`,
    `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY` are validated and documented.
    `qstash` fails closed unless complete; `cron` performs no external queue publication and can be
    selected without schema rollback or invalidating active deployments/wakeups.
  - Logs, rows exposed to logs, payloads, and safe errors contain no token, signing key, cron secret,
    user ID, runner endpoint, provider credential, raw provider response, or arbitrary exception.
- non-goals:
  - Do not implement the provider-phase drain (#267), post-registration stage drain (#268), runner
    sizing (#265), snapshots (#266), same-user capacity reuse, or the final provider benchmark.
  - Do not create or pre-provision a Droplet, add warm/ready capacity, run a real QStash publish,
    deploy, release, configure hosted secrets, or execute any provider/billable effect.
  - Do not remove the deployment cron, reuse `CRON_SECRET` as queue authority, change the SLO
    boundary, weaken deployment/provider idempotency, or make queue delivery authoritative.
- likely touchpoints:
  - `src/server/db/schema.ts`, a generated `drizzle/0026_*.sql` plus metadata, and deployment migration
    fixtures.
  - New `src/server/agents/agent-deployment-dispatch.ts` and a signed internal App Router POST route;
    the existing deployment cron route should sweep outbox work and retain global reconciliation.
  - `src/server/agents/agent-deployment-reconciler.ts`, `agent-deployments.ts`,
    `agent-deployment-retry.ts`, `agent-deployment-triggers.ts`, and cancellation in `lifecycle.ts`.
  - `src/server/env.ts`, `.env.example`, README/operator validation docs, `package.json`/`bun.lock`
    if the official QStash verifier/client is added, `PROGRESS.md`, and `CHANGELOG.md`.
  - Focused dispatch, signature-route, env, trigger, reconciler, retry, cancellation, migration, and
    local-smoke tests; preserve existing public API response shapes.
- required tests / gates:
  - Add DB race/failure fixtures for atomic creation/reschedule/terminal fencing, generation rollover,
    duplicate claims, stale generations, lease expiry, retry bounds, and cron recovery.
  - Add real-signature fixtures for both signing keys plus invalid signature, oversized body,
    malformed payload, replay, early delivery, and secret-redaction cases.
  - Add one integrated producer-to-consumer semantic test: committed deployment mutation -> durable
    wakeup -> dropped `after()` publish -> cron reclaim -> fake delayed publish -> signed delivery ->
    one targeted reconciliation under duplicate/reordered delivery.
  - Run focused new tests and existing deployment cron/trigger/reconciler/retry/cancellation/finalization
    tests, migration fixtures, `git diff --check`, `bun run verify`, and `bun run test:e2e:ci`.
  - Run `bun run local:agent:smoke` in default `cron` mode and through a fake delayed adapter; assert
    zero DigitalOcean requests and no real QStash/provider effect.
- risks:
  - Missing one of four deployment-mutator modules can orphan or resurrect work; use one transaction
    helper and audit every `next_attempt_at`/terminal write.
  - Publishing before commit, acknowledging the wrong generation, clock skew, or unsafe lease expiry
    can drop work or duplicate actions. Keep generation and lease predicates in every state change.
  - Signature verification must use exact raw bytes and a canonical configured callback origin;
    never accept a payload-provided URL or log verifier/provider errors verbatim.
  - Migration lock ordering must match deployment-row then wakeup-row ownership to avoid deadlocks;
    retry/terminal mode changes must remain safe for rows created under either dispatch mode.
- do-not-touch: Provider provisioning/effect checkpoints, runner registration/heartbeat drains,
  size/snapshot defaults and workflows, model canary behavior, unrelated PR #262, existing changelog
  history, and `/Users/alexmetelli/source/plingpling-step7-base`.
- dependency blockers: none. #263/#272 are merged. PR #272's Vercel failure is the documented
  fail-closed Clerk-preview baseline; if it recurs, compare with main and do not classify it as a
  #264 regression without evidence. #267 and #268 consume this contract and remain downstream.
- open questions: none blocking; route/table naming and cron-sweep composition are internal choices.

## Handoff — #264 Spec to Builder

- request: Implement only the contract above on `codex/issue-264-durable-wakeups`, beginning with
  schema/migration invariants and one atomic scheduling helper, then wire fake dispatch and signed
  delivery without external effects.
- evidence: Issue #264 and PLAN Step 2 agree on QStash configuration and at-least-once semantics;
  issue #263/PR #272 provide merged timing evidence; current mutators are confined to reconciler,
  deployment persistence/retry, and lifecycle cancellation modules.
- stop condition: Hand off after focused producer-to-consumer evidence and repository gates are
  recorded, or earlier on a repeated failure, credentials/external-effect requirement, or a needed
  product decision.

## Handoff — #264 Builder to Checker

- request: Check issue #264 implementation on `codex/issue-264-durable-wakeups`; verify the
  migration/schema, atomic wakeup writes, signed delivery route, cron recovery sweep, env/docs, and
  tests. Do not edit code.
- files changed: `.env.example`, `CHANGELOG.md`, `PROGRESS.md`, `app/api/internal/agent-deployments/reconcile/route.ts`,
  `app/api/internal/agent-deployments/wakeup/route.ts`, `drizzle/0026_talented_lady_vermin.sql`,
  `drizzle/meta/_journal.json`, `drizzle/meta/0026_snapshot.json`,
  `src/server/agents/agent-deployment-dispatch.ts`, `src/server/agents/agent-deployment-reconciler.ts`,
  `src/server/agents/agent-deployment-retry.ts`, `src/server/agents/agent-deployment-triggers.ts`,
  `src/server/agents/agent-deployments.ts`, `src/server/agents/lifecycle.ts`,
  `src/server/db/schema.ts`, `src/server/env.ts`, and focused unit tests.
- behavior: deployment create/retry/release/stage/backoff/ready/failed/cancel/replacement-pause
  paths now create or terminalize generation-fenced wakeup rows in the same DB transaction. The
  post-response trigger publishes the latest pending wakeup in QStash mode and falls back to the
  existing targeted reconciler in cron/unavailable mode. The protected cron route sweeps one
  publishable outbox row before the existing one-item reconcile. The new POST route verifies a
  bounded raw body with current/next signing keys before JSON parsing, atomically claims one due
  generation, then invokes targeted reconciliation; duplicate/early/stale/terminal deliveries do
  not execute work.
- tests passed: `bun run format:check`; `bun run lint`; `bun run typecheck`;
  `bun scripts/run-unit-tests.ts tests/unit/agent-deployment-wakeup-route.test.ts tests/unit/agent-deployment-triggers.test.ts tests/unit/server-env.test.ts tests/unit/agent-deployments-db.test.ts tests/unit/agent-deployment-cron-route.test.ts tests/unit/agent-deployment-migration-fixtures.test.ts`
  (6 files, 43 tests); `bun run test` (170 files, 1,645 tests); `bun run build`;
  `bun run test:e2e:ci` (26/26); `bun run local:agent:smoke` (`cleanupVerified:true`,
  `digitalOceanRequests:0`, p95 150.725s); `git diff --check`.
- known risks: signature verification uses a dedicated HMAC header over the raw body rather than
  importing an official QStash verifier package; checker should decide whether that satisfies the
  contract or should be changed before PR. The real external QStash publish path is implemented but
  unexercised; no real publish/provider/secret/deployment/billable action was run.
- stop condition: accept for PR only after checker independently exercises a producer-to-delivery
  semantic path and either runs or explicitly classifies the pending heavier gates.

## Gates

- #263 checker result: ALL GREEN at implementation `49c872a`.
- focused: 10 files / 95 tests passed.
- full: `bun run verify` passed with 169 unit files / 1,638 tests and production build.
- E2E: 26/26 passed.
- zero-cloud smoke: valid 15-stage record, `issueCounts:{}`, `digitalOceanRequests:0`,
  `cleanupVerified:true`, and p95 88.760 seconds.
- provider mode: failed closed; no billable provider action ran.
- remote: CodeRabbit, GitGuardian, and Socket passed. Vercel failed at the same fail-closed Clerk
  preview baseline as unrelated PR #262 and was accepted as non-blocking.
- #264 builder: format, lint, typecheck, focused unit, full unit, build, E2E, local zero-cloud
  smoke, and diff-check passed locally. Local smoke p95 was 150.725s, so the overall SLO remains
  unmet pending later steps.
- merge request check (2026-08-07):
  - result: BLOCKED; no fast-agent-creation PR is open or merge-ready.
  - `git status --short --branch --untracked-files=all`: current worktree is
    `codex/issue-264-durable-wakeups` with uncommitted #264 implementation changes.
  - `gh pr list --head codex/issue-264-durable-wakeups --state open --json ...`: `[]`.
  - `gh pr list --head codex/issue-265-runner-sizing --state open --json ...`: `[]`.
  - `gh pr list --head codex/issue-266-attested-snapshot --state open --json ...`: `[]`.
  - `gh pr list --state open --limit 10 --json ...`: only open PR is unrelated
    [#262](https://github.com/ametel01/plingpling/pull/262) on
    `docs/ai-integration-opportunities`, `mergeStateStatus: UNSTABLE`, with Vercel `FAILURE`.
  - next action: wait for checker verdicts, then commit/push/open the relevant issue PR before any
    merge. Do not merge #262 as part of this goal.

## Review Threads

- none. Reviews #4878363214 and #4878490254 were fixed and accepted by review #4878725523.

## Decisions And Lessons

- 2026-08-07:
  signal: The one-minute target cannot rely on capacity created before the user request.
  rule: Optimize cold on-demand dispatch, orchestration, size, images, readiness, and same-user reuse.
- 2026-08-07:
  signal: Consumer-only timing fixtures missed duplicate and synthetic producer evidence.
  rule: Require an integrated producer-sequence-to-report semantic fixture before checker acceptance.
- 2026-08-07:
  signal: Provider trials and snapshot builds can incur cost and touch external infrastructure.
  rule: Stop for explicit authorization before any billable provider execution.
- 2026-08-07:
  signal: Hot status exceeded 1,000 lines after three review cycles.
  rule: Archive completed contracts, logs, and review transcripts after each merge.

## Worktrees

- `/Users/alexmetelli/source/plingpling`: issue #264 branch; builder-owned, checker-ready.
- `/Users/alexmetelli/source/plingpling-issue-265`: issue #265 branch; spec-owned.
- `/Users/alexmetelli/source/plingpling-issue-266`: issue #266 branch; spec-owned.
- `/Users/alexmetelli/source/plingpling-step7-base`: pre-existing detached user-owned worktree;
  preserve and do not modify.

## Completed

- issue [#263](https://github.com/ametel01/plingpling/issues/263), PR
  [#272](https://github.com/ametel01/plingpling/pull/272), merge
  `7d1cb985c06b0007dadcfb0e42c5631c65b7c472`; maker/checker/reviewer accepted.
- retrospective archived; status compaction performed immediately, so no separate process issue is
  needed.
