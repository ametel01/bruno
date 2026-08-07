# One-Minute Cold Agent Creation Progress

Source: [`PLAN.md`](PLAN.md)

This file is the durable execution record for the plan. Update it after every completed step with
validation results, the commit reference when available, the current status, and the next step.
The update log is append-only.

## Status

- Current step: Step 2 — durable delayed deployment wakeups
- Overall status: in progress
- SLO target: at least 95% success and p95 committed-create-to-durable-ready latency at or below 60
  seconds across 30 clean cold DigitalOcean trials
- Provider acceptance: authorization-gated; not yet authorized or run
- Capacity policy: no pre-provisioned Droplets, warm pools, predictive capacity, or cross-user sharing

## Checklist

- [x] Step 0 — Progress and changelog tracking setup
- [x] Step 1 — Creation-latency evidence and benchmark
- [ ] Step 2 — Durable delayed deployment wakeups
- [ ] Step 3 — Bounded drain for provider provisioning phases
- [ ] Step 4 — Bounded drain for post-registration deployment stages
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
