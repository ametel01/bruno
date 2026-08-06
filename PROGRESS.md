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
- Provider-backed acceptance gate: pending explicit authorization.

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
  teardown. The final verified rerun reported `ready=1`, `successRate=1`, `readyLatency.p95Ms=88223`,
  and `digitalOceanRequests=0`.
- Added focused regression coverage for report ordering, ready/failed/incomplete rows, nearest-rank
  percentiles, invalid/missing/duplicate/reversed evidence, PostgreSQL timestamp strings, provider
  fail-closed CLI behavior, local zero-cloud guardrails, smoke wiring, and bootstrap boundary
  redaction.
- Updated `docs/E2E_VALIDATION.md` and `CHANGELOG.md`.
- Gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; focused unit harness
  for Step 1 tests; `bun run test` (169 files, 1628 tests); `bun run build`; `bun run test:e2e:ci`
  (26 tests); `bun run local:agent:smoke`; `bun run agent:creation:benchmark -- --limit 1`.
- Commit: this Step 1 implementation commit.
- Next: Step 2 / issue #264 — durable delayed deployment wakeups.
