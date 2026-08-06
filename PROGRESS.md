# One-Minute Cold Agent Creation Progress

Source: [`PLAN.md`](PLAN.md)

This file is the durable execution record for the plan. Update it after every completed step with
validation results, the commit reference when available, the current status, and the next step.
The update log is append-only.

## Status

- Current step: Step 1 — creation-latency evidence
- Overall status: in progress
- SLO target: at least 95% success and p95 committed-create-to-durable-ready latency at or below 60
  seconds across 30 clean cold DigitalOcean trials
- Provider acceptance: authorization-gated; not yet authorized or run
- Capacity policy: no pre-provisioned Droplets, warm pools, predictive capacity, or cross-user sharing

## Checklist

- [x] Step 0 — Progress and changelog tracking setup
- [ ] Step 1 — Creation-latency evidence and benchmark
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
- Required implementation gates: pending Step 1 changes.
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
- Commit: pending in the Step 0 tracking commit; record its reference in the next update.

