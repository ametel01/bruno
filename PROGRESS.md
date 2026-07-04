# Progress

## Milestone 7 Approval Queue

- Status: complete for #59/#62; #60/#61/#63/#64 remain pending
- Source plan: `docs/MILESTONES.md` Milestone 7
- Tracking issue: #62
- Current branch: `codex/issue-62-agent-detail-approvals`

### Issue Checklist

- [x] #59 Show pending approvals on the dashboard
- [ ] #60 Approve pending approvals end to end
- [ ] #61 Deny pending approvals end to end
- [x] #62 Show pending approvals on agent detail
- [ ] #63 Generate fake approvals for running agents
- [ ] #64 Verify Milestone 7 approval queue acceptance
- Later Milestone 7 issue agents must append new issue rows here before implementation evidence if GitHub adds more Milestone 7 work.

### Completion Evidence

- [x] #59 adds an additive `agent_approvals` table with `id`, `agent_id`, `title`, `description`, `status`, `payload_json`, `requested_by`, `resolved_by`, `created_at`, `resolved_at`, and `expires_at`.
- [x] #59 adds the exact `agent_approval_status` lifecycle values: `pending`, `approved`, `denied`, `expired`, and `cancelled`.
- [x] #59 adds local-development approval helpers that create pending approvals only for active existing agents owned by the local development user and list only pending approvals for active non-deleted local-development agents.
- [x] #59 keeps resolved approvals, soft-deleted-agent approvals, and other-user approvals out of the dashboard pending queue.
- [x] #59 renders a dashboard pending approvals panel from persisted data with agent identity/link, title, description, status, created time, and expiry when present.
- [x] #59 keeps raw `payload_json`, database internals, SQL, driver messages, stack traces, credentials, and environment values out of dashboard output and safe persistence errors.
- [x] #59 updates README and CHANGELOG to describe the dashboard pending approval queue as present behavior while leaving the remaining Milestone 7 slices to #60-#64.
- [x] #62 adds an agent-scoped pending approval read helper for the selected active local-development agent.
- [x] #62 renders a read-only agent-detail pending approvals panel with title, description, `pending` status, requester/source, created time, optional expiry, empty state, and safe error state.
- [x] #62 keeps resolved approvals, other-agent approvals, soft-deleted-agent approvals, and other-user approvals out of the selected detail page.
- [x] #62 keeps the agent record, config editor, runtime logs, and activity visible when approval loading fails.
- [x] #62 updates README and CHANGELOG to describe agent-detail approval visibility as present behavior while leaving approve/deny decisions and fake approval generation to sibling Milestone 7 slices.

### Validation

#### #59

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by existing Docker container `agentbay-postgres-1`.
  - Default app port `3000` was occupied by local `node` process `60238`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54359/agentbay`.
  - Isolated app/test server: `PORT=3059`, `PLAYWRIGHT_BASE_URL=http://localhost:3059`, `NEXT_PUBLIC_APP_URL=http://localhost:3059`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `bun run db:generate`: pass; generated additive `drizzle/0004_careless_santa_claus.sql` and `drizzle/meta/0004_snapshot.json` for `agent_approval_status` and `agent_approvals`.
  - `docker info --format '{{.ServerVersion}}'`: pass; Docker daemon reachable with server version `29.3.1`.
  - `docker run --name agentbay_issue_59-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54359:5432 -d postgres:17-alpine`: pass; started isolated Postgres because default port was occupied.
  - `bun run db:migrate`: pass with isolated DB env; migrations applied successfully.
  - `bun run db:health`: pass with isolated DB/app env; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `bun run test -- tests/unit/agent-schema.test.ts tests/unit/create-agent-db.test.ts tests/unit/root-page.test.tsx`: pass with isolated DB env; 3 files and 79 tests passed. Covers schema/migration inventory, approval service create/list, pending-only filtering, active-agent/user scoping, safe approval persistence errors, dashboard pending approval render, empty state, and approval-load failure that keeps agents/activity visible.
  - `bun run test:e2e -- --project=chromium-desktop -g "pending approvals"`: pass with isolated DB/app env; 1 Chromium desktop test passed and proves a persisted pending approval is visible on `/dashboard` with agent link, title, description, `pending`, created time, and expiry while omitting raw payload details.
- Required gates:
  - `bun run format:check`: pass; Biome checked 70 files.
  - `bun run lint`: pass; Biome checked 70 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass with isolated DB env after moving the approval service tests into the existing DB-backed persistence test file to avoid parallel shared-table truncation; 18 files and 145 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/dashboard`.
  - `bun run test:e2e`: pass with isolated DB/app env; 24 browser tests passed with 4 expected skips after making the focused approval proof desktop-only to avoid parallel local-development-user pointer races across Playwright projects.
  - `bun run verify`: pass with isolated DB/app env; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 145 unit tests and 24 E2E passed / 4 expected skips.
- Reconciliation:
  - After #58 merged as PR #97 at `197244c`, #59 was rebased onto `origin/main`; README conflict was resolved by preserving #58 completed config-editor wording and layering in the #59 pending-approval queue foundation.

#### #62

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by existing Docker container `agentbay-postgres-1`.
  - Default app port `3000` was occupied by local `node` process `60238`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54362/agentbay`.
  - Isolated app/test server: `PORT=3062`, `PLAYWRIGHT_BASE_URL=http://localhost:3062`, `NEXT_PUBLIC_APP_URL=http://localhost:3062`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker run --name agentbay_issue_62-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54362:5432 -d postgres:17-alpine`: pass; started isolated Postgres because the default port was occupied.
  - `bun run db:migrate`: pass with isolated DB env; migrations applied successfully.
  - `bun run db:health`: pass with isolated DB/app env; returned `status: ok` and `database: reachable`.
- Focused checks:
  - `bun run test -- tests/unit/create-agent-db.test.ts tests/unit/root-page.test.tsx`: pass with isolated DB env; 2 files and 72 tests passed. Covers agent-scoped pending-only listing, no cross-agent/resolved/soft-deleted/other-user leakage, detail render, empty state, and safe approval-load failure that keeps record/config/log/activity visible.
  - `bun run test:e2e -- --project=chromium-desktop -g "approval persistence surfaces"`: pass with isolated DB/app env; 2 Chromium desktop tests passed. Covers dashboard approval persistence and agent-detail approval visibility for the selected agent while another agent's approval does not render.
- Required gates:
  - `bun run format:check`: pass; Biome checked 70 files.
  - `bun run lint`: pass; Biome checked 70 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass with isolated DB env; 18 files and 148 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/agents/[agentId]`.
  - `bun run test:e2e`: pass with isolated DB/app env; 25 browser tests passed with 5 expected skips.
  - `bun run verify`: pass with isolated DB/app env; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 148 unit tests and 25 E2E passed / 5 expected skips.
- Reconciliation:
  - Initial aggregate `bun run verify` exposed a Playwright data race between the dashboard and detail approval persistence tests over the shared local-development-user pointer; the approval persistence tests now run in one serial group while the rest of the E2E suite remains parallel.

## Milestone 6 Agent Config Editor

- Status: complete for #54/#56/#57/#58
- Source plan: `docs/MILESTONES.md` Milestone 6
- Tracking issue: #58
- Current branch: `codex/issue-58-m6-docs-acceptance`

### Issue Checklist

- [x] #54 Add persistent agent config defaults
- [x] #56 Add validated config update API
- [x] #57 Add agent detail config editor
- [x] #58 Document and verify Milestone 6 acceptance
- Later Milestone 6 issue agents must append new issue rows here before implementation evidence if GitHub adds more Milestone 6 work.

### Completion Evidence

- [x] #54 adds a typed `agent_configs` table with one row per agent, system prompt, model provider, model name, integer-cent max daily spend, schedule mode, optional cron, timezone, and timestamps.
- [x] #54 creates the `agent_schedule_mode` enum with `manual` and `cron` values and database checks for non-negative spend plus schedule-mode/cron consistency.
- [x] #54 adds an additive migration that creates `agent_configs` and backfills default config rows only for active existing agents where `agents.deleted_at IS NULL`.
- [x] #54 writes the default config in the same transaction as the agent row and `agent.created` event for new agent creation.
- [x] #54 keeps defaults generic and non-secret: provider/model are `not_configured`, spend is `0` cents, schedule is manual, cron is `null`, timezone is `UTC`, and no API key, token, password, or secret storage is added.
- [x] #54 updates E2E cleanup to delete `agent_configs` before hard-deleting test `agents`, which is necessary because the new config table has a one-to-one foreign key to agents.
- [x] #54 does not add a config editor UI, config update API, `config.updated` events, template metadata/snapshots, real model/provider/Hermes/runner integrations, or secret handling.
- [x] #56 adds `PATCH /api/agents/:agentId` for active, non-deleted agents with validated partial updates for `name`, `systemPrompt`, `modelProvider`, `modelName`, `maxDailySpend`, `scheduleMode`, `scheduleCron`, and `timezone`.
- [x] #56 normalizes accepted max daily spend dollar input to integer cents, rejects zero, negative, malformed, non-finite, non-cent, and values above the local `$1000.00` cap before mutation.
- [x] #56 preserves the persisted schedule contract: manual schedules store `scheduleCron: null`, cron schedules require a valid five-field cron expression, and timezones must be valid IANA timezone names.
- [x] #56 rejects secret-like keys recursively before mutation and keeps config update event metadata to safe changed-field display values.
- [x] #56 updates `agents.name` and `agent_configs` atomically, writes exactly one `config.updated` event for effective changes, returns deterministic HTTP 200 no-op responses with `event: null`, and does not write runtime logs.
- [x] #56 does not add a config editor UI, optimistic UI, template metadata/snapshots, secret storage, real provider/model validation, Hermes config generation, runner/provisioning behavior, billing, auth, or external integrations.
- [x] #57 extends the active agent detail DTO with the persisted `agent_configs` row so the detail page can render current name, system prompt, model provider, model name, max daily spend, schedule mode, schedule cron, and timezone.
- [x] #57 adds a user-facing detail configuration editor that saves only through `PATCH /api/agents/:agentId`, sends `maxDailySpend` as a dollar amount, refreshes persisted detail data after accepted saves, and keeps draft edits separate from the saved summary.
- [x] #57 proves changing model name to `gpt-5.5-mini` and max daily spend to `$2.00` persists across refresh and creates exactly one readable `config.updated` Activity event with model and spend metadata.
- [x] #57 shows safe client feedback for invalid spend, blank required fields, invalid cron/timezone, malformed or failed save responses, and persistence failures without leaking database URLs, SQL, stack traces, driver details, or secrets.
- [x] #57 keeps rejected saves and no-op saves from updating the saved config summary or Activity timeline, and no-op saves do not create `config.updated` events.
- [x] #57 removes detail-page copy that described config editing as future or unavailable, without adding template metadata/snapshots, provider integrations, auth/billing, runner behavior, external services, or #58 final docs acceptance.
- [x] #58 updates README operator documentation so the detail config editor is described as completed local-development behavior, including edit, save, refresh persistence, validation, and `config.updated` Activity review steps.
- [x] #58 confirms README API/schema notes cover `PATCH /api/agents/:agentId`, `agent_configs`, and `agent_schedule_mode`.
- [x] #58 confirms `CHANGELOG.md` has only non-empty Keep a Changelog sections with qualifying functional Milestone 6 entries for config defaults, the validated PATCH API, and the detail config editor.
- [x] #58 records the final acceptance checklist below without adding new behavior, migrations, schemas, tests, template registry work, auth/billing, runner/deployment changes, or unrelated refactors.

### Final Acceptance Checklist

- [x] README describes the completed agent detail config editor workflow and does not frame config editing as future or unavailable.
- [x] README API documentation covers `PATCH /api/agents/:agentId`, validated editable fields, max daily spend normalization to integer cents, schedule validation, secret-like key rejection, no-op responses, and safe `config.updated` events.
- [x] README schema/migration notes cover `agent_configs` and the `agent_schedule_mode` enum.
- [x] `PROGRESS.md` marks Milestone 6 complete for #54/#56/#57/#58 and removes stale #57 in-validation/current-branch wording.
- [x] `CHANGELOG.md` contains only qualifying functional Milestone 6 entries under non-empty Keep a Changelog headings.
- [x] Browser acceptance evidence covers editing model name to `gpt-5.5-mini` and max daily spend to `$2.00`.
- [x] Browser acceptance evidence covers refresh persistence for the edited model name and max daily spend.
- [x] Browser acceptance evidence covers invalid spend rejection without updating saved config or Activity.
- [x] Browser acceptance evidence covers blank required-field rejection without updating saved config or Activity.
- [x] Browser acceptance evidence covers invalid schedule rejection without updating saved config or Activity.
- [x] Browser acceptance evidence covers exactly one readable `config.updated` timeline event with model and spend metadata.

### Validation

#### #58

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by existing Docker container `agentbay-postgres-1`.
  - Default app port `3000` was occupied by local `node` process `60238`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54358/agentbay`.
  - Isolated app/test server: `PORT=3058`, `PLAYWRIGHT_BASE_URL=http://localhost:3058`, `NEXT_PUBLIC_APP_URL=http://localhost:3058`.
- Setup:
  - `docker compose up -d postgres`: failed before validation because `0.0.0.0:54329` was already allocated by `agentbay-postgres-1`.
  - `docker compose down -v`: pass; removed the failed #58 compose container, network, and volume.
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker run --name agentbay_issue_58-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54358:5432 -d postgres:17-alpine`: pass; started an isolated Postgres service because the default port was occupied.
  - `docker exec agentbay_issue_58-postgres pg_isready -U agentbay -d agentbay`: pass; Postgres accepted connections.
- Documentation checks:
  - README reviewed against `app/agents/_components/agent-config-editor.tsx`, `app/api/agents/[agentId]/route.ts`, `src/server/agents/update-agent-config.ts`, and `tests/e2e/root-route.spec.ts`.
  - `CHANGELOG.md` reviewed for Keep a Changelog heading hygiene and qualifying functional Milestone 6 entries only.
- Acceptance evidence:
  - `tests/e2e/root-route.spec.ts` test `/agents detail edits config through persisted save and safe validation` covers no-op save behavior, safe failed persistence handling, invalid spend rejection, blank required-field rejection, invalid cron rejection, invalid timezone rejection, persisted `gpt-5.5-mini` and `$2.00` after refresh, exactly one readable `config.updated` Activity event, and no horizontal overflow.
- Required gates:
  - `bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run test -- tests/unit/update-agent-config-validation.test.ts tests/unit/update-agent-config-route.test.ts tests/unit/create-agent-db.test.ts tests/unit/agent-events.test.ts tests/unit/root-page.test.tsx`: pass; 5 files and 76 tests passed.
  - `bun run test:e2e -- --project=chromium-desktop -g "edits config"` with default `NEXT_PUBLIC_APP_URL=http://localhost:3000`: failed before tests because `127.0.0.1:3000` was already in use by local `node` process `60238`.
  - `bun run test:e2e -- --project=chromium-desktop -g "edits config"` with isolated app env: pass; 1 Chromium desktop test passed and proved config editor acceptance behavior.
  - `bun run verify` with isolated database/app env: pass; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 137 unit tests and 23 E2E passed / 3 expected skips.

#### #57

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by existing Docker container `agentbay-postgres-1`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54357/agentbay`.
  - Isolated app/test server: `PORT=3057`, `PLAYWRIGHT_BASE_URL=http://localhost:3057`, `NEXT_PUBLIC_APP_URL=http://localhost:3057`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker run --name agentbay_issue_57-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54357:5432 -d postgres:17-alpine`: pass; started an isolated Postgres service because the default port was occupied.
- Focused checks:
  - `bun run test -- tests/unit/root-page.test.tsx tests/unit/update-agent-config-validation.test.ts tests/unit/update-agent-config-route.test.ts`: pass; 3 files and 27 tests passed.
  - `bun run typecheck`: pass.
  - `bun run lint`: pass; Biome checked 68 files after the saved config summary was changed to semantic `fieldset` markup.
  - `bun run test -- tests/unit/create-agent-db.test.ts tests/unit/root-page.test.tsx tests/unit/update-agent-config-validation.test.ts tests/unit/update-agent-config-route.test.ts tests/unit/agent-events.test.ts`: pass with isolated DB env; 5 files and 76 tests passed.
  - `bun run test:e2e -- --project=chromium-desktop -g "edits config"`: pass with isolated DB/app env; proves no-op, validation rejection, safe failed persistence, persisted `gpt-5.5-mini` and `$2.00` after refresh, exactly one readable `config.updated` event, and no horizontal overflow.
- Required gates:
  - `bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run format:check`: pass; Biome checked 68 files.
  - `bun run lint`: pass; Biome checked 68 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass; 18 files and 137 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/agents/:agentId` and `/api/agents/:agentId`.
  - `bun run test:e2e`: pass; 23 browser tests passed with 3 expected skips.
  - `bun run verify`: pass; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 137 unit tests and 23 E2E passed / 3 expected skips.

#### #56

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by existing Docker container `agentbay-postgres-1`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54356/agentbay`.
  - Isolated app/test server: `PORT=3056`, `PLAYWRIGHT_BASE_URL=http://localhost:3056`, `NEXT_PUBLIC_APP_URL=http://localhost:3056`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `docker run --name agentbay_issue_56-postgres -e POSTGRES_DB=agentbay -e POSTGRES_USER=agentbay -e POSTGRES_PASSWORD=agentbay -p 54356:5432 -d postgres:17-alpine`: pass; started an isolated Postgres service after a Compose override attempt still tried to bind the occupied default port.
- Focused checks:
  - `bun run test -- tests/unit/update-agent-config-validation.test.ts tests/unit/update-agent-config-route.test.ts tests/unit/agent-events.test.ts`: pass; 3 files and 13 tests passed.
  - `bun run test -- tests/unit/create-agent-db.test.ts tests/unit/update-agent-config-validation.test.ts tests/unit/update-agent-config-route.test.ts tests/unit/agent-events.test.ts`: pass with isolated DB env; 4 files and 60 tests passed.
- Required gates:
  - `bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run format:check`: pass; Biome checked 67 files.
  - `bun run lint`: pass; Biome checked 67 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass; 18 files and 137 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/api/agents/:agentId`.
  - `bun run verify`: pass; aggregate format, lint, typecheck, unit test, build, and E2E gates passed with 137 unit tests and 22 E2E passed / 2 expected skips.

#### #54

- Date: 2026-07-04
- Environment:
  - Default Postgres port `54329` was occupied by existing Docker container `agentbay-postgres-1`.
  - Isolated database: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54354/agentbay`.
  - Isolated app/test server: `PORT=3024`, `PLAYWRIGHT_BASE_URL=http://localhost:3024`, `NEXT_PUBLIC_APP_URL=http://localhost:3024`.
- Setup:
  - `bun install --frozen-lockfile`: pass; installed dependencies from the committed lockfile because this worktree had no local `node_modules`.
  - `bun run db:generate`: pass; generated `drizzle/0003_mature_sandman.sql` and `drizzle/meta/0003_snapshot.json`, then the migration SQL was patched with the required active-agent backfill.
  - `docker compose -p agentbay_issue_54 -f compose.yaml -f <port override> up -d --force-recreate postgres`: pass; started `agentbay_issue_54-postgres-1` on host port `54354`.
- Focused checks:
  - `bun run test -- tests/unit/agent-schema.test.ts`: pass; 1 file and 8 tests passed.
  - `bun run test -- tests/unit/agent-schema.test.ts tests/unit/create-agent-db.test.ts tests/unit/create-agent-route.test.ts`: pass with isolated DB env; 3 files and 56 tests passed after rerunning with `NEXT_PUBLIC_APP_URL` set.
- Required gates:
  - `bun run db:migrate`: pass; migrations applied successfully against the isolated database.
  - `bun run db:health`: pass; returned `status: ok` and `database: reachable`.
  - `bun run format:check`: pass; Biome checked 64 files.
  - `bun run lint`: pass; Biome checked 64 files.
  - `bun run typecheck`: pass.
  - `bun run test`: pass; 16 files and 121 tests passed.
  - `bun run build`: pass; Next.js build completed and included `/api/agents`.
  - `bun run test:e2e`: pass after E2E cleanup fix; 22 passed and 2 expected project skips.
  - `bun run verify`: pass; aggregate format, lint, typecheck, test, build, and E2E gates passed with 121 unit tests and 22 E2E passed / 2 expected skips.

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
