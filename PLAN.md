# Implementation Plan

## Source Documents

- Path: `docs/RUNNER_RESILIENCE.md`
  - Role: Primary product and operational brief.
  - Summary: Requires version-aware runners, automatic DigitalOcean replacement, a boot-time
    readiness contract, bounded deployment stages, an immutable-image release pipeline,
    infrastructure reconciliation, and a nontechnical recovery experience. The existing gateway
    convergence fix is a prerequisite and is not to be reimplemented.

## Goals

- Make plingpling-managed DigitalOcean runners report an exact immutable release identity on every
  bootstrap heartbeat and steady-state heartbeat.
- Persist both the control plane's required runner image digest and each runner's observed image
  digest, and exclude unknown, malformed, or outdated runner releases from assignment.
- Make a new runner assignable only after it passes an authenticated, versioned boot-readiness
  contract proving Docker access, a disposable Hermes launch, internal health probing, the fixed
  model-canary transport, Telegram configuration loading, and cleanup.
- Automatically replace a managed runner that is missing, stale, incompatible, or unable to start
  an agent within the bounded gateway deadline without asking the user to inspect or replace a
  Droplet.
- Preserve agent ownership, desired state, encrypted credentials, configuration revision, usage
  accounting, and deployment history while handing work to a validated replacement.
- Reconcile DigitalOcean resources and database state so manually deleted Droplets, interrupted
  provisions, duplicate resources, stale assignments, and safe-to-delete orphans converge
  automatically.
- Release runner images in the safe order: immutable publication, digest verification, a real
  disposable-Droplet canary, control-plane deployment pinned to the verified digest, then a
  bounded fleet rollout.
- Keep the common user experience at the level of “Preparing your agent,” “Connecting Telegram,”
  “Ready,” or a recovery failure that genuinely requires user action.

## Non-Goals

- Automatically replacing user-operated `manual_vps` runners; incompatible manual runners must be
  excluded from placement and shown only in advanced operator surfaces.
- Supporting cloud providers other than the existing DigitalOcean provider contract.
- Redesigning model connections or adding providers beyond the existing direct ChatGPT/OpenAI and
  Claude/Anthropic paths.
- Reintroducing OpenRouter into new-agent setup, boot tests, release canaries, or recovery logic.
- Replacing the already-shipped in-container Hermes health-probe fix or changing Hermes itself.
- Contacting a real user's Telegram bot or consuming a real model provider during generic runner
  boot validation. Agent-specific external model and Telegram checks remain deployment stages.
- Migrating running work in place between Droplets with zero overlap. A short, bounded handover is
  acceptable, but plingpling must fence the old runner before starting the replacement workload.
- Automatically deleting an unowned or ambiguously owned DigitalOcean resource. Ambiguous provider
  state must fail closed and remain operator-only.
- Exposing runner IDs, Droplet IDs, image digests, provider errors, leases, replacement attempts,
  or infrastructure terminology in the common agent setup and detail flow.

## Definition of Done

- Runner images are published with immutable Git-SHA tags, OCI revision/version labels, SBOM and
  provenance, and the publication workflow returns the registry digest actually pushed.
- Cloud bootstrap accepts only an immutable `ghcr.io/...@sha256:...` runner reference in hosted
  DigitalOcean mode and passes the expected release version, image digest, and boot-contract
  version into the runner without treating those values as secrets.
- The runner derives its observed image identity from Docker rather than trusting the expected
  environment value, and heartbeat validation accepts only bounded canonical release fields.
- The latest required and observed release identity is persisted in indexed database columns; old
  heartbeat payloads remain parseable during rollout but cannot make a managed DigitalOcean runner
  assignable.
- Placement, agent creation, lifecycle start, deployment reconciliation, and the assignable-runner
  list all fail closed when release identity or boot-contract evidence is missing, invalid, or not
  equal to the control plane's required release.
- `/runner/v1/readiness` returns a versioned, authenticated, secret-free boot-contract result backed
  by a durable runner self-test rather than a constant response.
- The boot self-test uses a short-lived isolated fixture workload and proves Docker, Hermes launch,
  localhost detailed health, fixed no-tools canary transport, Telegram config parsing/loading, and
  exact cleanup without external provider or Telegram traffic.
- A durable, leased, idempotent runner-replacement workflow can provision and validate a new
  Droplet, fence the source runner, atomically reassign its active agents, retry their desired
  deployment/runtime state, confirm convergence, revoke old credentials, delete the old owned
  Droplet/firewall, and soft-delete the old runner row.
- Replacement never deletes the source resource before the target passes boot readiness. Failed or
  ambiguous target provisioning is cleaned up where ownership is certain and otherwise stops with
  a safe terminal recovery state.
- A gateway remains in the internal `starting_gateway` stage for no more than 30 seconds after
  accepted launch evidence. Timeout captures bounded redacted logs once and schedules runner
  replacement rather than restarting the same operation or exhausting 64 generic attempts.
- Automatic replacement is bounded to two replacements per agent deployment within a 24-hour
  window. Exceeding the budget stops billable churn and produces the generic user-facing recovery
  failure while retaining safe operator evidence.
- The infrastructure reconciler performs authoritative DigitalOcean-to-database comparison under
  a lease, repairs known interrupted resources by operation tag, marks missing resources, starts
  replacement for assigned missing runners, and deletes only provably owned unassigned orphans
  after a two-observation grace period.
- Common UI copy contains only “Preparing your agent,” “Connecting Telegram,” “Ready,” and a generic
  automatic-recovery failure. It does not ask the user to inspect cloud-init, endpoints, images,
  Droplets, or database records.
- Offline/degraded/outdated warnings are suppressed while automatic recovery is active. A runner
  warning becomes user-visible only after recovery is terminal and the user has an action they can
  take; technical evidence remains in advanced/operator views and structured logs.
- The release workflow provisions a real disposable DigitalOcean Droplet, waits for the exact
  release heartbeat and boot contract, exercises a synthetic agent start/status/canary/stop cycle,
  always deletes the canary resources, and blocks control-plane production deployment on failure.
- Production control-plane deployment is configured with the exact tested runner digest, and a
  bounded cron reconciler gradually replaces incompatible managed runners without requiring user
  action.
- Migrations are backward-safe, current managed runners are classified without becoming assignable
  on ambiguous evidence, rollback behavior is documented, and no raw credentials or unbounded
  provider/runtime output reaches persistence, logs, APIs, or UI.
- Unit, migration-fixture, local-cloud, Hermes-contract, runner-image, E2E, and provider-backed
  release-smoke gates pass. `PROGRESS.md`, `CHANGELOG.md`, operator documentation, and release
  evidence are current.

## Assumptions and Open Questions

- Assumption: automatic replacement applies only to `kind = digitalocean`, `provider =
  digitalocean` rows created and tagged by plingpling. Impact: manual VPS owners remain responsible
  for upgrading their own machines, but outdated manual runners are never assigned new work.
- Assumption: the required production runner release is the immutable digest provided through
  `AGENTBAY_RUNNER_IMAGE` during the production Vercel deployment. Impact: a mutable `:main` value is
  rejected in hosted DigitalOcean mode after migration; local Docker mode may retain explicit local
  tags for development.
- Assumption: `RUNNER_BOOT_CONTRACT_VERSION = "plingpling.runner.boot.v1"` is the initial contract,
  and a mismatch is equivalent to an outdated runner. Impact: contract evolution requires a
  coordinated runner-first rollout and compatibility window.
- Assumption: the boot model canary validates the fixed internal canary path against a local fake
  OpenAI-compatible fixture. It does not prove the user's OpenAI or Anthropic credential. Impact:
  actual provider validation remains in `verifying_model` for each agent.
- Assumption: Telegram boot validation proves that Hermes accepts and loads a bounded synthetic
  Telegram configuration without opening a real Telegram connection. Impact: real bot-token and
  allowed-user validation remains in `connecting_telegram`.
- Assumption: one replacement workflow may cover every active agent assigned to a source runner,
  while the current default capacity normally produces one-agent runners. Impact: handover code
  must lock capacity and preserve all eligible assignments rather than assuming exactly one agent.
- Assumption: 30 seconds is the internal gateway deadline, two replacements in 24 hours is the
  automatic recovery budget, and infrastructure reconciliation runs once per minute with a small
  per-run budget. Impact: these values should be constants with deterministic tests and operator
  overrides only if existing environment-validation conventions are followed.
- Assumption: a brief overlap in Droplet billing during validation and handover is acceptable.
  Impact: the old resource remains available until the target is proven, but cleanup begins
  immediately after successful convergence.
- Open question: which GitHub environment will hold `DIGITALOCEAN_TOKEN`, `VERCEL_TOKEN`,
  `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, the staging app URL, and its dedicated machine credential?
  Conservative plan: add the workflow and validation with an environment named
  `runner-production-release`, but do not claim live acceptance until those secrets are configured.
- Open question: whether production rollout should initially use a percentage or a fixed runner
  count. Conservative plan: use a fixed `AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE` default of one per cron
  invocation because it is deterministic and bounds spend.
- Existing repository issue: `tests/unit/progress-status.test.ts` expects historical
  `PROGRESS.md` content that commit `9f45d89` removed. Step 0 restores the last historical ledger
  from `9f45d89^:PROGRESS.md` before appending this plan's tracker so the canonical test gate remains
  meaningful instead of being deleted or excluded.

## Implementation Approach

Use four explicit contracts and one durable saga.

1. **Release identity contract.** Extend heartbeat payloads with a bounded `release` object:
   `version`, canonical `imageDigest`, and `bootContractVersion`. The runner obtains the observed
   image ID/digest through the mounted Docker socket using its own container identity; the expected
   digest is used only for comparison. Normalize the latest values onto `runners` columns for
   indexed placement and keep the full safe heartbeat metadata as history.
2. **Compatibility contract.** Add a server-owned parser for the required immutable runner image
   reference. Compatibility is true only when observed digest equals required digest, release
   version is bounded, boot contract matches, the authenticated readiness evidence is current, and
   the heartbeat is fresh. All placement and assignment paths consume this single decision module.
3. **Boot-readiness contract.** Replace the constant readiness response with a durable self-test
   snapshot generated when the runner starts. The self-test launches a uniquely labeled disposable
   Hermes fixture on the existing private network, uses in-container localhost probes, performs a
   fixed canary against a local fake model endpoint, loads synthetic Telegram configuration without
   network access, then removes the fixture. The endpoint returns only versioned enums and
   timestamps; no logs, configuration, endpoints, or credentials.
4. **Infrastructure ownership contract.** Continue using exact provisioning operation tags and
   provider resource IDs. Add stable managed-runner and runner-ID tags where DigitalOcean permits,
   then classify provider observations as exact, missing, adoptable interrupted create, ambiguous,
   or owned orphan. Only exact/adoptable cases mutate automatically; ambiguous cases fail closed.
5. **Replacement saga.** Add a `runner_replacements` durable state machine with source and target
   runner IDs, reason, state, attempt budget, lease, next action time, and safe terminal code. The
   reconciler advances one external effect per claim: create target row/token, provision target,
   validate exact release and boot contract, fence source, reassign agents transactionally, trigger
   deployment/runtime convergence, confirm workloads, revoke/delete source, and complete. Every
   effect is idempotent and rediscoverable after process death.

Roll out compatibly:

- First accept legacy heartbeats but classify managed runners without exact evidence as
  `unknown`, nonassignable, and replacement-eligible only after the new image is active.
- Publish and canary the new image before deploying a control plane that requires its digest.
- Deploy the control plane with the verified digest and a rollout batch of one.
- Reconcile replacements gradually. Do not mass-delete or mutate manually managed runners.
- Keep the prior runner digest available for rollback. Rollback means redeploying the control plane
  with the prior verified digest and stopping new replacement claims; already completed
  replacements remain valid if they match that rollback digest or are replaced gradually.

Keep user and operator presentation separate. Internal stages, release evidence, provider IDs, and
replacement states remain available to structured logs and advanced settings. The common agent UI
maps all pre-Telegram automatic work to “Preparing your agent,” maps only the existing Telegram
stage to “Connecting Telegram,” and shows technical warnings only when recovery is terminal.

## Quality Gates

- Setup status: Bun, Biome, TypeScript, Vitest, Next.js build, Playwright E2E, Drizzle migrations,
  local-cloud smoke, Hermes contract smoke, and runner Docker build are configured. Step 0 must
  restore the historical `PROGRESS.md` ledger removed by `9f45d89` before the baseline because one
  existing unit suite intentionally validates it.
- Baseline command: `bun install --frozen-lockfile && bun run db:migrate && bun run verify && bun run test:e2e:ci`
- Format command: `bun run format:check`
- Lint command: `bun run lint`
- Test command: `bun run test`
- Additional gates: `bun run typecheck`, `bun run build`, `bun run db:generate`, `bun run db:migrate`,
  `bun run local:cloud:smoke`, `bun run agent:hermes:contract-smoke`,
  `docker build -f Dockerfile.runner -t plingpling-runner:resilience .`, and `bun run test:e2e:ci`.
- Provider-backed release gate added by this plan: `bun run runner:release:smoke -- --image <immutable-image-ref>`.
- Gate policy: every implementation step runs format, lint, unit tests, typecheck, and build. Steps
  that modify schema, runner behavior, provisioning, UI, or release automation also run the named
  relevant additional gates. Fix new failures before proceeding; record genuinely pre-existing or
  credential-blocked external gates explicitly in `PROGRESS.md` without claiming they passed.

## Progress Tracking

- File: `PROGRESS.md`
- Requirement: Restore the historical ledger from `9f45d89^:PROGRESS.md`, then append a new
  “Runner Resilience and Automatic Replacement” section before any baseline or implementation work
  begins.
- Update rule: After each step is completed, update `PROGRESS.md` with the completed step,
  acceptance evidence, exact validation results, commit reference if available, current status,
  blockers, and next step. Preserve historical sections and update only this plan's ledger.

## Changelog Tracking

- File: `CHANGELOG.md`
- Standard: Keep a Changelog 1.0.0, <https://keepachangelog.com/en/1.0.0/>
- Requirement: `CHANGELOG.md` already exists with `# Changelog`, the standard preamble, and
  `## [Unreleased]`; Step 0 verifies and preserves it before implementation begins.
- Update rule: After each step is completed and validated, update `CHANGELOG.md` before creating
  that step's commit only if the step shipped a functional change. Add human-readable behavior
  under the appropriate existing or new non-empty `Added`, `Changed`, `Fixed`, or `Security`
  heading. Do not add entries for the plan, progress tracking, tests, CI-only validation, docs-only
  changes, or empty categories.

## Goal Handoff

- Readiness: This plan is ready to be used as a `/goal` payload.
- Scope: The `/goal` should execute only the work described in this plan unless the user explicitly
  expands it. Live DigitalOcean provisioning and production release remain subject to the existing
  configured credentials and external-write authorization.
- Done: The `/goal` is complete only when every item in `## Definition of Done` is satisfied, all
  incremental steps are complete, required quality gates pass or credential-blocked live evidence
  is explicitly documented, `PROGRESS.md` and `CHANGELOG.md` are current, each completed step has
  its focused commit, and the final state and rollout evidence are summarized for the user.

## Incremental Steps

### Step 0: Progress and Changelog Tracking Setup

Goal: Restore durable execution tracking without losing the repository's historical acceptance
ledger, and confirm the changelog is ready before any implementation work begins.

Depends on:

- None.

Changes:

- Restore `PROGRESS.md` from `9f45d89^:PROGRESS.md`; do not recreate a shortened file that breaks
  `tests/unit/progress-status.test.ts` or discards historical acceptance evidence.
- Append the plan title, source path, definition-of-done summary, complete Step 0–12 checklist,
  current status, update log, validation table, and next step under a new “Runner Resilience and
  Automatic Replacement” section.
- Document the per-step progress, functional-change-only changelog, validation, and focused-commit
  rules in the new section.
- Verify `CHANGELOG.md` retains Keep a Changelog 1.0.0 structure and `## [Unreleased]`; do not
  rewrite its existing product history.

Acceptance criteria:

- `PROGRESS.md` exists, preserves all prior sections, and contains the new checklist and update
  rules.
- `CHANGELOG.md` contains the standard header, preamble, and `## [Unreleased]` with no empty new
  category added for this docs-only step.
- `tests/unit/progress-status.test.ts` can read the restored file and retain its historical checks.

Advances Definition of Done by establishing the durable evidence ledger required for autonomous
execution.

Validation:

- Run `test -f PROGRESS.md && test -f CHANGELOG.md`.
- Run `bun run test tests/unit/progress-status.test.ts`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Fix failures before proceeding.

Progress:

- Mark Step 0 complete in `PROGRESS.md`, record validation results and the resulting commit, set the
  current status, and identify Step 1 as next.

Changelog:

- Do not add a changelog entry; progress restoration and plan tracking are not functional changes.

Commit:

- `docs: initialize runner resilience tracking`

### Step 1: Baseline Gates and Failure Characterization

Goal: Establish a green baseline and preserve the existing safety guarantees that later runner
compatibility, readiness, replacement, and release changes must not regress.

Depends on:

- Step 0.

Changes:

- Run the repository baseline with local Postgres and record exact results in `PROGRESS.md`.
- Add focused passing characterization tests in `tests/unit/runner-heartbeat.test.ts`,
  `tests/unit/runner-placement.test.ts`, `tests/unit/runner-service.test.ts`,
  `tests/unit/automatic-runner-provisioning.test.ts`, and
  `tests/unit/agent-deployment-reconciler.test.ts` for current authenticated heartbeat parsing,
  stale-heartbeat exclusion, provider-resource verification, exact owned cleanup, provisioning
  operation idempotency, secret redaction, in-container Hermes probing, and the already-shipped
  readiness-timeout stop/log-capture behavior.
- Record a gap matrix in `PROGRESS.md` showing that exact image identity, capability-backed
  readiness, automatic replacement, infrastructure inventory reconciliation, and smoke-before-
  deploy ordering are not yet implemented. Do not add tests that require future behavior or leave
  the repository red.
- Keep characterization deterministic with fake DigitalOcean and fake runner adapters; do not make
  external calls in unit tests.

Acceptance criteria:

- Existing pre-change safety behavior is explicit in tests, and future gaps are explicit in the
  progress ledger without encoding unsafe behavior as a permanent expectation.
- Tests demonstrate the release-identity and replacement gaps without weakening existing auth,
  ownership, secret-redaction, or gateway convergence coverage.
- The baseline is green after Step 0; any external credential blocker is recorded without being
  represented as a product failure.

Advances Definition of Done by reducing migration and recovery risk before schema and orchestration
changes.

Validation:

- Run `bun install --frozen-lockfile`.
- Run `bun run db:migrate`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Fix failures before proceeding.

Progress:

- Mark Step 1 complete in `PROGRESS.md`, record baseline and characterization results plus the
  commit reference, set current status, and identify Step 2.

Changelog:

- Do not add a changelog entry; tests and baseline evidence do not ship functional behavior.

Commit:

- `test: characterize runner resilience contracts`

### Step 2: Report Immutable Runner Release Identity

Goal: Make every managed runner prove which immutable runner image and contract it is actually
executing.

Depends on:

- Steps 0–1.

Changes:

- Add bounded release constants and parsing in `src/runner-service/constants.ts` and a small deep
  identity module under `src/runner-service/` rather than spreading Docker-inspection logic through
  heartbeat code.
- Update `Dockerfile.runner` and `.github/workflows/publish-runner-image.yml` with OCI source,
  revision, and version labels, linux/amd64 publication, SBOM, provenance, and immutable Git-SHA
  tags. Retain `:main` only as a non-authoritative convenience tag during transition.
- Extend bootstrap environment construction in `src/server/runners/cloud-runner-bootstrap.ts` with
  the expected version, digest, and boot-contract version parsed from the immutable runner image.
- Derive observed identity inside the runner using its container ID/hostname and the Docker socket;
  compare image metadata and repo digests without putting credentials or environment file contents
  in Docker argv or logs.
- Extend bootstrap and steady-state heartbeat bodies in `src/runner-service/bootstrap.ts` and
  `src/runner-service/server.ts` with the exact bounded `release` object.
- Extend validation in `src/server/runners/runner-heartbeat.ts`; retain safe parsing of legacy
  payloads during rollout but distinguish missing release evidence.
- Update heartbeat/bootstrap/image tests, bootstrap redaction tests, and contract fixtures.

Acceptance criteria:

- A heartbeat reports exact observed digest, release version, and contract version.
- Expected values alone cannot forge observed identity.
- Invalid digest/version/contract fields are rejected safely; identity never includes registry
  credentials, Docker inspect blobs, container IDs, or raw errors.
- Local Docker mode remains usable with an explicit development identity seam.

Advances Definition of Done by creating the authoritative observed runner identity needed for every
later compatibility and replacement decision.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `docker build -f Dockerfile.runner -t plingpling-runner:resilience .`.
- Run `bun run agent:hermes:contract-smoke`.
- Fix failures before proceeding.

Progress:

- Mark Step 2 complete in `PROGRESS.md`, record exact gate evidence and commit reference, set status,
  and identify Step 3.

Changelog:

- Add an `Added` entry under `## [Unreleased]` describing exact runner release identity in
  authenticated heartbeats.

Commit:

- `feat: report immutable runner release identity`

### Step 3: Persist Compatibility and Fail Closed During Assignment

Goal: Prevent new or restarted work from being assigned to a runner whose observed release is
unknown, invalid, or different from the control plane's required digest.

Depends on:

- Step 2.

Changes:

- Add backward-safe runner compatibility columns and checks in `src/server/db/schema.ts` with a
  generated Drizzle migration: required digest, observed digest, observed release version, observed
  boot-contract version, compatibility state, and last compatibility verification timestamp.
- Keep historical heartbeat metadata, but normalize validated current values onto `runners` in
  `src/server/runners/runner-heartbeat.ts` transactionally with the heartbeat.
- Add a deep `src/server/runners/runner-compatibility.ts` decision module that reads the required
  immutable digest from validated server configuration and returns `compatible`, `unknown`,
  `outdated`, or `invalid` with safe internal reason codes.
- Update `src/server/env.ts` so hosted DigitalOcean mode requires an immutable digest reference;
  preserve tagged local images only for `local_docker` mode.
- Make `src/server/runners/runner-placement.ts`, `runner-assignment.ts`,
  `runner-placement-verification.ts`, create/start paths, and deployment selection all use the same
  compatibility predicate.
- Backfill existing managed runner compatibility to `unknown`; do not infer compatibility from a
  mutable image tag or old version string.
- Add schema, migration-fixture, environment, heartbeat, assignment, placement, create, and
  lifecycle tests.

Acceptance criteria:

- Only fresh, exact-digest, contract-compatible runners are assignable.
- Legacy/outdated managed runners remain persisted and replacement-eligible but cannot receive new
  agents or restarts.
- Concurrent placement cannot bypass the compatibility check.
- Manual runners are excluded when incompatible but are not automatically deleted.

Advances Definition of Done by enforcing version awareness at every work-placement boundary.

Validation:

- Run `bun run db:generate` and review the generated SQL for additive/backward-safe changes.
- Run `bun run db:migrate` against a clean and an upgraded test database.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `bun run local:cloud:smoke`.
- Fix failures before proceeding.

Progress:

- Mark Step 3 complete in `PROGRESS.md`, record migration and gate evidence plus commit reference,
  set status, and identify Step 4.

Changelog:

- Add a `Changed` entry explaining that managed work is assigned only to the exact control-plane
  runner release.

Commit:

- `feat: enforce runner release compatibility`

### Step 4: Enforce a Real Boot-Readiness Contract

Goal: Make assignability prove runner capabilities rather than merely proving that the HTTP process
answers.

Depends on:

- Steps 2–3.

Changes:

- Add a versioned boot snapshot contract to `src/runner-service/runner-contracts.ts` with bounded
  component states for Docker, Hermes fixture launch, internal detailed health, fixed canary,
  Telegram config loading, and cleanup.
- Add an isolated runner self-test module under `src/runner-service/` that:
  - verifies Docker socket access and expected self-image identity;
  - creates a unique temporary state root and private-network fixture;
  - starts the pinned Hermes workload with a local fake model endpoint;
  - probes Hermes from inside the container using the existing secret-safe localhost approach;
  - sends the fixed no-tools canary request;
  - loads a bounded synthetic Telegram configuration without external Telegram traffic;
  - removes every labeled fixture container, network attachment, and temporary path on success,
    failure, timeout, or process restart.
- Persist the safe boot snapshot on the runner filesystem so `/runner/v1/readiness` remains
  deterministic across requests and reports `testing`, `ready`, or `failed` with contract version
  and timestamps.
- Change `handleReadinessRequest` in `src/runner-service/server.ts` from constant success to the
  injected self-test reader; keep bearer authentication and no-store behavior.
- Update app-side readiness parsing in `src/server/runners/runner-heartbeat.ts` and mark cloud
  provisioning ready only when release identity and all required boot components match.
- Add runner-service, cloud-bootstrap, readiness-route, registration, provisioning, timeout,
  cleanup, restart, redaction, and hostile-fixture tests.

Acceptance criteria:

- A runner cannot become `provisioningStatus = ready` from heartbeat plus constant HTTP success.
- Boot validation exercises the same in-container health/canary path used in production.
- Self-test has a strict total deadline, cleans up exactly owned fixtures, and emits only safe enum
  evidence.
- No real OpenAI, Anthropic, Telegram, or user credential is required or contacted.

Advances Definition of Done by making “cloud ready” a real, versioned capability contract.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `docker build -f Dockerfile.runner -t plingpling-runner:resilience .`.
- Run `bun run agent:hermes:contract-smoke`.
- Run `bun run local:cloud:smoke`.
- Fix failures before proceeding.

Progress:

- Mark Step 4 complete in `PROGRESS.md`, record contract and cleanup evidence plus commit reference,
  set status, and identify Step 5.

Changelog:

- Add an `Added` entry describing capability-based boot validation before a cloud runner accepts
  agents.

Commit:

- `feat: require runner boot readiness contract`

### Step 5: Persist a Durable Runner Replacement Workflow

Goal: Represent automatic replacement as an inspectable, leased, idempotent saga before performing
any new external effects.

Depends on:

- Steps 3–4.

Changes:

- Add `runner_replacements` and its enums/checks/indexes in `src/server/db/schema.ts` with source
  runner, optional target runner, reason, state, operation key, attempt/replacement budget,
  `nextAttemptAt`, lease owner/expiry, safe terminal code, timestamps, and one-active-replacement
  uniqueness per source.
- Add migration SQL and migration-fixture coverage for clean install, upgrade, constraints,
  idempotency, and rollback-safe additive behavior.
- Add `src/server/runners/runner-replacement-state.ts` for pure transitions and
  `runner-replacement-store.ts` for claim/lease/compare-and-set persistence.
- Define states for `pending`, `provisioning_target`, `validating_target`, `fencing_source`,
  `reassigning`, `converging_agents`, `cleaning_source`, `complete`, and `failed`.
- Add replacement reasons for release mismatch, boot failure, missing provider resource, stale
  heartbeat, endpoint failure, and gateway deadline.
- Enforce two replacements per agent deployment per 24 hours and one active source replacement;
  keep provider-call attempts separate from billable replacement count.
- Add unit, database concurrency, lease expiry, duplicate trigger, terminal-state, and safe DTO tests.

Acceptance criteria:

- Duplicate cron, heartbeat, deployment, and user-request triggers converge on one workflow.
- A process can die after any committed transition and another process can resume safely.
- No external Droplet action is needed to validate the state machine and persistence slice.
- Terminal data stores only bounded reason codes and safe summaries.

Advances Definition of Done by providing the durable recovery primitive needed for hands-off
replacement.

Validation:

- Run `bun run db:generate` and review the migration.
- Run `bun run db:migrate` against clean and upgraded databases.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Fix failures before proceeding.

Progress:

- Mark Step 5 complete in `PROGRESS.md`, record migration/concurrency evidence plus commit reference,
  set status, and identify Step 6.

Changelog:

- Add an `Added` entry describing durable automatic recovery tracking only if the workflow becomes
  observable through an API/operator surface in this step; otherwise defer the entry to Step 6.

Commit:

- `feat: persist runner replacement workflows`

### Step 6: Provision and Validate Replacement Runners

Goal: Automatically create a target Droplet and prove its immutable release and boot readiness
without touching the source assignment.

Depends on:

- Step 5.

Changes:

- Add `src/server/runners/runner-replacement-reconciler.ts` with one-effect-per-claim advancement
  for target row/token creation, DigitalOcean discovery/create/tag/firewall/bootstrap, and target
  readiness validation.
- Reuse `advanceAutomaticDigitalOceanRunnerProvisioning`, operation tags, registration tokens,
  provider request deadlines, and owned cleanup rather than duplicating provisioning logic.
- Ensure target bootstrap is always pinned to the currently required immutable digest and expected
  boot-contract version.
- Leave source credentials, assignment, workload, and Droplet unchanged until the target is online,
  release-compatible, boot-ready, fresh, and has enough capacity for all source assignments.
- On target failure, delete only exact owned target resources, revoke target credentials/tokens,
  retain the source, and schedule bounded retry or terminal recovery according to the workflow
  budget.
- Add fake-provider tests for create outcomes, authoritative rediscovery, duplicate resources,
  timeouts, target incompatibility, failed boot contract, cleanup success/ambiguity, and concurrent
  claims.

Acceptance criteria:

- Replacement never moves an agent or deletes a source before target validation.
- Interrupted provisioning is rediscovered by operation tag and resumes without duplicate Droplets.
- A target running the wrong digest or boot contract is rejected and cleaned up safely.
- Billable creation obeys the replacement budget.

Advances Definition of Done by making validated replacement capacity automatic while preserving a
safe fallback.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `bun run local:cloud:smoke`.
- Run `docker build -f Dockerfile.runner -t plingpling-runner:resilience .`.
- Fix failures before proceeding.

Progress:

- Mark Step 6 complete in `PROGRESS.md`, record provider/idempotency evidence plus commit reference,
  set status, and identify Step 7.

Changelog:

- Add an `Added` entry explaining that plingpling automatically provisions and validates replacement
  capacity for incompatible or unhealthy managed runners.

Commit:

- `feat: provision validated replacement runners`

### Step 7: Hand Over Agents and Clean Up the Source Runner

Goal: Move desired-running agents to the validated target, converge them, and retire the exact old
runner without user intervention.

Depends on:

- Step 6.

Changes:

- Add source fencing that marks the runner nonassignable, revokes or rotates command authority at
  the correct point, and best-effort stops exact selected-agent workloads before target launch.
- Lock source and target capacity, then atomically update eligible `agents.runnerId` assignments and
  replacement state while preserving user ownership, desired status, config revision, encrypted
  secrets, deployment history, and usage-period consistency.
- Integrate `agent-deployment-retry.ts`, deployment triggers, and runtime triggers so stopped agents
  remain stopped and desired-running agents reconcile on the target using fresh operation evidence.
- Confirm every moved desired-running agent reaches deployment/runtime ready before source cleanup;
  keep retryable convergence in the durable workflow.
- After convergence, revoke old runner credentials/tokens, delete the exact owned DigitalOcean
  firewall/Droplet, soft-delete the old runner row, and record bounded provisioning/replacement and
  agent events.
- If old resource deletion is ambiguous, retain cleanup state and do not roll the ready agents back
  to the source.
- Add multi-agent, stopped-agent, partial-convergence, process-death, double-run, credential-fencing,
  usage-accounting, provider-cleanup, and owner-isolation tests.

Acceptance criteria:

- No agent remains assigned to a deleted or incompatible source.
- Desired-running agents recover on the target; stopped agents do not start.
- Source and target cannot both continue accepting new work during handover.
- Old resources are deleted only after target and agents are proven; cleanup ambiguity is durable
  and retryable.

Advances Definition of Done by completing automatic replacement from infrastructure through agent
readiness and owned cleanup.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `bun run local:cloud:smoke`.
- Run `bun run agent:hermes:contract-smoke`.
- Run `bun run test:e2e:ci`.
- Fix failures before proceeding.

Progress:

- Mark Step 7 complete in `PROGRESS.md`, record handover/cleanup evidence plus commit reference, set
  status, and identify Step 8.

Changelog:

- Add a `Changed` entry explaining that agents automatically move to a validated runner and the old
  managed Droplet is retired after recovery.

Commit:

- `feat: hand over agents to replacement runners`

### Step 8: Reconcile DigitalOcean and Database Ownership

Goal: Continuously repair externally deleted Droplets, interrupted provisions, known stale
assignments, and provably owned orphan resources.

Depends on:

- Steps 5–7.

Changes:

- Extend the provider abstraction in `src/server/runners/digitalocean-provider.ts` to return the
  stable tags and timestamps needed for authoritative managed-resource inventory.
- Replace the standalone narrow script behavior with a leased
  `src/server/runners/runner-infrastructure-reconciler.ts` that compares a bounded set of active DB
  rows and managed DigitalOcean resources per invocation.
- Classify exact matches, missing provider resources, adoptable operation-tag resources, duplicate
  resources, stale assignments, owned unassigned orphans, and ambiguous/unowned resources.
- Start a replacement workflow for assigned missing/unhealthy resources, repair known interrupted
  rows from exact operation tags, and clear/tombstone only after transactional ownership checks.
- Require two authoritative observations separated by a grace period before deleting a provably
  owned orphan; never delete ambiguous resources.
- Add a protected internal reconciliation route and Vercel cron entry using the existing `CRON_SECRET`
  authorization and bounded one-row/one-effect semantics.
- Update `scripts/reconcile-cloud-runners.ts` to call the shared reconciler for operator diagnostics
  without having separate mutation rules.
- Add provider, route authorization, reconciliation, orphan grace, missing Droplet, duplicate,
  stale assignment, race, and redaction tests.

Acceptance criteria:

- Manual DigitalOcean deletion automatically produces replacement for affected active agents.
- A stale DB runner no longer blocks new provisioning or placement.
- Exact interrupted creates are adopted; ambiguous duplicates are not guessed at.
- Only resources proven owned by plingpling are automatically deleted.

Advances Definition of Done by ensuring external infrastructure and internal ownership converge
without database surgery.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `bun run local:cloud:smoke`.
- Run `bun run test:e2e:ci`.
- Fix failures before proceeding.

Progress:

- Mark Step 8 complete in `PROGRESS.md`, record reconciliation and deletion-safety evidence plus the
  commit reference, set status, and identify Step 9.

Changelog:

- Add a `Fixed` entry describing automatic repair of missing Droplets, stale records, interrupted
  provisions, and safe owned orphans.

Commit:

- `feat: reconcile managed runner infrastructure`

### Step 9: Replace Runners After Strict Deployment Deadlines

Goal: Turn a true gateway deadline or runner transport failure into one bounded recovery workflow
instead of repeated starts on the same machine.

Depends on:

- Steps 5–8.

Changes:

- Add explicit per-stage deadline timestamps or deterministic deadline derivation to deployment
  state so `starting_gateway` expires 30 seconds after accepted launch evidence independent of
  generic attempt count and cron cadence.
- In `src/server/agents/agent-deployment-reconciler.ts`, capture one bounded redacted log batch and
  stop the exact operation when the deadline expires; create/dedupe a replacement workflow with
  reason `gateway_deadline` and pause deployment on recovery rather than terminally restarting the
  same runner.
- Route repeated endpoint, stale heartbeat, boot incompatibility, and provider-resource-missing
  results into the same durable replacement trigger when safe.
- Resume the existing deployment on the target with a fresh operation ID/config correlation after
  handover; keep model and Telegram failures agent-specific and do not replace a healthy runner for
  invalid user credentials.
- Replace the broad 64-attempt behavior with stage-specific retry budgets and terminal codes while
  preserving idempotent cron/heartbeat/manual triggers.
- Add exact 29,999/30,000 ms boundary, one-log-capture, no-same-runner-restart, replacement-budget,
  provider/model/Telegram classification, duplicate trigger, and successful resume tests.

Acceptance criteria:

- “Starting gateway” either advances within 30 seconds or starts automatic runner recovery.
- A timed-out operation is never restarted repeatedly on the same runner.
- Model credential and Telegram token failures do not cause billable runner churn.
- Recovery budget exhaustion becomes one safe terminal result.

Advances Definition of Done by enforcing the strict stage SLA and preventing the prior 64-attempt
failure mode structurally.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `bun run local:cloud:smoke`.
- Run `bun run agent:hermes:contract-smoke`.
- Run `bun run test:e2e:ci`.
- Fix failures before proceeding.

Progress:

- Mark Step 9 complete in `PROGRESS.md`, record boundary/recovery evidence plus commit reference, set
  status, and identify Step 10.

Changelog:

- Add a `Fixed` entry describing strict gateway deadlines and automatic replacement instead of
  repeated same-runner setup attempts.

Commit:

- `fix: replace runners after bounded gateway failure`

### Step 10: Present One Automatic Recovery Experience

Goal: Remove infrastructure diagnosis from the common user flow while keeping advanced evidence
available to operators.

Depends on:

- Steps 7–9.

Changes:

- Collapse public deployment presentation in `src/shared/agent-deployment-presentation.ts` so
  pending, provisioning, configuration, gateway, canary, and replacement states display
  “Preparing your agent”; retain “Connecting Telegram” and “Ready.”
- Add a safe public recovery state to deployment DTO/presentation that says plingpling is preparing
  replacement capacity without exposing runner or Droplet details.
- Update `app/agents/_components/agent-deployment-progress.tsx`, agent detail/inventory empty and
  failure states, and dashboard summaries to keep one primary flow with automatic retry.
- Update `src/server/alerts/operational-summaries.ts` and runner-state loaders so offline,
  degraded, outdated, missing-endpoint, and source-draining alerts are suppressed while a live
  replacement workflow is active.
- Show a generic “Automatic setup could not recover” action only after terminal recovery, with one
  retry/stop choice. Keep digest, resource, endpoint, provider, and replacement details in an
  advanced operator disclosure or settings surface.
- Remove existing copy that tells ordinary users to inspect cloud-init, check runner endpoints,
  delete Droplets, fix database records, or create a new runner.
- Add component, presentation, root-page, mobile/desktop E2E, accessibility/live-region, refresh,
  and secret/identifier non-disclosure tests.

Acceptance criteria:

- A nontechnical user sees at most Preparing, Connecting Telegram, Ready, or terminal recovery.
- No misleading runner alert appears during provisioning or replacement.
- Refresh/browser-close preserves recovery progress.
- Technical evidence remains available without leaking secrets or opaque identifiers in common UI.

Advances Definition of Done by fulfilling the maximum-abstraction user promise.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `bun run test:e2e:ci` at desktop and configured mobile projects.
- Fix failures before proceeding.

Progress:

- Mark Step 10 complete in `PROGRESS.md`, record UI/E2E evidence plus commit reference, set status,
  and identify Step 11.

Changelog:

- Add a `Changed` entry describing the simplified automatic setup and recovery experience.

Commit:

- `feat: simplify automatic runner recovery status`

### Step 11: Release Through an Immutable Disposable-Droplet Canary

Goal: Ensure a runner release is proven on real DigitalOcean infrastructure before the production
control plane requires it or replaces existing runners.

Depends on:

- Steps 2–10.

Changes:

- Refactor `.github/workflows/publish-runner-image.yml` into a protected release workflow that
  builds once, pushes the Git-SHA tag, captures/verifies its digest, scans the image consistently
  with the Hermes image workflow, and emits the immutable `ghcr.io/...@sha256:...` reference.
- Add `scripts/smoke-runner-release.ts` and package script `runner:release:smoke` using the existing
  DigitalOcean provider, cloud bootstrap, runner registration, and safe cleanup contracts.
- The smoke must provision a disposable tagged Droplet, require exact release heartbeat and boot
  contract, exercise synthetic start/status/canary/stop through the runner, and always verify
  firewall/Droplet/runner-record cleanup in `finally`-equivalent workflow steps.
- Split publish/canary/deploy jobs with explicit dependencies so Vercel production deployment cannot
  run unless digest verification and Droplet smoke succeed.
- Deploy the exact tested commit to Vercel with `AGENTBAY_RUNNER_IMAGE` set to the immutable tested
  reference and `AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE=1`; verify `/health` and the internal required
  release after deployment.
- Keep a manual emergency rollback input selecting a previously verified immutable digest. Never
  automatically promote `:main`.
- Add workflow source-contract tests, smoke parser/cleanup tests, documentation for required GitHub
  environment secrets, and failure summaries that contain no credential or cloud-init output.

Acceptance criteria:

- Publish, verify, real-Droplet canary, and pinned control-plane deploy occur in that order.
- Any failure blocks promotion and still cleans exact canary resources.
- The production control plane exposes no secret and requires the tested digest.
- Rollout begins at one managed runner per reconciliation invocation and can be halted or rolled
  back without mass deletion.

Advances Definition of Done by preventing old or untested runner images from reaching new or
existing agents.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `docker build -f Dockerfile.runner -t plingpling-runner:resilience .`.
- Run `bun run runner:release:smoke -- --image <immutable-image-ref>` only with the dedicated
  authorized release environment; otherwise record the credential blocker without claiming live
  acceptance.
- Validate workflow YAML and run its source-contract tests.
- Fix failures before proceeding.

Progress:

- Mark Step 11 complete only after the real disposable-Droplet smoke and pinned production deploy
  pass; record immutable digest, safe workflow/deployment links, cleanup evidence, commit reference,
  status, and Step 12 as next.

Changelog:

- Add a `Changed` entry describing immutable, canary-verified runner releases and gradual automatic
  upgrades.

Commit:

- `ci: release runners through droplet canary`

### Step 12: Migration, Rollout, and Final Acceptance

Goal: Prove the complete one-click recovery outcome on upgraded data and close the plan with
operator-ready rollback and support documentation.

Depends on:

- Steps 0–11.

Changes:

- Add/update `README.md`, `docs/E2E_VALIDATION.md`, and a focused operator runbook describing the
  immutable release contract, compatibility states, replacement saga, budgets, cleanup safety,
  required release environment, pause/rollback controls, and advanced evidence.
- Exercise migrations from the current pre-plan schema with existing online, offline, provisioning,
  failed, and externally deleted runner fixtures; prove ambiguous legacy runners are nonassignable
  and gradually replaced rather than deleted in bulk.
- Run a controlled production rollout at batch size one and observe at least one old managed runner
  replaced end to end: target verified, agent reassigned/retried, source deleted, and common UI never
  requesting infrastructure action.
- Exercise a manually deleted test Droplet and prove infrastructure reconciliation creates a
  replacement without DB deletion by the user.
- Exercise gateway deadline recovery, duplicate cron/heartbeat triggers, browser close/refresh,
  replacement budget exhaustion, provider ambiguity, and rollback to a previously verified digest.
- Review structured logs, persisted events, public APIs, and UI for secret, raw provider output,
  image/reference, runner ID, Droplet ID, endpoint, and configuration leakage.
- Remove temporary rollout compatibility only after all managed runners report the required digest;
  keep parser support needed for a safe rollback window.

Acceptance criteria:

- Every Definition of Done item has direct test, migration, workflow, or production evidence.
- A nontechnical user can create or recover an agent without diagnosing or replacing a runner.
- Current managed runners converge to the tested digest gradually; no stale runner is assignable.
- Provider resources and DB records match after canary, replacement, deletion, and rollback tests.
- Documentation distinguishes deterministic local evidence from authorized live DigitalOcean
  evidence and records no secret values.

Advances Definition of Done by validating and documenting the complete production outcome.

Validation:

- Run `bun install --frozen-lockfile`.
- Run `bun run db:migrate`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run test`.
- Run `bun run typecheck`.
- Run `bun run build`.
- Run `bun run local:cloud:smoke`.
- Run `bun run agent:hermes:contract-smoke`.
- Run `docker build -f Dockerfile.runner -t plingpling-runner:resilience .`.
- Run `bun run test:e2e:ci`.
- Run `bun run runner:release:smoke -- --image <immutable-image-ref>` in the authorized release
  environment.
- Verify the production `/health` endpoint, exact required digest, bounded rollout, replacement
  completion, provider cleanup, and rollback evidence.
- Fix failures before proceeding.

Progress:

- Mark Step 12 complete in `PROGRESS.md`, record every final gate and acceptance artifact, final
  commit reference, rollout/rollback status, and that no step remains.

Changelog:

- Add no entry for documentation or validation alone. Add a final functional entry only if this
  step changes shipped rollout behavior beyond Steps 2–11.

Commit:

- `docs: close runner resilience rollout`
