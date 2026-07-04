# AgentBay

AgentBay is a Bun-managed Next.js App Router app for the completed Milestone 4 runtime monitoring slice plus the first Milestone 6 config-persistence foundation. It includes a dashboard-oriented shell, local Postgres migration tooling, runtime environment validation, a database-backed `/health` endpoint, persistent agent records and config defaults, deterministic Start, Stop, Restart, and Delete controls, persisted activity feeds, and scoped runtime logs for local development agents.

## Requirements

- Bun
- Docker with Docker Compose
- Vercel CLI access for preview deployments

## Install

Install dependencies from the repository root:

```bash
bun install
```

## Environment

Local and deployment environments must define:

```bash
DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Use `.env.example` as the local template. `DATABASE_URL` must use `postgres://` or `postgresql://`; `NEXT_PUBLIC_APP_URL` must use `http://` or `https://`. Secret values, production database URLs, Vercel tokens, and generated `.env.local` files must stay out of commits.

## Local Database

Start the local Postgres service:

```bash
docker compose up -d postgres
```

Apply infrastructure migrations:

```bash
bun run db:migrate
```

Check database-backed health from the command line:

```bash
bun run db:health
```

The local default database URL is:

```text
postgres://agentbay:agentbay@127.0.0.1:54329/agentbay
```

The migration set creates the local application metadata table plus the persistent agent schema:

- `users`: local development user records used until production auth exists.
- `agents`: persistent agent identity, template, lifecycle status, timestamps, and soft-delete marker.
- `agent_configs`: one typed config row per active agent with system prompt, model provider, model name, integer-cent daily spend cap, schedule mode, optional cron, timezone, and timestamps.
- `agent_events`: transactional audit events for agent creation, fake lifecycle transitions, dashboard activity, and per-agent activity.
- `agent_logs`: runtime log rows with nullable runner identity, static stream/level/message fields, and per-agent positive sequence values.
- `agent_status`: Postgres enum used by `agents.status`.
- `agent_schedule_mode`: Postgres enum used by `agent_configs.schedule_mode`.

The migrations do not create approval, runner, billing, auth, Hermes, Telegram, secrets, provisioning, or provider integration tables.

## Development Server

Run the development server after the database is available and migrations have run:

```bash
bun run dev
```

Open these route smoke targets locally:

- `http://localhost:3000/`
- `http://localhost:3000/dashboard`
- `http://localhost:3000/agents`
- `http://localhost:3000/settings`
- `http://localhost:3000/health`

`/health` returns 2xx JSON only when the app can reach the configured database. It returns non-2xx JSON when `DATABASE_URL` is missing, malformed, or points to an unavailable database.

## Agent Lifecycle Flow

The `/agents` page contains the current create/list and fake lifecycle workflow:

1. Open `/agents`.
2. Enter an agent name such as `Research Agent`.
3. Select a supported template, such as `research_agent`.
4. Submit the form.
5. Confirm the stopped agent appears in the `/agents` table with a generated `/agents/:agentId` link.
6. Open the detail page and use Start to move the agent from `stopped` to `starting`, then to `running` after deterministic fake-runner settling.
7. Confirm the detail runtime log panel shows the deterministic simulator output for the selected running agent.
8. Use Restart while the agent is `running` to move it through `restarting` and back to `running`.
9. Use Stop while the agent is `running` to move it back to `stopped` while already visible runtime logs remain readable.
10. Use Simulate error outside production to move an active agent to `error` and record one `agent.error` audit event.
11. Use Delete while the agent is not transitioning to soft-delete it from active views.
12. Refresh `/agents`, `/dashboard`, and the detail page to confirm active records remain visible and deleted records return not found.

The dashboard reads active persisted agents from the database. The detail page loads active persisted agent records by ID and returns not found for missing, malformed, or soft-deleted IDs. Delete preserves the `agents` row and existing `agent_events`, but removes the agent from `/agents`, `/dashboard`, and active detail reads.

Milestone 4 records are local-development records only. Lifecycle controls and runtime logs use deterministic database state, not real runner processes. Approvals, config editing, runner APIs, runner provisioning, Hermes, Telegram, billing, production auth, secret storage, backups, restore, cloud provisioning, and external provider integrations remain future scope.

## Create Agent API

`POST /api/agents` creates one stopped persistent agent record for the local development user, writes a default `agent_configs` row, and records one `agent.created` event in the same transaction.

Request body:

```json
{
  "name": "Research Agent",
  "templateKey": "research_agent"
}
```

Supported `templateKey` values are `research_agent`, `inbox_triage_agent`, `github_issue_agent`, and `social_content_agent`. The `name` value is trimmed, required, and limited to 120 characters.

Successful responses return HTTP 201 with the created agent identity, `stopped` status, timestamps, and the `agent.created` event type. Validation failures return safe JSON without database URLs, SQL errors, stack traces, or driver messages. Persistence failures return generic safe errors.

The initial persisted config defaults are intentionally non-secret and non-integrated: model provider and model name are `not_configured`, max daily spend is `0` cents, schedule mode is `manual`, schedule cron is `null`, timezone is `UTC`, and the generic system prompt is stored with the config row. Config editing, config update APIs, `config.updated` events, real provider/model integration, Hermes config generation, BYOK keys, and secret storage remain future scope.

## Lifecycle APIs

The current fake lifecycle APIs are:

- `POST /api/agents/:agentId/actions/start`: accepts active `idle`, `stopped`, or `error` agents, persists `starting`, records `agent.start_requested`, and deterministic settling records `agent.start_completed` when the fake runner reaches `running`.
- `POST /api/agents/:agentId/actions/stop`: accepts active `running` agents, persists `stopped`, and records `agent.stop_requested` plus `agent.stop_completed` transactionally.
- `POST /api/agents/:agentId/actions/restart`: accepts active `running` agents, persists `restarting`, records `agent.restart_requested`, and deterministic settling records `agent.restart_completed` when the fake runner returns to `running`.
- `POST /api/agents/:agentId/actions/simulate-error`: development/test-only and rejected in production. Outside production, accepts active non-deleted `idle`, `stopped`, `starting`, `running`, or `restarting` agents, persists `error`, and records exactly one `agent.error` audit event.
- `DELETE /api/agents/:agentId`: accepts active non-transitioning `idle`, `running`, `stopped`, or `error` agents, soft-deletes the row, and records exactly one `agent.deleted` event.

Missing, malformed, absent, already soft-deleted, and invalid-status targets return safe JSON errors and do not write mutation events. Delete is blocked while an agent is still `starting` or `restarting`.

## Activity Feeds

Activity feeds are the operator audit timeline for important persisted control-plane actions. They explain who changed an agent, what changed, and when it happened without requiring raw database access. They are intentionally low-volume audit events, not runtime logs. Chatty stdout, stderr, Hermes output, runner output, and generated task logs belong to the separate `agent_logs` runtime log path.

The dashboard shows the newest persisted activity across all agents. The agent detail page shows the selected agent's activity with pagination.

`GET /api/agents/:agentId/events` returns the selected active agent's event page:

- `agentId` must be a valid UUID for an active, non-deleted local development agent.
- Missing or soft-deleted agents return 404 JSON.
- `limit` is optional, must be a positive integer, and is capped at 100.
- `cursor` is optional and must be an opaque event feed cursor returned by a previous page.
- Responses are newest first by `created_at` and `id`.
- Successful responses have `{ "events": [...], "nextCursor": string | null }`.
- Malformed IDs, repeated cursor parameters, malformed cursors, invalid limits, and persistence failures return safe JSON without database URLs, SQL errors, stack traces, or driver messages.

Cursor values are opaque base64url strings. Clients should store or pass them back exactly as received and must not parse them. A non-null `nextCursor` points to the next older page. The detail UI renders that as Older activity and links back to the newest page when viewing older results.

Current audit event inventory:

- `agent.created`
- `agent.start_requested`
- `agent.start_completed`
- `agent.stop_requested`
- `agent.stop_completed`
- `agent.restart_requested`
- `agent.restart_completed`
- `agent.error`
- `agent.deleted`

Future milestones may add config, approval, runner, backup, restore, billing, and Hermes-related audit event types. Those future audit events should continue to describe control-plane facts, while high-volume runtime output remains separate log data.

## Runtime Logs

`GET /api/agents/:agentId/logs` returns active-agent scoped runtime logs from `agent_logs`:

- `agentId` must be a valid UUID for an active, non-deleted local development agent.
- Missing or soft-deleted agents return 404 JSON.
- `limit` is optional, must be a positive integer, and is capped at 100.
- `after` is optional and must be a non-negative integer sequence cursor from a previous page.
- Responses are oldest first by per-agent `sequence`.
- Successful responses have `{ "logs": [...], "nextAfter": number | null }`.
- Malformed IDs, repeated `after` or `limit` parameters, invalid limits, and persistence failures return safe JSON without database URLs, SQL errors, stack traces, credentials, or driver messages.

Log reads are pull-driven for the local fake runner. When the selected active agent has already settled to `running`, the read transactionally generates one deterministic four-line cycle before listing logs:

1. `Checking task queue...`
2. `No pending tasks.`
3. `Heartbeat OK.`
4. `Memory loaded.`

The first eligible read in a running segment creates the cycle immediately. Repeated reads at the same logical time are idempotent, and later reads create the next cycle only after the fixed simulator interval elapses while the agent remains in the same running segment. The running segment is based on the persisted `agents.updated_at` value after `starting` or `restarting` settles to `running`, so a later restart can generate a new cycle without being blocked by prior segment logs.

Generated rows use `runner_id = null`, safe static `stdout`/`info` content only, and per-agent monotonic `sequence` values. Runtime log generation does not write `agent_events`; lifecycle actions, including `simulate-error`, do not directly write runtime logs. Stopped, idle, pending transition, error, deleting, missing, and soft-deleted agents do not receive newly generated log rows, though active stopped or error agents can still return existing readable rows.

The agent detail page renders those logs in a runtime log panel. The panel shows loading, empty, loaded, and safe error states; displays only the log timestamp, stream, level, sequence, and message; and keeps the rest of the detail page readable if log loading fails. It polls only while the current detail status is `running`, so stopping or simulating an error leaves existing visible rows readable without appending new generated rows after the settled state.

## Quality Gates

Run individual gates when isolating failures:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:e2e
```

Run the aggregate gate before handoff or deployment:

```bash
bun run verify
```

The Playwright E2E suite starts the Next.js dev server and smoke-tests the browser create, lifecycle, dashboard activity, detail activity, scoped detail runtime logs, soft-delete, active-view removal, and not-found flows on desktop and mobile Chromium profiles. It expects a reachable migrated database for `/health`, agent records, activity feeds, and runtime logs, so run:

```bash
docker compose up -d postgres
bun run db:migrate
bun run test:e2e
```

## Vercel Preview Deployment

The initial empty-app preview from issue #6 was deployed from the authenticated local Vercel CLI account `ametel01` to scope `ametel01s-projects` and project `agentbay`.

Initial preview URL:

```text
https://agentbay-9wi2xvhbh-ametel01s-projects.vercel.app
```

For the completed Milestone 4 app, validate local gates first:

```bash
docker compose up -d postgres
bun run db:migrate
bun run db:health
bun run verify
```

Then link this checkout if needed:

```bash
vercel link --project agentbay --scope ametel01s-projects -y
```

Run an explicit preview deployment:

```bash
vercel deploy -y --no-wait --target preview --scope ametel01s-projects
```

The Vercel deployment environment must provide:

```text
DATABASE_URL
NEXT_PUBLIC_APP_URL
```

`DATABASE_URL` should be a Vercel-accessible Postgres connection string, not the local Docker URL. `NEXT_PUBLIC_APP_URL` should be the preview or production app URL used by that deployment. If the CLI has no credentials or Vercel lacks required env vars, record the exact blocker in `PROGRESS.md`.

The Vercel CLI creates local `.vercel/` metadata and may create `.env.local` for local credentials. Both are ignored and should remain local-only.

## Milestone 4 Acceptance

Milestone 4 is complete when:

- The app scaffold, TypeScript, formatter, linting, tests, build, and deployment path are present.
- `PROGRESS.md` and `CHANGELOG.md` exist and follow the tracking rules.
- Local Postgres starts, migrations run, and `/health` reports success only when the database is reachable.
- The migration set creates `users`, `agents`, `agent_events`, `agent_logs`, and `agent_status` for persistent agent records, audit events, and runtime logs.
- `POST /api/agents` creates a stopped agent and `agent.created` event transactionally with safe validation and persistence responses.
- `/agents` creates and lists active stopped agent records with stable detail links.
- `/dashboard` and `/agents/:agentId` read active persisted agent records from the database after refresh.
- Missing, malformed, or soft-deleted detail IDs render not found.
- Start, Stop, Restart, and Delete controls work through deterministic fake lifecycle state and reject invalid actions without corrupting state.
- Lifecycle event persistence is covered for `agent.start_requested`, `agent.start_completed`, `agent.stop_requested`, `agent.stop_completed`, `agent.restart_requested`, `agent.restart_completed`, and exactly one `agent.deleted` event per accepted Delete.
- `GET /api/agents/:agentId/events` returns safe per-agent event pages with opaque cursor pagination.
- The dashboard shows a compact latest activity feed across agents.
- The detail page shows per-agent activity with event time, type, message, actor, metadata summary, empty state, error state, and pagination.
- `GET /api/agents/:agentId/logs` returns safe active-agent scoped runtime logs with numeric `after` pagination and pull-driven deterministic simulator generation for running agents.
- The detail page shows runtime log loading, empty, loaded, and safe error states without exposing internal row names, database URLs, stack traces, credentials, or raw SQL/driver errors.
- Browser coverage proves detail Start eventually shows `Checking task queue...`, `No pending tasks.`, `Heartbeat OK.`, and `Memory loaded.`
- Browser coverage proves runtime logs stay scoped to the selected agent, visible rows remain readable after Stop, polling/generation does not append after Stop or Simulate error, and `agent.error` appears in the detail activity feed.
- Browser coverage proves create and lifecycle activity appears in both the dashboard latest activity feed and the agent detail activity feed.
- Soft delete removes agents from `/agents`, `/dashboard`, and active detail reads while preserving the database row and prior events.
- Approvals, config editing, runner APIs, real runner/provisioning behavior, Hermes, Telegram, billing, production auth, secret storage, backups, restore, and cloud provisioning remain out of scope.
- `.env.example` documents every required local/deploy variable without secrets.
- `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run db:migrate`, `bun run db:health`, `bun run build`, `bun run test:e2e`, and `bun run verify` pass against a migrated local database.
