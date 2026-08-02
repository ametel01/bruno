# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases begin.

## [Unreleased]

### Added

- Exact `AGENTBAY_ALLOW_PUBLIC_DEVELOPMENT=true` opt-in for temporarily exposing a Vercel production-target deployment with the shared development user while keeping hosted development fail-closed by default and preserving runner-machine authentication.
- Renamed the user-facing application and local package/database defaults from AgentBay to plingpling while retaining the established `AGENTBAY_*` runtime compatibility namespace.
- Credential-free local Hermes contract smoke command (`agent:hermes:contract-smoke`) that launches the pinned workload image with a fake OpenAI-compatible provider, private API auth checks, durable log ingestion, restart/state persistence, managed-state backup/restore, and cleanup without claiming external Telegram network behavior.
- Durable Hermes gateway log ingestion from the runner-managed `/opt/data` log stream, with source classification for gateway output versus container bootstrap diagnostics.
- Safe Hermes runtime diagnostics for runner log transport, app-side log persistence, and assigned-runner cleanup.
- Authenticated private Hermes readiness polling for runner-managed gateway launches, including config-revision and Telegram readiness checks before start/restart completion.
- Versioned Hermes launch specs, server-side launch-spec building with only the generated private API-server key, authenticated runner JSON transport, and managed per-agent Hermes prompt, revision, and workspace projection that preserves Hermes-owned provider state.
- Native `hermes setup` on the agent detail page through a short-lived interactive terminal, letting users choose a Hermes-supported subscription OAuth path, model, and optional messaging configuration without AgentBay collecting provider API keys.
- Encrypted per-agent secret storage, owner-scoped secret status/update/revoke APIs, generated agent API keys, and secret-free backup/restore/delete handling for the Hermes setup path.
- Pinned Hermes workload image artifact, local smoke verification, and a separate scanned GHCR publication workflow for the first real AgentBay-managed Hermes runtime.
- Server-only `AGENTBAY_AUTH_MODE` policy for registration-free loopback development, fail-closed Clerk production/custom-domain access, explicitly protected preview opt-in, and request-scoped shared-user resolution without changing runner-machine authentication.
- Assigned-runner detail and cloud-runner cards now show labeled raw-infrastructure estimates and active-agent allocation with explicit unavailable and failure states while preserving health and capacity context.
- Internal user resolution for Clerk sessions and registration-free development, with opaque unique Clerk links, concurrency-safe lazy creation, and an explicit count-only dry-run legacy claim that refuses ambiguous or conflicting ownership.
- Deterministic server-side daily and monthly runner infrastructure cost estimates from user-scoped usage periods, including overlapping-uptime unioning, per-agent allocation, supplied-clock windows, and explicit unavailable pricing states.
- Dashboard now shows server-rendered daily and monthly raw-infrastructure estimates, runner monthly cost, running-agent counts, per-active-agent estimates, and explicit unavailable and safe loader-failure states.
- Clerk-capable sign-in, registration, current-user, and sign-out surfaces with a Next.js 16 proxy route matrix that preserves the temporary Basic operator barrier and existing runner machine authentication until production cutover.
- Durable `agent_usage_periods` persistence for reproducible infrastructure usage tracking, with start/stop lifecycle instrumentation, continuous restart semantics, open intervals for missing stops, and no credential-bearing usage metadata.
- Dedicated runner Docker image artifact that packages the existing runner bootstrap and service runtime without Droplet-side source checkout or GitHub credentials.
- Server-side `AGENTBAY_RUNNER_IMAGE` selection for DigitalOcean cloud runner provisioning, including the public GHCR default, trimmed non-empty overrides, blank override validation, and safe runner image metadata in bootstrap/provisioning events.
- Runner service heartbeat loop that reports cloud runner online status and capacity metrics using the persisted runner credential.
- Initial AgentBay root app page that points users to the dashboard route.
- Database-backed `/health` endpoint and local Postgres migration tooling for operator checks.
- AgentBay product shell and initial routes for `/`, `/dashboard`, `/agents`, `/agents/:agentId`, and `/settings`, with empty states and placeholder-only settings surfaces.
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
- Selected-agent Docker cleanup that validates the exact stored container ID and `agentbay.agent_id` label before removing containers during delete cleanup.
- Standalone manual VPS runner service for selected-agent Docker start, stop, restart, status, and log APIs with temporary bearer-token auth, argv-only Docker calls, and `agentbay.agent_id` label scoping.
- Milestone 5 agent templates with a typed metadata registry, durable template version/snapshot persistence, create-flow template metadata, and persisted template settings on agent detail pages.
- Manual VPS runner persistence with durable runner identity rows, nullable agent assignment, optional non-secret development bootstrap, endpoint validation, and active-agent assigned-runner helpers without changing no-runner lifecycle behavior.
- Runner auth persistence foundation with hash-only one-time registration token state, hash-only runner credential rows, heartbeat history, expanded runner status coverage, important lookup indexes, and reusable token/hash helpers.
- Dashboard lifecycle forwarding for active agents assigned to `manual_vps` runners, including dashboard-side start, stop, restart, status, and log pulls with temporary bearer auth, bounded timeouts, safe remote failures, persisted `manual_runner` log rows, and Docker fallback for unassigned agents.
- Dashboard and agent detail manual runner status surfaces with safe runner name, kind, endpoint host, persisted status, updated timing, assigned-runner notices, offline/degraded alerts, and remote runner log visibility without exposing runner IDs, credentials, raw endpoint internals, or metadata.
- One-time runner registration APIs: `POST /api/runners/registration-tokens` returns a visible-once `agb_reg_*` token for the configured owning application user, and `POST /runner/v1/register` atomically exchanges it for durable runner identity plus a visible-once `agb_run_*` credential while persisting only hashes and returning safe errors for unusable tokens.
- `POST /runner/v1/heartbeat` with scoped runner credential authentication, safe credential failure responses, bounded non-secret heartbeat metrics, credential last-used updates, online status transitions, and stale/missing heartbeat reconciliation to `offline`.
- Operator runner credential lifecycle APIs: `POST /api/runners/:runnerId/credentials/rotate` returns a visible-once replacement `agb_run_*` credential while revoking existing active credentials, and `POST /api/runners/:runnerId/credentials/revoke` revokes active credentials so heartbeat authentication rejects old or revoked credentials without exposing stored hashes or previous raw credentials.
- Runner health visibility on dashboard, assigned-agent detail, and settings read surfaces, showing safe runner name, kind, endpoint host, heartbeat-derived status, version, last-seen time, and updated time without exposing runner IDs, credential material, hashes, or heartbeat metrics.
- Settings runner management controls for creating visible-once `agb_reg_*` registration tokens, rotating registered runner credentials with visible-once `agb_run_*` replacement display, and revoking active runner credentials with safe success, loading, validation, and error states.
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

- Hermes launch now preserves the wizard-owned `/opt/data/config.yaml`, `.env`, `auth.json`, subscription, provider, model, and messaging state while AgentBay merges only private API-server values and its prompt/revision files.
- DigitalOcean cloud runners now default back to the basic `$4` `s-1vcpu-512mb-10gb` tier for live Hermes validation, relying on the existing low-memory swap bootstrap instead of the previous 2 GB default.
- Assigned-runner delete cleanup now calls the runner cleanup path before soft-delete, and runner cleanup removes the selected container plus the exact per-agent Hermes state root idempotently.
- Runner-managed Hermes starts now launch the pinned workload image with `gateway run` on a private Docker network, projected `/opt/data` and `/workspace` mounts, bounded CPU/memory/PID limits, no published gateway port, label ownership, bounded graceful stops, and inspect validation before readiness.
- DigitalOcean cloud runners inject one-agent heartbeat capacity, prepare a private Hermes Docker network and managed state root, and pre-pull the pinned Hermes workload image during bootstrap.
- Browser runner settings, provisioning, placement, capacity, registration-token creation, and credential management now use explicit internal user ownership, while runner registration, heartbeat, bootstrap callbacks, and lifecycle bearer authentication remain machine-token based.
- Hosted app pages and app-side API routes now require operator access, while runner token endpoints remain credential-based.
- DigitalOcean cloud runner bootstrap now pulls and runs the selected runner image with Docker instead of depending on Droplet-side source checkout or host Bun setup.
- DigitalOcean cloud runner provisioning now requires and injects the server-side runner command bearer token for lifecycle API authentication.
- DigitalOcean cloud runner bootstrap now configures swap and longer one-time registration-token windows for low-memory Droplets.
- DigitalOcean cloud runner configuration now validates runner image, region, size, image, tags, SSH keys, and SSH source settings before provisioning; broad SSH access requires explicit CIDRs or `AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH=true`.

### Fixed

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

- Hermes setup terminals use owner-scoped runner placement, stopped-workload and single-session gating, a 15-minute one-time WebSocket-subprotocol token stored only as a digest, bounded PTY messages, private no-port/no-Docker-socket containers, and no terminal-output logging or persistence.
- Runner and app log ingestion now apply a shared defense-in-depth redaction corpus for OpenRouter keys, Telegram tokens, AgentBay bearer/API tokens, secret-bearing environment assignments, sensitive URL query values, and fixed test canaries.
