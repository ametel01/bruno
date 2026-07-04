# AgentBay

AgentBay is a Bun-managed Next.js App Router app for the completed Milestone 4 runtime monitoring slice, the completed Milestone 6 local-development config editor workflow, the completed Milestone 7 pending-approval queue workflow, and the Milestone 9 local-runner persistence foundation. It includes a dashboard-oriented shell, local Postgres migration tooling, runtime environment validation, a database-backed `/health` endpoint, persistent agent records, validated config defaults and updates, an agent detail config editor backed by the local PATCH API, deterministic Start, Stop, Restart, and Delete controls, persisted activity feeds, scoped runtime logs, local runner process metadata storage, dashboard plus agent-detail pending approvals for local development agents, dashboard approval decision controls, and fake approval generation for running local-development agents.

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
- `agent_events`: transactional audit events for agent creation, config updates, fake lifecycle transitions, dashboard activity, and per-agent activity.
- `local_runner_processes`: local runner process metadata scoped to an agent, including OS process id, safe command metadata, runner status, start/stop timestamps, exit code or signal, and a safe last-error string.
- `agent_logs`: runtime log rows with nullable runner identity, nullable local runner process link, stdout/stderr stream, level/message fields, timestamps, and per-agent positive sequence values.
- `agent_approvals`: pending and resolved approval request rows scoped to an agent, with title, description, lifecycle status, downstream payload JSON, requester, nullable resolver, creation, resolution, and expiry timestamps.
- `agent_status`: Postgres enum used by `agents.status`.
- `agent_schedule_mode`: Postgres enum used by `agent_configs.schedule_mode`.
- `agent_approval_status`: Postgres enum with `pending`, `approved`, `denied`, `expired`, and `cancelled`.

The migrations do not create Docker, cloud runner, billing, auth, Hermes, Telegram, secrets, provisioning, or provider integration tables.

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
7. Confirm the detail runtime log panel shows the deterministic simulator output for the selected running agent and can create one pending fake approval for the current running segment.
8. Use Restart while the agent is `running` to move it through `restarting` and back to `running`.
9. Use Stop while the agent is `running` to move it back to `stopped` while already visible runtime logs remain readable.
10. Use Simulate error outside production to move an active agent to `error` and record one `agent.error` audit event.
11. Use Delete while the agent is not transitioning to soft-delete it from active views.
12. Refresh `/agents`, `/dashboard`, and the detail page to confirm active records remain visible and deleted records return not found.

The dashboard reads active persisted agents from the database. The detail page loads active persisted agent records by ID and returns not found for missing, malformed, or soft-deleted IDs. Delete preserves the `agents` row and existing `agent_events`, but removes the agent from `/agents`, `/dashboard`, and active detail reads.

Agent records are local-development records only. Lifecycle controls, runtime logs, the detail config editor, dashboard plus agent-detail pending approvals panels, dashboard approval decision controls, and fake approval generation use deterministic database state and local read/write paths. Milestone 9 adds local runner process/log persistence helpers but does not spawn or supervise real processes yet. Approval payload execution, runner control APIs, runner provisioning, Hermes, Telegram, billing, production auth, secret storage, backups, restore, cloud provisioning, and external provider integrations remain future scope.

## Agent Detail Config Editor

The agent detail page includes the completed local-development configuration editor for active, non-deleted agents. The editor shows the saved model, max daily spend, schedule, and timezone summary above the editable form so draft edits stay separate from persisted state until a save is accepted.

Use the editor locally after creating an agent:

1. Open `/agents/:agentId`.
2. Edit supported local config fields: display name, system prompt, model provider, model name, max daily spend, schedule mode, schedule cron, and timezone.
3. Save config to send changed fields through `PATCH /api/agents/:agentId`.
4. Confirm the saved summary refreshes from persisted detail data after accepted saves.
5. Refresh the page and confirm accepted model and spend changes remain visible.
6. Check the Activity panel for a readable `config.updated` timeline entry with safe changed-field display values.

The editor rejects invalid draft values before save for blank required fields, malformed max daily spend values, invalid cron schedules, and invalid IANA timezones. The server-side `PATCH /api/agents/:agentId` validation remains authoritative, including recursive secret-like key rejection and persisted `agent_schedule_mode` constraints. Rejected saves and no-op saves do not update the saved summary and do not create `config.updated` events.

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

The initial persisted config defaults are intentionally non-secret and non-integrated: model provider and model name are `not_configured`, max daily spend is `0` cents, schedule mode is `manual`, schedule cron is `null`, timezone is `UTC`, and the generic system prompt is stored with the config row. The agent detail config editor updates these local-development fields through the validated `PATCH /api/agents/:agentId` API. Real provider/model integration, Hermes config generation, BYOK keys, and secret storage remain future scope.

## Agent Config Update API

`PATCH /api/agents/:agentId` updates the display name and persisted config row for an active, non-deleted local development agent in one transaction.

Editable request fields are all optional:

```json
{
  "name": "Research Agent",
  "systemPrompt": "Keep answers concise.",
  "modelProvider": "openai",
  "modelName": "gpt-4.1-mini",
  "maxDailySpend": "12.34",
  "scheduleMode": "manual",
  "scheduleCron": null,
  "timezone": "Asia/Manila"
}
```

String fields are trimmed. Blank `name`, `systemPrompt`, `modelProvider`, `modelName`, and `timezone` values are rejected. `maxDailySpend` is a positive dollar amount that must convert exactly to integer cents, must be greater than zero when supplied, and is capped at `$1000.00` for local development. The persisted and returned value is `maxDailySpendCents`.

`scheduleMode` is either `manual` or `cron`. Manual schedules persist `scheduleCron: null`; cron schedules require a nonblank five-field cron expression. `timezone` must be a valid IANA timezone.

Secret-like keys are rejected anywhere in the request object before mutation, including nested keys such as API key, token, password, secret, credential, private key, bearer, or authorization-style fields. Config updates do not store secret fields.

Effective changes return HTTP 200 with `ok: true`, `noOp: false`, the persisted agent identity, the persisted config DTO, `changedFields`, and `event: { "type": "config.updated" }`. Exactly one `config.updated` event is written with safe before/after display values.

Accepted no-op requests return HTTP 200 with `ok: true`, `noOp: true`, the persisted agent and config DTOs, `changedFields: []`, and `event: null`. No-op requests do not update rows and do not write events.

Validation failures, missing or soft-deleted agents, and persistence failures return safe JSON without database URLs, SQL errors, stack traces, driver messages, or secret values.

## Pending Approvals

The dashboard shows pending approval requests persisted in `agent_approvals` for active local-development agents. Each dashboard item displays the agent link, approval title, description, `pending` status, created time, expiry time when present, and Approve/Deny controls.

Dashboard pending approval items include a Deny control. Denying posts to `POST /api/approvals/:approvalId/deny`, resolves one pending approval to `denied`, sets `resolved_by` and `resolved_at`, writes one matching `approval.denied` event in the same transaction, and refreshes the pending queue so the resolved row disappears.

The agent detail page shows pending approval requests for the selected active local-development agent only. Each detail item displays the approval title, description, `pending` status, requester/source, created time, and expiry time when present.

When `GET /api/agents/:agentId/logs` observes an active, non-deleted local-development agent that has settled to `running`, the fake runner can create one deterministic pending approval for that running segment. The generated request uses a representative fake sensitive action such as Telegram message sending, public research execution, or Gmail inbox access; stores only a fake `actionType`, safe preview fields, the fake-runner source, and the running-segment timestamp; and writes one matching `approval.requested` audit event with safe metadata.

Approval rows store `payload_json` for downstream decision slices, but the dashboard and agent detail page do not render raw payload JSON, database internals, SQL, driver messages, stack traces, credentials, or environment values.

`POST /api/approvals/:approvalId/approve` approves one pending approval for an active, non-deleted local-development agent. Success updates only that approval from `pending` to `approved`, records `resolved_by` and `resolved_at`, and writes exactly one `approval.approved` event in the same transaction. Malformed approval IDs return validation JSON, missing or inaccessible approvals return not found JSON, already resolved approvals return a shared `approval_already_resolved` conflict with safe status, and persistence failures return generic safe errors.

Repeated deny requests against a denied or otherwise resolved approval return HTTP 409 with the reusable `approval_already_resolved` error code and a safe current status. Malformed approval IDs return HTTP 400 validation JSON, inaccessible approvals return HTTP 404, and persistence failures return generic safe errors. A forced decision-event write failure rolls back the denial update so no partial decision is visible.

Only `pending` approvals for active, non-deleted agents owned by the local development user appear in approval queues. Resolved approvals with `approved`, `denied`, `expired`, or `cancelled` status, approvals for other agents on a selected detail page, soft-deleted-agent approvals, stopped/non-running-agent approvals, and other-user approvals are excluded from the pending queues or fake generation path. Repeated observations of the same running segment/action do not create duplicate approval rows or duplicate `approval.requested` events. Repeated approval or deny attempts against an already resolved approval do not create duplicate decision events.

Approval payload execution and real provider action dispatch remain future milestone scope.

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
- `config.updated`
- `approval.requested`
- `approval.approved`
- `approval.denied`

Future milestones may add runner, backup, restore, billing, and Hermes-related audit event types. Those future audit events should continue to describe control-plane facts, while high-volume runtime output remains separate log data.

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

Generated rows use `runner_id = null`, safe static `stdout`/`info` content only, and per-agent monotonic `sequence` values. Runtime log generation does not mirror log lines into `agent_events`; it only writes the bounded `approval.requested` audit event when a running fake agent receives a generated approval request. Lifecycle actions, including `simulate-error`, do not directly write runtime logs. Stopped, idle, pending transition, error, deleting, missing, and soft-deleted agents do not receive newly generated log rows or fake approval requests, though active stopped or error agents can still return existing readable rows.

Local runner persistence helpers can also write `agent_logs` rows for a persisted `local_runner_processes` row. Those rows keep `stdout` and `stderr` stream identity, allocate stable per-agent sequence values after any existing rows, store timestamps, and keep a nullable `local_runner_process_id` link for process-scoped reads. Log persistence remains separate from audit events: stdout/stderr process output is not copied into `agent_events`.

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

## Post-Merge Cleanup

After a PR is merged, keep the builder/checker/reviewer separation intact: do not use cleanup as a substitute for required checks, checker evidence, maintainer-reviewer review, or GitHub merge-readiness. The coordinator or merger records cleanup evidence in `STATUS.md` so the next agent can verify the repo state without rediscovery.

Use this checklist for every merged agent worktree:

- Verify the PR merged remotely and record the merge commit:

  ```bash
  gh pr view <pr-number> --json number,state,mergedAt,mergeCommit,headRefName,url
  ```

- Verify the linked issue closed, or close/update it with evidence when auto-close did not happen:

  ```bash
  gh issue view <issue-number> --json number,state,closedAt,url
  ```

- Delete the remote branch explicitly when GitHub or local merge cleanup did not remove it:

  ```bash
  git push origin --delete <branch-name>
  ```

- Confirm the implementation worktree is clean before removal:

  ```bash
  git -C /path/to/issue-worktree status --short --branch --untracked-files=all
  ```

- Remove the implementation worktree, then delete the local branch:

  ```bash
  git worktree remove /path/to/issue-worktree
  git branch -D <branch-name>
  ```

- Fast-forward the root checkout `main` to `origin/main`:

  ```bash
  git -C /path/to/root-checkout switch main
  git -C /path/to/root-checkout pull --ff-only
  ```

- Record the remaining worktrees and root checkout cleanliness:

  ```bash
  git worktree list --porcelain
  git status --short --branch --untracked-files=all
  ```

- Clean isolated validation infrastructure by compose labels when they exist:

  ```bash
  docker compose -p <compose-project> down -v --remove-orphans
  ```

- If compose labels are absent, verify and remove the exact known validation containers by name and port, including anonymous volumes when they are disposable:

  ```bash
  docker ps -a --filter "name=<exact-container-name>" --format "{{.Names}}\t{{.Ports}}\t{{.Status}}"
  docker rm -f -v <exact-container-name>
  ```

`STATUS.md` must include the cleanup commands run, pass/fail result, merge commit, linked issue state or manual issue evidence, expected remaining worktrees, root status output summary, and any preserved worktree, branch, container, volume, or port with the reason it was preserved.

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
- The agent detail config editor updates local-development config fields, the dashboard plus agent detail page render persisted pending approvals, and dashboard Approve/Deny controls resolve pending approvals with `approval.approved` and `approval.denied` activity; approval payload execution, runner APIs, real runner/provisioning behavior, Hermes, Telegram, billing, production auth, secret storage, backups, restore, and cloud provisioning remain out of scope.
- `.env.example` documents every required local/deploy variable without secrets.
- `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run db:migrate`, `bun run db:health`, `bun run build`, `bun run test:e2e`, and `bun run verify` pass against a migrated local database.
