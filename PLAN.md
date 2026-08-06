# Implementation Plan

## Source Documents

- Path: `/Users/alexmetelli/.codex/attachments/a4c15e87-789f-4506-96d7-4ef1154ad934/pasted-text.txt`
  - Role: Primary performance assessment and implementation brief.
  - Summary: Identifies orchestration delays, stock-image bootstrap work, serial image pulls,
    undersized runners, duplicate boot validation, and one-agent capacity as contributors to the
    approximately 15-minute agent-creation path. It proposes a one-minute target, faster durable
    reconciliation, a versioned runner snapshot, larger runners, release-time boot validation, and
    same-user runner reuse.

## Goals

- Reduce cold agent creation, including creation of a new DigitalOcean Droplet after the user
  submits the request, from approximately 15 minutes toward a measured p95 of 60 seconds or less.
- Define the latency SLO as the interval from the committed `POST /api/agents` deployment request to
  the corresponding deployment reaching durable `ready` state.
- Remove avoidable minute-scale orchestration gaps while preserving leases, idempotency,
  crash recovery, cleanup ownership, and the once-per-minute cron as a recovery sweeper.
- Replace stock-Ubuntu package installation and full image downloads with a versioned,
  release-attested DigitalOcean snapshot whose first boot injects only instance-specific state.
- Right-size new runners so image extraction and Hermes startup do not depend on sustained swap.
- Move the full synthetic Hermes fixture out of the per-Droplet user-creation path only after the
  equivalent release/snapshot gate is restored and enforced.
- Preserve owner isolation and support reuse only for spare capacity on an already running runner
  owned by the same user.
- Produce sanitized stage-level and end-to-end measurements that can prove or disprove the target
  in local simulation and explicitly authorized provider-backed trials.

## Non-Goals

- Do not create Droplets before the user submits the agent-creation request.
- Do not add warm pools, unassigned ready capacity, onboarding-time provisioning, predictive
  provisioning, or asynchronous pool replenishment.
- Do not transfer or claim a Droplet between users, and do not introduce shared multi-tenant
  runners.
- Do not redefine a `202 Accepted` response as successful creation; the SLO ends only at durable
  agent readiness.
- Do not remove the protected cron reconciliation routes; they remain the recovery boundary for
  lost queue deliveries and request-scope callbacks.
- Do not restore model-canary calls to the production user-creation path.
- Do not add another cloud provider or redesign unrelated agent lifecycle, billing, authentication,
  backup, or UI behavior.
- Do not automatically run billable DigitalOcean benchmarks from ordinary CI or release workflows.

## Definition of Done

- Agent creation records a sanitized end-to-end latency and stage breakdown from deployment commit
  through Droplet provisioning, runner readiness, Hermes startup, Telegram verification, and
  durable `ready` completion.
- A repository-owned benchmark command reports count, success rate, p50, p95, maximum, and
  per-stage durations without printing secrets, raw endpoint credentials, or provider tokens.
- Deployment wakeups are durably represented in PostgreSQL and delivered at the persisted due time
  through authenticated delayed delivery; duplicate, reordered, retried, and dropped deliveries
  cannot duplicate Droplets or bypass deployment leases.
- Immediately executable provisioning phases are drained in one bounded execution while retaining
  a durable checkpoint after every provider effect. Ambiguous provider outcomes still fail closed
  and never repeat a billable create without authoritative discovery.
- Runner registration, heartbeat, gateway start, and retry events schedule prompt targeted work;
  the minute cron is demonstrably a fallback rather than the normal creation scheduler.
- The default cold-path runner size is supported by measured resource evidence and no longer relies
  on the 512 MB host plus swap to satisfy a 1536 MB Hermes container limit.
- A protected, explicitly dispatched snapshot workflow creates a versioned DigitalOcean snapshot
  from immutable runner and Hermes digests, verifies the full boot contract, sanitizes instance
  identity and credentials, makes the snapshot available in the target region, and cleans its
  temporary builder resources.
- Production Droplet creation selects an approved snapshot identity and rejects a missing,
  unverified, stale, region-incompatible, or digest-mismatched snapshot before a billable create.
- Per-Droplet readiness performs only the attested lightweight checks after the release and snapshot
  gates are enforced; full fixture validation remains available locally and in release/snapshot
  validation.
- Same-user runner reuse remains capacity-checked, resource-limited, and opt-in through configured
  capacity; cross-user reuse remains impossible.
- Rollout is feature-flagged or configuration-gated so operators can independently revert delayed
  dispatch, snapshot selection, lightweight readiness, and the new runner size without corrupting
  active deployment state.
- All repository quality gates pass, the local simulated-Droplet lifecycle passes, cloud-init syntax
  validation passes, and the release smoke passes against the exact immutable artifacts.
- After explicit cost and provider authorization, at least 30 clean cold-path DigitalOcean trials
  in the selected production region achieve at least 95% success and p95 commit-to-ready latency of
  60 seconds or less. Failed runs are included in the report rather than discarded.
- If the provider-backed p95 remains above 60 seconds after all in-scope work, the goal is not marked
  complete. The evidence and remaining provider floor are documented for a separate decision; this
  plan must not silently add pre-provisioning as a fallback.
- `PROGRESS.md`, `CHANGELOG.md`, operator documentation, environment-variable documentation, release
  procedures, rollback procedures, and benchmark evidence are current.

## Assumptions and Open Questions

- The user's instruction to exclude pre-provisioning supersedes the source document's warm-capacity
  recommendation. Consequently, the 60-second target is a cold-path performance hypothesis that
  must be demonstrated against DigitalOcean rather than treated as guaranteed.
- The primary benchmark region is the configured `AGENTBAY_DIGITALOCEAN_REGION`; expand to other
  regions only after the first region meets the SLO.
- Use Upstash QStash as the initial delayed-delivery adapter because the application is deployed on
  Vercel and QStash supports signed, retried, delayed HTTP delivery. Keep the domain interface small
  enough to replace the adapter later. Required configuration is `QSTASH_TOKEN`,
  `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY`.
- QStash delivery is at least once. PostgreSQL deployment generation, leases, idempotency keys, and
  provider operation tags remain authoritative; a queue message is only a wakeup hint.
- The existing cron secret must not be reused as QStash authority. Queue payloads contain only the
  deployment ID and generation/due-time fencing data.
- The initial right-size candidate is a supported 2 GB DigitalOcean size for one Hermes agent. The
  exact slug and any higher-capacity profile must be confirmed by the benchmark before changing the
  production default.
- Snapshot creation is a separate protected and manually authorized workflow. Do not add a
  DigitalOcean token to the ordinary `ci.yml` or automatic runner-image publication job.
- Snapshot artifacts are coupled to the immutable runner image, Hermes workload digest, boot
  contract version, Ubuntu base, architecture, and region. Changing any member requires a new
  attested snapshot identity.
- Full provider-backed trials create billable resources and require the existing explicit
  DigitalOcean authorization controls plus an agreed run budget. The executing goal must pause for
  authorization at that step if it has not already been supplied.
- The existing `CHANGELOG.md` already follows Keep a Changelog structure. Step 0 must preserve and
  validate it rather than replacing its history.

## Implementation Approach

- Treat PostgreSQL as the source of truth. Add a small outbox/wakeup record linked to a deployment
  generation and due time. Commit the deployment mutation and wakeup atomically, then publish it to
  QStash after commit. Delivery calls a signed internal route that attempts targeted reconciliation.
  A cron sweeper republishes unsent or expired wakeups so queue or request-scope failures remain
  recoverable.
- Separate state-machine durability from execution cadence. Each provider effect retains its
  existing before/after persistence and operation tag, but one invocation continues through safe,
  immediately executable phases until it reaches an external wait, terminal result, cancellation,
  iteration limit, or action deadline.
- Apply the same bounded-drain pattern after runner ingress. A heartbeat or delayed wakeup may move
  through multiple zero-wait stages, while gateway convergence is rescheduled at the exact persisted
  backoff instead of waiting for the next minute tick.
- Introduce configuration modes with safe defaults during rollout:
  - `AGENTBAY_DEPLOYMENT_DISPATCH_MODE=cron|qstash`, initially `cron` until QStash preflight passes.
  - `AGENTBAY_RUNNER_BOOT_VALIDATION_MODE=full|release_attested`, initially `full` until snapshot and
    release evidence is enforced.
  - Continue using `AGENTBAY_DIGITALOCEAN_IMAGE` and
    `AGENTBAY_DIGITALOCEAN_SIZE_SLUG`, but validate approved snapshot metadata and the selected
    measured size before provisioning.
- Build snapshots in a dedicated protected workflow using repository-owned scripts and the existing
  DigitalOcean SDK boundary. The builder installs Docker and Caddy, preloads exact immutable images,
  installs the runner service definition, executes the full boot fixture, removes credentials,
  logs, cloud-init state, SSH host keys, machine identity, and agent data, then powers down before
  snapshotting. Cleanup must run on success, failure, cancellation, and ambiguous provider outcomes.
- Restore the simulated-Droplet release canary before allowing `release_attested` readiness. The
  snapshot workflow and release workflow must emit machine-readable evidence consumed by production
  configuration; mutable names or operator assertions alone are insufficient.
- Roll out in shadow/evidence mode first: collect timings without changing readiness, then enable
  QStash dispatch, then bounded draining, then the larger size, then snapshot selection, and finally
  lightweight per-Droplet readiness. Each switch has an independent rollback.

## Quality Gates

- Setup status: Existing gates are clearly configured in `package.json`, `biome.json`,
  `vitest.config.ts`, `tsconfig.json`, `.github/workflows/ci.yml`, and the runner smoke scripts. No
  quality-gate setup step is required.
- Baseline command: `bun install --frozen-lockfile && bun run verify && bun run test:e2e:ci`
- Format command: `bun run format:check`
- Lint command: `bun run lint`
- Test command: `bun run test`
- Additional gates: `bun run typecheck`, `bun run build`, `bun run test:e2e:ci`,
  `bun run repro:cloud-runner`, `bun run local:agent:smoke`, and the capability-gated
  `bun run runner:release:smoke -- --image <immutable-image> --provider local_docker`.
- Provider acceptance gate: the benchmark command added in Step 1, run only with explicit
  DigitalOcean authorization and sanitized retained evidence.

## Progress Tracking

- File: `PROGRESS.md`
- Requirement: Create `PROGRESS.md` before any quality-gate setup or implementation work begins.
- Update rule: After each step is completed, update `PROGRESS.md` with the completed step,
  validation results, commit reference if available, current status, and next step.

## Changelog Tracking

- File: `CHANGELOG.md`
- Standard: Keep a Changelog 1.0.0, <https://keepachangelog.com/en/1.0.0/>
- Requirement: Validate and preserve the existing `CHANGELOG.md` before implementation begins.
- Initial content: Retain `# Changelog`, the standard preamble, the existing `## [Unreleased]`
  section, and its current history.
- Update rule: After each step is completed and validated, update `CHANGELOG.md` before creating that
  step's commit only if the step shipped a functional change. Omit entries for chores, progress
  tracking, implementation plans, docs-only updates, tests or coverage, CI or validation runs,
  framework migration housekeeping, and empty category headings.

## Goal Handoff

- Readiness: This plan is ready to be used as a `/goal` payload.
- Scope: The `/goal` should execute only the work described in this plan unless the user explicitly
  expands it. In particular, it must not add pre-provisioning or warm capacity.
- Done: The `/goal` is complete only when every item in `## Definition of Done` is satisfied, all
  incremental steps are complete, required quality gates pass or documented pre-existing failures
  are handled, `PROGRESS.md` and `CHANGELOG.md` are current, and the final state is summarized for
  the user.

## Incremental Steps

### Step 0: Progress and Changelog Tracking Setup

Goal: Create durable progress tracking and validate the changelog before implementation starts.

Changes:

- Create `PROGRESS.md` in the project root with the plan title and source, the complete Step 0-9
  checklist, current status, next step, validation summary, and append-only update log.
- Document in `PROGRESS.md` that it must be updated after every completed step.
- Validate the existing `CHANGELOG.md` against Keep a Changelog 1.0.0 and preserve its current
  history and `## [Unreleased]` content.
- Document that `CHANGELOG.md` is updated only for validated functional changes.

Acceptance criteria:

- `PROGRESS.md` exists and lists every incremental step with Step 0 marked complete.
- `CHANGELOG.md` retains its existing entries, standard preamble, and top-level
  `## [Unreleased]` section.
- No implementation or runtime behavior changes in this step.

Validation:

- Run `test -f PROGRESS.md && test -f CHANGELOG.md`.
- Inspect both headings and confirm no existing changelog content was lost.

Progress:

- Mark Step 0 complete in `PROGRESS.md`, record validation, set Step 1 as current, and add the commit
  reference after committing if available.

Changelog:

- Do not add a changelog entry because tracking setup is not a functional change.

Commit:

- `chore: initialize fast-creation progress tracking`

### Step 1: Establish the Baseline and Latency Evidence Contract

Goal: Make the current cold path measurable end to end before changing its behavior.

Depends on:

- Step 0

Changes:

- Add `src/server/agents/agent-creation-latency.ts` to derive commit-to-ready/failed latency from
  `agent_deployments.created_at`, `completed_at`, and `failed_at`, plus stage timing from deployment
  and runner provisioning events.
- Extend `src/server/runners/cloud-runner-bootstrap.ts` and bootstrap-event ingestion so every
  package, image-pull, container-start, registration, boot-validation, and readiness boundary has a
  sanitized started/completed/failed timestamp.
- Add `scripts/benchmark-agent-creation.ts` and a package command that can summarize existing runs or
  drive an explicitly authorized number of local/provider cold trials, always including failures.
- Emit a single structured completion log with deployment ID, runner ID, outcome, total duration,
  and bounded stage durations; do not include user IDs, tokens, endpoints, secret values, or raw
  cloud-init output.
- Add unit tests for duration calculation, missing/duplicate events, terminal failures, percentile
  calculation, output redaction, and deterministic ordering.
- Update `docs/E2E_VALIDATION.md` with the exact SLO boundary, benchmark usage, authorization
  requirements, evidence format, and cleanup expectations.

Acceptance criteria:

- The benchmark reports count, successes, failures, success rate, p50, p95, maximum, and per-stage
  distributions from deterministic fixture data.
- A local simulated cold creation produces a complete timing record.
- Missing stages are reported as missing evidence rather than silently treated as zero duration.
- This step records the baseline but does not change scheduling or boot behavior.
- Advances Definition of Done by creating the measurement and evidence contract.

Validation:

- Run targeted latency, bootstrap-event, deployment, and redaction tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run local:agent:smoke` and generate a sanitized benchmark summary from that run.

Progress:

- Update `PROGRESS.md` with Step 1 completion, baseline evidence, gate results, commit reference if
  available, current status, and Step 2 as next.

Changelog:

- Add an `Added` entry under `## [Unreleased]` describing operator-visible agent-creation latency
  evidence and the benchmark command.

Commit:

- `feat: add agent creation latency evidence`

### Step 2: Add Durable Delayed Deployment Wakeups

Goal: Deliver retries at their persisted due times without making the minute cron the normal path.

Depends on:

- Steps 0-1

Changes:

- Add a Drizzle migration and schema table for deployment wakeups/outbox rows with deployment ID,
  deployment generation, due time, state, bounded attempt count, provider message ID, lease fields,
  last safe error code, and timestamps. Add uniqueness and due-work indexes.
- Add `src/server/agents/agent-deployment-dispatch.ts` with an adapter interface, a QStash adapter,
  outbox claim/publish/ack/retry operations, and a disabled `cron` mode.
- Add a signed internal App Router POST endpoint for QStash delivery. Verify QStash signatures with
  current and next signing keys before reading the bounded JSON payload.
- Add a protected cron/outbox sweep path that republishes due unacknowledged work; retain the
  existing deployment cron as the final recovery path.
- Atomically create or supersede a wakeup whenever deployment work persists `next_attempt_at`.
- Publish after commit through the existing `after()` seam, but treat that publication as lossy;
  outbox state remains authoritative.
- Validate `AGENTBAY_DEPLOYMENT_DISPATCH_MODE` and QStash capability names in `src/server/env.ts` and
  `.env.example`; fail closed when `qstash` is selected without complete signing configuration.
- Add unit/database/route tests for signatures, duplicate delivery, stale generation, publish
  failure, retry, claim fencing, cron recovery, terminal deployment cancellation, and secret
  redaction.

Acceptance criteria:

- A scheduled 2-second retry is delivered near its due time in adapter tests rather than waiting for
  a minute boundary.
- At-least-once duplicate delivery performs at most one claimed deployment action.
- Lost post-response publication remains recoverable from the outbox and cron.
- Queue mode can be disabled without schema rollback and existing deployment rows remain valid.
- Advances Definition of Done by providing durable prompt wakeups.

Validation:

- Run targeted dispatch schema, persistence, route-authentication, trigger, and deployment tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run local:agent:smoke` in `cron` mode and with a fake delayed-delivery adapter.

Progress:

- Update `PROGRESS.md` with Step 2 completion, migration and failure-recovery evidence, gate results,
  commit reference if available, current status, and Step 3 as next.

Changelog:

- Add an `Added` entry describing durable prompt deployment wakeups and cron fallback.

Commit:

- `feat: add durable deployment wakeups`

### Step 3: Drain Immediately Executable Droplet Provisioning Phases

Goal: Complete discovery, create, tagging, firewall, and endpoint transitions without one scheduler
tick per phase.

Depends on:

- Steps 0-2

Changes:

- Refactor `src/server/runners/runner-provisioning.ts` so automatic provisioning can process a
  bounded sequence of immediately executable phases in one action context.
- Preserve the existing operation tag before create, authoritative discovery, provider-effect
  checkpoints, cleanup ownership, abort handling, and ambiguous-outcome rules after each phase.
- Stop draining on `waiting_for_runner`, missing public endpoint, provider ambiguity, retryable
  transport failure, cancellation, action deadline, iteration bound, or terminal state.
- Avoid repeating the already-applied tags from the Droplet create request unless authoritative
  provider state proves a correction is required.
- Update `src/server/agents/agent-deployment-reconciler.ts` to persist the next precise wakeup rather
  than scheduling exponential delay after a successful immediately executable phase.
- Expand `tests/unit/automatic-runner-provisioning.test.ts`,
  `tests/unit/agent-deployment-reconciler.test.ts`, and provider tests to characterize multi-phase
  success, crash points between every phase, duplicate triggers, and ambiguous create outcomes.

Acceptance criteria:

- The normal fake-provider cold path reaches `waiting_for_runner` in one bounded invocation after
  one billable create.
- Injected crashes after create, tagging, or firewall resume from the persisted checkpoint without
  duplicating the Droplet or losing cleanup ownership.
- One invocation never exceeds the action deadline or configured phase bound.
- Advances Definition of Done by removing provider-phase scheduler gaps.

Validation:

- Run targeted automatic-provisioning, provider, reconciler, cancellation, and finalization-race
  tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run repro:cloud-runner`.
- Run `bun run local:agent:smoke` and compare the orchestration portion with the Step 1 baseline.

Progress:

- Update `PROGRESS.md` with Step 3 completion, before/after orchestration evidence, gate results,
  commit reference if available, current status, and Step 4 as next.

Changelog:

- Add a `Changed` entry describing faster cold-runner provisioning without reduced recovery safety.

Commit:

- `perf: drain safe runner provisioning phases`

### Step 4: Drain Post-Registration Deployment Stages Promptly

Goal: Move from runner readiness through Hermes and Telegram readiness without one heartbeat or cron
tick per zero-wait stage.

Depends on:

- Steps 0-3

Changes:

- Add a bounded targeted-drain function in
  `src/server/agents/agent-deployment-reconciler.ts` that continues only after `advanced` outcomes
  and stops on external wait, future `next_attempt_at`, terminal state, lost lease, iteration limit,
  or action deadline.
- Use the drain function from QStash delivery, post-create triggers, runner registration, and runner
  heartbeat scheduling while preserving the current deployment-before-runtime ordering.
- After an accepted gateway start, persist and dispatch a short readiness wakeup at the exact due
  time rather than waiting for a 30-second heartbeat. Keep runner heartbeats as independent health
  evidence.
- Ensure cancellation, Stop, Delete, replacement, retry, and terminal cleanup supersede pending
  wakeups through deployment-generation fencing.
- Add deterministic tests covering `provisioning_runner → configuring_hermes → starting_gateway`,
  ready gateway to Telegram finalization, not-yet-ready polling, queue duplication, heartbeat races,
  finalization races, and dropped delivery recovery.

Acceptance criteria:

- A ready fake runner advances through every zero-wait deployment stage in one bounded drain.
- A gateway that becomes ready after a short delay is revisited at the persisted delay without a
  heartbeat or minute cron.
- No drain spins on a future retry or monopolizes a request beyond its deadline.
- Advances Definition of Done by removing post-registration scheduler gaps.

Validation:

- Run targeted deployment reconciler, trigger, heartbeat-route, cancellation, retry, and
  finalization-race tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run local:agent:smoke` and compare the complete local latency with Step 1.

Progress:

- Update `PROGRESS.md` with Step 4 completion, before/after stage-gap evidence, gate results, commit
  reference if available, current status, and Step 5 as next.

Changelog:

- Add a `Changed` entry describing prompt progression from runner readiness to usable agent.

Commit:

- `perf: drain ready agent deployment stages`

### Step 5: Right-Size Cold Runners and Preserve Resource Isolation

Goal: Remove the default host-memory mismatch that makes startup dependent on swap.

Depends on:

- Steps 0-4

Changes:

- Add a sanitized size-profile benchmark mode to `scripts/benchmark-agent-creation.ts` that compares
  configured DigitalOcean sizes while keeping region, image, and workload digests fixed.
- Add validation that the configured runner size is compatible with the requested same-user agent
  capacity and the Hermes CPU/memory limits; fail before create on a known-incompatible profile.
- Change the default in `src/server/env.ts` from the 512 MB size only after the protected benchmark
  confirms the exact supported 2 GB-or-larger slug.
- Retain swap only as emergency resilience for explicitly supported low-memory profiles, not as the
  normal method for satisfying the Hermes memory limit.
- Keep `AGENTBAY_RUNNER_MAX_AGENTS=1` as the safe default during this step.
- Update environment tests, bootstrap tests, resource-limit tests, README configuration, cost
  estimates, and operator documentation.

Acceptance criteria:

- Default configuration can run one Hermes container within physical memory plus runner overhead.
- Invalid size/capacity combinations fail before any provider effect.
- Container CPU, memory, PID, no-new-privileges, and capability restrictions remain enforced.
- Advances Definition of Done by eliminating the known memory/swap mismatch.

Validation:

- Run targeted environment, cost, bootstrap, placement, and Docker runtime-limit tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run repro:cloud-runner` with the selected size profile.
- Run `bun run local:agent:smoke` with equivalent CPU and memory limits.
- With explicit authorization, run the minimum size-profile provider sample required to select the
  new default and retain the sanitized result.

Progress:

- Update `PROGRESS.md` with Step 5 completion, selected-size evidence, gate results, commit reference
  if available, current status, and Step 6 as next.

Changelog:

- Add a `Changed` entry describing the new cold-runner default and pre-create compatibility check.

Commit:

- `perf: right-size managed runners for Hermes`

### Step 6: Build and Attest a Versioned DigitalOcean Runner Snapshot

Goal: Remove package installation and full immutable-image downloads from each Droplet's first boot.

Depends on:

- Steps 0-5

Changes:

- Add repository-owned snapshot build modules under `src/server/runners/` and a
  `scripts/build-runner-snapshot.ts` entrypoint using a narrow DigitalOcean snapshot-provider
  contract with fake-provider tests.
- Add a manually dispatched, protected `.github/workflows/build-runner-snapshot.yml` that accepts
  exact immutable runner/Hermes digests, region, base image, architecture, and explicit cost
  authorization. It must not run on push or ordinary CI.
- Provision a temporary builder, install Docker and Caddy, preload the exact runner, default agent,
  and Hermes images, install systemd/bootstrap assets, and run the complete runner boot fixture.
- Before snapshotting, remove all registration/runner credentials, agent state, logs, shell history,
  cloud-init instance state, SSH host keys, machine ID, temporary networks/containers, and builder
  metadata. Power the builder down cleanly.
- Create the snapshot, wait for authoritative completion, make it available in the target region,
  and emit a signed/immutable manifest containing snapshot ID, region, base image, runner digest,
  Hermes digest, boot contract, source revision, and validation timestamps.
- Cleanup the builder Droplet, firewall, registration tokens, credentials, and failed snapshot
  artifacts on success, failure, cancellation, and unambiguous retry paths. Fail closed on ambiguous
  ownership.
- Extend `src/server/env.ts` and provisioning preflight to accept only configured snapshot evidence
  matching the required release; retain stock-image mode behind rollback configuration.
- Update fake provider, SDK runtime declarations, snapshot workflow tests, release docs, security
  redaction tests, and cleanup tests.

Acceptance criteria:

- The protected workflow produces a snapshot and manifest only after the full boot contract passes.
- A scan of the mounted image/builder before snapshotting finds none of the forbidden credential or
  instance-identity artifacts.
- Production provisioning rejects mismatched or unavailable snapshot evidence before creating a
  Droplet.
- Temporary billable resources are verified absent after every tested terminal path.
- Advances Definition of Done by supplying a prebuilt, attested cold-boot artifact without
  pre-provisioning a user Droplet.

Validation:

- Run targeted snapshot provider, manifest, preflight, workflow, cleanup, and secret-redaction tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run repro:cloud-runner` against snapshot-mode first-boot data.
- Run `bun run local:agent:smoke` using a local snapshot-equivalent image.
- With explicit authorization, dispatch the protected snapshot workflow once and verify artifact and
  builder cleanup evidence.

Progress:

- Update `PROGRESS.md` with Step 6 completion, snapshot identity and cleanup evidence, gate results,
  commit reference if available, current status, and Step 7 as next.

Changelog:

- Add an `Added` entry describing versioned, attested runner snapshots and fail-closed selection.

Commit:

- `feat: publish attested runner snapshots`

### Step 7: Restore Release Validation and Slim Per-Droplet Readiness

Goal: Eliminate the duplicate synthetic Hermes launch from user creation without reducing release
confidence.

Depends on:

- Steps 0-6

Changes:

- Re-enable the simulated-Droplet canary in `.github/workflows/deploy-production.yml` and restore the
  `verified-runner-release` artifact and rollback contract documented in
  `docs/RUNNER_RELEASES.md`.
- Make the release canary validate the exact snapshot manifest, immutable runner image, Hermes image,
  generated first-boot data, registration/heartbeat contract, full Hermes fixture, detailed health,
  Telegram configuration loading, and cleanup.
- Add `full` and `release_attested` readiness policies to `src/runner-service/boot-self-test.ts` and
  shared runner contracts. `release_attested` verifies Docker, snapshot/runner/Hermes identity,
  private runner endpoint, and authenticated heartbeat without launching the synthetic fixture.
- Require exact, unexpired release/snapshot evidence before the control plane treats a lightweight
  result as assignable. Any mismatch falls back to failure, not to an unverified fast path.
- Preserve the full fixture for local smoke, snapshot publication, release validation, and explicit
  diagnostics.
- Update boot snapshot schema/contract versions, compatibility checks, heartbeat parsing, release
  workflow tests, runner readiness tests, docs, rollout configuration, and rollback instructions.

Acceptance criteria:

- No production configuration can select lightweight readiness without matching verified release
  and snapshot evidence.
- The release gate runs the full fixture and produces a verified rollback artifact.
- A new snapshot-based Droplet completes lightweight readiness without launching and deleting a
  synthetic Hermes workload before the real agent.
- Switching validation mode back to `full` is a configuration-only rollback.
- Advances Definition of Done by safely removing duplicate boot work.

Validation:

- Run targeted boot-self-test, heartbeat, compatibility, release-required, release-workflow, and
  release-smoke tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run repro:cloud-runner`.
- Run `bun run local:agent:smoke` in both `full` and `release_attested` modes.
- Run `bun run runner:release:smoke -- --image <immutable-image> --provider local_docker` and retain
  the verified evidence.

Progress:

- Update `PROGRESS.md` with Step 7 completion, full-versus-lightweight evidence, gate results, commit
  reference if available, current status, and Step 8 as next.

Changelog:

- Add a `Changed` entry describing release-attested lightweight Droplet readiness and restored
  release validation.

Commit:

- `perf: use release-attested runner readiness`

### Step 8: Validate and Document Same-User Runner Reuse

Goal: Avoid unnecessary new Droplets for later agents when the same user's runner has measured spare
capacity, without introducing any pre-provisioned or cross-user pool.

Depends on:

- Steps 0-7

Changes:

- Add a resource profile that computes supported `AGENTBAY_RUNNER_MAX_AGENTS` from runner memory,
  CPU, disk, and per-Hermes limits instead of accepting an unsafe independent count.
- Keep the production default at one unless a larger measured profile is explicitly selected.
- Strengthen placement tests to prove same-user ownership, heartbeat freshness, release
  compatibility, capacity locking, concurrent-create exclusion, and fallback to cold Droplet
  creation only when no eligible capacity exists.
- Add load/smoke coverage for two agents on an authorized larger runner, including restart, Stop,
  delete, logs, isolation, and resource-limit enforcement.
- Update README and operator docs with supported profiles, cost/latency tradeoffs, and the explicit
  statement that no runner is pre-created or shared across users.

Acceptance criteria:

- Concurrent same-user creates cannot oversubscribe a runner.
- Cross-user placement remains impossible at the database predicate and transaction-lock levels.
- Unsupported capacity/size combinations fail before effects.
- Existing-runner latency is reported separately from cold-Droplet latency and cannot hide cold-path
  SLO failures.
- Advances Definition of Done by safely using already available same-user capacity.

Validation:

- Run targeted placement, assignment, heartbeat, compatibility, concurrency, and runtime-limit tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run local:agent:smoke` with a supported two-agent profile and verify cleanup.

Progress:

- Update `PROGRESS.md` with Step 8 completion, isolation/capacity evidence, gate results, commit
  reference if available, current status, and Step 9 as next.

Changelog:

- Add a `Changed` entry only if supported same-user capacity behavior or defaults changed; omit an
  entry if this step produced tests and documentation only.

Commit:

- `perf: validate same-user runner capacity reuse`

### Step 9: Prove the Cold-Path SLO and Roll Out Safely

Goal: Validate the complete non-preprovisioned design against DigitalOcean and promote it only if it
meets the target.

Depends on:

- Steps 0-8

Changes:

- Run shadow measurements with dispatch still in `cron` mode, then enable QStash dispatch, bounded
  drains, the measured runner size, snapshot selection, and `release_attested` readiness one switch
  at a time in a protected environment.
- Add/complete an explicitly authorized benchmark mode that performs at least 30 clean cold runs in
  the selected region. Every trial starts after the user-equivalent create request, creates a new
  Droplet, reaches ready or terminal failure, and deletes all created resources.
- Record immutable runner/Hermes/snapshot identities, configuration modes, region, size, timestamps,
  success/failure outcome, p50/p95/max, stage distributions, and verified cleanup in a sanitized
  artifact. Do not retain credentials or raw cloud-init output.
- Exercise rollback independently for QStash-to-cron dispatch, snapshot-to-stock image, lightweight-
  to-full readiness, and runner-size configuration.
- Update `docs/E2E_VALIDATION.md`, `docs/RUNNER_RELEASES.md`, `docs/RUNNER_RESILIENCE.md`, and README
  with the proven result, operational dashboards/alerts, runbook, and rollback sequence.
- If p95 exceeds 60 seconds, use the stage evidence to document the remaining bottleneck and continue
  only with optimizations already inside this plan. Do not add warm capacity or mark the goal done.

Acceptance criteria:

- At least 30 provider-backed cold trials have at least 95% success and p95 commit-to-ready latency
  of 60 seconds or less.
- All Droplets, firewalls, temporary snapshots/builders, tokens, credentials, agents, and database
  test records created by the benchmark are verified cleaned or intentionally retained with an
  explicit record.
- Each rollback path is tested and documented.
- All Definition of Done items are satisfied and the final evidence clearly separates cold and
  existing-runner paths.
- Completes Definition of Done by proving the provider-backed cold-path SLO, cleanup, and rollback
  contract without adding pre-provisioned capacity.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run repro:cloud-runner`.
- Run `bun run local:agent:smoke`.
- Run `bun run runner:release:smoke -- --image <immutable-image> --provider local_docker`.
- With explicit authorization, run the Step 1 benchmark command for at least 30 DigitalOcean cold
  trials and verify its cleanup report.

Progress:

- Update `PROGRESS.md` with Step 9 completion, final SLO and cleanup evidence, all gate results,
  commit reference if available, final status, and no next step.

Changelog:

- Add a `Changed` entry describing the shipped faster cold-creation path and its operator controls.
  Do not add an entry for the benchmark report or documentation alone.

Commit:

- `perf: roll out one-minute cold agent creation`
