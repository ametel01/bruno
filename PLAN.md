# Implementation Plan

## Source Documents

- Path: `/Users/alexmetelli/.codex/attachments/35e0153c-dd3a-4cae-9e45-6382c1ef17af/pasted-text.txt`
  - Role: Primary implementation brief.
  - Summary: Make agent creation produce an automatically configured and running Hermes gateway with a verified model and connected Telegram adapter; correct the pinned Hermes readiness contract; replace mandatory interactive setup for the default path; add durable orchestration, restart/reconciliation, and live Telegram acceptance.
- Path: `docs/MILESTONES.md`
  - Role: Supporting product roadmap and Milestone 18 acceptance contract.
  - Summary: Requires a narrow Hermes + Telegram + BYOK path, encrypted secret handling, generated per-agent configuration, logs, lifecycle controls, safe failures, and an end-to-end Telegram reply before beta.
- Path: `docs/PRD.md`
  - Role: Supporting product and test constraints.
  - Summary: Defines plingpling as an operations control plane, requires a working Telegram-connected agent without founder help, favors thin vertical slices, and names the dashboard/API fake-runner seam plus the runner contract as the primary test boundaries.
- Path: `PROGRESS.md`
  - Role: Existing implementation history and conflict record.
  - Summary: Milestone 18 currently stops at an interactive native `hermes setup` flow that deliberately avoids collecting provider keys. This plan supersedes that choice only for the new automatic-ready path while preserving the native setup terminal as an advanced/recovery option.

## Goals

- Make the default successful agent-creation outcome a real Hermes container running `hermes gateway run`, not merely a stopped database record assigned to a runner.
- Require the automatic path to finish with a healthy private Hermes API server, a successful bounded model canary, and `platforms.telegram.state === "connected"` for the configured bot.
- Collect or reference all configuration required before creation begins: agent/template, OpenRouter model and encrypted BYOK credential, unique Telegram bot token, and numeric Telegram allowlist.
- Replace mandatory interactive Hermes setup on the automatic path with deterministic, idempotent projection of plingpling-owned Hermes configuration and secrets.
- Move long provisioning and startup work into a durable, retryable, idempotent deployment reconciliation flow that survives Vercel request completion, duplicate submissions, runner delays, and process restarts.
- Separate desired state from observed runtime state and keep a running gateway reconciled after Docker or runner-host restarts.
- Preserve owner isolation, secret redaction, existing lifecycle controls, logs, backups, and advanced native Hermes setup.
- Provide local deterministic coverage plus a capability-gated staging smoke that proves a Telegram message receives a real Hermes reply before rollout.

## Non-Goals

- Automating Telegram BotFather bot creation, changing Telegram privacy mode, or managing Telegram accounts on the user's behalf.
- Sharing one Telegram bot token across multiple simultaneously running agents.
- Supporting Telegram groups, webhooks, local Bot API servers, voice, large-file delivery, or platforms other than Telegram in this plan.
- Automating or copying Nous Portal/subscription OAuth artifacts between agents. Native interactive Hermes OAuth remains available but is not the first automatic-ready path.
- Adding model providers beyond the existing OpenRouter BYOK path, fallback routing, bundled model credits, or provider billing.
- Exposing the private Hermes API port publicly or replacing Hermes's own dashboard.
- Reworking billing, backups, approvals, templates, or fleet capacity except where compatibility with automatic deployment requires it.
- Treating a configured token, a running Docker PID, or HTTP 200 alone as proof that the agent is ready.

## Definition of Done

- `POST /api/agents` supports a documented automatic-ready creation mode, returns `202 Accepted` with stable agent and deployment-operation identifiers, and is idempotent for a client-supplied idempotency key.
- The default create UI supplies validated agent/template, OpenRouter model/key, Telegram bot token, and numeric allowed-user IDs without ever redisplaying or logging secret values.
- The server validates the Telegram token with `getMe`, rejects invalid/revoked or already-active bot credentials safely, generates the private Hermes API key, and persists all credentials encrypted and owner-scoped.
- A durable deployment record exposes the stages `pending`, `provisioning_runner`, `configuring_hermes`, `starting_gateway`, `verifying_model`, `connecting_telegram`, `ready`, and `failed`, with bounded attempts, leases, safe error codes, and timestamps.
- Reconciliation can resume after a Vercel invocation ends, after duplicate triggers, after runner registration/heartbeat delays, and after a reconciler or runner restart without creating duplicate agents, droplets, deployments, or selected-agent containers.
- The Hermes launch contract carries the selected provider/model and only the secrets required by that agent; plingpling atomically projects managed `config.yaml`, `.env`, `SOUL.md`, workspace, and revision metadata with correct ownership and secret-safe logging.
- Automatic-ready creation does not require opening the native Hermes setup terminal. The terminal remains available for advanced/manual OAuth configuration and recovery, clearly labeled as outside automatic readiness.
- The runner launches the pinned Hermes workload as `gateway run`, returns launch acceptance without holding a Vercel request open for the full readiness window, and exposes a typed observed readiness snapshot to the control plane.
- Readiness matches the pinned Hermes `v2026.7.7.2` contract: expected image/mount/config revision are verified from runner-owned Docker/projection evidence, while `/health/detailed` verifies gateway and platform state without requiring a nonexistent `configRevision` response field.
- Readiness requires API-server connectivity, Telegram state `connected`, and one successful bounded authenticated model canary per config revision; failures remove or reconcile partial containers and create safe `agent.error` diagnostics.
- `agents.desiredStatus` (or an equivalently explicit persisted field) records operator intent separately from observed lifecycle status. A desired-running agent is restarted/reconciled after Docker or host restart; an intentional stop remains stopped.
- The selected-agent Docker container has an appropriate restart policy, and periodic reconciliation detects missing/exited containers plus Hermes Telegram circuit-breaker/disconnection states.
- The UI shows real persisted deployment stages and actionable safe failures, redirects to the agent detail after creation, and marks the agent ready only after all required checks pass.
- Existing explicit Start/Stop/Restart/Delete behavior, capacity limits, ownership boundaries, logs, backups, and manual setup flows continue to pass regression coverage.
- Migrations are generated and validated; `.env.example`, `README.md`, relevant operator/deployment docs, `docs/MILESTONES.md`, `PROGRESS.md`, and `CHANGELOG.md` describe the finished behavior, new variables, rollback, and live acceptance evidence.
- Core quality gates, local-cloud/browser coverage, pinned-image smoke, the production readiness contract smoke, failure-path tests, reboot/reconciliation tests, and the capability-gated live Telegram reply smoke pass. Any unavailable external gate is reported as a blocker rather than represented as success.

## Assumptions and Open Questions

- **Superseding product decision:** the new brief reintroduces provider credentials for deterministic creation, conflicting with the current Milestone 18 record that plingpling must not request a provider key. This plan assumes the latest brief supersedes that decision for an opt-in automatic-ready path and implements OpenRouter BYOK first. If subscription-only OAuth is still mandatory, stop before Step 4 and obtain a separate approved design for reusable, revocable, per-agent OAuth authorization.
- **Telegram ownership:** each automatically running agent uses a unique Telegram bot token. Reuse across active gateways is rejected because concurrent polling conflicts.
- **Telegram authorization:** at least one numeric `TELEGRAM_ALLOWED_USERS` entry is mandatory. DM pairing and open access are deferred so a newly ready bot is secure and immediately usable by a known user.
- **Telegram transport:** the first path uses Hermes's default long polling, so no public webhook port or Telegram firewall ingress is required.
- **Model boundary:** the first automatic path supports `modelProvider=openrouter` and a model with at least the Hermes-required context size. Model-catalog validation should use a small server-owned allowlist/metadata contract rather than trusting arbitrary client text. Additional providers are deferred.
- **Canary cost:** the user accepts one low-token model canary per new configuration revision. The probe must cap output, use a deterministic prompt, avoid tools, and never retry without a persisted attempt/backoff limit.
- **Orchestration:** use a database-backed reconciliation controller, not an in-request sleep loop and not a new third-party queue. It is triggered opportunistically after create, by runner heartbeat, and by a protected Vercel cron route. Each invocation performs bounded work and can be repeated safely.
- **Rollout:** automatic-ready creation is protected initially by `AGENTBAY_READY_AGENT_CREATION_ENABLED`. Existing explicit stopped/manual creation remains available as `launchMode: "stopped"` during rollout. The flag is enabled by default only after local, staging, and rollback acceptance complete.
- **Source of truth:** plingpling owns managed provider/model, API-server, Telegram, terminal, safety, and prompt keys for automatic agents. Hermes may continue to own unrelated advanced settings. Managed keys override wizard edits on the next reconciliation and the UI must say so.
- **Pinned upstream contract:** implementation and tests target the source-pinned Hermes `v2026.7.7.2` image/digest. Upgrading Hermes remains a separate reviewed change with contract fixtures and image smoke.
- **Live acceptance prerequisites:** a scanned/published workload image, authorized DigitalOcean test budget, dedicated staging Telegram bot and user, and a funded/valid OpenRouter key are required. The goal cannot be marked complete without them unless the user explicitly narrows the definition of done.

## Implementation Approach

1. Correct the current readiness mismatch before expanding creation. Parse the pinned `/health/detailed` shape (`status`, `gateway_state`, `platforms.<name>.state`) and verify plingpling's config revision through the existing projected marker and Docker labels instead of expecting Hermes to echo it. Use the production waiter in the real-image contract smoke and clean up failed launches.
2. Introduce an `agent_deployments` persistence contract and explicit desired state. A deployment row is the durable operation returned to the client; it holds stage, attempt count, safe failure code/detail, lease timestamps, config revision, and completion timestamps. Enforce one active deployment per agent and claim work transactionally with an expiring lease.
3. Keep creation atomic for control-plane state: validate input and external credential shape/preflight, then insert the agent, config, encrypted secrets, generated API key, desired state, deployment operation, and audit event in one database transaction. Runner/DigitalOcean side effects happen only after commit through reconciliation.
4. Extend the versioned launch spec rather than smuggling values through process-global environment variables. Add typed OpenRouter model configuration and secret fields for OpenRouter, Telegram, allowlist, and API server; keep strict exact-key parsing, byte bounds, redacted serialization, owner-scoped decryption, and HTTPS runner transport.
5. Replace the automatic path's `config.yaml` existence gate with a YAML-aware managed projection. Parse existing YAML, replace only plingpling-managed paths, preserve unrelated advanced Hermes settings, render deterministically, write atomically, reject symlinks/path escapes, set secret-file mode `0600`, and record the applied revision. The advanced native setup terminal remains available but is no longer a prerequisite for managed agents.
6. Split runner launch acceptance from readiness completion. `POST start` validates/projects and starts or reuses the exact matching labeled container, then returns a typed accepted result quickly. A runner status/readiness command probes the private container network and reports bounded, redacted liveness, gateway, API-server, Telegram, model-canary, and revision evidence. No Hermes port is published.
7. Implement a level-based reconciler: read desired and observed state, take the next idempotent action, persist the result, release the lease, and stop. Triggers may race; database leases, unique constraints, provider idempotency, runner labels, and config revisions make duplicate triggers safe. Vercel cron provides eventual progress when the browser closes; runner heartbeats trigger prompt progress when infrastructure becomes ready.
8. Mark `ready` only after the runner reports the expected container/config revision, the private API server authenticates, the gateway and Telegram platform are connected, and the one-time model canary succeeds. Persist safe reason codes and selected redacted diagnostics; never persist raw upstream bodies, tokens, prompts containing secrets, or private endpoint details.
9. Add desired-state durability: use `--restart unless-stopped` (or the reviewed equivalent), report selected workload observations in heartbeat/status, and reconcile desired-running agents after reboot. Intentional Stop changes desired state before stopping/removing the container so restart policy cannot resurrect it.
10. Roll out behind a feature flag. First prove fake-provider/fake-Telegram local behavior, then the pinned image locally, then one controlled staging agent with a dedicated Telegram bot and real message/reply. Preserve `launchMode: "stopped"` as rollback while automatic mode is stabilized.

## Quality Gates

- Setup status: Core format, lint, typecheck, unit, build, CI browser smoke, Docker image smoke, and local Hermes contract commands already exist. A capability-gated live Hermes/Telegram acceptance command is missing and must be established in Step 1 before feature implementation.
- Baseline commands: `bun run verify` and `bun run test:e2e:ci`
- Format command: `bun run format:check`
- Lint command: `bun run lint`
- Test command: `bun run test`
- Typecheck command: `bun run typecheck`
- Build command: `bun run build`
- CI browser command: `bun run test:e2e:ci`
- Full local browser command: `bun run verify:e2e` (run only with its documented provider/local-cloud capabilities; never provision external resources implicitly)
- Hermes image command: `bun run agent:image:smoke`
- Hermes runtime contract command: `bun run agent:hermes:contract-smoke`
- Required new external gate: `bun run verify:hermes:staging` (added in Step 1; fail closed with named missing capabilities and never print secrets)
- Migration commands for schema steps: `bun run db:generate` and `bun run db:migrate`
- Diff hygiene: `git diff --check`

## Progress Tracking

- File: `PROGRESS.md`
- Requirement: Preserve the existing historical ledgers and append a new “Automatic Ready Hermes + Telegram Creation” ledger before any quality-gate setup or implementation work begins.
- Initial content: Add this plan's source paths, assumptions, complete step checklist, current status, validation/evidence table, blockers, and next step.
- Update rule: After each step is completed, update `PROGRESS.md` with the completed step, validation results, commit reference if available, current status, and next step. Never record credentials, raw provider responses, private runner endpoints, Droplet IPs, or secret-bearing output.

## Changelog Tracking

- File: `CHANGELOG.md`
- Standard: Keep a Changelog 1.0.0, <https://keepachangelog.com/en/1.0.0/>
- Requirement: Preserve the existing changelog and confirm it contains `# Changelog`, the standard preamble, and a top-level `## [Unreleased]` before implementation starts.
- Update rule: After each step is completed and validated, update `CHANGELOG.md` before creating that step's commit only if the step shipped a functional change. Use only applicable `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security` headings, keep newest entries first, and omit empty headings.
- Exclusions: Do not add entries for planning, progress tracking, tests/coverage alone, CI/validation runs, docs-only work, or framework/housekeeping changes.

## Goal Handoff

- Readiness: This plan is ready to be used as a `/goal` payload.
- Scope: The `/goal` should execute only the work described here unless the user explicitly expands it. It must not provision billable infrastructure, mutate hosted secrets, publish images, or contact a real Telegram user until the relevant step and authorization prerequisites are satisfied.
- Done: The `/goal` is complete only when every item in `## Definition of Done` is satisfied, all incremental steps are complete, required gates pass or documented pre-existing failures are handled, live Telegram reply evidence is collected, `PROGRESS.md` and `CHANGELOG.md` are current, and the final state is summarized for the user.

## Incremental Steps

### Step 0: Progress and Changelog Tracking Setup

Goal: Establish a durable execution ledger for automatic Hermes/Telegram creation without erasing prior milestone history.

Depends on:

- None.

Changes:

- Append a dedicated plan ledger and unchecked Step 0–10 checklist to `PROGRESS.md`.
- Record the BYOK-versus-native-OAuth conflict, the OpenRouter-first assumption, external acceptance prerequisites, current status, and next step.
- Verify `CHANGELOG.md` already follows Keep a Changelog 1.0.0; preserve all existing entries and the top-level `## [Unreleased]` section.
- Update `tests/unit/progress-status.test.ts` only if its structural assertions need the new ledger title/checklist.

Acceptance criteria:

- Existing progress history remains intact.
- The new ledger exposes every plan step, evidence field, current blocker, and next action.
- The changelog structure is valid and receives no tracking-only entry.

Advances Definition of Done:

- Makes autonomous execution and later live-acceptance evidence inspectable.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Mark Step 0 complete in `PROGRESS.md`, record validation results and the commit reference if available, set Step 1 as next.

Changelog:

- Do not add an entry; this step changes tracking only.

Commit:

- `docs: initialize automatic Hermes deployment tracking`

### Step 1: Quality Gates Setup and Baseline Evidence

Goal: Add the missing fail-closed staging acceptance entrypoint and record the pre-implementation baseline.

Depends on:

- Step 0.

Changes:

- Add `verify:hermes:staging` to `package.json` and a bounded script under `scripts/` that preflights the published image digest, explicit DigitalOcean budget authorization, runner credentials, OpenRouter key, dedicated Telegram bot token, and Telegram test-user/chat identifiers.
- Make the preflight report only named configured/missing capabilities and safe fingerprints; never echo raw values.
- Require a separate explicit confirmation variable before any billable Droplet or Telegram send. A missing capability must fail closed and must not be reported as a passing smoke.
- Document the command and prerequisites in `docs/E2E_VALIDATION.md` and `.env.example` using placeholders only.
- Add unit tests for capability detection, secret redaction, and the no-side-effect failure path.
- Run the existing baseline before changing product behavior and record any pre-existing failure separately.

Acceptance criteria:

- The repository has an exact command for final live acceptance.
- Running it without capabilities performs no external mutation and returns a safe actionable failure.
- Core baseline results are recorded before implementation.

Advances Definition of Done:

- Establishes the required external quality gate before feature work begins.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run verify:hermes:staging` without live capabilities and confirm fail-closed/no-side-effect behavior.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Update `PROGRESS.md` with baseline and preflight evidence, commit reference if available, current status, and Step 2.

Changelog:

- Do not add an entry; a validation harness alone is not a functional product change.

Commit:

- `test: add fail-closed Hermes staging gate`

### Step 2: Align Readiness With the Pinned Hermes Contract

Goal: Make a real pinned Hermes gateway capable of reaching readiness and clean up failed partial launches.

Depends on:

- Steps 0–1.

Changes:

- Update `src/runner-service/docker.ts` so `/health/detailed` parsing matches pinned `v2026.7.7.2`: require safe top-level/gateway state plus `platforms.api_server.state` and, when required, `platforms.telegram.state`.
- Remove the nonexistent Hermes `configRevision` response-field requirement. Continue verifying revision through `agentbay.config_revision` Docker labels, projected `agentbay-config-revision.json`, expected image, and exact mounts.
- Return typed readiness reasons (`api_server_not_connected`, `telegram_not_connected`, `gateway_failed`, `revision_mismatch`, `timeout`) without raw upstream bodies.
- On readiness failure, stop/remove the just-launched mismatched container or explicitly retain it as a reconciler-owned partial state; do not leave an untracked running gateway.
- Update `tests/unit/docker-runner-adapter.test.ts`, `tests/unit/hermes-lifecycle-readiness.test.ts`, and runner-service tests with an exact bounded fixture from the pinned contract.
- Change `scripts/smoke-local-hermes-contract.ts` so it exercises the production parser/waiter rather than replacing it. Use local fake platform state; do not claim external Telegram behavior.

Acceptance criteria:

- The pinned response fixture can become ready without `configRevision` in HTTP JSON.
- API-server or Telegram non-connected states remain not ready.
- Revision mismatch is still rejected using runner-owned evidence.
- A failed launch leaves no orphaned selected-agent container and records a safe `agent.error` path.

Advances Definition of Done:

- Removes the immediate production blocker and makes readiness evidence truthful.

Validation:

- Run focused readiness, lifecycle, runner, and smoke unit tests.
- Run `bun run agent:hermes:contract-smoke`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Update `PROGRESS.md` with fixture/smoke evidence, validation results, commit reference if available, current status, and Step 3.

Changelog:

- Add a `Fixed` entry describing successful pinned-Hermes readiness and partial-container cleanup.

Commit:

- `fix: align Hermes gateway readiness contract`

### Step 3: Persist Desired State and Deployment Operations

Goal: Add the durable, idempotent control-plane state needed for asynchronous automatic deployment.

Depends on:

- Steps 0–2.

Changes:

- Extend `src/server/db/schema.ts` and generate a migration for explicit agent desired state plus `agent_deployments`.
- Model deployment ID, agent/user ownership, stage, config revision, idempotency key, attempt count, safe error code/detail, next-attempt time, lease owner/expiry, started/completed/failed timestamps, and audit timestamps.
- Enforce one active deployment per agent, owner-scoped lookup indexes, and idempotency uniqueness at the database boundary.
- Add server-only deployment DTO/parser/state-transition modules under `src/server/agents/` with an allowed transition table and terminal-state immutability.
- Add owner-scoped deployment read service and `GET /api/agents/[agentId]/deployment` without exposing secrets or internal endpoints.
- Preserve existing agents as `desiredStatus=stopped` in the migration; do not auto-start historical records.

Acceptance criteria:

- Migrations preserve every existing agent and default historical desired state safely.
- Duplicate idempotency keys resolve to the same operation.
- Concurrent claim attempts produce one active lease.
- Foreign-user deployment reads return the existing concealed not-found behavior.

Advances Definition of Done:

- Creates the durable operation and desired/observed separation required for orchestration and UI polling.

Validation:

- Run `bun run db:generate`.
- Run `bun run db:migrate` against a clean local database and an existing migrated database fixture.
- Run focused schema, migration, deployment-state, idempotency, and user-isolation tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Update `PROGRESS.md` with migration/concurrency evidence, commit reference if available, current status, and Step 4.

Changelog:

- Add a `Changed` entry only if the desired-state/deployment API is externally observable in this step; otherwise record no changelog entry.

Commit:

- `feat: persist agent deployment operations`

### Step 4: Add Managed Creation Configuration and Encrypted Credentials

Goal: Let the server atomically create everything required for an automatic OpenRouter + Telegram deployment.

Depends on:

- Steps 0–3.

Changes:

- Extend create payload validation in `src/server/agents/create-agent.ts` with `launchMode`, idempotency key, OpenRouter model, OpenRouter key, Telegram bot token, and numeric allowed-user IDs.
- Add a server-side approved OpenRouter model metadata contract that rejects `not_configured`, unsafe tokens, and models below the supported Hermes context threshold.
- Reuse encrypted agent-secret primitives, but add transaction-aware insertion so agent/config/secrets/generated API key/deployment/event commit atomically.
- Validate the Telegram bot token with a bounded `getMe` client before persistence; store only safe bot ID/username metadata needed for display. Never log the URL containing the token.
- Reject a Telegram token fingerprint already active for another non-deleted agent; add a partial uniqueness constraint if database enforcement is practical with the existing fingerprint contract.
- Make `POST /api/agents` return `202` with `{agent, deployment}` for `launchMode:"ready"`; retain explicit `launchMode:"stopped"` compatibility during rollout.
- Add validation, route, transaction rollback, idempotency, duplicate-token, encryption, redaction, and user-isolation tests.

Acceptance criteria:

- Invalid model, bot token, or allowlist fails before runner/DigitalOcean side effects.
- A database failure leaves no partial agent, secret, or deployment rows.
- Retrying the same idempotency key returns the same operation without revalidating into duplicate state.
- Responses/events/logs contain no OpenRouter key, Telegram token, API key, ciphertext, auth tag, or private endpoint.

Advances Definition of Done:

- Makes automatic deployment inputs complete, secure, owner-scoped, and durable.

Validation:

- Run `bun run db:generate` and `bun run db:migrate` if a uniqueness migration is required.
- Run focused create validation/route/DB, secret, Telegram-client, idempotency, and isolation tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Update `PROGRESS.md` with atomicity/redaction evidence, commit reference if available, current status, and Step 5.

Changelog:

- Add `Added` and, if applicable, `Security` entries for ready-mode creation and encrypted/unique Telegram credentials.

Commit:

- `feat: accept managed Hermes creation credentials`

### Step 5: Project a Complete Managed Hermes Configuration

Goal: Start automatic agents without running the interactive Hermes setup wizard.

Depends on:

- Steps 0–4.

Changes:

- Version the launch contract in `src/server/agents/agent-launch-spec.ts` to include selected OpenRouter provider/model, required platform list, Telegram bot/allowlist secrets, API key, runtime settings, and a deterministic config revision.
- Update `src/server/agents/agent-launch-builder.ts` to decrypt exactly the required active secrets for the owner and return typed missing/revoked failures.
- Add a YAML parser/serializer only if needed; pin it and use strict plain-object parsing with prototype/pollution defenses and deterministic output.
- Update `src/runner-service/hermes-projection.ts` to merge plingpling-owned model, terminal, browser, guardrail, API-server, and Telegram settings into `config.yaml`, and managed provider/Telegram/API secrets into `.env`.
- Preserve unrelated Hermes-owned advanced settings while making managed paths authoritative. Continue atomic writes, symlink/path-escape rejection, UID/GID ownership, `.env` mode `0600`, and revision metadata.
- Remove the `config.yaml` existence gate only for valid managed launch specs; retain it for legacy/native-manual specs.
- Keep `app/agents/_components/agent-hermes-setup.tsx` and setup-session routes as advanced/recovery tools, with copy that managed settings will be reapplied on restart.
- Update launch-spec helpers and all parser, redaction, projection, setup-compatibility, backup, restore, and lifecycle tests.

Acceptance criteria:

- A fresh empty per-agent state root can be projected and launched from database state alone.
- The resulting config enables API server and Telegram, selects the requested model, and contains no secret outside `.env`.
- Re-projecting the same revision is byte-stable; a new revision updates only managed values and preserves unrelated advanced values.
- Redacted launch specs cannot reveal any credential.

Advances Definition of Done:

- Removes the mandatory interactive setup blocker and establishes plingpling as the automatic path's source of truth.

Validation:

- Run focused launch-spec, builder, projection, secret-redaction, setup-session, backup/restore, and lifecycle tests.
- Run `bun run agent:hermes:contract-smoke` with local fake model and fake Telegram platform state.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Update `PROGRESS.md` with deterministic projection/redaction evidence, commit reference if available, current status, and Step 6.

Changelog:

- Add `Changed` and `Security` entries for wizard-free managed configuration and secret projection.

Commit:

- `feat: project managed Hermes and Telegram config`

### Step 6: Split Runner Launch Acceptance From Observed Readiness

Goal: Ensure Vercel requests do not block on Hermes boot while preserving exact runner control and diagnostics.

Depends on:

- Steps 0–5.

Changes:

- Refactor `src/runner-service/docker.ts` into idempotent launch acceptance and readiness/status probing. Reuse an already-running exact image/revision container; replace only stale/mismatched selected containers.
- Change runner `POST .../start` and restart contracts in `src/runner-service/server.ts` to return a typed accepted operation quickly after projection and Docker launch.
- Extend runner status with redacted Hermes observations: container state, applied revision, gateway state, API-server state, Telegram state, readiness reason, and observation timestamp.
- Keep all Hermes probing on the runner's private Docker network and require the generated bearer key.
- Update `src/server/runners/manual-runner-adapter.ts` and lifecycle adapters to understand accepted versus ready without falsely writing `running` immediately.
- Make stop/delete cancel in-progress launches and clean state idempotently.
- Add timeout, duplicate launch, mismatched revision, partial crash, unauthorized probe, and redaction contract tests.

Acceptance criteria:

- Runner start returns within a bounded short command timeout while Hermes may still be starting.
- Repeating start for the same revision creates exactly one selected container.
- Status distinguishes accepted/starting/ready/failed and exposes no raw health body or secrets.
- Existing stop/restart/delete remain safe during every intermediate state.

Advances Definition of Done:

- Establishes the nonblocking runner boundary required by durable control-plane reconciliation.

Validation:

- Run focused runner-service, manual-adapter, lifecycle, route, Docker, auth, and redaction tests.
- Run `bun run agent:hermes:contract-smoke`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Update `PROGRESS.md` with timing/idempotency evidence, commit reference if available, current status, and Step 7.

Changelog:

- Add a `Changed` entry for asynchronous runner launch and truthful observed readiness.

Commit:

- `refactor: make Hermes runner launches asynchronous`

### Step 7: Reconcile Creation Through Ready

Goal: Automatically advance a persisted ready-mode deployment from runner provisioning to a verified running Hermes/Telegram agent.

Depends on:

- Steps 0–6.

Changes:

- Add an idempotent deployment reconciler under `src/server/agents/` that claims one expired/available lease, performs at most one bounded side-effect stage, records the result/event, and schedules the next attempt.
- Reuse existing runner placement/provisioning services without performing DigitalOcean side effects inside the create transaction.
- Trigger reconciliation opportunistically after create, after runner registration/heartbeat, and from a protected `app/api/internal/agent-deployments/reconcile/route.ts` Vercel cron route.
- Protect the internal route with the deployment's cron secret contract; document `CRON_SECRET`/Vercel configuration without committing values.
- Add bounded exponential backoff, terminal/nonterminal error classification, stale-lease recovery, maximum attempts, and an operator retry action that does not duplicate resources.
- After runner readiness, dispatch the exact launch revision, poll typed runner status, execute one bounded no-tools model canary through the runner/private API, require Telegram `connected`, then atomically mark deployment `ready`, desired/observed agent `running`, open usage accounting, and emit completion events.
- On failure, set safe deployment/agent error state, capture redacted runner logs, close reservations, and make cleanup/retry ownership explicit.

Acceptance criteria:

- Closing the browser after `202` does not stop eventual deployment progress.
- Concurrent create kick, heartbeat, cron, and manual retry triggers do not duplicate side effects.
- A model that cannot answer or a Telegram adapter that cannot connect never becomes ready.
- Successful reconciliation records one running transition and one usage period.

Advances Definition of Done:

- Delivers the core automatic create-to-ready system behavior.

Validation:

- Run focused reconciler lease, transition, retry, provisioning, lifecycle, canary, Telegram readiness, event, cost/usage, and isolation tests.
- Run local-cloud smoke with delayed runner heartbeat and duplicate reconcile triggers.
- Run `bun run agent:hermes:contract-smoke`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Update `PROGRESS.md` with concurrency/canary evidence, commit reference if available, current status, and Step 8.

Changelog:

- Add an `Added` entry for durable automatic create-to-ready deployment and safe retry behavior.

Commit:

- `feat: reconcile agents automatically to ready`

### Step 8: Add One-Click Creation and Persisted Progress UI

Goal: Give users a compact creation experience that truthfully tracks the durable deployment operation.

Depends on:

- Steps 0–7.

Changes:

- Update `app/agents/_components/create-agent-form.tsx` to collect model, masked OpenRouter key, masked Telegram bot token, and normalized allowed-user IDs, with clear BotFather/allowlist guidance and no secret rehydration.
- Replace timer-simulated setup stages with polling of the persisted deployment endpoint; use the exact server stages and safe error actions.
- Generate/send an idempotency key per submission, retain it across retry, and prevent duplicate browser submission.
- Redirect/link to the agent detail while deployment continues and show the same persisted stage on inventory/detail/dashboard surfaces.
- Update lifecycle controls so Start is unnecessary for ready-mode creation, Stop changes desired state, Retry resumes failed deployments, and advanced Hermes setup remains available but secondary.
- Add accessible desktop/mobile states for provisioning, configuring, starting, model verification, Telegram connection, ready, failed, retrying, and intentionally stopped.
- Update route/component/page tests and Playwright create/progress/failure/mobile coverage using fake runner/provider/Telegram seams.

Acceptance criteria:

- UI stages remain accurate after refresh, navigation, or opening another browser.
- Secret inputs are cleared after submission and never rendered from server state.
- A successful ready-mode submission ends on an agent marked ready/running without pressing Start or opening Hermes setup.
- Failure copy identifies the safe next action without raw upstream detail.

Advances Definition of Done:

- Makes the automatic backend flow usable without founder assistance.

Validation:

- Run focused create-form, deployment-status, lifecycle-control, route, redaction, and operational page tests.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci` for desktop and mobile.
- Run `bun run verify:e2e` only in the documented local-cloud/provider-safe environment.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Update `PROGRESS.md` with browser/mobile evidence, commit reference if available, current status, and Step 9.

Changelog:

- Add `Added` and `Changed` entries for credential-complete one-click creation and persisted progress UI.

Commit:

- `feat: add one-click ready agent creation`

### Step 9: Make Desired-Running Gateways Durable

Goal: Keep ready agents running across Docker/runner restarts while respecting intentional stops.

Depends on:

- Steps 0–8.

Changes:

- Add `--restart unless-stopped` or the reviewed equivalent to selected-agent containers and assert it during Docker inspect.
- Change Stop to persist `desiredStatus=stopped` before removing/stopping the workload; Start/ready-mode creation persists `desiredStatus=running` before reconciliation.
- Extend runner heartbeat or bounded status reconciliation with selected workload observations sufficient to detect missing/exited/mismatched containers and Telegram platform state.
- Reconcile desired-running agents after runner registration/heartbeat and periodically through cron. Do not restart deleted, stopped, over-capacity, revoked-secret, or terminally failed agents.
- Detect Telegram `retrying`, `fatal`, `paused`, and prolonged non-connected states; create safe alerts/events and apply bounded recovery rather than infinite restart loops.
- Preserve one continuous or correctly segmented usage period according to actual observed running intervals.
- Add reboot, Docker daemon restart, intentional stop, stale heartbeat, circuit-breaker, revoked secret, and no-restart-loop tests.

Acceptance criteria:

- A desired-running agent returns to ready after a simulated runner reboot without user action.
- An intentional stop remains stopped after runner/Docker restart.
- Telegram failure is visible and bounded; it cannot silently leave an agent displayed ready.
- Restart/reconciliation does not duplicate containers, usage periods, or events.

Advances Definition of Done:

- Provides the operational durability expected from an always-on Telegram agent.

Validation:

- Run focused Docker inspect/restart-policy, runner heartbeat, reconciliation, lifecycle, alert/event, and usage-period tests.
- Run local Docker/cloud reboot and restart smoke scenarios.
- Run `bun run agent:hermes:contract-smoke`.
- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `git diff --check`.
- Fix every failure before proceeding.

Progress:

- Update `PROGRESS.md` with reboot/stop/circuit-breaker evidence, commit reference if available, current status, and Step 10.

Changelog:

- Add `Changed` and `Fixed` entries for desired-state recovery and intentional-stop durability.

Commit:

- `feat: reconcile durable Hermes gateway state`

### Step 10: Final Acceptance, Documentation, and Controlled Rollout

Goal: Prove the full hosted Telegram outcome, document operations/rollback, and enable automatic-ready creation safely.

Depends on:

- Steps 0–9.
- Authorized staging resources and credentials listed in assumptions.

Changes:

- Update `.env.example`, `README.md`, `docs/E2E_VALIDATION.md`, and deployment/operator documentation with ready-mode variables, cron protection, model/Telegram prerequisites, BotFather steps, allowlist behavior, state meanings, retry/cleanup, canary cost, restart behavior, and rollback.
- Update `docs/MILESTONES.md` and `PROGRESS.md` with verified Milestone 18/19 evidence and any explicitly deferred native-OAuth automation.
- Build/scan/publish the reviewed Hermes image if required and record only image digests/CI references.
- Run `verify:hermes:staging` against one authorized basic DigitalOcean runner and dedicated Telegram bot: create ready-mode agent, observe all persisted stages, send a unique Telegram message from the allowed user, receive and correlate the Hermes reply, inspect redacted logs/events, restart and re-verify, stop and verify it remains stopped, then clean up authorized resources.
- Test failure cases with an invalid token using a non-live fixture, provider canary failure, runner delay, duplicate idempotency submission, and reconciliation retry.
- Enable `AGENTBAY_READY_AGENT_CREATION_ENABLED` for the controlled environment only after the smoke passes; retain explicit `launchMode:"stopped"` rollback.
- Perform a final secret scan of diffs, logs, progress, changelog, test artifacts, and deployment evidence.

Acceptance criteria:

- An allowed Telegram user receives a real reply from the newly created hosted Hermes agent without pressing Start or opening setup.
- Restart and intentional stop behavior match desired state.
- Logs/events/status provide enough redacted evidence to diagnose provisioning, model, and Telegram failures.
- Rollback to stopped/manual creation is documented and tested.
- No credentials, private endpoints, user PII, or secret-bearing provider responses are committed or retained in artifacts.

Advances Definition of Done:

- Closes every behavioral, operational, documentation, migration, and live-acceptance requirement.

Validation:

- Run `bun run format:check`.
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Run `bun run test:e2e:ci`.
- Run `bun run verify:e2e` in the documented provider-safe environment.
- Run `bun run agent:image:smoke` against the exact release candidate image.
- Run `bun run agent:hermes:contract-smoke`.
- Run `bun run verify:hermes:staging` with explicit authorized capabilities.
- Run `git diff --check` and the repository's secret scanning/review checks.
- Fix every failure before proceeding; do not mark live acceptance complete from mocks alone.

Progress:

- Mark Step 10 and the plan complete in `PROGRESS.md`, record sanitized CI/deployment/image/live-smoke references and final cleanup, and summarize the finished state.

Changelog:

- Add final `Added`, `Changed`, `Fixed`, and/or `Security` entries only for observable behavior not already recorded by prior functional steps. Do not add entries for docs, tests, validation, or rollout evidence alone.

Commit:

- `feat: complete automatic Hermes Telegram rollout`
