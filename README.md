# AgentBay

AgentBay is a Bun-managed Next.js App Router app for the completed Milestone 2 fake lifecycle slice. It includes a dashboard-oriented shell, local Postgres migration tooling, runtime environment validation, a database-backed `/health` endpoint, persistent agent records, and deterministic Start, Stop, Restart, and Delete controls for local development agents.

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
- `agent_events`: transactional audit events for agent creation and fake lifecycle transitions.
- `agent_status`: Postgres enum used by `agents.status`.

The migrations do not create log, approval, runner, billing, auth, Hermes, Telegram, secrets, provisioning, or provider integration tables.

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
7. Use Restart while the agent is `running` to move it through `restarting` and back to `running`.
8. Use Stop while the agent is `running` to move it back to `stopped`.
9. Use Delete while the agent is not transitioning to soft-delete it from active views.
10. Refresh `/agents`, `/dashboard`, and the detail page to confirm active records remain visible and deleted records return not found.

The dashboard reads active persisted agents from the database. The detail page loads active persisted agent records by ID and returns not found for missing, malformed, or soft-deleted IDs. Delete preserves the `agents` row and existing `agent_events`, but removes the agent from `/agents`, `/dashboard`, and active detail reads.

Milestone 2 records are local-development records only. Lifecycle controls use deterministic database state, not real runner processes. Logs, approvals, event-log UI, runner provisioning, Hermes, Telegram, billing, production auth, secret storage, and external provisioning remain future scope.

## Create Agent API

`POST /api/agents` creates one stopped persistent agent record for the local development user and records one `agent.created` event in the same transaction.

Request body:

```json
{
  "name": "Research Agent",
  "templateKey": "research_agent"
}
```

Supported `templateKey` values are `research_agent`, `inbox_triage_agent`, `github_issue_agent`, and `social_content_agent`. The `name` value is trimmed, required, and limited to 120 characters.

Successful responses return HTTP 201 with the created agent identity, `stopped` status, timestamps, and the `agent.created` event type. Validation failures return safe JSON without database URLs, SQL errors, stack traces, or driver messages. Persistence failures return generic safe errors.

## Lifecycle APIs

The current fake lifecycle APIs are:

- `POST /api/agents/:agentId/actions/start`: accepts active `idle`, `stopped`, or `error` agents, persists `starting`, records `agent.start_requested`, and deterministic settling records `agent.start_completed` when the fake runner reaches `running`.
- `POST /api/agents/:agentId/actions/stop`: accepts active `running` agents, persists `stopped`, and records `agent.stop_requested` plus `agent.stop_completed` transactionally.
- `POST /api/agents/:agentId/actions/restart`: accepts active `running` agents, persists `restarting`, records `agent.restart_requested`, and deterministic settling records `agent.restart_completed` when the fake runner returns to `running`.
- `DELETE /api/agents/:agentId`: accepts active non-transitioning `idle`, `running`, `stopped`, or `error` agents, soft-deletes the row, and records exactly one `agent.deleted` event.

Missing, malformed, absent, already soft-deleted, and invalid-status targets return safe JSON errors and do not write mutation events. Delete is blocked while an agent is still `starting` or `restarting`.

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

The Playwright E2E suite starts the Next.js dev server and smoke-tests the browser create, lifecycle, soft-delete, active-view removal, and not-found flows on desktop and mobile Chromium profiles. It expects a reachable migrated database for `/health` and agent records, so run:

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

For the completed Milestone 2 app, validate local gates first:

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

## Milestone 2 Acceptance

Milestone 2 is complete when:

- The app scaffold, TypeScript, formatter, linting, tests, build, and deployment path are present.
- `PROGRESS.md` and `CHANGELOG.md` exist and follow the tracking rules.
- Local Postgres starts, migrations run, and `/health` reports success only when the database is reachable.
- The migration set creates `users`, `agents`, `agent_events`, and `agent_status` for persistent agent records.
- `POST /api/agents` creates a stopped agent and `agent.created` event transactionally with safe validation and persistence responses.
- `/agents` creates and lists active stopped agent records with stable detail links.
- `/dashboard` and `/agents/:agentId` read active persisted agent records from the database after refresh.
- Missing, malformed, or soft-deleted detail IDs render not found.
- Start, Stop, Restart, and Delete controls work through deterministic fake lifecycle state and reject invalid actions without corrupting state.
- Lifecycle event persistence is covered for `agent.start_requested`, `agent.start_completed`, `agent.stop_requested`, `agent.stop_completed`, `agent.restart_requested`, `agent.restart_completed`, and exactly one `agent.deleted` event per accepted Delete.
- Soft delete removes agents from `/agents`, `/dashboard`, and active detail reads while preserving the database row and prior events.
- Logs, approvals, event-log UI, real runner/provisioning behavior, Hermes, Telegram, billing, production auth, and secret storage remain out of scope.
- `.env.example` documents every required local/deploy variable without secrets.
- `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run db:migrate`, `bun run db:health`, `bun run build`, `bun run test:e2e`, and `bun run verify` pass against a migrated local database.
