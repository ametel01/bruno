# Agent Team Status

Cold history: [`STATUS.archive.md`](STATUS.archive.md)

## Active Work

- issue: [#267](https://github.com/ametel01/plingpling/issues/267)
  owner: builder-agent (`issue_264_builder`)
  branch: `codex/issue-267-provider-phase-drain`
  worktree: `/Users/alexmetelli/source/plingpling`
  pr: none
  phase: checker cycle 1 local-smoke blocker fixed; ready for checker
  cycle: 2/5

## Goal Contract

- outcome: Execute `PLAN.md` through its Definition of Done, including 30 explicitly authorized
  clean cold DigitalOcean trials with at least 95% success and p95 committed-create-to-durable-ready
  latency at or below 60 seconds.
- current result: Repository work for #263, #265, and #266 is merged. The rebased #264 zero-cloud
  lifecycle smoke passed at 149.874 seconds with zero DigitalOcean requests, so the SLO is not yet
  met; #267 is expected to remove the observed 60-second post-readiness provider poll.
- non-goals: No Droplets before a create request; no warm pools, ready capacity, onboarding or
  predictive provisioning, cross-user sharing, or SLO expansion beyond durable `ready`.
- authorization boundary: Do not spend provider resources, build provider snapshots, configure
  production secrets, deploy, or release without explicit authorization.
- do-not-touch: Preserve `/Users/alexmetelli/source/plingpling-step7-base`, unrelated PR #262, and
  existing changelog history.

## Dependency Graph

- completed repository scope: #263 / PR #272; #264 / PR #275; #265 / PR #273; #266 / PR #274
- ready now: #267 provider-phase drain; #268 post-registration stage drain
- #267 and #268 are parallel-safe only in isolated worktrees and both touch
  `src/server/agents/agent-deployment-reconciler.ts`; coordinate merge order.
- #269 remains downstream of #266's authorization-independent repository work; #270 remains
  downstream of #265's authorization-independent repository work.
- blocked by #264-#270: #271 provider-backed SLO proof

## Next Assignment Contract

- Assign one builder to #267 on `codex/issue-267-provider-phase-drain`; the implementation must stay
  inside fake providers, injected SDK clients, and the isolated `local_docker` smoke boundary.
- Every checker must exercise the real deployment-trigger -> lease claim -> provider drain ->
  persisted wakeup path, not only direct provisioner fixtures.
- Provider-effect recovery must prove authoritative observation before any replay after an ambiguous
  create, tag, or firewall outcome.
- No real DigitalOcean/QStash request, snapshot build, workflow dispatch, deployment, hosted-secret
  mutation, or billable action is authorized for #267.

## Completion Contract — #267

- readiness: `ready`. Issue #264 is closed by merged PR #275 at `fa79f4a`; #267 has no comments,
  linked PR, unresolved review thread, credential need, or remaining agent-actionable dependency.
- outcome: In one deployment action, drain the cold on-demand runner through authoritative
  discovery, at most one Droplet create, tag confirmation/correction, firewall confirmation/create,
  and endpoint persistence until `waiting_for_runner`, while preserving a durable checkpoint around
  every provider effect and the existing user/operation/cleanup fences.
- acceptance criteria and invariants:
  - The normal `FakeDigitalOceanProvider` path reaches persisted runner status `registering` /
    provisioning status `waiting_for_runner` in one call to
    `advanceAutomaticDigitalOceanRunnerProvisioning`, with one authoritative discovery, exactly one
    create, no redundant tag POST when the create response already proves all required tags, exactly
    one firewall, a persisted endpoint/firewall ID, and ordered started/completed phase events.
  - Keep the operation key durably stored before the first provider request. Before every subsequent
    phase/effect, reload or fence the owned runner by runner ID, user ID, operation key, non-deleted
    state, active deployment lease/config revision, and agent desired-running state. A concurrent
    Stop/Delete/lost lease may finish checkpointing an effect already in flight but starts no later
    provider effect.
  - Persist each successful provider result transactionally before continuing: provider resource
    ID, firewall ID when known, endpoint when known, next provisioning phase, and the safe completed
    event. A failed checkpoint stops the drain; it must never fall through to the next effect.
  - Create recovery stays fail-closed: `pending` may create only after authoritative exact-operation-
    tag discovery proves zero matches. `creating`, an unknown create outcome, a crash after create,
    non-authoritative discovery, or discovery transport failure never issues another create. One
    exact owned match is adopted; multiple/mismatched matches terminalize as
    `runner_provisioning_outcome_unknown` with cleanup ownership retained.
  - The create request contains the full normalized tag set. In `tagging`, an authoritative provider
    observation that already contains that set advances without `tagResource`; a correction is sent
    only for authoritatively missing tags. Unknown/ambiguous tag results stop for observation, and a
    crash after an applied tag resumes without replaying it.
  - Firewall recovery uses the deterministic firewall name plus Droplet attachment/ownership. An
    authoritative exact match is adopted and checkpointed, authoritative absence may create once,
    and missing observation support, multiple/mismatched matches, or an unknown effect outcome stops
    without another firewall create. A crash after firewall application resumes with the same
    firewall ID and exact cleanup ownership.
  - After firewall completion, persist an endpoint from authoritative provider state and enter
    `waiting_for_runner`. If no public endpoint exists, persist `bootstrapping` and stop; do not poll
    or consume repeated provider phases inside the same action.
  - Use a named default drain bound of eight state-machine iterations (with a smaller injectable test
    bound); never execute a ninth. Check the existing 45-second action deadline/abort signal before
    every provider transport and pass the same signal through. Stop on cancellation, lost authority,
    abort/deadline, bound, retryable transport failure, provider ambiguity, missing endpoint,
    `waiting_for_runner`, or any terminal runner/deployment state.
  - Return a typed stop disposition so the reconciler persists the precise wakeup: unfinished but
    immediately executable work stopped only by the iteration/deadline bound is due immediately;
    `waiting_for_runner`, missing endpoint, or a safe retryable observation failure uses the bounded
    external-wait retry; ambiguous effects permit observation/discovery only and eventually fail at
    the existing attempt limit. Do not apply exponential `runner_not_ready` delay between successful
    immediately executable phases.
  - Duplicate/reordered targeted triggers retain the deployment lease as the execution fence and
    produce at most one create, one required tag correction, and one firewall. Safe events/logs must
    not expose operation tags, registration/bearer/provider/QStash secrets, raw provider responses,
    endpoint credentials, or arbitrary exception text.
- crash/failure semantics required by tests:
  - Inject a crash after each create, tag, and firewall fake effect but before its completion
    checkpoint; the next invocation must authoritatively adopt the same effect, reach
    `waiting_for_runner`, keep one Droplet/firewall, and retain exact cleanup ownership.
  - Inject a crash after each committed phase checkpoint; resume at the next phase without replay.
  - Inject checkpoint persistence failure, cancellation/lost lease between phases, duplicate
    triggers, deadline abort, iteration exhaustion, non-authoritative/failed observation, unknown
    create/tag/firewall outcome, missing endpoint, and multiple discovered resources; assert the
    stop disposition, wakeup timing, provider call counts, terminal code, and cleanup flag.
- non-goals / authorization boundary:
  - No pre-provisioned Droplets, warm/ready pools, predictive provisioning, cross-user sharing, or
    capacity created before the user's committed create request.
  - Do not implement #268 post-registration draining, #265 size-default selection, #266 snapshot
    execution, #269/#270, or #271 provider SLO proof; do not change the durable-ready SLO boundary.
  - Do not make a real DigitalOcean or QStash request; build/run a provider snapshot; run provider-
    backed `test:e2e`, benchmark trials, or reconcile scripts; configure secrets; dispatch a GitHub
    workflow; deploy/release; or perform any billable action.
- likely touchpoints:
  - `src/server/runners/runner-provisioning.ts` for the bounded drain, phase reload/fences, typed stop
    disposition, and checkpoint-before-continue behavior.
  - `src/server/runners/digitalocean-provider.ts` and
    `src/server/runners/local-docker-digitalocean-provider.ts` only as needed for authoritative
    tag/firewall observation and idempotent fake/local behavior; all API tests use injected SDK
    clients and no network.
  - `src/server/agents/agent-deployment-reconciler.ts` for immediate versus external-wait wakeups
    without weakening deployment leases or transactional wakeup replacement.
  - `tests/unit/automatic-runner-provisioning.test.ts`,
    `tests/unit/agent-deployment-reconciler.test.ts`, `tests/unit/digitalocean-provider.test.ts`,
    `tests/unit/local-docker-digitalocean-provider.test.ts`, cancellation/finalization race tests,
    and local-smoke timing assertions. `PROGRESS.md`/`CHANGELOG.md` updates belong to the builder only
    after gates pass; no schema/migration change is expected.
- required tests / gates:
  - Focused provider/provisioner/reconciler/cancellation/finalization/local-smoke unit tests, including
    one concurrent real producer path: committed deployment -> targeted claim -> bounded drain ->
    durable precise wakeup, with fake call-count and checkpoint assertions.
  - `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test`; `bun run build`;
    `bun run test:e2e:ci`; `bun run repro:cloud-runner`; `git diff --check`.
  - Run `bun run local:agent:smoke` only with its package-script-enforced `local_docker`, local token,
    and synthetic-boundary sentinels. Require `digitalOceanRequests:0`, `simulatedDroplets:1`,
    `cleanupVerified:true`, one provider-phase invocation to `waiting_for_runner`, and before/after
    orchestration timing versus the Step 1 baseline. This is local behavior evidence, not SLO proof.
- risks: Provider reads that are cached/non-authoritative can incorrectly authorize replay; firewall
  POST can succeed before a transport failure; concurrent cancellation can race an in-flight effect;
  and an unconditional loop can overrun the 45-second lease/deadline. Fail closed and checkpoint
  ownership before continuing; never infer absence from an unsupported or partial provider read.
- do-not-touch: schema/migrations unless a blocking invariant is first escalated; post-registration
  stage logic, size/snapshot defaults/workflows, benchmark provider authorization, production/release
  configuration, unrelated PR #262, and `/Users/alexmetelli/source/plingpling-step7-base`.
- open questions: none blocking. Provider observation method names and internal result type names are
  implementation choices, provided the authoritative present/absent/ambiguous semantics above are
  explicit and testable.

## Handoff — #267 Spec to Builder

- request: Implement only the #267 contract on `codex/issue-267-provider-phase-drain`, starting with
  crash fixtures and authoritative tag/firewall observation, then add the bounded loop and precise
  reconciler wakeup disposition.
- evidence: Issue #267 and PLAN Step 3 match; current code returns after each successful provider
  phase and `reconcileProvisioningRunner` always schedules `runner_not_ready` backoff. Create already
  carries the complete tags, while DigitalOcean firewall creation lacks crash-safe authoritative
  adoption and therefore needs special review.
- stop condition: Hand off after fake/injected/local gates and before/after orchestration evidence are
  recorded, or earlier on repeated failure, a required schema/product decision, or any need for real
  provider/QStash/deployment/billable authority.

## Handoff — #267 Builder to Checker

- request: Independently verify #267 on branch `codex/issue-267-provider-phase-drain` at the builder
  commit. Do not edit code.
- files changed: `CHANGELOG.md`, `PROGRESS.md`, `STATUS.md`,
  `src/server/runners/runner-provisioning.ts`,
  `src/server/runners/digitalocean-provider.ts`,
  `src/server/runners/local-docker-digitalocean-provider.ts`,
  `src/server/agents/agent-deployment-reconciler.ts`,
  `tests/unit/automatic-runner-provisioning.test.ts`,
  `tests/unit/local-docker-digitalocean-provider.test.ts`,
  `tests/unit/agent-deployment-reconciler.test.ts`,
  `tests/unit/digitalocean-provider.test.ts`,
  `tests/unit/runner-infrastructure-reconciler.test.ts`, and
  `tests/unit/runner-replacement-reconciler.test.ts`.
- behavior implemented: automatic DigitalOcean provisioning now drains bounded provider phases through
  `waiting_for_runner` in one fake/injected provider call path, skips redundant tag POSTs when create
  already proves the full required tag set, observes/adopts crash-completed create/tag/firewall
  effects before replay, persists waiting status/firewall/endpoint in one checkpoint, rechecks
  deployment lease/config/desired-running authority before provider effects, and returns typed
  dispositions consumed by the reconciler for immediate versus external-wait wakeups.
- checker cycle 1 fix: coordinator serialized local smoke at `b476652` exposed that
  `LocalDockerDigitalOceanProvider` did not implement the authoritative managed-inventory/firewall
  observation path, so local_docker stopped at `provider_firewall_observation_failed` with reason
  `unsupported` and scheduled repeated `runner_not_ready` backoffs. The local provider now returns
  authoritative local inventory, records deterministic firewall names, and preserves cleanup state
  without changing fail-closed real-provider semantics.
- tests added/updated: one-call normal fake drain, create/tag/firewall after-effect crash recovery,
  one-call local_docker drain to `waiting_for_runner`, immediate provisioner wakeup disposition, and
  updated replacement/infrastructure/provider assertions for bounded drain and firewall-name
  metadata.
- gates passed:
  - `bun scripts/run-unit-tests.ts tests/unit/automatic-runner-provisioning.test.ts` — 15 tests
    passed.
  - `bun scripts/run-unit-tests.ts tests/unit/local-docker-digitalocean-provider.test.ts` — 4 tests
    passed.
  - `bun scripts/run-unit-tests.ts tests/unit/automatic-runner-provisioning.test.ts tests/unit/local-docker-digitalocean-provider.test.ts`
    — 19 tests passed.
  - `bun scripts/run-unit-tests.ts tests/unit/agent-deployment-reconciler.test.ts` — 41 tests
    passed.
  - `bun scripts/run-unit-tests.ts tests/unit/digitalocean-provider.test.ts` — 17 tests passed.
  - `bun scripts/run-unit-tests.ts tests/unit/runner-infrastructure-reconciler.test.ts` — 11 tests
    passed.
  - `bun scripts/run-unit-tests.ts tests/unit/runner-replacement-reconciler.test.ts` — 11 tests
    passed.
  - `bun run format:check`; `bun run lint`; `bun run typecheck`; `git diff --check`; `bun run test`
    — 174 files / 1701 tests; `bun run build`; `bun run test:e2e:ci` — 26 tests;
    `bun run repro:cloud-runner`.
- skipped: `bun run local:agent:smoke` was intentionally not run; coordinator must serialize the
  local Docker smoke slot. No real DigitalOcean/QStash/deploy/release/billable action was run.
- reviewer focus: verify provider-effect checkpoint ordering, crash adoption without replay, typed
  wakeup persistence, lease/desired-running fence behavior, safe logs/events, and zero external
  effects.

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

## Checker Result — #264 Cycle 1

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
- Coordinator should grant #264 a serialized `bun run local:agent:smoke` slot after the cycle-2
  commit lands; builder intentionally did not run smoke while #265 may own the shared namespace.

## Handoff — #264 Builder Cycle 2 to Coordinator/Checker

- request: Re-run serialized local smoke for #264 after this branch's harness fix is committed.
- scope: minimal shared harness fix only; preserved #264 QStash/signature/transaction changes and
  did not import #265 resource-profile scope.
- behavior changes:
  - `compose.yaml` now maps dashboard container port 3000 to
    `${AGENTBAY_APP_HOST_PORT:-55300}` and sets `NEXT_PUBLIC_APP_URL` to the matching
    `http://host.docker.internal:${AGENTBAY_APP_HOST_PORT:-55300}` callback origin.
  - `local:cloud:up` and `local:agent:smoke` scripts expose the same default
    `AGENTBAY_APP_HOST_PORT=${AGENTBAY_APP_HOST_PORT:-55300}` override.
  - `scripts/smoke-local-agent-cycle.ts` resolves the app host port once, passes it to compose,
    sets `NEXT_PUBLIC_APP_URL` accordingly, and probes
    `http://127.0.0.1:${AGENTBAY_APP_HOST_PORT}/health` instead of hard-coded port 3000.
  - Smoke diagnostics no longer attempt nested Docker exec when `agentbay-local-cloud-runner` was
    never created; dashboard logs remain available for startup failures.
- regressions added:
  - Unit coverage for default/custom/invalid app host port resolution and callback URL construction.
  - Source/compose/package assertions proving the compose port mapping, callback URL, package smoke
    override, host health probe helper, and container-existence guard are wired.
- tests passed:
  - `bun scripts/run-unit-tests.ts tests/unit/local-agent-cycle-smoke.test.ts` — PASS, 1 file / 5
    tests, isolated DB `plingpling_test_42904_5cc945f7dade`.
  - `bun run format:check` — PASS, 402 files.
  - `bun run lint` — PASS, 402 files.
  - `bun run typecheck` — PASS.
- not run:
  - `bun run local:agent:smoke` was intentionally not run while #265 builder/checker may own the
    shared local-smoke namespace. Coordinator should serialize and run it next.

## Checker Result — #264 Cycle 2

Status: FAILED

## Commands

- command: `git status --short --branch --untracked-files=all && git log --oneline --decorate -8`
  result: PASS
  evidence: branch `codex/issue-264-durable-wakeups`; HEAD
  `c6e2f28 Fix local smoke app host port isolation`; only `STATUS.md` dirty from checker evidence.
- command: `git diff --stat 29dba9c..HEAD && git diff --name-status 29dba9c..HEAD && git diff --check 29dba9c..HEAD`
  result: PASS
  evidence: cycle-2 diff is scoped to `compose.yaml`, `package.json`,
  `scripts/smoke-local-agent-cycle.ts`, `tests/unit/local-agent-cycle-smoke.test.ts`, and status;
  no diff-check whitespace errors.
- command: source inspection of configurable local smoke port and diagnostics
  result: PASS
  evidence: `compose.yaml` maps `${AGENTBAY_APP_HOST_PORT:-55300}:3000` and sets
  `NEXT_PUBLIC_APP_URL=http://host.docker.internal:${AGENTBAY_APP_HOST_PORT:-55300}`;
  `package.json` passes `AGENTBAY_APP_HOST_PORT` into `local:cloud:up` and `local:agent:smoke`;
  `scripts/smoke-local-agent-cycle.ts` resolves `AGENTBAY_APP_HOST_PORT`, uses
  `http://host.docker.internal:<port>` for app URL, probes `http://127.0.0.1:<port>/health`, and
  skips nested-Docker diagnostics when `agentbay-local-cloud-runner` does not exist.
- command: `bun scripts/run-unit-tests.ts tests/unit/local-agent-cycle-smoke.test.ts`
  result: PASS
  evidence: isolated DB `plingpling_test_43590_2dadf12d3f48`; 1 file / 5 tests passed.
- command: dedicated port/namespace preflight
  result: PASS
  evidence: Python bind check reported ports `55300`, `55311`, `55321`, `55331`, and `55341` free;
  `docker ps -a --filter label=agentbay.agent_id` returned no rows; broad `name=agentbay` listed
  only old exited `agentbay-postgres-1`.
- command: `AGENTBAY_APP_HOST_PORT=55311 bun run local:agent:smoke`
  result: FAILED
  evidence: smoke used app callback origin `http://host.docker.internal:55311` and advanced local
  provisioning through `provider_create_completed`, but failed before ready/cleanup summary. Exact
  terminal errors: `Error response from daemon: container ... is not running`;
  `Error response from daemon: removal of container agentbay-local-cloud-runner is already in progress`;
  `Failed query: select "stage", "error_code", "error_detail" from "agent_deployments" ... <-
  Error: connect ECONNREFUSED 127.0.0.1:55432`.
- command: cleanup checks after failed cycle-2 smoke
  result: PASS
  evidence: `docker ps -a --filter label=agentbay.agent_id --format ...` returned no rows; broad
  `docker ps -a --filter name=agentbay --format ...` only listed old exited `agentbay-postgres-1`;
  bind check reported ports `55311`, `55432`, and `3045` free.

## Failures

- file: `scripts/smoke-local-agent-cycle.ts`
  check: serialized default-cron local full-cycle smoke on dedicated port
  exact error: local smoke did not emit the required summary because the simulated Droplet container
  stopped and cleanup raced with removal; the script then lost its local Postgres connection:
  `Error: connect ECONNREFUSED 127.0.0.1:55432`.
  likely owner: builder-agent for #264 or local Docker smoke harness owner.

## Coverage Gaps

- The smoke run did not produce a complete valid creation-latency timing summary,
  `cleanupVerified:true`, `digitalOceanRequests:0`, or completed proof of no real QStash publish.
- No dedicated fake-delayed local-smoke command/harness exists. This is non-blocking only for the
  fake-delay semantic path because the isolated integrated fake producer-consumer check already
  passed in cycle 1 with fake publisher, signed delivery, duplicate delivery, and exactly one
  targeted reconcile; it does not replace the failed default local smoke gate.
- Real external QStash publishing remains unexercised by design; no production secrets, real QStash
  publishes, provider calls, deployments, or billable effects were authorized or intentionally run.

## Next Action

- Builder/coordinator should fix the remaining local smoke stability failure where the simulated
  Droplet/local Compose stack exits or is removed before the deployment reaches ready, then rerun
  `AGENTBAY_APP_HOST_PORT=<free-port> bun run local:agent:smoke` and require a completed summary
  with valid timing, `cleanupVerified:true`, `digitalOceanRequests:0`, and no real QStash/provider
  effects before PR/review.

## Gates

- #264 checker cycle-2 result (2026-08-07, `issue_264_checker`): FAILED at `c6e2f28`.
  - port isolation/diagnostics regression: PASS via source inspection and
    `bun scripts/run-unit-tests.ts tests/unit/local-agent-cycle-smoke.test.ts` (1 file / 5 tests).
  - dedicated smoke preflight: PASS; port `55311` free and no agent-labeled containers before run.
  - smoke gate: FAILED with simulated Droplet container not running/removal in progress and local DB
    `ECONNREFUSED 127.0.0.1:55432`; no completed timing/provider/cleanup summary emitted.
  - cleanup after failure: PASS; no agent-labeled containers remained, and ports `55311`, `55432`,
    `3045` were free.
- #264 builder cycle-2 harness gates (2026-08-07, `issue_264_builder`): PASS locally; smoke pending
  serialized slot.
  - command: `bun scripts/run-unit-tests.ts tests/unit/local-agent-cycle-smoke.test.ts`
    result: PASS.
    evidence: isolated DB `plingpling_test_42904_5cc945f7dade`; 1 file / 5 tests passed.
  - command: `bun run format:check`
    result: PASS.
    evidence: Biome checked 402 files with no fixes.
  - command: `bun run lint`
    result: PASS.
    evidence: Biome checked 402 files with no fixes.
  - command: `bun run typecheck`
    result: PASS.
    evidence: Next route types generated successfully and `tsc --noEmit` passed.
  - skipped: `bun run local:agent:smoke`
    reason: shared local-smoke namespace must be serialized; coordinator should run it after
    cycle-2 commit.
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
  - result: PARTIAL; #264 branch is checker-green below, but no PR is open; no PR object can be
    merged yet.
  - `git status --short --branch --untracked-files=all`: current worktree is
    `codex/issue-264-durable-wakeups` with only `STATUS.md` modified by checker evidence.
  - `gh pr list --head codex/issue-264-durable-wakeups --state open --json ...`: `[]`.
  - `gh pr list --head codex/issue-265-runner-sizing --state open --json ...`: `[]`.
  - `gh pr list --head codex/issue-266-attested-snapshot --state open --json ...`: `[]`.
  - `gh pr list --state open --limit 10 --json ...`: only open PR is unrelated
    [#262](https://github.com/ametel01/plingpling/pull/262) on
    `docs/ai-integration-opportunities`, `mergeStateStatus: UNSTABLE`, with Vercel `FAILURE`.
  - next action: commit/push/open the #264 PR before any #264 merge; continue #265/#266 checks.
    Do not merge #262 as part of this goal.

## Checker Result

Status: ALL GREEN

## Commands

- command: required skill load
  result: PASS
  evidence: loaded `checker-agent`, `agent-team-status-protocol`, `testing-standards`,
    `ci-quality-gates`, and `ci-security-gates`; `test-workflow-standards` was requested by the
    coordinator but is not present in `/Users/alexmetelli/.agents/skills`, so
    `testing-standards` is the available test-workflow substitute.
- command: `git status --short --branch --untracked-files=all`
  result: PASS
  evidence: branch `codex/issue-264-durable-wakeups`; no source files dirty before checker update.
- command: `git rev-parse --short HEAD && git rev-parse --short main && git rev-parse --short origin/main && git merge-base HEAD main`
  result: PASS
  evidence: HEAD `65851f1`, `main`/`origin/main` `57e4843`, merge-base
    `57e4843975175cbb2f04ab45c8f7f6f1d4abcbf6`; branch is rebased on current main.
- command: `gh pr list --repo ametel01/plingpling --state open --head codex/issue-264-durable-wakeups --json ...`
  result: PASS
  evidence: `[]`; no open PR currently exists for this branch.
- command: `git diff --stat main...HEAD`, `git diff --name-status main...HEAD`, and
    `git diff --check main...HEAD`
  result: PASS
  evidence: scoped #264 diff is 27 files / 8,646 insertions / 895 deletions, covering env/docs,
    wakeup route, dispatch module, migration/schema, deployment mutators, QStash dependency, and
    focused tests; no diff-check errors.
- command: source inspection of producer mutation -> transactional wakeup -> dropped post-commit
    publish -> cron reclaim -> signed duplicate/stale delivery -> exactly-one targeted reconcile
  result: PASS
  evidence: `agent-deployments.ts:137`, `:385`, and `:480` require transaction handles before
    create/release/transition writes; `agent-deployment-dispatch.ts:170-235` locks the deployment
    row and terminalizes/replaces generation-fenced wakeups in the same transaction;
    `publishLatestDeploymentWakeupAfterCommit` at `agent-deployment-dispatch.ts:319-349` publishes
    only committed pending/failed wakeups; `sweepDeploymentWakeupOutbox` at
    `agent-deployment-dispatch.ts:355-407` reclaims due unpublished/failed work in QStash mode;
    `claimDeploymentWakeupDelivery` at `agent-deployment-dispatch.ts:409-478` atomically claims only
    due latest-generation rows and returns duplicate/stale/terminal outcomes without executing
    reconciliation; `wakeup/route.ts:38-78` verifies the raw body before parsing, claims inside a
    transaction, and invokes `reconcileTargetAgentDeployment` only after a successful claim.
- command: source inspection of official QStash compatibility and no provider/queue authority
  result: PASS
  evidence: `agent-deployment-dispatch.ts:3` imports `Client` and `Receiver` from
    `@upstash/qstash`; `:56-57` uses `Upstash-Signature`/`Upstash-Region`; `:106-135` verifies with
    `Receiver.verify` using current/next signing keys, callback URL subject, raw body, region, and
    clock tolerance; `:480-500` publishes with `Client.publishJSON`, `notBefore`, retries,
    deduplication ID, and redaction. `readDeploymentDispatchConfig` defaults to cron unless QStash
    config is complete; `package.json` local smoke forces `AGENTBAY_DIGITALOCEAN_PROVIDER_MODE=local_docker`.
- command: ambient secret/effect preflight
  result: PASS
  evidence: environment variable names checked without printing values:
    `AGENTBAY_DEPLOYMENT_DISPATCH_MODE`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
    `QSTASH_NEXT_SIGNING_KEY`, `DIGITALOCEAN_ACCESS_TOKEN`, and
    `AGENTBAY_DIGITALOCEAN_PROVIDER_MODE` are all unset in the checker shell.
- command:
    `bun scripts/run-unit-tests.ts tests/unit/agent-deployment-wakeup-route.test.ts tests/unit/agent-deployments-db.test.ts tests/unit/agent-deployment-cron-route.test.ts tests/unit/agent-deployment-triggers.test.ts tests/unit/server-env.test.ts tests/unit/agent-deployment-migration-fixtures.test.ts tests/unit/agent-launch-builder.test.ts tests/unit/local-agent-cycle-smoke.test.ts tests/unit/agent-deployment-reconciler.test.ts`
  result: PASS
  evidence: isolated DB `plingpling_test_67745_afb2b3694ad0`; migrations applied; 9 files / 99
    tests passed; DB removed.
- command: `bun run format:check`
  result: PASS
  evidence: Biome checked 410 files in 108ms; no fixes applied.
- command: `bun run lint`
  result: PASS
  evidence: Biome checked 410 files in 215ms; no fixes applied.
- command: coordinator gate evidence supplied for final rebased head `65851f1`
  result: PASS
  evidence: coordinator reported focused 9 files / 106 tests, format/lint/typecheck/build, full
    unit 174 files / 1,696 tests, E2E 26/26, exact local smoke
    `cleanupVerified:true`, `digitalOceanRequests:0`, p95 `149874ms`, and clean ports; checker did
    not rerun the shared local smoke stack to avoid introducing provider/namespace effects.

## Failures

- none.

## Coverage Gaps

- No open PR exists for `codex/issue-264-durable-wakeups`; there is nothing for the checker to
  merge or verify as a PR object yet.
- Real external QStash publishing and real DigitalOcean provisioning were intentionally not run and
  remain outside #264 authorization. The checked path uses fakes/local Docker plus coordinator smoke
  evidence with `digitalOceanRequests:0`.
- #264 is merge-ready for durable wakeups, but it does not by itself prove the overall one-minute
  creation target; the recorded local smoke p95 is ~150 seconds, and provider-backed 30-trial SLO
  proof remains downstream.

## Next Action

- Open/push the #264 PR from `codex/issue-264-durable-wakeups`, then merge only after normal PR
  review/CI policy is satisfied. Checker verdict on the branch head: merge-ready for #264.

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

- `/Users/alexmetelli/source/plingpling`: issue #264 branch; coordinator-owned, checker-green.
- `/Users/alexmetelli/source/plingpling-issue-265`: merged #265 branch; preserve existing state.
- `/Users/alexmetelli/source/plingpling-issue-266`: main at merged #266; preserve existing state.
- `/Users/alexmetelli/source/plingpling-step7-base`: pre-existing detached user-owned worktree;
  preserve and do not modify.

## Completed

- issue [#263](https://github.com/ametel01/plingpling/issues/263), PR
  [#272](https://github.com/ametel01/plingpling/pull/272), merge
  `7d1cb985c06b0007dadcfb0e42c5631c65b7c472`; maker/checker/reviewer accepted.
- repository scope for issue [#265](https://github.com/ametel01/plingpling/issues/265), PR
  [#273](https://github.com/ametel01/plingpling/pull/273), merge
  `84a1860f4030496adda7dfc324ef86acafb19742`; post-merge main CI rerun passed.
- repository scope for issue [#266](https://github.com/ametel01/plingpling/issues/266), PR
  [#274](https://github.com/ametel01/plingpling/pull/274), merge
  `57e4843975175cbb2f04ab45c8f7f6f1d4abcbf6`; issue remains open for authorized provider proof.
- retrospective archived; status compaction performed immediately, so no separate process issue is
  needed.
