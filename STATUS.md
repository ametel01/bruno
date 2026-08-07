# Agent Team Status

Cold history: [`STATUS.archive.md`](STATUS.archive.md)

## Active Work

- issue: [#264](https://github.com/ametel01/plingpling/issues/264)
  owner: checker-agent (`issue_264_checker`)
  branch: `codex/issue-264-durable-wakeups`
  worktree: `/Users/alexmetelli/source/plingpling`
  pr: none
  phase: failed serialized local smoke
  cycle: 1/5
- issue: [#265](https://github.com/ametel01/plingpling/issues/265)
  owner: checker-agent (`issue_265_checker`)
  branch: `codex/issue-265-runner-sizing`
  worktree: `/Users/alexmetelli/source/plingpling-issue-265`
  pr: none
  phase: checking authorization-independent scope
  cycle: 0/5
- issue: [#266](https://github.com/ametel01/plingpling/issues/266)
  owner: checker-agent (`issue_266_checker`)
  branch: `codex/issue-266-attested-snapshot`
  worktree: `/Users/alexmetelli/source/plingpling-issue-266`
  pr: none
  phase: checking repository-only scope
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

## Checker Result — #264 Initial

Status: FAILED

## Commands

- command: `git status --short --branch --untracked-files=all`
  result: branch `codex/issue-264-durable-wakeups`, `M STATUS.md`
  evidence: HEAD `ebd3773 Add durable deployment wakeups`; checker only updated `STATUS.md`.
- command: `gh issue view 264 --repo ametel01/plingpling --json title,state,body,labels,assignees,comments,url`
  result: PASS
  evidence: issue #264 is open and requires signed delayed QStash delivery plus durable recovery.
- command: `gh pr list --repo ametel01/plingpling --state open --head codex/issue-264-durable-wakeups --json number,title,url,headRefName,baseRefName,mergeStateStatus,isDraft,reviewDecision,statusCheckRollup,closingIssuesReferences`
  result: PASS
  evidence: `[]`; no #264 PR exists yet, so there is nothing merge-ready.
- command: Upstash primary docs review (`https://upstash.com/docs/qstash/howto/signature`,
  `https://upstash.com/docs/qstash/sdks/ts/examples/receiver`,
  `https://upstash.com/docs/qstash/quickstarts/vercel-nextjs`,
  `https://upstash.com/docs/qstash/howto/roll-signing-keys`)
  result: FAILED
  evidence: real QStash deliveries use `Upstash-Signature` JWT verification with raw-body hash and
  claim checks; implementation uses a bespoke body HMAC in `x-agentbay-qstash-signature`.
- command: source inspection of deployment mutation + wakeup atomicity
  result: FAILED
  evidence: helper APIs can perform deployment mutation and wakeup mutation as separate statements
  when passed a plain DB handle.
- command: `bun scripts/run-unit-tests.ts tests/unit/agent-deployment-wakeup-route.test.ts tests/unit/agent-deployment-triggers.test.ts tests/unit/server-env.test.ts tests/unit/agent-deployments-db.test.ts tests/unit/agent-deployment-cron-route.test.ts tests/unit/agent-deployment-migration-fixtures.test.ts`
  result: PASS
  evidence: isolated DB `plingpling_test_76358_482cde9c1d27`; 6 files / 43 tests passed.

## Failures

- file: `src/server/agents/agent-deployment-dispatch.ts:56`
  check: real QStash delivery compatibility
  exact error: implementation expects `x-agentbay-qstash-signature`, but QStash sends
  `Upstash-Signature`.
  likely owner: builder-agent for #264.
- file: `src/server/agents/agent-deployment-dispatch.ts:72`
  check: official QStash signature verification
  exact error: bespoke HMAC over body only; missing JWT signature verification and `iss`, `sub`,
  `exp`, `nbf`, and raw-body hash claim checks.
  likely owner: builder-agent for #264.
- file: `app/api/internal/agent-deployments/wakeup/route.ts:90`
  check: signed route delivery
  exact error: route reads the custom header via `deploymentWakeupSafeCodes.signatureHeader`, so a
  real QStash delivery is rejected before payload parsing.
  likely owner: builder-agent for #264.
- file: `tests/unit/agent-deployment-wakeup-route.test.ts:51`
  check: production-compatible signature fixture
  exact error: test signs with the same bespoke helper instead of an Upstash-compatible JWT/header
  fixture.
  likely owner: builder-agent for #264.
- file: `src/server/agents/agent-deployments.ts:153`
  check: atomic deployment mutation and wakeup creation
  exact error: helper inserts deployment then separately writes wakeup without enforcing an owning
  transaction at the helper boundary.
  likely owner: builder-agent for #264.

## Coverage Gaps

- Full gates (`bun run verify`, `bun run test:e2e:ci`, `bun run local:agent:smoke`) were not run
  after blocking semantic/security failures.
- No passing test covers real `Upstash-Signature` JWT verification with current/next signing keys,
  URL subject, expiration, not-before, and raw-body hash.
- No integrated committed mutation -> durable wakeup -> dropped publish -> cron reclaim -> fake
  publish -> signed duplicate delivery -> exactly-one targeted reconcile test was found.
- Cron route tests do not assert the outbox sweep is invoked before reconcile.
- Fake-delayed local smoke evidence was not found.

## Next Action

- Builder should replace the bespoke HMAC verifier with official/compatible QStash JWT verification,
  add real signature fixtures and the integrated producer-to-consumer recovery test, and enforce
  deployment+wakeup atomicity at helper boundaries before checker rerun.

## Handoff — #264 Builder Cycle 1 to Checker

- request: Re-check #264 on `codex/issue-264-durable-wakeups`; checker blockers were fixed without
  real QStash, DigitalOcean, provider, deployment, or billable effects.
- behavior changes:
  - QStash delivery verification now uses `@upstash/qstash` `Receiver.verify` against
    `Upstash-Signature`, exact raw body bytes, canonical callback URL subject, current/next signing
    keys, issuer/time claim handling, and optional `Upstash-Region`.
  - QStash publishing now uses the official `Client.publishJSON` with redaction, retries,
    deduplication ID, and delayed `notBefore`; tests continue to inject fake publishers.
  - Deployment create/release/stage mutation helpers now require a Drizzle transaction handle at the
    type and runtime boundary, and the wakeup helper rejects plain DB handles before any half-state
    can be exposed.
  - Deployment creation locks the owned agent row before idempotency/active checks and insert,
    avoiding transaction-aborting active-index violations while preserving same-key idempotency.
  - The protected cron route test now asserts wakeup outbox sweep happens before normal reconcile.
- files changed in cycle 1: `package.json`, `bun.lock`,
  `app/api/internal/agent-deployments/wakeup/route.ts`,
  `src/server/agents/agent-deployment-dispatch.ts`, `src/server/agents/agent-deployments.ts`,
  `tests/unit/agent-deployment-wakeup-route.test.ts`, `tests/unit/agent-deployments-db.test.ts`,
  `tests/unit/agent-deployment-cron-route.test.ts`, and
  `tests/unit/agent-launch-builder.test.ts`.
- regressions added:
  - Real-format Upstash JWT fixtures for current and next signing keys.
  - Raw-body hash mismatch, wrong callback subject, expired token, future not-before token, unsigned
    delivery, duplicate delivery, and early-delivery route coverage.
  - Plain DB handle rejection proving no deployment row or wakeup row is exposed when the owning
    transaction boundary is missing.
  - Cron route ordering coverage for outbox sweep before reconcile.
- tests passed:
  - `bun run typecheck` — PASS.
  - `bun scripts/run-unit-tests.ts tests/unit/agent-deployment-wakeup-route.test.ts tests/unit/agent-deployment-triggers.test.ts tests/unit/server-env.test.ts tests/unit/agent-deployments-db.test.ts tests/unit/agent-deployment-cron-route.test.ts tests/unit/agent-deployment-migration-fixtures.test.ts tests/unit/agent-launch-builder.test.ts`
    — PASS, 7 files / 53 tests.
  - `bun run format:check` — PASS, 402 files.
  - `bun run lint` — PASS, 402 files.
  - `bun run test` — PASS, 170 files / 1,647 tests.
  - `bun run build` — PASS.
- not run:
  - `bun run local:agent:smoke` was intentionally not run in this cycle because the coordinator
    flagged shared local-smoke namespace collisions across #264/#265/#266; leave smoke to serialized
    checker/coordinator execution.
  - `bun run test:e2e:ci` was not rerun in this cycle; previous builder evidence before checker was
    26/26 passing, and this cycle focused on repository-local signature/transaction blockers.
- known risks:
  - The remaining integrated producer-to-consumer recovery path should be checked independently by
    checker with fake publisher/signed delivery evidence.
  - Real external QStash publishing remains unexercised by design; no real queue/provider effects
    were authorized.

## Checker Result

Status: FAILED

## Commands

- command: `git status --short --branch --untracked-files=all && git log --oneline --decorate -6`
  result: PASS
  evidence: branch `codex/issue-264-durable-wakeups`; HEAD
  `29dba9c Fix QStash wakeups and atomic deployment writes`; only `STATUS.md` dirty from checker
  evidence.
- command: Upstash primary docs review:
  `https://upstash.com/docs/qstash/howto/signature`,
  `https://upstash.com/docs/qstash/sdks/ts/examples/receiver`,
  `https://upstash.com/docs/qstash/sdks/ts/gettingstarted`
  result: PASS
  evidence: docs require `Upstash-Signature`, SDK `Receiver.verify` with raw body and URL, and SDK
  `Client` for publishing; local `@upstash/qstash` package is `2.11.3`.
- command: source inspection of `src/server/agents/agent-deployment-dispatch.ts` and
  `app/api/internal/agent-deployments/wakeup/route.ts`
  result: PASS
  evidence: route reads `Upstash-Signature`; verifier constructs official `Receiver` with
  current/next signing keys and verifies raw body, canonical callback URL, optional Upstash region,
  and five-second clock tolerance before JSON parsing. Publisher constructs official `Client` and
  calls `publishJSON` with callback URL, payload, `POST`, `notBefore`, `retries: 3`,
  generation-scoped `deduplicationId`, and redaction.
- command: source inspection of deployment mutation+wakeup boundaries
  result: PASS
  evidence: `createAgentDeploymentForUser`, `releaseAgentDeploymentLease`, and
  `transitionAgentDeploymentStage` now require transaction handles and call `assertTransactionHandle`
  before mutations; repo call sites pass `tx`; plain DB rejection is covered before exposing rows.
- command:
  `bun scripts/run-unit-tests.ts tests/unit/agent-deployment-wakeup-route.test.ts tests/unit/agent-deployment-triggers.test.ts tests/unit/server-env.test.ts tests/unit/agent-deployments-db.test.ts tests/unit/agent-deployment-cron-route.test.ts tests/unit/agent-deployment-migration-fixtures.test.ts tests/unit/agent-launch-builder.test.ts`
  result: PASS
  evidence: isolated DB `plingpling_test_96723_484bbc91adb7`; 7 files / 53 tests passed.
- command: isolated manual integrated semantic check with fake publisher and real-format signed JWT
  delivery
  result: PASS
  evidence: isolated DB `plingpling_checker_4352_c0e54f4b9e71`; committed deployment mutation
  produced pending wakeup; cron outbox sweep published one fake message; signed delivery returned
  `{ok:true, processed:1, outcome:"advanced"}`; duplicate delivery returned
  `{ok:true, processed:0, outcome:"already_claimed"}`; reconcile calls `1`; final wakeup state
  `claimed`; no real QStash/provider effects.
- command: `bun run verify`
  result: PASS
  evidence: `format:check` checked 402 files; `lint` checked 402 files; route typegen and
  `tsc --noEmit` passed; full unit suite passed with isolated DB
  `plingpling_test_97147_e8fa2ef4a41f`, 170 files / 1,647 tests; production build compiled
  successfully.
- command: `bun run test:e2e:ci`
  result: BLOCKED by local port conflict
  evidence: default `http://localhost:3100` was already used.
- command: `PORT=3117 bun run test:e2e:ci`
  result: PASS
  evidence: 26 Playwright CI tests passed in 25.3s.
- command: `bun run local:agent:smoke`
  result: FAILED
  evidence: first serialized default-cron smoke attempt exited 1 with
  `Error response from daemon: No such container: agentbay-local-cloud-runner` followed by
  `Error: docker compose failed with exit 1.` No smoke summary, timing record, zero-provider
  assertion, or QStash absence proof was produced by the run.
- command: `bun run local:agent:smoke`
  result: FAILED
  evidence: retry failed with the same error:
  `Error response from daemon: No such container: agentbay-local-cloud-runner`; `Error: docker compose failed with exit 1.`
- command: cleanup checks after failed smoke
  result: PASS
  evidence: `docker ps -a --filter label=agentbay.agent_id --format ...` returned no rows;
  `docker ps -a --filter name=agentbay --format ...` only showed old `agentbay-postgres-1`
  exited from 4 days ago.

## Failures

- file: `scripts/smoke-local-agent-cycle.ts`
  check: serialized default-cron local full-cycle smoke
  exact error: `Error response from daemon: No such container: agentbay-local-cloud-runner`;
  `Error: docker compose failed with exit 1.`
  likely owner: builder-agent for #264 or coordinator/local Docker harness owner.

## Coverage Gaps

- `bun run local:agent:smoke` did not produce a valid timing record, `cleanupVerified:true`,
  `digitalOceanRequests:0`, or any completed lifecycle summary because it failed during local
  Docker setup/diagnostics.
- No dedicated fake-delayed local-smoke command or harness was found in `package.json`,
  `scripts/smoke-local-agent-cycle.ts`, or repo references to `AGENTBAY_DEPLOYMENT_DISPATCH_MODE`;
  fake delayed behavior is covered by the already-passed isolated integrated fake
  producer-consumer check, not by local smoke.
- Real external QStash publishing remains unexercised by design; no production secrets, real QStash
  publishes, provider calls, deployments, or billable effects were authorized or intentionally run.

## Next Action

- Builder/coordinator should fix the local smoke harness failure for missing
  `agentbay-local-cloud-runner`, then rerun `bun run local:agent:smoke` and require a completed
  summary with `cleanupVerified:true`, `digitalOceanRequests:0`, and a valid creation-latency timing
  record before PR/review.

## Gates

- #264 checker cycle-1 result (2026-08-07, `issue_264_checker`): FAILED at `29dba9c`.
  - prior blocker resolved: QStash verification now uses official `@upstash/qstash` `Receiver` and
    `Upstash-Signature` with raw body, callback URL subject, time claims, body hash, current/next
    signing keys, and safe error handling.
  - prior blocker resolved: deployment mutation helpers now reject plain DB handles before writes and
    require transaction handles for create/release/stage wakeup mutations.
  - focused tests: PASS, 7 files / 53 tests, isolated DB `plingpling_test_96723_484bbc91adb7`.
  - integrated semantic check: PASS, isolated DB `plingpling_checker_4352_c0e54f4b9e71`, fake
    publisher, signed delivery, duplicate delivery, exactly one targeted reconcile, final state
    `claimed`.
  - full non-smoke gates: `bun run verify` PASS; `PORT=3117 bun run test:e2e:ci` PASS, 26/26.
  - smoke gate: `bun run local:agent:smoke` FAILED twice with missing
    `agentbay-local-cloud-runner`; no completed timing/cleanup/provider summary was emitted.
  - cleanup check after failure: no containers with `agentbay.agent_id` label remained; only old
    exited `agentbay-postgres-1` was listed by the broad `name=agentbay` filter.
- #264 builder cycle-1 fix gates (2026-08-07, `issue_264_builder`): PASS locally.
  - command: `bun run typecheck`
    result: PASS.
    evidence: Next route types generated successfully and `tsc --noEmit` passed.
  - command:
    `bun scripts/run-unit-tests.ts tests/unit/agent-deployment-wakeup-route.test.ts tests/unit/agent-deployment-triggers.test.ts tests/unit/server-env.test.ts tests/unit/agent-deployments-db.test.ts tests/unit/agent-deployment-cron-route.test.ts tests/unit/agent-deployment-migration-fixtures.test.ts tests/unit/agent-launch-builder.test.ts`
    result: PASS.
    evidence: isolated DB `plingpling_test_89132_597bfb5396d4`; 7 files / 53 tests passed.
  - command: `bun run format:check`
    result: PASS.
    evidence: Biome checked 402 files with no fixes.
  - command: `bun run lint`
    result: PASS.
    evidence: Biome checked 402 files with no fixes.
  - command: `bun run test`
    result: PASS.
    evidence: isolated DB `plingpling_test_89980_4223127395a1`; 170 files / 1,647 tests passed.
  - command: `bun run build`
    result: PASS.
    evidence: Next.js production build compiled successfully and generated route output.
  - skipped: `bun run local:agent:smoke`
    reason: coordinator reported shared local-smoke namespace collisions; reserved for serialized
    checker/coordinator execution.
- #264 checker result (2026-08-07, `issue_264_checker`): FAILED at `ebd3773`.
  - command:
    `git status --short --branch --untracked-files=all`
    result: `## codex/issue-264-durable-wakeups` with `M STATUS.md` before checker update.
    evidence: branch HEAD `ebd3773 Add durable deployment wakeups`; no PR exists for
    `codex/issue-264-durable-wakeups`.
  - command:
    `gh issue view 264 --repo ametel01/plingpling --json title,state,body,labels,assignees,comments,url`
    result: issue #264 is open and agent-ready.
    evidence: acceptance requires signed delayed delivery, fail-closed queue mode, duplicate/stale
    fencing, lost publication recovery, and no real QStash/provider effects.
  - command:
    `gh pr list --repo ametel01/plingpling --state open --head codex/issue-264-durable-wakeups --json number,title,url,headRefName,baseRefName,mergeStateStatus,isDraft,reviewDecision,statusCheckRollup,closingIssuesReferences`
    result: `[]`.
    evidence: there is no mergeable PR for #264 yet.
  - command:
    Upstash primary docs review:
    `https://upstash.com/docs/qstash/howto/signature`,
    `https://upstash.com/docs/qstash/sdks/ts/examples/receiver`,
    `https://upstash.com/docs/qstash/quickstarts/vercel-nextjs`,
    `https://upstash.com/docs/qstash/howto/roll-signing-keys`.
    result: blocking contract mismatch.
    evidence: QStash delivery verification uses a JWT in `Upstash-Signature`; official verification
    requires raw-body verification plus JWT claim checks including issuer, subject URL, expiration,
    not-before, and body hash. The implementation instead defines
    `SIGNATURE_HEADER = "x-agentbay-qstash-signature"` at
    `src/server/agents/agent-deployment-dispatch.ts:56`, creates a bespoke HMAC at
    `src/server/agents/agent-deployment-dispatch.ts:72-74`, verifies only that HMAC at
    `src/server/agents/agent-deployment-dispatch.ts:109-123`, and reads that custom header in
    `app/api/internal/agent-deployments/wakeup/route.ts:85-95`. Real QStash deliveries would be
    rejected; non-QStash clients with the signing key could be accepted without JWT issuer/subject,
    expiry, not-before, or body-hash claim validation.
  - command:
    source inspection of deployment mutation atomicity.
    result: contract not satisfied at helper boundaries.
    evidence: `createAgentDeploymentForUser` inserts a deployment at
    `src/server/agents/agent-deployments.ts:153-175` and then writes the wakeup separately at
    `src/server/agents/agent-deployments.ts:179-184`; `releaseAgentDeploymentLease` mutates the
    deployment at `src/server/agents/agent-deployments.ts:396-407` and then writes the wakeup at
    `src/server/agents/agent-deployments.ts:409-414`; `transitionAgentDeploymentStage` mutates the
    deployment at `src/server/agents/agent-deployments.ts:523-540` and then writes the wakeup at
    `src/server/agents/agent-deployments.ts:542-547`. These helpers accept a plain DB handle, so
    atomicity depends on every caller wrapping them in a transaction; a wakeup-write failure after
    the deployment mutation can expose only half the state. The contract requires the mutation and
    authoritative wakeup generation to be atomic.
  - command:
    `bun scripts/run-unit-tests.ts tests/unit/agent-deployment-wakeup-route.test.ts tests/unit/agent-deployment-triggers.test.ts tests/unit/server-env.test.ts tests/unit/agent-deployments-db.test.ts tests/unit/agent-deployment-cron-route.test.ts tests/unit/agent-deployment-migration-fixtures.test.ts`
    result: PASS.
    evidence: isolated DB `plingpling_test_76358_482cde9c1d27`; 6 files / 43 tests passed.
  - failures:
    - `src/server/agents/agent-deployment-dispatch.ts:56`: signature header is
      `x-agentbay-qstash-signature`; real QStash sends `Upstash-Signature`.
    - `src/server/agents/agent-deployment-dispatch.ts:72-123`: signature verification is bespoke
      HMAC over body only; missing official QStash JWT verification and required `iss`, `sub`,
      `exp`, `nbf`, and body-hash checks.
    - `app/api/internal/agent-deployments/wakeup/route.ts:85-95`: route reads the custom header and
      cannot accept a real QStash delivery.
    - `tests/unit/agent-deployment-wakeup-route.test.ts:51-54` and
      `tests/unit/agent-deployment-wakeup-route.test.ts:159-165`: tests generate the same bespoke
      HMAC instead of an Upstash-compatible JWT/header fixture, so they do not prove the production
      queue contract.
    - `src/server/agents/agent-deployments.ts:153-184`,
      `src/server/agents/agent-deployments.ts:396-414`, and
      `src/server/agents/agent-deployments.ts:523-547`: deployment mutation and wakeup mutation are
      not enforced as one transaction by the helper API.
  - coverage gaps:
    - Did not run `bun run verify`, `bun run test:e2e:ci`, `bun run local:agent:smoke`, or build
      gates after the blocking semantic/security failures above.
    - No passing test covers a real Upstash/QStash JWT in `Upstash-Signature` with current/next key
      rotation, URL subject validation, expiration, not-before, and body-hash claim validation.
    - No integrated committed mutation -> durable wakeup -> dropped post-commit publish -> cron
      reclaim -> fake publish -> signed duplicate delivery -> exactly-one targeted reconcile test
      was found.
    - `tests/unit/agent-deployment-cron-route.test.ts` does not assert the outbox sweep is invoked
      before the cron reconcile path.
    - No fake-delayed local smoke evidence was found; the builder smoke was default cron-only.
  - next action:
    Builder should replace the bespoke HMAC verifier with the official QStash verifier/compatible
    JWT verification against `Upstash-Signature`, add real signature fixtures and the integrated
    producer-to-consumer recovery test, and enforce deployment+wakeup atomicity at the helper
    boundary before checker rerun.
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
