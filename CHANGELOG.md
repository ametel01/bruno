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

### Fixed

- Create-agent failures now return safe actionable database setup errors when Postgres is unavailable or migrations are missing, and the create form prevents pre-hydration no-op submissions.
