# One-Minute Cold Agent Creation Progress

Source: [`PLAN.md`](PLAN.md)

This file is the durable execution record for the plan. Update it after every completed step with
validation results, the commit reference when available, the current status, and the next step.
The update log is append-only.

## Status

- Current step: Step 7 — authorization-independent release-attested readiness preparation; merge is
  blocked until Step 6 live snapshot evidence is explicitly authorized and verified
- Overall status: in progress
- SLO target: at least 95% success and p95 committed-create-to-durable-ready latency at or below 60
  seconds across 30 clean cold DigitalOcean trials
- Provider acceptance: authorization-gated; not yet authorized or run
- Capacity policy: no pre-provisioned Droplets, warm pools, predictive capacity, or cross-user sharing

## Checklist

- [x] Step 0 — Progress and changelog tracking setup
- [x] Step 1 — Creation-latency evidence and benchmark
- [x] Step 2 — Durable delayed deployment wakeups
- [x] Step 3 — Bounded drain for provider provisioning phases
- [x] Step 4 — Bounded drain for post-registration deployment stages
- [ ] Step 5 — Right-size cold managed runners
- [ ] Step 6 — Build and attest a DigitalOcean runner snapshot
- [ ] Step 7 — Release-attested lightweight per-Droplet readiness
- [ ] Step 8 — Safe same-user capacity reuse
- [ ] Step 9 — Provider-backed SLO proof and rollout

## Validation Summary

- Step 0: `PROGRESS.md` and `CHANGELOG.md` exist. The changelog retains its Keep a Changelog
  preamble, `## [Unreleased]`, and existing history. No runtime behavior changed and no changelog
  entry was added.
- Step 1: Added deterministic agent-creation latency reporting, the read-only benchmark command,
  sanitized terminal-ready logging, local smoke timing output before cleanup, docs, changelog, and
  regression tests. The smoke/benchmark passes exposed two issues before final handoff: overly
  strict PostgreSQL timestamp parsing and an incorrect UUID-to-operation-key runner correlation.
  Both fixes were added before final gates.
- Required implementation gates: Step 1 passed `bun run format:check`, `bun run lint`,
  `bun run typecheck`, `bun scripts/run-unit-tests.ts tests/unit/agent-creation-latency.test.ts
  tests/unit/agent-creation-benchmark.test.ts tests/unit/local-agent-cycle-smoke.test.ts
  tests/unit/runner-bootstrap-events.test.ts`, `bun run test`, `bun run build`,
  `bun run test:e2e:ci`, `bun run local:agent:smoke`, and
  `bun run agent:creation:benchmark -- --limit 1`.
- Step 6 repository implementation: Added protected manual snapshot workflow, local build
  orchestrator, signed manifest verification, snapshot-mode pre-create evidence validation,
  snapshot first-boot bootstrap mode, fake-provider action/image surfaces, docs, and tests. Step 6
  remains unchecked because live DigitalOcean snapshot execution and cleanup acceptance are explicitly
  authorization-gated and have not run.
- Provider-backed acceptance gate: pending explicit authorization.
- Step 5 authorization-independent subset: canonical runner profile validation, pre-provider
  rejection, runtime-limit propagation, and fake-only benchmark candidate validation are implemented
  for issue #265. Full local gates passed. The hosted default is intentionally unchanged pending
  authorized provider evidence.
- Step 2 focused gates: `bun run format:check`, `bun run lint`, `bun run typecheck`,
  `bun scripts/run-unit-tests.ts tests/unit/agent-deployment-wakeup-route.test.ts
  tests/unit/agent-deployment-triggers.test.ts tests/unit/server-env.test.ts
  tests/unit/agent-deployments-db.test.ts tests/unit/agent-deployment-cron-route.test.ts
  tests/unit/agent-deployment-migration-fixtures.test.ts`, `bun run test`, `bun run build`, and
  `git diff --check` passed locally.
- Step 2 E2E/local smoke gates: `bun run test:e2e:ci` passed 26/26. `bun run local:agent:smoke`
  passed with `cleanupVerified:true`, `digitalOceanRequests:0`, `issueCounts:{}`, and p95
  150.725 seconds in this local cold run.
- Step 3 repository implementation: Added a bounded eight-iteration automatic provider drain,
  typed provisioner stop dispositions, lease/desired-running rechecks before provider effects,
  authoritative tag/firewall observation and crash adoption, and immediate wakeups for bound-limited
  provider work. No real DigitalOcean, QStash, deployment, release, or billable action was run.
- Step 3 gates: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`
  (174 files / 1700 tests), `bun run build`, `bun run test:e2e:ci` (26 tests),
  `bun run repro:cloud-runner`, and `git diff --check` passed locally. `bun run local:agent:smoke`
  was intentionally not run because coordinator serialization is required.
- Step 4 post-rebase gates: after #267 merged, the branch rebased onto `d4541c0` while preserving
  both reconciler contracts. The combined focused suite passed 12 files / 110 tests; `bun run verify`
  passed 175 files / 1,709 tests and the production build; `bun run repro:cloud-runner`,
  `PORT=3128 bun run test:e2e:ci` (26/26), and `git diff --check` passed. The serialized
  `local:agent:smoke` passed with `cleanupVerified:true`, `digitalOceanRequests:0`, one simulated
  Droplet, and the full producer-to-ready sequence. Its single local cold run was 152.675 seconds,
  dominated by 123.888 seconds in provisioning/scheduler wait and 70.593 seconds of runner boot;
  this is safety evidence, not provider-backed SLO evidence.
- Step 4 checker-blocker fix: a deadline-aborted signed wakeup delivery now releases its exact
  deployment claim and creates the next due generation atomically, fenced by the unchanged
  stage/config/lease and an active running agent. A signed-route regression covers real wakeup
  claim, real drain deadline abort, and real replacement publication. The combined focused suite
  passed 12 files / 111 tests; format, lint, typecheck, and diff-check passed. The serialized smoke
  was not rerun.
- Step 8 repository/local implementation: fail-closed capacity evaluation, owner-aware transactional
  reservation/revalidation, cross-user exclusion, real lifecycle concurrency races, and separate
  cold/reuse latency cohorts merged in PR #280. Hosted capacity remains one, so Step 8 stays
  incomplete pending an approved larger profile, disk budget, local/provider two-agent smoke, and
  explicitly authorized provider evidence.

## Issue Graph

- Wave 0: [#263](https://github.com/ametel01/plingpling/issues/263)
- Wave 1: [#264](https://github.com/ametel01/plingpling/issues/264),
  [#265](https://github.com/ametel01/plingpling/issues/265),
  [#266](https://github.com/ametel01/plingpling/issues/266)
- Wave 2: [#267](https://github.com/ametel01/plingpling/issues/267),
  [#268](https://github.com/ametel01/plingpling/issues/268),
  [#269](https://github.com/ametel01/plingpling/issues/269),
  [#270](https://github.com/ametel01/plingpling/issues/270)
- Wave 3: [#271](https://github.com/ametel01/plingpling/issues/271)

## Update Log

### 2026-08-07 — Step 8 repository/local implementation complete

- Implemented fail-closed same-user runner reuse for issue #270 without enabling hosted
  `maxAgents > 1`: selectable capacity is now bounded by computed CPU, physical memory, disk,
  heartbeat, configured, and explicit measured-profile caps. Missing/unmeasured inputs default to
  one.
- Replaced bare runner capacity locks with owner-aware transaction locks and revalidation across
  ready create, legacy create, lifecycle start, Hermes setup, pending deployment placement, runtime
  availability, and runner replacement handover. Durable reservations count
  `desired_status = 'running'`, including stopped ready-mode agents.
- Added cold/reuse/unknown creation-latency cohorts so existing-runner reuse cannot improve
  cold-Droplet p95/SLO evidence.
- Validation passed: `bun run format:check`, `bun run lint`, `bun run typecheck`, focused
  `bun scripts/run-unit-tests.ts tests/unit/runner-resource-profiles.test.ts
  tests/unit/runner-placement.test.ts tests/unit/create-agent-ready-db.test.ts
  tests/unit/agent-creation-latency.test.ts tests/unit/hermes-readiness.test.ts
  tests/unit/start-agent-route.test.ts tests/unit/runner-replacement-handover.test.ts
  tests/unit/runner-service.test.ts`, `bun run test` (175 files / 1718 tests), `bun run build`,
  `bun run test:e2e:ci` (26/26), `bun run repro:cloud-runner`, and `git diff --check`.
- Skipped: `bun run local:agent:smoke` because the serialized local smoke slot was not explicitly
  granted for this builder run. No real provider, deploy, workflow, QStash, hosted-secret, or
  billable action was run.
- Remaining blockers for hosted enablement/#270 completion: no approved larger measured runner
  profile, no approved per-Hermes disk budget/host disk reserve, and no authorized provider-backed
  two-agent trial. Step 9 remains next for provider-backed SLO proof after authorization.

### 2026-08-07 — Step 0 complete

- Created the complete Step 0–9 checklist before implementation.
- Validated and preserved the existing Keep a Changelog structure and content.
- Published issues #263–#271 with native dependency relationships.
- Set Step 1 and issue #263 as the current work.
- Commit: `3d435fc`.

### 2026-08-07 — Step 1 implementation complete

- Implemented the creation-latency report contract for persisted ready, failed, and nonterminal
  deployment rows with deterministic nearest-rank p50/p95 summaries and invalid evidence surfacing.
- Added the read-only `agent:creation:benchmark` command. DigitalOcean mode fails closed unless an
  explicit positive trial count, provider-cost flag, and exact authorization sentinel are present;
  provider execution remains unimplemented and unauthorized in this step.
- Wired successful terminal deployment transitions to one sanitized timing log and wired
  `local:agent:smoke` to emit/return `local_agent_cycle_creation_latency` before database volume
  teardown. The final verified rerun reported a valid 15-stage record with `ready=1`,
  `successRate=1`, `readyLatency.p95Ms=88760`, `issueCounts:{}`, and `digitalOceanRequests=0`.
- Added focused regression coverage for report ordering, ready/failed/incomplete rows, nearest-rank
  percentiles, invalid/missing/duplicate/reversed evidence, PostgreSQL timestamp strings, provider
  fail-closed CLI behavior, local zero-cloud guardrails, smoke wiring, and bootstrap boundary
  redaction.
- Updated `docs/E2E_VALIDATION.md` and `CHANGELOG.md`.
- Gates passed: `bun run verify` (169 files, 1638 tests, production build); focused unit harness
  (10 files, 95 tests); `bun run test:e2e:ci` (26 tests); `bun run local:agent:smoke`; provider
  fail-closed guards; and `bun run agent:creation:benchmark -- --limit 1`.
- Merge: PR #272, commit `7d1cb985c06b0007dadcfb0e42c5631c65b7c472`.
- Next: Step 2 / issue #264 — durable delayed deployment wakeups.

### 2026-08-07 — Step 5 authorization-independent implementation in progress

- Added a canonical DigitalOcean managed-runner resource-profile catalog with vCPU, physical memory,
  disk, monthly price metadata, the documented 384 MiB runner/OS reserve, and the explicit
  low-memory swap-resilience marker.
- Wired hosted config and manual/automatic provisioning through fail-closed compatibility checks for
  supported slugs, CPU, physical memory, PID syntax, and one-agent capacity. Rejected configurations
  stop before SSH-key lookup, Droplet creation/read, firewall mutation, tagging, or cleanup calls.
- Propagated validated Hermes Docker CPU, memory, and PID limits into cloud bootstrap env and runner
  service defaults while preserving Docker hardening enforcement.
- Extended the benchmark CLI to require explicit supported candidate slugs before DigitalOcean
  benchmark authorization can proceed. Provider execution remains unimplemented and unauthorized.
- Updated operator docs, `.env.example`, and changelog. The default Droplet slug remains unchanged
  until explicit provider evidence authorizes a replacement.
- Focused gates passed: `bun --conditions react-server scripts/run-unit-tests.ts
  tests/unit/runner-resource-profiles.test.ts tests/unit/cost-prices.test.ts
  tests/unit/server-env.test.ts tests/unit/cloud-runner-bootstrap.test.ts
  tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts
  tests/unit/agent-creation-benchmark.test.ts` after `bun install` restored missing local tooling.

### 2026-08-07 — Step 5 authorization-independent checker handoff

- Kept the DigitalOcean default slug unchanged because provider-backed size evidence is still not
  authorized. Hosted compatibility now fails closed for the legacy 512 MiB default unless an explicit
  supported physical profile such as `s-1vcpu-2gb` is configured with the canonical Hermes limits.
- Full gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test`
  (170 files, 1,645 tests); `bun run build`; `bun run test:e2e:ci` (26 tests);
  `AGENTBAY_DIGITALOCEAN_SIZE_SLUG=s-1vcpu-2gb AGENTBAY_HERMES_DOCKER_CPUS=1
  AGENTBAY_HERMES_DOCKER_MEMORY=1536m AGENTBAY_HERMES_DOCKER_PIDS_LIMIT=256 bun run
  repro:cloud-runner`; and equivalent `bun run local:agent:smoke`.
- The local agent smoke stayed inside the synthetic local Docker boundary: `digitalOceanRequests=0`,
  one simulated Droplet, agent created/deleted, cleanup verified, and single-run local p95
  `161323` ms. This is behavior evidence only, not DigitalOcean SLO evidence.
- Read-only `bun run agent:creation:benchmark -- --limit 1` completed against the local DB but the
  latest row was incomplete/invalid, so it is not SLO evidence.
- DigitalOcean benchmark mode parsed the explicit authorized candidate slug gate and then stopped at
  the existing reserved/unimplemented provider-trial boundary. No provider resources were created.
- Next: checker review. Merge/default selection remains blocked on green required main CI or accepted
  upstream classification plus explicit provider evidence authorization.

### 2026-08-07 — Step 6 repository implementation ready for review

- Implemented repository-local runner snapshot support for issue #266 without pre-provisioning user
  Droplets or dispatching the protected workflow.
- Added signed canonical snapshot manifests, fail-closed snapshot evidence selection, narrow
  DigitalOcean image/action/provider interfaces, fake-provider cleanup/effect tracing, snapshot-mode
  first boot without apt/package/image pulls, and stock-image rollback behavior.
- Added `.github/workflows/build-runner-snapshot.yml` as a protected `workflow_dispatch`-only
  workflow with pre-secret authorization validation, non-cancelling concurrency, least-privilege
  permissions, unconditional cleanup, and allowlisted manifest artifacts.
- Updated `docs/RUNNER_RELEASES.md`, `README.md`, and `CHANGELOG.md`.
- Gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`;
  `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-manifest.test.ts
  tests/unit/runner-snapshot-build.test.ts tests/unit/runner-snapshot-workflow.test.ts
  tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts
  tests/unit/digitalocean-provider.test.ts`; `bun run test` (172 files, 1,646 tests);
  `bun run build`.
- Skipped by design: protected DigitalOcean workflow dispatch, provider resource creation/deletion,
  environment/secrets configuration, `bun run test:e2e:ci`, `bun run repro:cloud-runner`, and
  `bun run local:agent:smoke` with a local snapshot-equivalent image.
- Step 6 and issue #266 must remain open until explicit live snapshot authorization proves manifest
  artifact attestation and absence of builder/firewall/credential leftovers.

### 2026-08-07 — Step 2 builder implementation ready for checker

- Added `agent_deployment_wakeups` with generation fencing, publish leases, safe error codes, due
  indexes, delivery indexes, migration metadata, and migration fixture assertions.
- Added deployment dispatch configuration with default `cron` mode and fail-closed `qstash` mode
  requiring `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, and an HTTPS
  callback origin.
- Added the dispatch module, protected signed wakeup route, QStash publisher boundary, cron outbox
  sweep, and post-response publication path while retaining targeted reconcile fallback in cron or
  unavailable modes.
- Wired deployment create, retry, release, stage transition, backoff, runner-recovery pause, ready,
  failed, and lifecycle cancellation paths so wakeups are scheduled or terminalized in the same DB
  transaction as the deployment mutation.
- Added focused coverage for env validation, post-response trigger behavior, signed route delivery,
  duplicate/early/unsigned delivery, generation terminalization, migration objects, and cron sweep
  invocation. No real QStash, DigitalOcean, deployment, secret, or billable provider effect was run.
- Gates additionally passed after tracker updates: `bun run test:e2e:ci` (26/26) and
  `bun run local:agent:smoke` with zero DigitalOcean requests and verified cleanup. The local smoke
  p95 was 150.725 seconds, so the overall one-minute SLO remains unmet pending later plan steps.

### 2026-08-07 — Step 4 implementation ready for ordered rebase and checker

- Added deployment- and runner-targeted drains that select at most one deployment, pin its ID after
  the first claim, and continue only across successful `advanced` transitions for at most eight
  stage actions under one shared 45-second deadline and abort signal.
- Rewired post-create fallback, delayed wakeup delivery, runner registration, and heartbeat ingress
  to the drains. Signed delivery publishes the newly persisted exact-time wakeup after a drain, and
  runner ingress commits deployment/runtime initialization before issuing one runtime reconcile.
- Added fake-only semantic coverage for provisioning-to-ready progression, exact ordered events,
  one gateway start, a second due deployment remaining untouched, a persisted two-second gateway
  wait with no early claim, shared deadline/signal behavior, and concurrent runner kicks executing
  one stage action.
- Focused 9-file coverage passed 89 tests. Full gates passed: format, lint, typecheck, 174 unit files
  / 1,703 tests, production build, E2E 26/26 on port 3128, and diff-check. No real DigitalOcean,
  QStash, workflow, snapshot, deploy, secret, or billable effect ran.
- Pending: merge #267 first, rebase this branch without weakening either drain, then run checker and
  the coordinator-serialized `local:agent:smoke` gate.

### 2026-08-07 — Step 4 complete

- Rebased the post-registration drain after Step 3, fixed deadline-abort wakeup replacement, and
  merged issue #268 through PR #277 at `f2fb3f6d`.
- Required repository gates passed, including focused reconciler/trigger/heartbeat races, full unit
  and build, 26/26 E2E, cloud-runner reproduction, and serialized local simulated-Droplet smoke.
- The local smoke produced one simulated Droplet, zero DigitalOcean requests, verified cleanup, and
  152.675 seconds commit-to-ready. This proves safety and orchestration behavior, not the provider
  SLO.

### 2026-08-07 — Step 8 repository/local scope merged; provider acceptance pending

- Merged issue #270 repository scope through PR #280 at `d07ecf97` after five independent review
  cycles closed every assignment, replacement, rollback, capacity, and cross-user race finding.
- Final gates passed: 25 ready-create database races, the 13-file/357-test safety matrix, full 175
  files / 1,733 tests, production build, 26/26 E2E, cloud-runner reproduction, PR CI, and post-merge
  main CI.
- Hosted defaults remain fail-closed at one. Step 8 is not complete until maintainers approve an
  exact larger runner profile and disk budget and explicitly authorize a two-agent provider-backed
  isolation/load trial and required local smoke.
- Next authorization-independent work: specify and prepare Step 7 / issue #269 locally. Do not merge
  it before Step 6 live snapshot evidence exists. Steps 5, 6, 8, and 9 remain provider-gated.
