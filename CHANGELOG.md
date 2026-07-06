# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases begin.

## [Unreleased]

### Added

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
- One-time runner registration APIs: `POST /api/runners/registration-tokens` returns a visible-once `agb_reg_*` token for the development user, and `POST /runner/v1/register` atomically exchanges it for durable runner identity plus a visible-once `agb_run_*` credential while persisting only hashes and returning safe errors for unusable tokens.
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

### Fixed

- Docker lifecycle start/restart now reject fast-exiting containers after inspect, handle replacement start failures safely, and avoid marking agents running unless Docker reports the selected replacement container is actually running.
- Docker lifecycle stop and crash reconciliation now treat selected-agent containers that already exited with code `0` as clean stops instead of surfacing false crash or stop-failure states.
- Active-agent reads now reconcile bounded Docker runner state so a crashed selected-agent Docker container does not remain shown as `running`.
- Local runner adapter start failures now terminate spawned child processes when durable runner-state persistence fails, preventing orphaned dummy/local processes.
- Local runner process log streaming now scopes process-id reads to the requested active development-user agent so a known process UUID for another agent cannot return that agent's stdout/stderr.
- Restart controls now clear their local busy state when the local runner restart returns directly to `running`.
- Dashboard persisted-agent controls remain available on phone widths by using the mobile agent status card list when the desktop table is hidden, with hardened wrapping and focus states for combined mobile agent, approval, log, and alert controls.
- Create-agent failures now return safe actionable database setup errors when Postgres is unavailable or migrations are missing, and the create form prevents pre-hydration no-op submissions.
