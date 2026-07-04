# Progress

## Milestone 5 Agent Templates

- Status: initialized
- Source plan: `docs/MILESTONES.md` Milestone 5
- Tracking issue: #48
- Current branch: `codex/issue-48-m5-tracking`

### Issue Checklist

- [x] #48 Initialize Milestone 5 progress and changelog tracking
- [ ] #49 Add the typed agent template registry
- [ ] #50 Persist template versions and snapshots on agents
- [ ] #51 Show template metadata in the create-agent flow
- [ ] #52 Show persisted template settings on agent detail
- [ ] #53 Prove Milestone 5 template acceptance end to end
- Later Milestone 5 issue agents must append new issue rows here before implementation evidence if GitHub adds more Milestone 5 work.

### Current Status

Milestone 5 execution is ready for template implementation work, but no template registry, schema, API, UI, runner, auth, billing, provider, secret, migration, lifecycle, event, or runtime log behavior has been added by #48.

The source scope remains `docs/MILESTONES.md` Milestone 5: a typed template registry, initial template keys, template fields, durable template key/version/snapshot persistence, create-flow and detail-page metadata display, and metadata-only templates without tool or model API integration.

The stale issue context was checked against current `main` at the start of #48. The earlier concern that `PROGRESS.md` was deleted or `CHANGELOG.md` might be missing is not current after #47/#90 because both root tracking files exist in this branch.

### Tracking Rules

- Update `PROGRESS.md` for each Milestone 5 issue with status, branch, implementation evidence, validation commands, and any skipped checks or blockers.
- Update `CHANGELOG.md` only for user-visible functional changes. Do not add changelog entries for chores, tests, validation-only work, tracking-only edits, or empty headings.
- Keep Milestone 5 implementation evidence separate from older Milestone 4 history below this section.

### Update Log

- 2026-07-04: #48 initialized Milestone 5 tracking from `docs/MILESTONES.md`, recorded the #48-#53 checklist, documented the stale-context check for existing root tracking files, and recorded the `CHANGELOG.md` update rule. `CHANGELOG.md` was left unchanged because it already has the required Keep a Changelog preamble and `## [Unreleased]` section.

## Milestone 4 Agent Detail Runtime Logs

- Status: complete
- Issues: #47
- Branch: `codex/issue-47-agent-detail-logs`

### Completion Evidence

- [x] #47 adds an agent detail runtime log panel that fetches `GET /api/agents/:agentId/logs` and renders only safe log DTO fields: `createdAt`, `stream`, `level`, `sequence`, and `message`.
- [x] The panel has loading, empty, loaded, and safe error states; the agent record, identity, and activity panels remain readable when runtime log loading fails.
- [x] Runtime log polling is scoped to the selected detail agent and only continues while the current detail status is `running`; stopped and error states keep already visible rows readable without appending new generated rows.
- [x] Starting from the detail UI shows the deterministic simulator cycle: `Checking task queue...`, `No pending tasks.`, `Heartbeat OK.`, and `Memory loaded.`
- [x] Stopping from the detail UI leaves visible rows readable, and simulating an error moves the agent to `error` while the detail activity feed shows the existing `agent.error` audit event.
- [x] E2E coverage creates two agents and proves runtime logs stay scoped to the selected detail page; cleanup deletes `agent_logs` before `agent_events` and `agents`.
- [x] Detail log layout uses wrapping list rows, and Playwright verifies no horizontal overflow on both the existing desktop and mobile projects.
- [x] Final Milestone 4 docs/tracking now describe the detail runtime log panel as present behavior instead of future scope.
- [x] No schema, migration, worker, real runner, auth, provider, secret, GitHub issue, or Milestone 5 work was added.

### Validation

- Date: 2026-07-04
- Environment:
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54347/agentbay`.
  - Isolated app/test server: `PORT=3021`, `PLAYWRIGHT_BASE_URL=http://localhost:3021`, `NEXT_PUBLIC_APP_URL=http://localhost:3021`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker compose -p agentbay_issue_47 -f compose.yaml -f <port override> up -d --force-recreate postgres`: pass; started `agentbay_issue_47-postgres-1` on host port `54347`.
  - `bun run db:generate`: not run; #47 made no schema or migration changes.
- Required gates:
  - `bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run format:check`: pass; Biome checked 64 files.
  - `bun run lint`: pass; Biome checked 64 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass; 16 files and 118 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/agents/:agentId` and `/api/agents/:agentId/logs`.
  - `bun run test:e2e`: pass; 22 passed and 2 expected project skips across `chromium-desktop` and `chromium-mobile`.
  - `bun run verify`: pass; aggregate format, lint, typecheck, test, build, and E2E gates passed with 22 E2E passed and 2 expected project skips.

## Milestone 4 Running Agent Runtime Logs

- Status: complete
- Issues: #46
- Branch: `codex/issue-46-running-logs`

### Completion Evidence

- [x] #46 keeps runtime log generation pull-driven from `GET /api/agents/:agentId/logs`; no background worker, timer loop, queue, scheduler, SSE, websocket, runner service, lifecycle direct log writes, or event-feed writes were added.
- [x] #46 generates the deterministic four-line simulator cycle only for active running fake agents: `Checking task queue...`, `No pending tasks.`, `Heartbeat OK.`, `Memory loaded.`
- [x] #46 settles due fake `starting` and `restarting` transitions through the existing active-agent read path before generation, then uses the persisted `agents.updated_at` running segment boundary.
- [x] #46 keeps repeated reads at the same logical time idempotent and adds the next cycle only after the fixed simulator interval while the agent remains in the same running segment.
- [x] #46 allocates per-agent monotonic sequences inside a generation transaction after locking the active running agent row; the existing unique `(agent_id, sequence)` index remains the collision backstop.
- [x] #46 does not generate for stopped, idle, pending transition, error, deleting, missing, or soft-deleted agents; existing readable rows for active stopped/error agents remain listable.
- [x] #46 preserves #45 `simulate-error` as audit-only: it writes `agent.error` but no runtime logs, and reads stop generating after an agent enters `error`.
- [x] #46 uses safe static generated content only with `runner_id = null` and no secrets, environment values, database URLs, stacks, provider credentials, or real process output.

### Validation

- Date: 2026-07-04
- Environment:
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54346/agentbay`.
  - Isolated app/test server: `PORT=3020`, `PLAYWRIGHT_BASE_URL=http://localhost:3020`, `NEXT_PUBLIC_APP_URL=http://localhost:3020`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker compose -p agentbay_issue_46 -f compose.yaml -f /tmp/agentbay-issue-46-compose.override.yaml up -d --force-recreate postgres`: pass; started `agentbay_issue_46-postgres-1` on host port `54346`.
  - `bun run db:generate`: not run; #46 made no schema or migration changes.
- Required gates:
  - `bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run test -- tests/unit/create-agent-db.test.ts tests/unit/agent-logs-route.test.ts`: pass after timestamp-normalization fix; 2 files and 58 tests passed.
  - `bun run format:check`: pass; Biome checked 63 files.
  - `bun run lint`: pass; Biome checked 63 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass; 16 files and 118 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/api/agents/:agentId/logs`.
  - `bun run test:e2e`: pass; 18 passed and 2 expected project skips.
  - `bun run verify`: pass; aggregate format, lint, typecheck, test, build, and E2E gates passed with 18 E2E passed and 2 expected project skips.

## Milestone 4 Development Error Simulator

- Status: in progress
- Issues: #45
- Branch: `codex/issue-45-simulate-error`

### Completion Evidence

- [x] #45 adds development/test-only `POST /api/agents/:agentId/actions/simulate-error` guarded before lifecycle DB work when `NODE_ENV === "production"`.
- [x] #45 simulates an active non-deleted agent error by transactionally setting `status = "error"`, persisting a safe status reason, and writing exactly one `agent.error` audit event with `fromStatus`, `toStatus`, and `source` metadata.
- [x] #45 exposes the simulator from the shared lifecycle controls only outside production, so dashboard and detail surfaces inherit the same tester action.
- [x] #45 keeps simulated error audit events separate from `agent_logs` and does not add runtime log generation, log panel UI, runner integration, or schema changes.

### Validation

- Date: 2026-07-04
- Environment:
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54341/agentbay`.
  - Isolated app/test server: `PORT=3015`, `PLAYWRIGHT_BASE_URL=http://localhost:3015`, `NEXT_PUBLIC_APP_URL=http://localhost:3015`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker compose -p agentbay_issue_45 -f compose.yaml -f <port override> up -d postgres`: pass; started `agentbay_issue_45-postgres-1` on host port `54341`.
- Required gates:
  - `bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run format:check`: pass; Biome checked 63 files.
  - `bun run lint`: pass; Biome checked 63 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass; 16 files and 110 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/api/agents/:agentId/actions/simulate-error`.
  - `bun run test:e2e`: pass; 18 passed and 2 expected project skips.
  - `bun run verify`: pass; aggregate format, lint, typecheck, test, build, and E2E gates passed with 18 E2E passed and 2 expected project skips.

## Milestone 4 Durable Agent Logs

- Status: in progress
- Issues: #44
- Branch: `codex/issue-44-agent-logs`

### Completion Evidence

- [x] #44 adds additive `agent_logs` storage with `agent_id`, nullable unreferenced `runner_id`, `stream`, `level`, `message`, positive per-agent `sequence`, `created_at`, and a unique `(agent_id, sequence)` index.
- [x] #44 exposes `GET /api/agents/:agentId/logs` for active, non-deleted agents with oldest-first pages, bounded limits, repeated-query rejection, safe JSON errors, and numeric `after` sequence pagination.
- [x] #44 keeps runtime logs separate from Milestone 3 audit events and does not add simulated log generation, runner integration, or UI wiring.

### Validation

- Date: 2026-07-04
- Environment:
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54340/agentbay`.
  - Isolated app/test server: `PORT=3014`, `PLAYWRIGHT_BASE_URL=http://localhost:3014`, `NEXT_PUBLIC_APP_URL=http://localhost:3014`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile after the first migration-generation attempt found no local `node_modules`.
  - `docker compose -p agentbay_issue_44 -f compose.yaml -f <port override> up -d postgres`: pass; started `agentbay_issue_44-postgres-1` on host port `54340`.
- Required gates:
  - `bun run db:generate`: pass; generated `drizzle/0002_icy_star_brand.sql` and `drizzle/meta/0002_snapshot.json`.
  - `bun run db:migrate`: pass; migrations applied successfully.
  - `bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run format`: pass; no fixes after tracking-doc updates.
  - `bun run verify`: pass; includes `format:check`, `lint`, `typecheck`, `test` (15 files, 104 tests), `build`, and `test:e2e` (18 passed, 2 expected skips).

## Milestone 3 Activity Feeds

- Status: complete
- Issues: #39, #40, #41, #42, #43
- Branch: `codex/issue-43-m3-verification`

### Completion Evidence

- [x] #39 established the shared event timeline foundation: transactional event writers, opaque cursor helpers, event DTO mapping, actor display, metadata summaries, and newest-first query helpers.
- [x] #40 exposed `GET /api/agents/:agentId/events` with active-agent validation, safe JSON errors, bounded limits, and opaque cursor pagination.
- [x] #41 added the dashboard latest activity feed for newest persisted agent audit events, including deleted-agent context.
- [x] #42 added the agent detail activity feed with event time, type, message, actor, metadata summary, empty/error states, and older-page navigation.
- [x] #43 updated operator docs, stale UI copy, changelog tracking, and milestone tracking for the completed activity feed slice.

### Definition Of Done

- [x] Activity feed purpose and the audit-event versus future runtime-log boundary are documented.
- [x] `GET /api/agents/:agentId/events` behavior, safe errors, and opaque cursor pagination are documented.
- [x] Current event inventory is documented: `agent.created`, `agent.start_requested`, `agent.start_completed`, `agent.stop_requested`, `agent.stop_completed`, `agent.restart_requested`, `agent.restart_completed`, and `agent.deleted`.
- [x] User-facing copy no longer describes implemented activity feed surfaces as future work.
- [x] E2E coverage proves create and lifecycle activity appears in both dashboard latest activity and agent detail activity.
- [x] Future scope remains explicit for runtime logs, approvals, config editing, runner APIs, runner provisioning, Hermes, Telegram, billing, production auth, backups, restore, cloud provisioning, secrets, and external provider integrations.
- [x] No Milestone 4+ schema, migration, dependency, runner, log, approval, billing, auth, cloud, Hermes, Telegram, backup, or restore work was added.

### Final Validation

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by existing Docker container `agentbay-postgres-1`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54339/agentbay`.
  - Isolated app/test server: `PORT=3013`, `PLAYWRIGHT_BASE_URL=http://localhost:3013`, `NEXT_PUBLIC_APP_URL=http://localhost:3013`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile after the first migration attempt found no local `node_modules`.
  - `docker compose -p agentbay_issue_43 -f compose.yaml -f <(printf '%s\n' 'services:' '  postgres:' '    ports: !override' '      - "54339:5432"') up -d postgres`: pass; started `agentbay_issue_43-postgres-1`.
- Required gates:
  - `bun run db:migrate`: pass; migrations applied successfully.
  - `bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run format:check`: pass; Biome checked 57 files.
  - `bun run lint`: pass; Biome checked 57 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass; 14 test files and 83 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/api/agents/:agentId/events`.
  - `bun run test:e2e`: pass; 18 passed and 2 expected project skips.
  - `bun run verify`: pass; aggregate format, lint, typecheck, test, build, and E2E gates passed with 18 E2E passed and 2 expected project skips.
