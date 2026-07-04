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
- `POST /api/agents/:agentId/actions/start` and Start UI controls for fake lifecycle start requests, deterministic settling to running, and matching lifecycle events.
- `POST /api/agents/:agentId/actions/stop` and Stop UI controls for running agents, including transactional stop events and visible status refresh back to stopped.
- `POST /api/agents/:agentId/actions/restart` and Restart UI controls for running agents, including deterministic fake-runner settling back to running and matching lifecycle events.
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

### Fixed

- Dashboard persisted-agent controls remain available on phone widths by using the mobile agent status card list when the desktop table is hidden, with hardened wrapping and focus states for combined mobile agent, approval, log, and alert controls.
- Create-agent failures now return safe actionable database setup errors when Postgres is unavailable or migrations are missing, and the create form prevents pre-hydration no-op submissions.
