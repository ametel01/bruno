# One-Minute Cold Agent Deployment — Remaining Implementation Plan

## Status and Basis

This is the remaining-work plan agreed on 2026-08-08 after reconciling the original ten-step plan
with the repository. `PROGRESS.md` preserves the original checklist and append-only execution log.

Merged foundations already present:

- latency event collection and deterministic reports;
- PostgreSQL deployment wakeups with QStash delivery and cron recovery;
- bounded provider-phase and post-registration deployment drains;
- fail-closed runner resource profiles and pre-provider compatibility checks;
- protected snapshot builder, signed manifest v1, and snapshot-mode bootstrap plumbing;
- owner-fenced capacity reservation and separate cold/reuse latency cohorts.

Those foundations are not treated as greenfield work. This plan covers their remaining correctness
gaps, the unimplemented release-attested path, provider acceptance, rollout, and production proof.

## Source Documents

- `/Users/alexmetelli/.codex/attachments/a4c15e87-789f-4506-96d7-4ef1154ad934/pasted-text.txt`
  — original performance assessment and implementation brief.
- `PROGRESS.md` — durable historical execution and validation record.
- `STATUS.md` — current repository and external-gate status.
- `CONTEXT.md` — canonical domain language for deployment, readiness, ownership, and evidence.
- `docs/adr/0001-use-a-cold-deployment-slo.md` — SLO and no-preprovisioning decision.
- `docs/adr/0002-separate-snapshot-attestation-from-approval.md` — snapshot trust decision.
- `docs/adr/0003-pin-rollout-configuration-per-deployment.md` — retry and rollback configuration decision.

## Goal

At least 95 percent of eligible production Cold Deployments must become Ready Deployments within 60
seconds of their request transaction's accepted boundary. A failure, timeout, or slow success is a
miss; successful-only latency percentiles are diagnostic and never determine acceptance.

The target is a hard operational SLO, not a promise that DigitalOcean can satisfy it. Repository
implementation can finish while the goal remains incomplete. The SLO becomes proven only when the
latest 100 eligible production Cold Deployments contain at least 95 ready-within-60-second results,
and that status can regress as the rolling cohort changes.

## Domain and Measurement Contract

- The clock starts at an immutable database-clock `accepted_at` captured as late as practical inside
  the creation transaction. The request is accepted only if that transaction commits, and commit
  latency remains conservatively inside the measurement.
- Existing `created_at` remains audit/order metadata. Existing `runner_accepted_at` remains gateway
  operation acceptance and must not be renamed or reused.
- Historical rows without `accepted_at` are legacy-boundary diagnostics and are excluded from the
  new SLO cohort. They are not backfilled with the earlier application timestamp.
- A Ready Deployment requires the real Hermes gateway to be healthy, intended Telegram
  configuration to be verified, and readiness to be durably committed.
- Crossing 60 seconds records an SLO Miss but does not terminate a recoverable deployment.
- Eligible production observations are real Owner requests that commit and require a newly created
  runner. Explicit operator trials, Same-Owner Reuse, and Owner cancellation before 60 seconds are
  excluded. Provider/internal failures, retries, timeouts, and slow successes remain included.
- Deployment origin and initial cohort classification are persisted transactionally. Subsequent
  Owner cancellation is explicit; reports do not infer or rewrite cohort identity from mutable
  evidence.
- API acceptance availability is separate from the deployment SLO and includes valid requests that
  fail before committing a deployment.
- The decisive measure is ready-within-60-seconds count: at least 29 of 30 provider trials and at
  least 95 of the latest 100 eligible production deployments. Successful-ready p50/p95/max and
  stage distributions remain clearly labeled diagnostics.

## Non-Goals

- No Droplet, warm pool, unassigned ready capacity, onboarding provisioning, or predictive capacity
  may exist before the Owner's request commits.
- Do not redefine `202 Accepted`, runner boot, runner admission, gateway health, or an attested check
  as Ready Deployment.
- Do not share or transfer runners across Owners.
- Do not expand hosted multi-agent capacity in this plan. Existing capacity-one Same-Owner Reuse is
  preserved; the larger-capacity product milestone is a linked follow-up workstream.
- Do not remove protected cron reconciliation or make QStash authoritative.
- Do not restore model-canary calls to production user creation.
- Do not add DigitalOcean credentials to ordinary CI or the credential-free release canary.
- Do not authorize provider spend merely by approving or executing repository work.
- Do not add another cloud provider, observability vendor, or unrelated lifecycle redesign.

## Definition of Done

- `accepted_at`, immutable origin/cohort data, cancellation eligibility, trial-ledger identity, and
  rollout-configuration generation are represented durably and reported without legacy relabeling.
- Reports and operator aggregates use ready-within-60 counts for acceptance, include every relevant
  failure, keep successful-only percentiles diagnostic, and never emit users, tokens, raw endpoints,
  credentials, or bootstrap output.
- Valid pre-commit request failures are visible in API-acceptance availability and authorized trial
  ledgers even when no deployment row exists.
- QStash remains an at-least-once wakeup hint over PostgreSQL state. Poison publishing exhausts
  safely, raises an operational alert, and can be replayed only as a new fenced generation.
- Cron recovery drains at most 25 items or 40 seconds per invocation and cannot duplicate provider
  effects or bypass leases.
- The default managed runner is changed from the invalid 512 MiB profile to a provider-available,
  statically compatible provisional 2 GB profile. Production promotion and later resizing remain
  independently reversible and cost-authorized.
- Snapshot manifest v2 has no time expiry and does not use control-plane source revision as a
  compatibility constraint. Provenance remains signed; compatibility remains exact for immutable
  runner/default-agent/Hermes identities, boot contract, base OS, architecture, region, disk, and
  authoritative provider availability.
- Signed snapshot and release bundles are published as digest-addressed OCI artifacts in GHCR,
  include an Ed25519 key ID, support overlapping trusted keys, and retain at least active and
  previous approved bundles.
- Production approval is the exact protected configuration bundle digest. Promotion replaces it,
  revocation removes it, and rollback restores a retained compatible digest.
- A protected snapshot workflow proves the real DigitalOcean snapshot, full fixture, sanitation,
  and cleanup. A credential-free release workflow separately proves the exact control-plane/runner
  contract and selected snapshot digest. Lightweight readiness requires both.
- `release_attested` distinguishes current-runner Observed Checks from historical Attested Checks.
  Stock mode always runs full validation.
- Rollout configuration is pinned per deployment. Rollback changes defaults for new deployments;
  existing deployments retain their compatible choices unless explicitly quarantined for safety.
- A signed, immutable 30-slot provider cohort passes request acceptance, ready-within-60, identity,
  and cleanup gates. No failed slot is replaced or discarded.
- Guarded production rollout completes with each independent rollback exercised.
- The latest 100 eligible production Cold Deployments contain at least 95 ready-within-60 results.
  The rolling status, alerts, and sanitized signed evidence remain available to operators.
- Required repository gates, local simulated-Droplet smoke, cloud-init validation, release smoke,
  provider cleanup checks, documentation, `PROGRESS.md`, and `CHANGELOG.md` are current.

## External Authorization Contract

Repository implementation and fake/local validation require no provider authorization. Each live
phase requires a separate explicit authorization that names:

- region;
- exact runner size profile(s);
- trial or builder count;
- maximum spend;
- dedicated benchmark Owner and Telegram test bot;
- cleanup and intentionally retained artifact policy.

Separate approval is required for:

1. read-only/provider capability validation if credentials are needed;
2. one live snapshot builder and cleanup proof;
3. size-profile provider observation;
4. the immutable 30-slot acceptance cohort;
5. guarded production rollout.

An authorization does not silently carry into a later phase. Ordinary CI and releases remain
provider-credential-free.

## Rollout and Safety Policy

- Code defaults remain conservative: `cron`, stock image, full validation, and capacity one.
- Protected production configuration explicitly selects QStash, an approved snapshot bundle,
  `release_attested`, and the measured size only after their gates pass.
- Active dispatch mode and pinned artifact/configuration generations are exposed in sanitized health
  or operator evidence.
- Prefer rollback to the previous Approved Snapshot. Retain compatible-size stock mode with full
  validation as last-resort recovery; do not claim it meets the optimized SLO without evidence.
- Immediately halt new cold provisioning on ownership, authentication, artifact-identity,
  duplicate-billable-effect, or cleanup violations.
- Repeated functional failures roll back the affected feature. Isolated latency misses are retained
  and investigated through stage evidence rather than triggering an automatic safety rollback.
- Existing Admitted Runners retain their recorded evidence after a validation-mode rollback.
  Quarantine or replace them only for invalid evidence or runtime health.

## Evidence Retention

- Retain immutable SLO boundary, cohort, configuration, and terminal-outcome fields indefinitely.
- Retain detailed stage events for at least 90 days.
- Retain sanitized signed cohort summaries and snapshot/release OCI bundles indefinitely.
- Retain at least active and previous approved bundles and every signing key still needed to verify
  them.
- Never retain raw provider credentials, Telegram credentials, cloud-init output, or secret-bearing
  endpoints in evidence.

## Remaining Phases

### R1 — Reconcile Measurement Boundaries and Cohort Accounting

Goal: Make the agreed SLO and trial accounting impossible to mislabel or cherry-pick.

Changes:

- Add a migration and schema fields for nullable `accepted_at`, immutable deployment origin and
  cohort, explicit Owner cancellation timing, and rollout-configuration generation.
- Capture `accepted_at` with the database clock late in the creation transaction. Keep old rows null
  and preserve `created_at` and `runner_accepted_at` meanings.
- Version the latency report and use `accepted_at` for new evidence. Surface legacy-boundary,
  missing-boundary, unknown-cohort, and invalid-order issues explicitly.
- Replace successful-only p95 acceptance with ready-within-60 counts. Continue reporting diagnostic
  success/failure and per-stage distributions.
- Add a durable provider-trial ledger whose numbered attempts begin before the create request, link
  to an exact deployment when one commits, and retain pre-commit, runtime, timeout, and cleanup
  outcomes.
- Add immutable benchmark run IDs and exact deployment selection; never select a provider cohort by
  querying only the latest rows.
- Add sanitized operator aggregation for the latest 100 eligible production deployments and API
  acceptance availability.
- Update migration fixtures, deterministic report tests, benchmark tests, redaction tests,
  `docs/E2E_VALIDATION.md`, environment docs, and operator documentation.

Acceptance:

- Historical rows remain diagnostic and cannot enter the new SLO.
- Every authorized trial slot appears once even if no deployment commits.
- A mix of slow successes and failures fails the binary gate even when successful-only p95 is low.
- Owner cancellation affects eligibility only when explicit and before the 60-second boundary.
- Structured output contains no identifying or secret material.

Validation:

- Run focused migration, creation, latency, benchmark, percentile, cohort, cancellation, and
  redaction tests.
- Run `bun run verify`, `bun run test:e2e:ci`, and `bun run local:agent:smoke`.

Progress and changelog:

- Record migration/report versions and gates in `PROGRESS.md`.
- Add an Unreleased entry for the operator-visible corrected latency contract.

### R2 — Harden Delayed Dispatch Recovery and Poison Handling

Goal: Preserve prompt delivery without allowing permanent publication failures or recovery backlog
to grow silently.

Depends on: R1.

Changes:

- Add an `exhausted` wakeup state or equivalent immutable exhausted timestamp, safe reason, and
  indexes that exclude exhausted rows from ordinary claims.
- Add a configurable publish-attempt maximum with default 12. Permanent authentication/payload
  failures exhaust immediately; retryable publication failures consume the bound atomically.
- Emit sanitized operational evidence when a row exhausts.
- Add an operator-only list/inspect and replay surface. Replay terminalizes the exhausted identity
  and creates a new generation transactionally after confirming the deployment is still active.
- Drain cron recovery in a bounded loop of at most 25 items or 40 seconds while preserving leases,
  generation fences, and one-provider-effect invariants.
- Keep code default `cron`; require explicit complete QStash production configuration and expose the
  active mode.
- Add duplicate, reordered, concurrent exhaustion/replay, QStash outage, cron backlog, deadline, and
  stale-deployment tests plus a runbook.

Acceptance:

- No poison row is reclaimed indefinitely.
- Replay cannot reuse a delivery identity or revive terminal work.
- A QStash outage remains recoverable through bounded cron work without duplicate Droplets.
- A scheduled short retry uses delayed delivery near its due time when QStash mode is enabled.

Validation:

- Run focused schema, dispatch, signed-route, cron, replay, lease, and provider-effect tests.
- Run `bun run verify`, `bun run test:e2e:ci`, and both cron/fake-QStash local smoke modes.

Progress and changelog:

- Record poison/replay and backlog evidence in `PROGRESS.md`.
- Add an Unreleased entry for exhausted-wakeup recovery and operator replay.

### R3 — Promote a Compatible Runner Size and Snapshot Attestation v2

Goal: Make new runners physically viable and establish durable, revocable snapshot trust.

Depends on: R1–R2.

Changes:

- Confirm `s-1vcpu-2gb` availability and one-agent resource behavior in the configured region, then
  replace the invalid 512 MiB code default. Keep the production selection independently reversible.
- Bump snapshot schema to v2. Remove `expiresAt`, maximum-age rejection, and source revision from
  compatibility inputs. Retain signed source repository/revision and timestamps as provenance.
- Reject v1 for production approval; no promoted v1 artifact exists.
- Bind compatibility to exact immutable runner/default-agent/Hermes digests, boot contract, base
  image, architecture, region, disk, and authoritative provider image availability.
- Add signed-bundle key IDs and an operator-managed trusted Ed25519 public-key set with overlap for
  rotation and rollback.
- Publish sanitized signed snapshot bundles to GHCR as digest-addressed OCI artifacts. Continue
  uploading Actions artifacts only as workflow convenience.
- Model approval through the exact protected production bundle digest; document promotion,
  supersession, revocation, key rotation, and previous-snapshot rollback.
- With separate authorization, run one protected DigitalOcean snapshot build. Verify full fixture,
  sanitation, snapshot availability, builder/firewall/key/token cleanup, and retained bundle digest.

Acceptance:

- The provisional default passes static checks and authorized regional provider observation before
  production promotion.
- Manifest v2 never expires by time and an unrelated control-plane commit does not invalidate it.
- Revoked/untrusted/mismatched/unavailable evidence fails before a Droplet create.
- Active and previous approved bundles remain independently verifiable.
- Live builder resources are absent after every terminal path.

Validation:

- Run focused resource-profile, environment, manifest, signing, key-rotation, OCI publication,
  provider, snapshot workflow, sanitation, cleanup, and redaction tests.
- Run `bun run verify`, `bun run test:e2e:ci`, `bun run repro:cloud-runner`, and snapshot-equivalent
  local smoke.
- Run provider checks only under their exact authorization.

Progress and changelog:

- Record selected profile, manifest/bundle digests, key ID, live authorization, and cleanup evidence
  in `PROGRESS.md`.
- Add Unreleased entries for the compatible default and snapshot-attestation v2.

### R4 — Restore Verified Releases and Release-Attested Readiness

Goal: Remove the synthetic Hermes fixture from eligible snapshot boots without weakening admission.

Depends on: R3 live snapshot evidence.

Changes:

- Restore the credential-free full-fixture release canary as a promotion dependency.
- Generate, sign, publish, and consume a release OCI bundle binding exact control-plane/runner
  contract evidence, immutable images, boot contract, selected snapshot bundle digest, full fixture,
  and cleanup.
- Join snapshot and release evidence by immutable identities. Do not give the release workflow
  DigitalOcean credentials or claim it booted the provider snapshot.
- Version the boot/readiness contract and add `full|release_attested` modes.
- Represent `observedChecks` separately from `attestedChecks`. Lightweight boot observes Docker,
  required services, injected bundle digests, and exact preloaded images; control-plane admission
  additionally requires authenticated registration, heartbeat, readiness, and exact release
  compatibility.
- Do not launch a synthetic Hermes fixture in `release_attested`. Preserve the full fixture for
  stock mode, local smoke, snapshot publication, release validation, and explicit diagnostics.
- Persist selected rollout configuration generation, bundle identities, size, dispatch mode, and
  validation mode per deployment.
- Restore exact-artifact rollback and ensure new-runner validation rollback does not reinterpret
  existing Admitted Runners.

Acceptance:

- Lightweight mode cannot be selected without both approved snapshot and verified release bundles.
- Historical fixture evidence is never represented as a current-machine observation.
- Stock mode always performs full validation.
- Promotion and rollback verify exact bundle/image/contract identities and cleanup.

Validation:

- Run focused boot-contract, parser, heartbeat, admission, release-attestation, workflow, OCI,
  compatibility, rollback, and redaction tests.
- Run `bun run verify`, `bun run test:e2e:ci`, `bun run repro:cloud-runner`, and local smoke in both
  modes.
- Run `bun run runner:release:smoke -- --image <immutable-image> --provider local_docker` and retain
  its exact signed bundle evidence.

Progress and changelog:

- Record release/snapshot bundle linkage, observed/attested checks, gates, and rollback evidence in
  `PROGRESS.md`.
- Add an Unreleased entry for verified release-attested readiness.

### R5 — Run Authorized Provider Acceptance and Guarded Rollout

Goal: Demonstrate the complete cold path safely before exposing it as the production default.

Depends on: R1–R4.

Changes:

- Implement a resumable, sequential provider driver with an immutable 30-slot ledger, dedicated
  benchmark Owner and Telegram test bot, exact deployment IDs, per-slot timeout, checkpoint/resume,
  budget/quota handling, terminal cleanup, and authoritative provider-absence verification.
- Include request attempts that fail before deployment commit in API acceptance availability.
- After a cohort starts, consume a slot for every harness, provider, deployment, readiness, timeout,
  or cleanup outcome. Never discard or replace a failed slot.
- Pause immediately on leaked resources, duplicate billable effects, ownership/authentication
  violations, or artifact-identity mismatch. Preserve the slot and require renewed authorization to
  resume the same ledger.
- Require at least 29 of 30 valid attempts to commit, at least 95% of committed deployments to be
  ready within 60 seconds, and at least 29 of all 30 numbered slots to finish ready within 60
  seconds. Thus one pre-commit failure is allowed only when every committed slot passes readiness.
- Produce a sanitized signed report with identities, configuration generation, region, size,
  outcome, stage distributions, and cleanup. Tombstone benchmark agents while retaining permitted
  evidence.
- Roll out QStash, bounded recovery, provisional size, approved snapshot, and
  `release_attested` through protected configuration. Exercise each independent rollback.
- Halt new cold provisioning for safety violations. Use repeated functional failures for feature
  rollback and rolling stage evidence for performance decisions.

Acceptance:

- The immutable provider cohort passes both request-acceptance and ready-within-60 gates.
- Every billable resource and credential is absent or intentionally retained in the signed record.
- Each rollback path is tested without reinterpreting active deployments.
- Synthetic trials remain excluded from the production SLO cohort.

Validation:

- Run all repository gates and release/local smoke gates before provider work.
- Run the exact authorized DigitalOcean cohort and cleanup audit.
- Verify sanitized artifacts independently before guarded production promotion.

Progress and changelog:

- Record authorization scope, ledger/bundle digest, all outcomes, cleanup, rollbacks, and promotion
  state in `PROGRESS.md`.
- Add an Unreleased entry for the shipped guarded cold-path behavior, not for evidence alone.

### R6 — Observe the Rolling Production Cohort

Goal: Prove and continuously evaluate the hard SLO with real eligible production requests.

Depends on: guarded rollout in R5.

Changes:

- Continuously evaluate the latest 100 Eligible Cold Deployments using immutable accepted/cohort and
  terminal fields.
- Exclude only tagged operator trials, Same-Owner Reuse, and explicit Owner cancellations before 60
  seconds. Include all provider/internal failures, retries, timeouts, and slow successes.
- Expose sanitized ready-within-60 count, API acceptance availability, successful-only diagnostic
  distributions, stage evidence, active configuration generations, and SLO status through the
  existing operator surface.
- Open an incident and remove proven status whenever the rolling result drops below 95 of 100.
- Retain signed point-in-time summaries without rewriting historical reports.

Acceptance:

- At least 95 of the latest 100 eligible production Cold Deployments are ready within 60 seconds.
- The cohort contains no synthetic trials and no silently omitted failures.
- Current operational status and historical signed evidence are both available.
- All Definition of Done items and documentation are current.

Progress and changelog:

- Keep the goal active while fewer than 100 eligible observations exist.
- When the gate first passes, record the signed summary digest and mark the goal proven.
- If it later regresses, record the incident and current unproven status; do not rewrite the earlier
  result.
- Do not add a changelog entry for observation alone.

## Follow-Up Workstream: Multi-Agent Same-Owner Capacity

The product requirement for multiple agents on one runner remains valid but is outside this cold
deployment plan. Current hosted capacity stays fail-closed at one. A separate authorized plan must
define per-Hermes disk budget, host reserve, live CPU/memory/disk telemetry, larger measured profiles,
two- and three-agent isolation/load tests, concurrent placement behavior, restart/delete/log
isolation, provider cost, and the Milestone 14 acceptance gate. Reuse results must remain separate
from Cold-Deployment SLO evidence.

## Canonical Quality Gates

- Install: `bun install --frozen-lockfile`
- Format: `bun run format:check`
- Lint: `bun run lint`
- Typecheck: `bun run typecheck`
- Unit/integration: `bun run test`
- Build: `bun run build`
- Combined repository gate: `bun run verify`
- Browser E2E: `bun run test:e2e:ci`
- Cloud reproduction: `bun run repro:cloud-runner`
- Local lifecycle smoke: `bun run local:agent:smoke`
- Release smoke: `bun run runner:release:smoke -- --image <immutable-image> --provider local_docker`

Use focused tests during each phase, then the proportional full gates listed above. Provider-backed
commands run only with the phase's explicit authorization.

## Progress and Changelog Rules

- `PROGRESS.md` remains append-only for execution evidence. Preserve its original Step 0–9 history
  and use R1–R6 for this rebased plan.
- After each phase, append completed work, exact validations, external authorization if any, commit
  reference, current status, and next phase.
- Preserve the existing Keep a Changelog structure and history.
- Update `CHANGELOG.md` only for validated functional changes. Omit entries for plans, tracking,
  evidence-only runs, tests, CI, docs-only updates, and empty headings.

## Goal Handoff

This plan is ready as the bounded execution payload. It authorizes repository implementation and
local/fake validation only. It must pause at every provider-backed gate until the exact external
authorization is supplied. The goal is complete only when R1–R6 and every Definition of Done item
are satisfied; lack of traffic, provider variance, or missing spend authorization must not be hidden
by synthetic observations, pre-created capacity, or a success boundary short of Ready Deployment.
