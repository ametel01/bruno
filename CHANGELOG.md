# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases begin.

## [Unreleased]

### Added

- Protected snapshot builds now publish each sanitized signed Snapshot Attestation v2 bundle to
  GHCR as an OCI artifact, return only its immutable OCI manifest reference plus exact bundle
  digest, re-pull and verify both identities, retain the signing public key with the bundle, and
  verify active and previous approval candidates without granting ordinary CI or release workflows
  provider-dispatch authority.
- Snapshot Attestation v2 now binds exact immutable runner, default-agent, Hermes, boot-contract,
  base OS, architecture, region, disk, and provider-availability identities in a canonical signed
  bundle. Production selects one exact revocable digest, verifies the bundle through an overlapping
  operator-managed Ed25519 key-ID trust set, rejects v1, keeps source and timestamps as non-expiring
  provenance, and can restore a retained compatible digest without rewriting its attestation.
- Bounded deployment recovery now drains at most 25 due items under one shared 40-second cron
  deadline, preserves PostgreSQL-first progress during QStash outages, aborts stalled hint
  publication while its delivery generation remains fenced, and reports only the active
  `cron`/`qstash` mode (or fail-closed `invalid`) through public health evidence.
- Bounded poison-wakeup handling now exhausts permanent QStash authentication/payload failures
  immediately and retryable publication failures after an atomic configurable attempt limit of 12
  by default. Exhausted generations leave ordinary claims, retain only sanitized operational
  evidence, and can be inspected or transactionally replayed through bearer-protected operator
  routes only while their Agent Deployment remains active and the generation remains current.
- An immutable 30-slot Provider Trial Cohort ledger that pre-creates numbered attempts, retains one
  pre-commit or exact deployment-linked request outcome and one terminal outcome per slot, prevents
  membership replacement after start, reports API acceptance separately from failure-inclusive
  ready-within-60 results, and supports deterministic sanitized Ed25519-signed evidence by exact
  cohort ID.
- Immutable database-clock Agent Deployment acceptance boundaries, origin, initial cohort,
  environment, Owner-cancellation evidence, and rollout-configuration generation with a versioned
  sanitized report that selects the latest 100 Eligible Cold Deployments before gating. Unknown
  configuration and contradictory cancellation evidence fail visibly. Slow readiness, terminal
  failure, and absence of readiness at the boundary remain diagnostic causes of the canonical SLO
  Miss, while unbackfilled historical rows remain diagnostic.
- Bounded automatic DigitalOcean provider-phase draining now reaches `waiting_for_runner` in one
  fake/injected provider action, skips redundant tag writes when create already proves the required
  tags, adopts crash-completed create/tag/firewall effects through authoritative observation, and
  persists immediate versus external-wait deployment wakeups from typed provisioner dispositions.
- Bounded post-registration deployment drains now pin one deployment across at most eight
  immediately executable stages under one 45-second abort budget, preserve generation/lease fences,
  publish exact external-wait wakeups, and finish runner-ingress deployment work before one runtime
  reconciliation kick.
- Safe Same-Owner Reuse now fails closed to measured CPU, physical-memory, disk, heartbeat,
  configured, and explicit profile-cap evidence, reserves capacity under owner-aware transaction
  locks, falls implicit capacity losers back to Cold Deployment, and reports Cold-Deployment latency
  separately from Same-Owner Reuse.
- Canonical DigitalOcean managed-runner resource profiles now couple price and physical resource
  metadata, reject incompatible Hermes CPU/memory/capacity combinations before provider effects,
  propagate exact Hermes Docker CPU/memory/PID limits through cloud bootstrap, and keep provider
  size-comparison benchmarks fail-closed behind explicit candidate slugs and authorization.
- Protected manual runner snapshot build plumbing with signed manifest verification, fake-provider
  cleanup/order coverage, snapshot-mode first boot, stock rollback, and fail-closed snapshot evidence
  validation before hosted Droplet creation.
- Generation-fenced deployment wakeups with a PostgreSQL outbox, protected signed internal delivery
  route, QStash fail-closed configuration, cron recovery sweep, and regression coverage for
  duplicate, early, unsigned, and stale delivery behavior.
- Read-only Agent Deployment latency benchmark reporting with deterministic p50/p95 summaries,
  invalid-evidence surfacing, local smoke timing output before cleanup, and fail-closed provider
  benchmark authorization.
- Production Pino JSON logging with configurable levels, recursive credential redaction, normalized errors, correlated agent/Droplet/deployment lifecycle fields, and targeted provider, runner-ingress, retry, terminal-failure, and cleanup instrumentation.
- A fail-closed `local:agent:smoke` regression gate now runs the complete ready-agent create, deploy, model-canary, restart, stop, delete, and cleanup cycle inside exactly one Docker-based Droplet simulator with its own nested daemon; it verifies the pinned Hermes image and executable inside that Droplet and probes the started gateway's authenticated detailed-health endpoint in-container while keeping model and Telegram network boundaries synthetic and making no DigitalOcean request.
- Automatic managed-runner recovery now provisions immutable digest-pinned replacement capacity, rediscovers interrupted targets by operation tag, verifies fresh release and boot readiness plus assignment capacity, and safely cleans failed targets without disturbing source workloads.
- Capability-backed cloud runner boot validation now verifies Docker and self-image access, an isolated pinned Hermes fixture, private detailed health, a fixed model canary, synthetic no-traffic Telegram configuration loading, and exact cleanup before a compatible runner becomes assignable.
- Authenticated runner heartbeats now report Docker-observed immutable image digests, bounded OCI release versions, and the versioned runner boot contract, while cloud bootstrap carries expected release identity only as non-secret comparison data.
- A nontechnical agent setup flow with two assistant choices, ChatGPT and Claude, owner-scoped encrypted connection reuse, first-connection-only API-key entry, fixed safe defaults, and one primary “Create my agent” action while the app owns model, runner, configuration, launch, and health-check details.
- Server-owned ChatGPT and Claude assistant profiles with encrypted direct OpenAI/Anthropic credentials, strict managed launch parsing, exact Hermes provider/environment projection, bounded model selection, and a legacy-only OpenRouter compatibility branch.
- Default-disabled durable Hermes staging acceptance with exact published-image provenance, isolated ownership, one-effect reconciliation, two interactive-human Telegram reply attestations, restart/Stop/rollback evidence, and ordered workload, secret, firewall, Droplet, and runner cleanup.
- Credential-complete one-click ready agent creation with masked direct model and Telegram inputs, normalized Telegram allowlists, idempotent submission, and persisted deployment progress across inventory, detail, dashboard, refreshes, and browser contexts.
- Automatic ready-mode deployments now reconcile durably from creation to verified running state with bounded leases, post-response/heartbeat/cron triggers, one canary, Telegram-ready confirmation, usage-period completion, and a safe owner-scoped retry API.
- Managed Hermes launch-spec v3 now carries server-selected ChatGPT/OpenAI or Claude/Anthropic configuration plus server-only model, Telegram, Telegram allowlist, and private API credentials from persisted deployment state.
- Automatic Hermes agents now receive a complete managed `config.yaml`, `.env`, `SOUL.md`, workspace, and revision projection from a fresh runner state root without requiring native `hermes setup`.
- Opt-in `202 Accepted` ready-mode agent creation for ChatGPT or Claude and Telegram inputs.
- Exact `BRUNO_ALLOW_PUBLIC_DEVELOPMENT=true` opt-in for temporarily exposing a Vercel production-target deployment with the shared development user while keeping hosted development fail-closed by default and preserving runner-machine authentication.
- Renamed the user-facing application and local package/database defaults to Bruno.
- Credential-free local Hermes contract smoke command (`agent:hermes:contract-smoke`) that launches the pinned workload image with a fake OpenAI-compatible provider, private API auth checks, durable log ingestion, restart/state persistence, managed-state backup/restore, and cleanup without claiming external Telegram network behavior.
- Durable Hermes gateway log ingestion from the runner-managed `/opt/data` log stream, with source classification for gateway output versus container bootstrap diagnostics.
- Safe Hermes runtime diagnostics for runner log transport, app-side log persistence, and assigned-runner cleanup.
- Authenticated private Hermes readiness polling for runner-managed gateway launches, including config-revision and Telegram readiness checks before start/restart completion.
- Versioned Hermes launch specs, server-side launch-spec building with only the generated private API-server key, authenticated runner JSON transport, and managed per-agent Hermes prompt, revision, and workspace projection that preserves Hermes-owned provider state.
- Native `hermes setup` on the agent detail page through a short-lived interactive terminal, letting users choose a Hermes-supported subscription OAuth path, model, and optional messaging configuration without Bruno collecting provider API keys.
- Encrypted per-agent secret storage, owner-scoped secret status/update/revoke APIs, generated agent API keys, and secret-free backup/restore/delete handling for the Hermes setup path.
- Pinned Hermes workload image artifact, local smoke verification, and a separate scanned GHCR publication workflow for the first real Bruno-managed Hermes runtime.
- Server-only `BRUNO_AUTH_MODE` policy for registration-free loopback development, fail-closed Clerk production/custom-domain access, explicitly protected preview opt-in, and request-scoped shared-user resolution without changing runner-machine authentication.
- Assigned-runner detail and cloud-runner cards now show labeled raw-infrastructure estimates and active-agent allocation with explicit unavailable and failure states while preserving health and capacity context.
- Internal user resolution for Clerk sessions and registration-free development, with opaque unique Clerk links, concurrency-safe lazy creation, and an explicit count-only dry-run legacy claim that refuses ambiguous or conflicting ownership.
- Deterministic server-side daily and monthly runner infrastructure cost estimates from user-scoped usage periods, including overlapping-uptime unioning, per-agent allocation, supplied-clock windows, and explicit unavailable pricing states.
- Dashboard now shows server-rendered daily and monthly raw-infrastructure estimates, runner monthly cost, running-agent counts, per-active-agent estimates, and explicit unavailable and safe loader-failure states.
- Clerk-capable sign-in, registration, current-user, and sign-out surfaces with a Next.js 16 proxy route matrix that preserves the temporary Basic operator barrier and existing runner machine authentication until production cutover.
- Durable `agent_usage_periods` persistence for reproducible infrastructure usage tracking, with start/stop lifecycle instrumentation, continuous restart semantics, open intervals for missing stops, and no credential-bearing usage metadata.
- Dedicated runner Docker image artifact that packages the existing runner bootstrap and service runtime without Droplet-side source checkout or GitHub credentials.
- Server-side `BRUNO_RUNNER_IMAGE` selection for DigitalOcean cloud runner provisioning, including the public GHCR default, trimmed non-empty overrides, blank override validation, and safe runner image metadata in bootstrap/provisioning events.
- Runner service heartbeat loop that reports cloud runner online status and capacity metrics using the persisted runner credential.
- Initial Bruno root app page that points users to the dashboard route.
- Database-backed `/health` endpoint and local Postgres migration tooling for operator checks.
- Bruno product shell and initial routes for `/`, `/dashboard`, `/agents`, `/agents/:agentId`, and `/settings`, with empty states and placeholder-only settings surfaces.
- Milestone 1 Postgres schema migration for `users`, `agents`, `agent_events`, and the `agent_status` enum without enabling agent creation or lifecycle behavior.
- `POST /api/agents` for validated transactional creation of stopped persistent agents and matching `agent.created` events.
- Database-backed `/agents` create/list workflow for creating stopped persistent agents and showing refreshed active records with stable links.
- Database-backed dashboard and agent detail read surfaces for active persisted agents, including refreshed stopped status visibility and not-found handling for missing or inactive detail records.
- `POST /api/agents/:agentId/actions/start` and Start UI controls that launch a real local runner child process, transition to running only after spawn succeeds, and record matching lifecycle events.
- `POST /api/agents/:agentId/actions/stop` and Stop UI controls that terminate the tracked local runner child process before refreshing status back to stopped.
- `POST /api/agents/:agentId/actions/restart` and Restart UI controls that terminate the tracked local runner child, start a replacement process, and record matching lifecycle events.
- `DELETE /api/agents/:agentId` and Delete UI controls for soft-deleting non-transitioning active agents from active views while preserving audit events.
- Dashboard lifecycle controls for starting, stopping, restarting, and deleting active persisted agents without opening the detail page.
- Milestone 3 event timeline foundation with shared transactional event writers, event DTO mapping, opaque cursor helpers, and newest-first query helpers for per-agent and latest dashboard activity feeds.
- `GET /api/agents/:agentId/events` for safe per-agent activity pages with active-agent validation, bounded limits, and opaque cursor pagination.
- Dashboard latest activity feed showing newest persisted agent audit events with deleted-agent context.
- Agent detail activity feed showing event time, type, message, actor, metadata summaries, and older-page navigation.
- Durable `agent_logs` storage and `GET /api/agents/:agentId/logs` for active-agent scoped runtime log reads with numeric `after` sequence pagination.
- Development-only `POST /api/agents/:agentId/actions/simulate-error` action and shared non-production UI control for forcing active agents into `error` with one safe `agent.error` audit event.
- Pull-driven deterministic simulated runtime log generation for active running fake agents when `GET /api/agents/:agentId/logs` is read.
- Agent detail runtime log panel with loading, empty, loaded, and safe error states; scoped polling while running; readable retained logs after stop/error; and Milestone 4 desktop/mobile E2E verification.
- Persistent `agent_configs` defaults for active agents, including migration backfill and transactional default config creation during `POST /api/agents`.
- `PATCH /api/agents/:agentId` for validated agent config updates, deterministic no-op responses, integer-cent spend persistence, and one safe `config.updated` event for effective changes.
- Agent detail config editor for persisted local-development agent configs, including model/spend edits through the validated PATCH API, safe validation failures, refresh-backed saved state, and readable `config.updated` Activity entries.
- Dashboard pending approvals panel backed by the new `agent_approvals` persistence contract for active local-development agents.
- `POST /api/approvals/:approvalId/approve` and dashboard Approve controls for transactionally resolving one pending approval to `approved` with one `approval.approved` audit event.
- Agent detail pending approvals panel that renders only the selected active local-development agent's persisted pending requests with safe empty and error states.
- Fake running-agent approval generation that creates one deterministic pending approval and `approval.requested` event from the runtime-log observation path without exposing raw payload internals.
- `POST /api/approvals/:approvalId/deny` and dashboard Deny controls that transactionally resolve one pending approval to `denied`, record resolver fields, and write one safe `approval.denied` event.
- Mobile `/agents` status cards with wrapped agent identity fields, status-aware Resume and confirmed Stop controls backed by the existing lifecycle actions, and no one-tap mobile Delete action.
- Mobile-ready approval cards on dashboard and agent detail with requester, safe fake-runner payload summaries, coordinated Approve/Deny controls, mobile Deny confirmation, resolved approved/denied card state, and mobile Playwright coverage for both decisions.
- Mobile-ready agent detail latest log summaries and operational alerts derived from selected-agent status, pending or expired approvals, and alert-relevant events, with safe bounded text and documented runner-state alert deferral until runner state exists.
- Local runner process metadata and stdout/stderr agent log persistence helpers for Milestone 9, including safe last-error storage, process-scoped log reads, stable per-agent log ordering, and audit-event separation.
- Dashboard latest process logs panel for active agents, with stdout/stderr lines, timestamps, agent links, safe empty/error states, and seeded UI coverage for scoped persisted process logs.
- Local runner adapter interface for starting, stopping, restarting, status checks, and persisted log-stream reads with a real dummy child process by default and explicit executable/argv configuration for future Hermes swaps.
- Docker runner container metadata persistence for selected agents, including exact container ID, container name, image, observed status, timestamps, sanitized metadata, and exact-container scoped log helpers for future Docker adapter work.
- Docker runner adapter primitives for starting, stopping, restarting, inspecting, and log-streaming one selected-agent container through Docker CLI argument arrays with labels, isolated workspaces, read-only config mounts, and initial CPU/memory limits.
- Agent runtime log rows now persist a source and metadata alongside stdout/stderr line content, and the product log API/detail panel expose only a safe public log DTO without log-row, agent, runner, container, or raw metadata identifiers.
- Lifecycle-launched local runner crash handling that moves agents to `error`, records safe status reasons, persists process exit details, captures stdout/stderr logs, and writes an `agent.error` audit event.
- Start, Stop, and Restart API/dashboard/detail controls now run through the Docker runner adapter, preserving the existing lifecycle UI while creating, stopping, or replacing only the selected agent's Docker container and surfacing captured Docker stdout/stderr logs.
- Docker runner crash reconciliation that moves unexpectedly exited selected-agent containers to `error`, writes a safe `agent.error` audit event, and records a visible Docker-sourced stderr system log with exit metadata.
- Selected-agent Docker cleanup that validates the exact stored container ID and `bruno.agent_id` label before removing containers during delete cleanup.
- Standalone manual VPS runner service for selected-agent Docker start, stop, restart, status, and log APIs with temporary bearer-token auth, argv-only Docker calls, and `bruno.agent_id` label scoping.
- Milestone 5 agent templates with a typed metadata registry, durable template version/snapshot persistence, create-flow template metadata, and persisted template settings on agent detail pages.
- Manual VPS runner persistence with durable runner identity rows, nullable agent assignment, optional non-secret development bootstrap, endpoint validation, and active-agent assigned-runner helpers without changing no-runner lifecycle behavior.
- Runner auth persistence foundation with hash-only one-time registration token state, hash-only runner credential rows, heartbeat history, expanded runner status coverage, important lookup indexes, and reusable token/hash helpers.
- Dashboard lifecycle forwarding for active agents assigned to `manual_vps` runners, including dashboard-side start, stop, restart, status, and log pulls with temporary bearer auth, bounded timeouts, safe remote failures, persisted `manual_runner` log rows, and Docker fallback for unassigned agents.
- Dashboard and agent detail manual runner status surfaces with safe runner name, kind, endpoint host, persisted status, updated timing, assigned-runner notices, offline/degraded alerts, and remote runner log visibility without exposing runner IDs, credentials, raw endpoint internals, or metadata.
- One-time runner registration APIs: `POST /api/runners/registration-tokens` returns a visible-once `bruno_reg_*` token for the configured owning application user, and `POST /runner/v1/register` atomically exchanges it for durable runner identity plus a visible-once `bruno_run_*` credential while persisting only hashes and returning safe errors for unusable tokens.
- `POST /runner/v1/heartbeat` with scoped runner credential authentication, safe credential failure responses, bounded non-secret heartbeat metrics, credential last-used updates, online status transitions, and stale/missing heartbeat reconciliation to `offline`.
- Operator runner credential lifecycle APIs: `POST /api/runners/:runnerId/credentials/rotate` returns a visible-once replacement `bruno_run_*` credential while revoking existing active credentials, and `POST /api/runners/:runnerId/credentials/revoke` revokes active credentials so heartbeat authentication rejects old or revoked credentials without exposing stored hashes or previous raw credentials.
- Runner health visibility on dashboard, assigned-agent detail, and settings read surfaces, showing safe runner name, kind, endpoint host, heartbeat-derived status, version, last-seen time, and updated time without exposing runner IDs, credential material, hashes, or heartbeat metrics.
- Settings runner management controls for creating visible-once `bruno_reg_*` registration tokens, rotating registered runner credentials with visible-once `bruno_run_*` replacement display, and revoking active runner credentials with safe success, loading, validation, and error states.
- Cloud runner provisioning persistence and a server-only DigitalOcean provider contract with fake create, tag, firewall, cleanup, and failure paths for follow-on provisioning workflow tests.
- Backend `POST /api/runners` DigitalOcean provisioning workflow that validates create-runner input, persists refresh-safe provisioning phases, records Droplet create/tag/firewall API progress, creates a hash-only one-time registration token for bootstrap, returns duplicate-submit progress, and exposes safe failure state without provider credentials or registration secrets.
- Cloud runner bootstrap content, runner-side bootstrap registration, provisioning event tracking, cloud registration-token exchange, and first-heartbeat readiness transitions without exposing provider credentials or long-lived runner credentials.
- Settings and dashboard cloud runner provisioning surfaces with a Create Runner action, safe persisted provider/phase/readiness details, online heartbeat visibility, and redacted actionable failure guidance.
- Cloud runner assignment, failed-provision cleanup, and Milestone 13 operator evidence so online DigitalOcean runners can back assigned agents, owned failed Droplets are deleted where safe, and unsafe cleanup returns explicit manual instructions.
- Runner capacity normalization and placement selection so Milestone 14 create/start enforcement and UI summaries can share max-agent, running-agent, CPU, memory, and disk capacity fields.
- Agent creation and start now consume runner placement, assign eligible online runners, return safe plan/capacity blockers, and reserve runner capacity before start so concurrent starts cannot overbook the final slot.
- Docker runner start now gives each agent a distinct container-side config path and bind-mount target, strengthening multi-agent runtime isolation on shared runners.
- Backup persistence foundation with a durable `backups` table, manifest validation for agent/config/template/skills/memory/log metadata, conservative backup status transitions, and raw-secret rejection with safe secret references.
- Server-only backup object storage boundary with deterministic fake storage tests, S3-compatible configuration validation, safe storage URIs, and credential-free failure messages for backup artifacts.
- Manual agent backup creation through `POST /api/agents/:agentId/backups`, including sanitized manifest assembly, backup artifact upload, ready/failed backup persistence, and `backup.created` audit events.
- Backup restore creation through `POST /api/agents/:agentId/backups/:backupId/restore`, including artifact download, manifest validation, new stopped-agent creation, restored config/template metadata, restored backup status, and `backup.restored` audit events.
- Agent detail backup controls showing safe backup status, created/restored timestamps, manual backup creation, ready-backup restore actions, and restored-agent discovery without rendering storage URIs or raw artifact internals.

### Changed

- Completed the Bruno namespace migration across application copy, runtime configuration, generated
  credentials, database ownership keys, Docker resources, container images, and deployment workflows.

- Runner releases are now SHA-only immutable candidates that must pass digest verification, critical-vulnerability scanning, and one explicitly authorized, serialized disposable release canary against a production-configured staged control plane before that exact deployment can be promoted; test processes cannot construct a live DigitalOcean client, linked-repository production builds cannot bypass the canary, rollout is one runner per reconciliation, and artifact-backed rollback halts further fleet work.
- Automatic setup and runner recovery now share one public Preparing, Connecting Telegram, and Ready experience; live replacement hides misleading runner alerts and infrastructure identifiers, terminal recovery offers Retry or Stop, and technical runner evidence stays in a closed advanced disclosure.
- Desired-running agents now move automatically to a validated replacement runner through fresh deployment and runtime evidence, while stopped agents remain stopped and the obsolete managed firewall and Droplet are retired only after convergence.
- Managed runner assignment, explicit assignment, create/start placement, deployment selection, and live placement verification now share a fail-closed release policy: hosted DigitalOcean images must be immutable digest references, legacy managed rows remain `unknown` and unassignable until an authenticated heartbeat proves the exact configured digest, release version, and boot contract, while explicitly incompatible manual runners are excluded without being deleted.
- Managed desired-running Hermes gateways now recover through a durable, leased runtime reconciler with bounded observation, restart backoff, Telegram diagnostics, usage segmentation, and a circuit breaker across runner and Docker restarts.
- Agent lifecycle controls now follow persisted desired and deployment state: managed setup can be stopped or retried, ready agents need no Start action, and manual Hermes setup is secondary advanced recovery.
- Managed Hermes runner start/restart now return asynchronous launch acceptance with typed observed status and canary contracts, so the control plane no longer treats Docker launch as application readiness.
- Native/manual Hermes agents retain the launch-spec v2 compatibility path and still require existing Hermes setup state, while managed direct-provider deployments bypass that setup gate and reapply bruno-owned provider, Telegram, API-server, terminal, browser, safety, and prompt settings on start/restart.
- Agent records now persist explicit stopped/running desired state, and owners can read the latest deployment operation through `GET /api/agents/:agentId/deployment` without exposing leases, idempotency keys, or ownership internals.
- Split deterministic local verification from provider-backed acceptance: `bun run verify` now ends after the production build, while `bun run verify:e2e` adds the full E2E suite.

- Hermes launch now preserves the wizard-owned `/opt/data/config.yaml`, `.env`, `auth.json`, subscription, provider, model, and messaging state while Bruno merges only private API-server values and its prompt/revision files.
- DigitalOcean cloud runners now default back to the basic `$4` `s-1vcpu-512mb-10gb` tier for live Hermes validation, relying on the existing low-memory swap bootstrap instead of the previous 2 GB default.
- Assigned-runner delete cleanup now calls the runner cleanup path before soft-delete, and runner cleanup removes the selected container plus the exact per-agent Hermes state root idempotently.
- Runner-managed Hermes starts now launch the pinned workload image with `gateway run` on a private Docker network, projected `/opt/data` and `/workspace` mounts, bounded CPU/memory/PID limits, no published gateway port, label ownership, bounded graceful stops, and inspect validation before readiness.
- DigitalOcean cloud runners inject one-agent heartbeat capacity, prepare a private Hermes Docker network and managed state root, and pre-pull the pinned Hermes workload image during bootstrap.
- Browser runner settings, provisioning, placement, capacity, registration-token creation, and credential management now use explicit internal user ownership, while runner registration, heartbeat, bootstrap callbacks, and lifecycle bearer authentication remain machine-token based.
- Hosted app pages and app-side API routes now require operator access, while runner token endpoints remain credential-based.
- DigitalOcean cloud runner bootstrap now pulls and runs the selected runner image with Docker instead of depending on Droplet-side source checkout or host Bun setup.
- DigitalOcean cloud runner provisioning now requires and injects the server-side runner command bearer token for lifecycle API authentication.
- DigitalOcean cloud runner bootstrap now configures swap and longer one-time registration-token windows for low-memory Droplets.
- DigitalOcean cloud runner configuration now validates runner image, region, size, image, tags, SSH keys, and SSH source settings before provisioning; broad SSH access requires explicit CIDRs or `BRUNO_DIGITALOCEAN_ALLOW_PUBLIC_SSH=true`.

### Fixed

- Protected snapshot builders now wait within a strict bounded deadline for SSH and full-fixture
  evidence, run the immutable runner boot self-test instead of treating image pulls as fixture proof,
  remove complete cloud-init and temporary SSH authorization state, and fail publication closed unless
  authoritative Droplet, firewall, and provider-key cleanup evidence is retained and attested.
- Non-hosted Playwright commands now pin development authentication, preventing operator or Clerk
  settings in `.env.local` from replacing the expected credential-free application shell.
- Ready agent creation now reuses an eligible runner or fails before persistence unless automatic DigitalOcean provisioning is fully configured; when no runner is available, the bounded post-response reconciler immediately advances through runner initialization and starts one provisioning attempt instead of leaving the deployment pending. Production builds also reject ready-agent configuration without an immutable runner image.
- Managed gateway launches now have a strict 30-second deadline and recover on a validated replacement runner after one bounded diagnostic capture and stop, instead of repeatedly starting the same operation on an unhealthy machine; model and Telegram failures remain agent-specific and recovery stops safely after two replacement workflows per day.
- Managed runner infrastructure now repairs externally deleted Droplets, stale assignments, and exact interrupted provisions automatically, while duplicate or ambiguous resources fail closed and only provably owned orphans are deleted after two authoritative observations.
- Deleting an agent now remains authoritative after automatic setup is cancelled or its database tombstone is committed, so an unreachable assigned runner cannot leave the agent visible or require a second Delete attempt.
- Cloud runners now use secret-safe in-container Hermes health probes and model-canary fallbacks when the private runner-to-workload network path is unavailable, and a genuine gateway readiness timeout captures logs, stops once, and fails clearly instead of looping through 64 start attempts.
- Assigned DigitalOcean runners no longer raise misleading offline or degraded operational alerts while cloud provisioning is actively progressing.
- The empty agent list now shows a real “Create your first agent” action that jumps to Guided setup instead of leaving a decorative line that could be mistaken for a broken button.
- Deployment and runtime reconciliation now use the exact configured `BRUNO_HERMES_WORKLOAD_IMAGE` instead of falling back to the source-pinned default during launch and observation.
- Intentional Stop now remains authoritative across runner and Docker restarts, while agent inventory, detail, dashboard, and the runtime endpoint report current managed gateway and Telegram truth instead of stale deployment readiness.
- Projected Hermes credential reads now reject FIFO and other nonregular `.env` substitutions without blocking runner status or canary requests.
- Managed Hermes projection now preserves safe unrelated YAML scalar text containing punctuation such as `!`, `*`, and `&` while still rejecting actual YAML tags, anchors, aliases, and merge keys.
- Managed Hermes projection now rejects explicit YAML tags, secret-like null/map/array/non-placeholder values, shell-default env references, nonregular target files, and Docker inspect exposure of Telegram allowlist values.
- Telegram secret replacement now returns generic active-bot conflicts and distinguishes invalid bot tokens from temporary Telegram validation outages without mutating stored secrets.
- Pinned Hermes gateway readiness now follows the `v2026.7.7.2` detailed-health platform-state contract without requiring an HTTP config-revision echo, while failed post-launch evidence or readiness checks remove the partial selected-agent container.
- Local Docker cloud-runner smoke now treats fresh Hermes setup blocking as a safe control-flow result, bridges the runner env file through a host-visible path for Docker-socket simulation, and packages all runner-service runtime imports in the runner image.
- Hermes readiness failures now record `agent.error`, avoid premature start/restart completion events, and leave a safe actionable lifecycle reason; the Docker capability set now keeps only the minimal capabilities the Hermes supervisor needs after dropping all others.
- Cloud runner bootstrap now persists exchanged credentials in the host-mounted environment file,
  safely recovers an interrupted unexpired DigitalOcean registration, and recognizes the exact
  authenticated not-found response from older runner images whose readiness route is unavailable.
- Runner placement now excludes cloud runners until authenticated readiness, verifies the live
  DigitalOcean resource and runner endpoint before assignment, tombstones externally deleted
  Droplets, and revalidates the candidate transactionally before creating an agent.
- Added an opt-in, secret-safe Clerk Playwright development smoke harness for deterministic
  email-code, current-user, sign-out, and isolated-context checks without changing credential-free
  CI or claiming Google/Apple provider success.
- The hosted Clerk launcher now bootstraps testing state before Playwright workers start and
  rejects duplicate/non-`+clerk_test` identities while binding each browser context to its
  resolved primary email without retaining PII.
- The opt-in hosted Clerk harness now supplies the existing development Basic-auth credentials
  only as in-memory Playwright HTTP credentials, allowing it to reach the Clerk-protected app
  while production cutover remains intentionally deferred.
- The hosted Clerk Playwright server now binds to the same `localhost` hostname used by Next.js
  16's internal development render proxy, preventing authenticated dashboard requests from
  failing with a misleading socket reset.
- Authentication progress and acceptance docs now correctly separate completed #232 development
  Clerk setup/doctor evidence from the still-open #239 hosted browser/provider smoke and
  runner-backed full-E2E gates.
- Production Vercel builds now apply pending Drizzle migrations before compiling, and successful remote runner starts compensate failed lifecycle finalization instead of leaving agents permanently `starting`.
- DigitalOcean cloud runner bootstrap now validates and reloads the generated Caddy reverse-proxy config after writing it, so fresh Droplets serve the runner endpoint instead of the package default site.
- Stale runner heartbeats now reconcile runners to `offline` before status summaries, cloud provisioning summaries, and placement decisions read them.
- Production agent starts now return a clear no-online-runner response instead of falling back to local Docker when no cloud runner is ready.
- Stalled DigitalOcean runner bootstrap attempts now become actionable failed provisioning states instead of staying in progress indefinitely.
- Cloud runner bootstrap now persists exchanged runner credentials on the Droplet so registration survives service restarts without reusing one-time tokens.
- DigitalOcean cloud runner bootstrap now registers public `sslip.io` HTTPS endpoints through a Caddy reverse proxy instead of loopback runner URLs.
- Backup-created timeline events no longer include backup storage URIs, keeping activity feeds free of artifact locations while preserving backup ID and status context.
- Docker lifecycle start/restart now reject fast-exiting containers after inspect, handle replacement start failures safely, and avoid marking agents running unless Docker reports the selected replacement container is actually running.
- Docker lifecycle stop and crash reconciliation now treat selected-agent containers that already exited with code `0` as clean stops instead of surfacing false crash or stop-failure states.
- Active-agent reads now reconcile bounded Docker runner state so a crashed selected-agent Docker container does not remain shown as `running`.
- Local runner adapter start failures now terminate spawned child processes when durable runner-state persistence fails, preventing orphaned dummy/local processes.
- Local runner process log streaming now scopes process-id reads to the requested active development-user agent so a known process UUID for another agent cannot return that agent's stdout/stderr.
- Restart controls now clear their local busy state when the local runner restart returns directly to `running`.
- Dashboard persisted-agent controls remain available on phone widths by using the mobile agent status card list when the desktop table is hidden, with hardened wrapping and focus states for combined mobile agent, approval, log, and alert controls.
- Create-agent failures now return safe actionable database setup errors when Postgres is unavailable or migrations are missing, and the create form prevents pre-hydration no-op submissions.

### Security

- Managed Hermes projection tests now exercise the injected filesystem transaction seam for temp collisions, UID/GID ownership calls, write/chmod/chown/fsync/rename failures, marker-last recovery, temp cleanup, and nonregular projected targets.
- Managed Hermes projection hardening now enforces exact env-reference placeholders for secret-like YAML keys, AST-level YAML tag/anchor rejection, uniform hardlink/FIFO/device/nonregular target validation across all four projected files, and low-entropy Telegram allowlist inspect-leak checks.
- Managed Hermes projection now uses strict YAML parsing, exact launch-spec key validation, prototype/tag/alias/duplicate/size/depth defenses, no-follow path checks, marker-last atomic writes, secret-free serialization, and `0600` env file handling.
- Ready-mode creation and Telegram secret backfill now have real-Postgres race, rollback, replay, and isolation coverage for token uniqueness, bot-subject uniqueness, idempotency, requested runners, and insert-boundary failures.
- Secret redaction now also catches percent-encoded Telegram bot API URLs while preserving raw Telegram token redaction.
- Ready-mode agent creation now prepares encrypted direct OpenAI/Anthropic, Telegram, allowlist, and private API credentials in memory and commits the agent, managed config, secrets, deployment, desired-running intent, and creation event atomically.
- Telegram bot validation is bounded to one redacted `getMe` preflight with fixed origin, timeout, response-size, and safe failure mapping.
- Active Telegram bot credentials now use stable server-only uniqueness metadata and database-enforced active-bot indexes while preserving the existing public secret fingerprint.
- Hermes setup terminals use owner-scoped runner placement, stopped-workload and single-session gating, a 15-minute one-time WebSocket-subprotocol token stored only as a digest, bounded PTY messages, private no-port/no-Docker-socket containers, and no terminal-output logging or persistence.
- Runner and app log ingestion now apply a shared defense-in-depth redaction corpus for OpenRouter keys, Telegram tokens, Bruno bearer/API tokens, secret-bearing environment assignments, sensitive URL query values, and fixed test canaries.
