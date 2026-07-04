# Progress

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
